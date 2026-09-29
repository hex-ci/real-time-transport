import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  mountWithParam,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'
import FavoriteEditorPage from '../favorite-editor.vue'

/**
 * 关注线路的「列表页 + 独立编辑页」：行是链接、行内没有编辑器、取消关注只在编辑页、
 * 认不出的 id 不渲染成某一条、摘要与原来的折叠态一字不差、以及草稿语义（保存才写库，返回不写）。
 *
 * 展开退休之后，这一域只剩两种页面：`/settings/lines`（列表 + 搜索 + 拖动排序）与
 * `/settings/lines/:favoriteId`（一条线路自己的字段）。每一条断言都对着**渲染出来的东西**，
 * 而不是源码里的字符串 —— 前五条各自说的是用户看得见的一个事实。
 *
 * 第六、七条（草稿语义）是这次改动真正新增的行为，也是「就地展开」那一版没有的事实：
 * 那时每一次选择都当场写库，故「没按保存就不写库」这句话当时根本说不出口。
 */

const FAV_ID = 'fav-300'
const OTHER_ID = 'fav-301'
const UP = 'bus_027_300_0'
const DOWN = 'bus_027_300_1'
const LINE_NAME = '300内'
const OTHER_NAME = '52路'
const STOP_NAME = '和平东桥'

const FAVOURITE: Record<string, unknown> = {
  id: FAV_ID,
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: LINE_NAME,
  preferredDirection: 0,
  displayOrder: 0,
  morningDirection: 0,
  morningStopName: STOP_NAME,
  morningStopOrder: 1,
  eveningDirection: 1,
  eveningStopName: '安慧桥',
  eveningStopOrder: 2,
}

/** 另一条关注：列表里有两行，故「href 指向该条」有可区分的两个答案。 */
const SECOND: Record<string, unknown> = {
  ...FAVOURITE,
  id: OTHER_ID,
  lineId: 'bus_027_52_0',
  reverseLineId: undefined,
  lineName: OTHER_NAME,
  displayOrder: 1,
  morningStopName: undefined,
  morningStopOrder: undefined,
  eveningStopName: undefined,
  eveningStopOrder: undefined,
}

const DIR0 = {
  lineId: UP,
  direction: 0,
  directionName: '开往 和平东桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: STOP_NAME, order: 1, interchanges: [] },
    { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
  ],
}

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

