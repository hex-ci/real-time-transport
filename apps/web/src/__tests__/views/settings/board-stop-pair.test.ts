import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterLinkStub, mountComponent, press, type HostElement, type MountedHost, type Route } from './settings-harness'
import FavoriteEditorPage from '../../../views/settings/favorite-editor.vue'
import LinesPage from '../../../views/settings/lines.vue'

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
 *
 * 写入的那一半住在**编辑页**（`/settings/lines/:favoriteId`），摘要那一半住在列表页 ——
 * 「列表页 + 独立编辑页」把同一份判断分在两页上，故本文件两个都挂：`mountEditor` 驱动写入，
 * `mountList` 读那一行印出的摘要。
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

/** 挂**编辑页**：写入路径住在这里。 */
async function mountLines(favourite: Record<string, unknown>): Promise<MountedHost> {
  const host = await mountComponent(FavoriteEditorPage, {
    props: { favoriteId: FAV_ID },
    routes: routes(favourite),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/**
 * 挂**列表页**：折叠摘要（今天叫「行摘要」）住在这里。
 *
 * 它只有一个按钮可按 —— 那一行的链接 —— 而摘要就印在那个链接里，故本函数不按任何东西。
 */
async function mountList(favourite: Record<string, unknown>): Promise<MountedHost> {
  const host = await mountComponent(LinesPage, {
    routes: routes(favourite),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/**
 * 列表行印出的那一行 —— 用户不打开任何东西时看到的东西。
 *
 * 它是行自己的链接（原先是一个 `button`，展开被撤掉之后整行是链接）。按链接定位而不是按标签，
 * 因为那一行上再没有别的元素能承载这段摘要。
 */
function rowSummary(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'a' && host.textOf(item).includes('300内'),
    'the followed row of 300内',
  )
}

/**
 * 打开行的上车点选择器，按模板顺序：上班在前，下班在后。
 *
 * 按它们拥有的组合框弹层（`aria-haspopup="listbox"`）识别：编辑页上没有别的按钮是组合框，
 * 而整行那个链接也不是（它是 `<a>`），故这里不会再点中别的东西。
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

/** 编辑页底部的保存控件。 */
function saveButton(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === '保存',
    'the save button',
  )
}

/**
 * 按保存，让这一页的草稿落库。
 *
 * 草稿语义：改方向、改站都只改这一页的草稿，**保存**是唯一落库的时刻（见 `docs/PRD.md` §4.1）。
 * 故下面每一条「写请求带了什么」的断言都由它触发 —— 而每次改动之后先断言一次零写入，
 * 那条断言才是这一版真正新增的事实：改动本身不写库。
 */
async function save(host: MountedHost): Promise<void> {
  await press(host, saveButton(host))
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
  it('记录 (和平东桥, 第36站)：改完先不写库，按保存才带上站序，触发器读回这一对', async () => {
    const host = await mountLines(FAVOURITE)

    await pickStop(host, 0, DUP, 36)

    // 草稿语义：挑一个站**不**写库。
    expect(writes(host), 'picking a stop wrote to the server before 保存').toHaveLength(0)

    await save(host)

    const patch = writes(host)
    // 保存写**整屏**（幂等），故写里既有方向那一半也有这一对；这里要钉住的是那一对本身。
    const stopWrite = patch.find(request => 'morningStopOrder' in request.body)
    expect(stopWrite, 'picking a stop + 保存 sent no stop write').toBeDefined()
    // 一对随之传递——站名**与**说明选中两个同名站中哪一个的站序。
    // body 为 `{morningStopName: '和平东桥'}` 是缺陷，带着这一对却丢下方向也是。
    expect(stopWrite!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36 })

    // 且屏幕读回它存储的那一对，而非首个同名站。
    expect(host.text()).toContain(`${DUP}`)
    expect(host.text()).toContain('第36站')
    host.unmount()
  })

  it('一个只存了名字、而又同名多站的旧行：说「无法确定是哪一站」，不说「不在本方向停靠」', async () => {
    // 开发实例持有的旧行：一个站名而无站序，且该名字在本方向上出现两次。它读不出来，
    // 而说「不在本方向停靠」会是假的——该方向确实停靠那里（两次）。
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP })

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

  it('列表行的摘要不替一个读不出来的站说话', async () => {
    // 列表行是用户不点进去时看到的东西：当该行自己的方向有两个同名站时，
    // 它不得把一个光秃秃的「🏠 和平东桥」印得像该站已定。
    const host = await mountList({ ...FAVOURITE, morningStopName: DUP })

    const summary = host.textOf(rowSummary(host))
    expect(summary).toContain(DUP)
    expect(summary).toContain('同名')
    host.unmount()
  })

  it('正对照：这一行还没存过任何东西时，列表行说「未设置上车点」', async () => {
    // 行摘要不得声称一个它无从知晓的站序 —— 只有空话说得出这一点。
    const host = await mountList(FAVOURITE)

    expect(host.textOf(rowSummary(host))).toContain('未设置上车点')
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

    const triggers = pickerTriggers(host)
    expect(host.textOf(triggers[0]!), 'the stored stop was dropped when the direction changed').toContain(DUP)
    expect(host.textOf(triggers[0]!)).toContain('第36站')
    expect(host.text()).toContain('请重选')
    // 读取绝不写入：加载时纠正所存一对的页面会在用户背后改写他们的选择。
    expect(writes(host)).toHaveLength(0)
    host.unmount()
  })

  it('改方向：按保存才写，且只写方向，不碰站名与站序两列', async () => {
    const host = await mountLines({
      ...FAVOURITE,
      morningStopName: DUP,
      morningStopOrder: 36,
    })

    const radios = host.nodes(item => item.props.role === 'radio')
    expect(radios.length, 'the editor rendered no direction radio').toBe(4)
    // 上班的两个药丸在前，按 `directionOptions` 顺序：锚定的方向，然后另一个。
    await press(host, radios[1]!)
    // 草稿语义：按一下药丸不写库。
    expect(writes(host), 'choosing a direction wrote to the server before 保存').toHaveLength(0)

    await save(host)

    const patch = writes(host)
    const directionWrite = patch.find(request => 'morningDirection' in request.body)
    expect(directionWrite, 'changing the direction + 保存 sent no direction write').toBeDefined()
    // 写入方向时完全不得携带站点列：这一对留下，而方向写入绝不能清空它（也不能重编它）。
    expect(directionWrite!.body).toEqual({ morningDirection: 1 })
    host.unmount()
  })

  it('什么都没改也能保存：按下就是把这一屏按现在这个样子再存一次（幂等）', async () => {
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP, morningStopOrder: 36 })

    const button = saveButton(host)
    expect(button.props.disabled, '保存 is not pressable with nothing changed').toBe(false)
    await save(host)

    // 写的是这一屏上真有的那几件：方向（双向线路上有得选）与这一对。
    const patch = writes(host)
    expect(patch.find(r => 'morningDirection' in r.body), 'the direction half was skipped').toBeDefined()
    expect(patch.find(r => 'morningStopOrder' in r.body)?.body)
      .toEqual({ morningStopName: DUP, morningStopOrder: 36 })
    host.unmount()
  })
})

