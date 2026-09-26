import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, mountComponent, press, type HostElement, type MountedHost, type Route } from './settings-harness'
import LinesPage from '../lines.vue'

/**
 * 关注线路 · 上车点写入：记录的是 (站名, 站序) 一对，不是一个名字。
 *
 * 实测缺陷：300内 方向 0 上「和平东桥」同时是第 1 站和第 36 站（环线的首末站，相隔 194 m）。
 * picker 把两个都列出来了，使用者选了第 36 站，而这一行只存下站名 —— 于是一切读侧只能按名字
 * `find`，取到第 1 站：步行、距离、到站分钟、整条出门结论都按另一个物理站台算。
 *
 * 这里钉的是**屏幕这一层**：选第 36 站时发出去的写请求必须带上它的站序；改方向时不得动已存的
 * 站；一个只存了名字、而又同名多站的旧行，屏幕必须如实说「无法确定是哪一站」，不能说
 * 「不在本方向停靠」（那是假的：它停靠），也不能替使用者挑一个。
 */

const FAV_ID = 'fav-300'
const UP = 'bus_027_300_0'
const DOWN = 'bus_027_300_1'
const DUP = '和平东桥'

/** 关注的线路：一条公交双向线路，上午已选定方向。 */
const FAVOURITE = {
  id: FAV_ID,
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: '300内',
  preferredDirection: 0,
  displayOrder: 0,
  morningDirection: 0,
}

/** 方向 0：环线的首末站同名。 */
const DIR0 = {
  lineId: UP,
  direction: 0,
  directionName: '开往 和平东桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: DUP, order: 1, interchanges: [] },
    { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
    { id: 's36', name: DUP, order: 36, interchanges: [] },
  ],
}

/** 另一方向完全不停这个名字。 */
const DIR1 = {
  lineId: DOWN,
  direction: 1,
  directionName: '开往 安慧桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '安贞桥东', order: 1, interchanges: [] },
    { id: 's2', name: '安慧桥', order: 2, interchanges: [] },
  ],
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 本页发出的读取，外加回显所给行的 PATCH。 */
function routes(favourite: Record<string, unknown>): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [favourite] })],
    // 页面加载关注线路的**两个**方向：方向选择器各自按其上游详情命名。
    [/\/api\/transit\/lines\//, request => ({
      success: true,
      data: request.url.includes(DOWN) ? DIR1 : DIR0,
    })],
    // 写入：用调用方索要的那行作答，使屏幕渲染的是 store 自己的回读。
    [/\/api\/transit\/favorites\/fav-300$/, request => ({
      success: true,
      data: { ...favourite, ...(request.body as Record<string, unknown> ?? {}) },
    })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

async function mountLines(favourite: Record<string, unknown>): Promise<MountedHost> {
  const host = await mountComponent(LinesPage, {
    routes: routes(favourite),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 关注行自己的触发器——用户读到的折叠摘要。 */
function rowTrigger(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).includes('300内'),
    'the followed row of 300内',
  )
}

async function openRow(host: MountedHost): Promise<void> {
  await press(host, rowTrigger(host))
}

/**
 * 打开行的上车点选择器，按模板顺序：上班在前，下班在后。
 *
 * 按它们拥有的组合框弹层（`aria-haspopup="listbox"`）识别：该行的折叠触发器也是按钮，只按
 * `aria-expanded` 匹配会把它选进来——装置会因此点中整行而非选择器。
 */
function pickerTriggers(host: MountedHost): HostElement[] {
  return host.nodes(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))
}

/** 经选择器自己的弹层选一个站，按该选项陈述的 (站名, 站序)。 */
async function pickStop(host: MountedHost, which: 0 | 1, name: string, order: number): Promise<void> {
  const triggers = pickerTriggers(host)
  const trigger = triggers[which]
  if (!trigger) throw new Error(`the opened row rendered no picker at index ${which}`)
  await press(host, trigger)
  const option = host.node(
    item => item.props.role === 'option'
      && host.textOf(item).includes(name)
      && host.textOf(item).includes(`第${order}站`),
    `the stop option 「${name} 第${order}站」`,
  )
  await press(host, option)
}

/** 本页发出的每次写入，连同它发送的 body。 */
function writes(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.method === 'PATCH')
}

/** 打开行的选择器，按模板顺序（上班、下班）。 */
function triggersOf(host: MountedHost): HostElement[] {
  return pickerTriggers(host)
}