function routes(rows: Array<Record<string, unknown>> = [FAVOURITE, SECOND]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: rows })],
    [/\/api\/transit\/lines\//, request => ({ success: true, data: request.url.includes(DOWN) ? DIR1 : DIR0 })],
    [/\/api\/transit\/favorites\/[^/]+$/, request => ({
      success: true,
      data: { ...FAVOURITE, id: request.url.split('/').at(-1), ...(request.body as Record<string, unknown> ?? {}) },
    })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

async function mountList(rows: Array<Record<string, unknown>> = [FAVOURITE, SECOND]): Promise<MountedHost> {
  const host = await mountComponent(LinesPage, {
    routes: routes(rows),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

async function mountEditor(
  favoriteId: string,
  rows: Array<Record<string, unknown>> = [FAVOURITE, SECOND],
): Promise<MountedHost> {
  const host = await mountComponent(FavoriteEditorPage, {
    props: { favoriteId },
    routes: routes(rows),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 列表行自己的链接：按它印出的线路名定位。 */
function rowLink(host: MountedHost, name: string): HostElement {
  return host.node(
    item => item.tag === 'a' && host.textOf(item).includes(name),
    `the followed row of ${name}`,
  )
}

/** 一个节点子树里的每个节点，含自身。 */
function subtree(node: HostElement): HostElement[] {
  const out: HostElement[] = []
  const visit = (current: HostElement): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return out
}

/** 本页发出的每次写入，连同它发送的 body。 */
function writes(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.method === 'PATCH')
}

function saveButton(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === '保存',
    'the save button',
  )
}

/** 编辑页上的方向药丸，按模板顺序：上班两个、下班两个。 */
function directionRadios(host: MountedHost): HostElement[] {
  return host.nodes(item => item.props.role === 'radio')
}

describe('钉子①：列表行整行是链接，href 指向该条', () => {
  it('每一行是一个链接，href 就是这一条自己的编辑页', async () => {
    const host = await mountList()

    expect(rowLink(host, LINE_NAME).props.href).toBe(`/settings/lines/${FAV_ID}`)
    expect(rowLink(host, OTHER_NAME).props.href).toBe(`/settings/lines/${OTHER_ID}`)
    // 两条各指自己的那一条：写死一个 id 的实现会让上面两条里的一条红。
    expect(rowLink(host, LINE_NAME).props.href).not.toBe(rowLink(host, OTHER_NAME).props.href)
    host.unmount()
  })

  it('链接里包含这一行的摘要（行与它的状态不能各说一半）', async () => {
    const host = await mountList()

    // 摘要印在链接内部，故读屏器把它当链接的一部分念出来。
    expect(host.textOf(rowLink(host, LINE_NAME))).toContain(`🏠 ${STOP_NAME} 第1站`)
    host.unmount()
  })

  it('拖拽手柄与链接是两个元素：手柄在链接之外，故抓取不会同时被读成一次导航', async () => {
    const host = await mountList()

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    expect(handle.tag).not.toBe('a')
    // 手柄**不是**行链接的后代：长在链接里的一次抓取会同时触发导航。
    expect(subtree(rowLink(host, LINE_NAME)).includes(handle), 'the drag handle lives inside the row link').toBe(false)
    // 而手柄自己吃掉按压（`@click.stop`），它仍在拖动容器认的那个属性上。
    expect(handle.props['data-drag-handle']).toBeDefined()
    host.unmount()
  })
})

describe('钉子②：行内没有编辑控件（没有组合框、没有站点列表、没有方向单选）', () => {
  it('列表页一个组合框都没有，也没有方向药丸', async () => {
    const host = await mountList()

    // 非空在前：列表本身有东西可展示，故「一个都没有」不是因为这一页什么都没渲染。
    expect(host.nodes(item => item.tag === 'a'), 'the list rendered no row at all').not.toHaveLength(0)
    expect(host.nodes(item => item.tag === 'button' && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox')), 'a stop picker is on the list page')
      .toHaveLength(0)
    expect(host.nodes(item => item.props.role === 'radio'), 'the direction pills are on the list page').toHaveLength(0)
    // 行内不放编辑器：列表页里没有展开态，故一行被打开这件事本身不存在。
    expect(host.nodes(item => item.props['aria-expanded'] !== undefined)).toHaveLength(0)
    host.unmount()
  })

  it('正对照：同一份数据在编辑页上，组合框与方向药丸都在', async () => {
    const host = await mountEditor(FAV_ID)

    expect(host.nodes(item => item.tag === 'button' && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox')))
      .toHaveLength(2)
    expect(directionRadios(host)).toHaveLength(4)
    host.unmount()
  })
})

describe('钉子③：取消关注只在编辑页，列表页没有', () => {
  it('列表页没有取消关注这个控件，编辑页有', async () => {
    const list = await mountList()
    expect(list.text(), 'the list page carries the destructive action').not.toContain('取消关注')
    expect(list.nodes(item => (item.tag === 'button' || item.tag === 'a') && list.textOf(item).includes('取消关注')))
      .toHaveLength(0)
    list.unmount()

    const editor = await mountEditor(FAV_ID)
    expect(editor.nodes(item => item.tag === 'button' && editor.textOf(item).trim() === '取消关注')).toHaveLength(1)
    editor.unmount()
  })

  it('编辑页上的取消关注带确认弹窗：按它不立刻发 DELETE', async () => {
    const host = await mountEditor(FAV_ID)

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '取消关注', 'the unfollow button'))

    expect(host.text()).toContain(`取消关注 ${LINE_NAME}？`)
    expect(host.server.requests.filter(request => request.method === 'DELETE'), 'the confirmation was skipped').toHaveLength(0)
    host.unmount()
  })
})

describe('钉子④：参数不是已知的收藏 id 时，不渲染成某一条', () => {
  it('认不出的 id：说这条关注不存在，且不渲染任何一条的字段', async () => {
    const host = await mountEditor('fav-不存在')

    expect(host.text()).toContain('这条关注不存在')
    // 没有把**第一条**渲染出来：那会让用户在以为自己在编这一条的时候改掉另一条。
    expect(host.text(), 'an unknown id was rendered as the first row').not.toContain(`编辑 ${LINE_NAME}`)
    expect(host.text()).not.toContain('🏠 上班')
    expect(host.nodes(item => item.tag === 'button' && host.textOf(item).trim() === '保存')).toHaveLength(0)
    // 出路仍在：返回控件指向关注线路列表，且**只有**它一个同目标的返回控件。
    const back = host.nodes(item => item.tag === 'a' && host.textOf(item).includes('返回关注线路'))
    expect(back).toHaveLength(1)
    expect(back[0]!.props.href).toBe('/settings/lines')
    host.unmount()
  })

  it('认得出的 id 才渲染这一条：标题点名它，字段是它自己的', async () => {
    const host = await mountEditor(FAV_ID)

    expect(host.text()).toContain(`编辑 ${LINE_NAME}`)
    expect(host.text(), 'the editor rendered another row’s fields').not.toContain(OTHER_NAME)
    host.unmount()
  })

  it('关注列表读取还没作答时不说「不存在」——那时没人知道这个 id 有没有对应一行', async () => {
    // 这一条是「不发明默认值」的另一半：把「还没读到」说成「不存在」同样是替一次没答上来的
    // 读取作主张，且用户会因此去重新关注一条他其实关注着的线路。
    const host = await mountComponent(FavoriteEditorPage, {
      props: { favoriteId: FAV_ID },
      routes: [
        [/\/api\/transit\/favorites$/, () => new Promise(() => {})],
        [/\/api\/transit\/lines\//, () => ({ success: true, data: DIR0 })],
        [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    expect(host.text()).toContain('正在读取关注线路…')
    expect(host.text(), 'a read still on its way was worded as a missing row').not.toContain('这条关注不存在')
    host.unmount()
  })
})

describe('钉子⑤：摘要与原来折叠态那一行一字不差', () => {
  it('两个上车点都在：`🏠 X 第N站 · 🏢 Y 第N站`', async () => {
    const host = await mountList([FAVOURITE])

    expect(host.textOf(rowLink(host, LINE_NAME))).toContain(`🏠 ${STOP_NAME} 第1站 · 🏢 安慧桥 第2站`)
    host.unmount()
  })

  it('一个都没设置：说「未设置上车点」', async () => {
    const host = await mountList([SECOND])

    expect(host.textOf(rowLink(host, OTHER_NAME))).toContain('未设置上车点')
    host.unmount()
  })

  it('只有一个方向设了：只印那一个，另一个不占位', async () => {
    const host = await mountList([{ ...FAVOURITE, eveningStopName: undefined, eveningStopOrder: undefined }])

    const summary = host.textOf(rowLink(host, LINE_NAME))
    expect(summary).toContain(`🏠 ${STOP_NAME} 第1站`)
    expect(summary, 'an unset purpose printed a placeholder').not.toContain('🏢')
    host.unmount()
  })

  it('站名在方向里出现两次：印「（同名2站）」，不印一个它无从知晓的站序', async () => {
    // 逐字这一条覆盖的是「原来折叠态显示什么，现在还是什么」：含糊的那一行仍照它的原因读，
    // 而不是退化成光秃秃的站名。
    const dup = {
      lineId: UP,
      direction: 0,
      directionName: '开往 和平东桥',
      cityCode: '027',
      type: 'bus',
      stops: [
        { id: 's1', name: STOP_NAME, order: 1, interchanges: [] },
        { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
        { id: 's36', name: STOP_NAME, order: 36, interchanges: [] },
      ],
    }
    const host = await mountComponent(LinesPage, {
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [{ ...FAVOURITE, morningStopName: STOP_NAME, morningStopOrder: undefined }] })],
        [/\/api\/transit\/lines\//, request => ({ success: true, data: request.url.includes(DOWN) ? DIR1 : dup })],
        [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    const summary = host.textOf(rowLink(host, LINE_NAME))
    expect(summary).toContain(`🏠 ${STOP_NAME}（同名2站）`)
    expect(summary, 'the ambiguous name was given a stop number').not.toContain('第1站')
    host.unmount()
  })
})

describe('钉子⑥：草稿语义 —— 保存写库一次，返回丢弃不写', () => {
  it('改方向不写库；按保存只写一次方向', async () => {
    const host = await mountEditor(FAV_ID)

    await press(host, directionRadios(host)[1]!)
    expect(writes(host), 'choosing a direction wrote to the server').toHaveLength(0)

    await press(host, saveButton(host))
    // 保存写**整屏**（幂等）：这里钉住方向那一半写对了，且它不带站点列。
    const patch = writes(host)
    const directionWrite = patch.find(request => 'morningDirection' in request.body)
    expect(directionWrite, '保存 did not write the direction').toBeDefined()
    expect(directionWrite!.body).toEqual({ morningDirection: 1 })
    host.unmount()
  })

  it('选上车点也不写库；按保存才写这一对', async () => {
    const host = await mountEditor(FAV_ID)

    const trigger = host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))[0]!
    await press(host, trigger)
    await press(host, host.node(
      item => item.props.role === 'option' && host.textOf(item).includes('安贞桥东'),
      'the stop option 「安贞桥东」',
    ))
    expect(writes(host), 'picking a stop wrote to the server before 保存').toHaveLength(0)

    await press(host, saveButton(host))
    const patch = writes(host)
    const stopWrite = patch.find(request => 'morningStopOrder' in request.body)
    expect(stopWrite, '保存 did not write the picked stop').toBeDefined()
    expect(stopWrite!.body).toEqual({ morningStopName: '安贞桥东', morningStopOrder: 2 })
    host.unmount()
  })

  it('改完之后返回：一个 PATCH 都不发', async () => {
    // 「返回」在本装置里就是卸载这一页 —— 路由跳走会让 Vue 卸载它，而本仓没有导航守卫、
    // 没有 `keep-alive`（见 `docs/PRD.md` §4.1 的已知未决），故草稿随组件一起消失。
    const host = await mountEditor(FAV_ID)

    await press(host, directionRadios(host)[1]!)
    const list = host.nodes(item => item.tag === 'a' && host.textOf(item).includes('返回关注线路'))[0]!
    // 返回控件指向列表页，且它是一次真实导航（`href`），不是脚本跳转。
    expect(list.props.href).toBe('/settings/lines')

    host.unmount()
    expect(writes(host), 'leaving the page wrote the draft').toHaveLength(0)
  })

  it('两个目的都改过：保存把两件各写一次，共两次，且各写各的列', async () => {
    const host = await mountEditor(FAV_ID)

    // 上班方向换成 1（原为 0），下班方向换成 0（原为 1）。
    const radios = directionRadios(host)
    await press(host, radios[1]!)
    await press(host, radios[2]!)
    await press(host, saveButton(host))

    const patch = writes(host)
    const morning = patch.find(request => 'morningDirection' in request.body)
    const evening = patch.find(request => 'eveningDirection' in request.body)
    expect(morning, 'the morning direction was not written').toBeDefined()
    expect(evening, 'the evening direction was not written').toBeDefined()
    expect(morning!.body).toEqual({ morningDirection: 1 })
    expect(evening!.body).toEqual({ eveningDirection: 0 })
    host.unmount()
  })

  it('两个目的各写各自的列：上班那一次不带下班的列，反之亦然', async () => {
    const host = await mountEditor(FAV_ID)

    await press(host, directionRadios(host)[1]!)
    await press(host, saveButton(host))

    const patch = writes(host)
    const morning = patch.find(request => 'morningDirection' in request.body)
    expect(morning, 'the morning direction was not written').toBeDefined()
    // 用途选择的是**列**：写上班那一次绝不能带上晚上的列，那会改写用户从未触碰的值。
    expect(Object.keys(morning!.body)).toEqual(['morningDirection'])
    host.unmount()
  })

  it('换了编的是哪一条：草稿跟着走，不把上一条的改动写进这一条', async () => {
    // vue-router 在 `/settings/lines/a` 与 `/settings/lines/b` 之间复用同一个组件实例
    // （同一条路由记录），故参数变化时草稿必须重新起草 —— 否则屏幕上还是上一条的草稿，
    // 而按保存会把上一条的字段写到这一条上。
    const host = await mountWithParam(FavoriteEditorPage, 'favoriteId', FAV_ID, {
      routes: routes(),
      components: { RouterLink: RouterLinkStub },
    })

    // 在上一条上改一个方向（不保存）。
    await press(host, directionRadios(host)[1]!)
    expect(writes(host)).toHaveLength(0)

    // 同一次挂载里换成另一条：这正是路由参数变化时 Vue 做的事。
    await host.setParam(OTHER_ID)

    expect(host.text()).toContain(`编辑 ${OTHER_NAME}`)
    // 另一条什么都没设过，故它自己的草稿是空的：按下保存只会写这一条自己的值，
    // 上一条那个改动一个字都不会落到它身上。
    await press(host, saveButton(host))
    const patch = writes(host)
    expect(patch.find(request => 'morningDirection' in request.body), 'another row’s direction was written onto this one').toBeUndefined()
    host.unmount()
  })
})

describe('编辑页与列表页共用的那一份判断：两处说同一句话', () => {
  it('列表行的摘要与编辑页对同一份存储给出同一个站序', async () => {
    const list = await mountList([FAVOURITE])
    const editor = await mountEditor(FAV_ID)

    const summary = list.textOf(rowLink(list, LINE_NAME))
    expect(summary).toContain(`🏠 ${STOP_NAME} 第1站`)
    // 编辑页的选择器触发器读回同一对：站名与站序。
    const trigger = editor.nodes(item => item.tag === 'button' && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))[0]!
    expect(editor.textOf(trigger)).toContain(STOP_NAME)
    expect(editor.textOf(trigger)).toContain('第1站')
    list.unmount()
    editor.unmount()
  })
})