describe('清空上车点：站名与站序一起 null', () => {
  it('按「清除上班固定站点」再保存，PATCH 的两列都是 null —— 不是只把站名置空', async () => {
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP, morningStopOrder: 36 })

    await press(host, clearStopControl(host, 'morning'))
    // 清空也只是一个草稿改动：保存之前库里的值不动。
    expect(writes(host), 'clearing the stop wrote to the server before 保存').toHaveLength(0)

    await save(host)

    const patch = writes(host)
    const clearWrite = patch.find(request => 'morningStopOrder' in request.body)
    expect(clearWrite, 'clearing the stop + 保存 sent no stop write').toBeDefined()
    // `{morningStopName: null}` 单独一个就是缺陷。两列是一个站的身份，故清空要写**两列**
    // ——单独的 null 会被服务端拒绝（400），且若真落库会留下站序与已清空的名字并排。
    expect(clearWrite!.body).toEqual({ morningStopName: null, morningStopOrder: null })

    // 且屏幕把该行读回为已清空，而非对某个名字做猜测。
    expect(host.text()).toContain('未设置')
    expect(host.textOf(triggersOf(host)[0]!)).not.toContain(DUP)
    host.unmount()
  })

  it('正对照：清空保存之后重新选同一个站再保存，写出去的仍是这一对（清空没有把写站弄坏）', async () => {
    const host = await mountLines({ ...FAVOURITE, morningStopName: DUP, morningStopOrder: 36 })

    await press(host, clearStopControl(host, 'morning'))
    await save(host)
    await pickStop(host, 0, DUP, 36)
    await save(host)

    const stopWrites = writes(host).filter(request => 'morningStopOrder' in request.body)
    expect(stopWrites, 'clear + re-pick did not send exactly two stop writes').toHaveLength(2)
    expect(stopWrites[0]!.body).toEqual({ morningStopName: null, morningStopOrder: null })
    // 一对完整回来，且站序是被选的那个（36，而非首个同名的第 1 站）。
    expect(stopWrites[1]!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36 })
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

    await press(host, clearStopControl(host, 'evening'))
    await save(host)

    const patch = writes(host)
    const clearWrite = patch.find(request => 'eveningStopOrder' in request.body)
    expect(clearWrite, 'clearing the evening stop + 保存 sent no stop write').toBeDefined()
    // 用途选择的是**列**，不只是值：在此写入上午一对的分支会清掉用户从未触碰的站，
    // 并留下晚间那个。
    expect(clearWrite!.body).toEqual({ eveningStopName: null, eveningStopOrder: null })
    host.unmount()
  })

  it('下班选站：写的是 evening 的两列，且站序是点的那一站', async () => {
    const host = await mountLines({ ...FAVOURITE, eveningDirection: 1 })

    await pickStop(host, 1, '安慧桥', 2)
    await save(host)

    const patch = writes(host)
    const stopWrite = patch.find(request => 'eveningStopOrder' in request.body)
    expect(stopWrite, 'picking the evening stop + 保存 sent no stop write').toBeDefined()
    expect(stopWrite!.body).toEqual({ eveningStopName: '安慧桥', eveningStopOrder: 2 })
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