/**
 * 针对某用途的选择器清空控件——触发器旁的 X。
 *
 * 按该控件携带的无障碍名（`清除上班固定站点`）定位：它是该行上唯一说明它清空两个选择器中哪一个的东西，
 * 两个按钮在其他方面完全相同。
 */
function clearStopControl(host: MountedHost, purpose: 'morning' | 'evening'): HostElement {
  const label = `清除${purpose === 'morning' ? '上班' : '下班'}固定站点`
  return host.node(
    item => item.tag === 'button' && item.props['aria-label'] === label,
    `the ${purpose} clear control`,
  )
}

describe('选中的是第 36 站，写下去的就必须是第 36 站', () => {
  it('记录 (和平东桥, 第36站)：写请求带上站序，触发器读回这一对', async () => {
    const host = await mountLines(FAVOURITE)

    // 折叠摘要不得声称一个它无从知晓的站序：该行还没存储任何东西。
    expect(host.textOf(rowTrigger(host))).toContain('未设置上车点')

    await openRow(host)
    await pickStop(host, 0, DUP, 36)

    const patch = writes(host)
    expect(patch, 'picking a stop sent no write at all').toHaveLength(1)
    // 一对随之传递——站名**与**说明选中两个同名站中哪一个的站序。
    // body 为 `{morningStopName: '和平东桥'}` 是缺陷，带着这一对却丢下方向也是。
    expect(patch[0]!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36 })

    // 且屏幕读回它存储的那一对，而非首个同名站。
    expect(host.text()).toContain(`${DUP}`)
    expect(host.text()).toContain('第36站')
    host.unmount()
  })

  it('一个只存了名字、而又同名多站的旧行：说「无法确定是哪一站」，不说「不在本方向停靠」', async () => {
    // 开发实例持有的旧行：一个站名而无站序，且该名字在本方向上出现两次。它读不出来，
    // 而说「不在本方向停靠」会是假的——该方向确实停靠那里（两次）。
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP })

    await openRow(host)

    const text = host.text()
    expect(text).toContain('同名')
    expect(text).toContain('请重选')
    expect(text, 'a stop this direction does serve was reported as unserved').not.toContain('不在本方向停靠')
    // 触发器显示所存站名而**无**站序：这里的站序会是一个没人做过的选择
    // （首个匹配正是第 36 站变成第 1 站的原因）。
    const triggers = pickerTriggers(host)
    expect(host.textOf(triggers[0]!)).toContain(DUP)
    expect(host.textOf(triggers[0]!), 'the ambiguous name was given a stop number').not.toContain('第1站')
    host.unmount()
  })

  it('折叠摘要不替一个读不出来的站说话', async () => {
    // 折叠行是用户不打开任何东西时看到的东西：当该行自己的方向有两个同名站时，
    // 它不得把一个光秃秃的「🏠 和平东桥」印得像该站已定。
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP })

    const summary = host.textOf(rowTrigger(host))
    expect(summary).toContain(DUP)
    expect(summary).toContain('同名')
    host.unmount()
  })
})

describe('改了方向之后，已选的站既不被丢掉，也不被换成另一个', () => {
  it('方向改到不经过该站的一侧：保留那一对，并如实说请重选', async () => {
    // 用户的站留在行上（他们的选择值得保留，在他们不知情下清掉会丢失他们无法恢复的信息）；
    // 变化在于它在新方向上不再可定位——且绝不能对着新方向的列表被静默重新解析。
    const host = await mountLines({
      ...FAVOURITE,
      morningStopName: DUP,
      morningStopOrder: 36,
      morningDirection: 1,
    })

    await openRow(host)

    const triggers = pickerTriggers(host)
    expect(host.textOf(triggers[0]!), 'the stored stop was dropped when the direction changed').toContain(DUP)
    expect(host.textOf(triggers[0]!)).toContain('第36站')
    expect(host.text()).toContain('请重选')
    // 读取绝不写入：加载时纠正所存一对的页面会在用户背后改写他们的选择。
    expect(writes(host)).toHaveLength(0)
    host.unmount()
  })

  it('改方向只写方向，不碰站名与站序两列', async () => {
    const host = await mountLines({
      ...FAVOURITE,
      morningStopName: DUP,
      morningStopOrder: 36,
    })

    await openRow(host)
    const radios = host.nodes(item => item.props.role === 'radio')
    expect(radios.length, 'the expanded row rendered no direction radio').toBe(4)
    // 上班的两个药丸在前，按 `directionOptions` 顺序：锚定的方向，然后另一个。
    await press(host, radios[1]!)

    const patch = writes(host)
    expect(writes(host), 'changing the direction sent no write').toHaveLength(1)
    // 写入方向时完全不得携带站点列：这一对留下，而方向写入绝不能清空它（也不能重编它）。
    expect(patch[0]!.body).toEqual({ morningDirection: 1 })
    host.unmount()
  })
})

describe('清空上车点：站名与站序一起 null', () => {
  it('按「清除上班固定站点」发出的 PATCH，两列都是 null —— 不是只把站名置空', async () => {
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP, morningStopOrder: 36 })

    await openRow(host)
    await press(host, clearStopControl(host, 'morning'))

    const patch = writes(host)
    expect(patch, 'clearing the stop sent no write at all').toHaveLength(1)
    // `{morningStopName: null}` 单独一个就是缺陷。两列是一个站的身份，故清空要写**两列**
    // ——单独的 null 会被服务端拒绝（400），且若真落库会留下站序与已清空的名字并排。
    expect(patch[0]!.body).toEqual({ morningStopName: null, morningStopOrder: null })

    // 且屏幕把该行读回为已清空，而非对某个名字做猜测。
    expect(host.text()).toContain('未设置')
    expect(host.textOf(triggersOf(host)[0]!)).not.toContain(DUP)
    host.unmount()
  })

  it('正对照：清空之后重新选同一个站，写出去的仍是这一对（清空没有把写站弄坏）', async () => {
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP, morningStopOrder: 36 })

    await openRow(host)
    await press(host, clearStopControl(host, 'morning'))
    await pickStop(host, 0, DUP, 36)

    const patch = writes(host)
    expect(patch, 'clear + re-pick did not send exactly two writes').toHaveLength(2)
    expect(patch[0]!.body).toEqual({ morningStopName: null, morningStopOrder: null })
    // 一对完整回来，且站序是被选的那个（36，而非首个同名的第 1 站）。
    expect(patch[1]!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36 })
    expect(host.textOf(triggersOf(host)[0]!)).toContain('第36站')
    host.unmount()
  })
})

describe('两个用途各写各自的两列', () => {
  it('下班清空：写的是 evening 的两列，不是 morning 的两列', async () => {
    const host = await mountLines({
      ...FAVOURITE,
      eveningStopName: '安慧桥',
      eveningStopOrder: 2,
      eveningDirection: 1,
    })

    await openRow(host)
    await press(host, clearStopControl(host, 'evening'))

    const patch = writes(host)
    expect(patch, 'clearing the evening stop sent no write at all').toHaveLength(1)
    // 用途选择的是**列**，不只是值：在此写入上午一对的分支会清掉用户从未触碰的站，
    // 并留下晚间那个。
    expect(patch[0]!.body).toEqual({ eveningStopName: null, eveningStopOrder: null })
    host.unmount()
  })

  it('下班选站：写的是 evening 的两列，且站序是点的那一站', async () => {
    const host = await mountLines({ ...FAVOURITE, eveningDirection: 1 })

    await openRow(host)
    await pickStop(host, 1, '安慧桥', 2)

    const patch = writes(host)
    expect(patch, 'picking the evening stop sent no write at all').toHaveLength(1)
    expect(patch[0]!.body).toEqual({ eveningStopName: '安慧桥', eveningStopOrder: 2 })
    host.unmount()
  })
})

describe('只有一个站名、没有站序的选择：本地就拒绝，一个请求都不发', () => {
  it('setBoardStop 收到站序为 null 的选择：抛出行里那段话，且不发 PATCH', async () => {
    const host = await mountLines(FAVOURITE)
    // store 必须真正持有该行，使移除守卫的改动会被一次真实写入应答，
    // 而非对着一个未知 id 静默无操作。
    await host.store.fetchFavorites()

    await expect(host.store.setBoardStop(FAV_ID, 'morning', { name: DUP, order: null }))
      .rejects.toThrow('该站名在本方向有多个同名站，无法确定是哪一站，请选择一个具体的站点')

    // 无站序的选择在此**被**拒绝，用该行自己的提示所用的措辞。
    // 往返它会把服务端的 400 放进面板。
    expect(writes(host), 'an order-less choice was sent to the server').toHaveLength(0)
    host.unmount()
  })
})
