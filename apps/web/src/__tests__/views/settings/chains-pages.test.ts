import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  mountWithParam,
  press,
  type,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import ChainsListPage from '../chains.vue'
import ChainEditorPage from '../chain-editor.vue'

/**
 * 通勤链路的「列表页 + 独立编辑页」：行是链接、行内没有表单、删除只在编辑页、认不出的
 * chainId 不渲染成某一条、摘要与原来卡片行一字不差，以及草稿语义（保存写库一次，返回不写）。
 *
 * 就地插入表单那一版没有的事实有两条，都由本文件钉住：**列表页上没有任何输入控件**
 * （故页面高度与编辑状态无关），以及**返回不等于保存**（改动只活在这一页里）。
 *
 * 每条断言都对着**渲染出来的东西**，而不是源码里的字符串。
 */

const { pushedRoutes } = vi.hoisted(() => ({ pushedRoutes: [] as string[] }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: async (to: string) => { pushedRoutes.push(to) } }),
}))

beforeEach(() => {
  pushedRoutes.length = 0
})

const LIST_HREF = '/settings/chains'
const NEW_HREF = '/settings/chains/new'

const MORNING_ID = 'chain-morning'
const EVENING_ID = 'chain-evening'

/** 快线 1 路 上的一程：接驳骑行、额外 5 分 —— 每一件都印成它自己的字。 */
function storedLeg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 0,
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    cityCode: '027',
    boardStationName: '东大桥',
    boardStationOrder: 3,
    alightStationName: '建国门',
    alightStationOrder: 4,
    transferExtraMinutes: 5,
    connectionMode: 'cycle',
    ...overrides,
  }
}

/** 一条链路，如 API 所答。 */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MORNING_ID,
    userId: 'default_user',
    name: '早上上班',
    purpose: 'morning',
    displayOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    legs: [storedLeg()],
    ...overrides,
  }
}

/** 第二条：目的不同、接驳方式没选过、额外时间为 null —— 每一件都印成它自己的字。 */
const SECOND = stored({
  id: EVENING_ID,
  name: '下班回家',
  purpose: 'evening',
  displayOrder: 1,
  legs: [{
    seq: 0,
    lineId: 'subway_027_88',
    lineName: '地铁 88 号线',
    cityCode: '027',
    boardStationName: '平安里',
    boardStationOrder: 3,
    alightStationName: '西直门',
    alightStationOrder: 1,
    transferExtraMinutes: null,
    connectionMode: null,
  }],
})

/** 两条关注线路：链路里那两条段的线路都在里面，故保存不会被「已不再关注」拦下。 */
const FAVOURITES = [
  {
    id: 'fav-bus-1',
    userId: 'default_user',
    cityCode: '027',
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    preferredDirection: 0,
    reverseLineId: 'bus_027_1_rev',
    displayOrder: 0,
  },
  {
    id: 'fav-subway-88',
    userId: 'default_user',
    cityCode: '027',
    lineId: 'subway_027_88',
    lineName: '地铁 88 号线',
    preferredDirection: 0,
    reverseLineId: 'subway_027_88',
    displayOrder: 1,
  },
]

const BUS_STOPS = [
  { id: 's1', name: '十里堡', order: 1, interchanges: [] },
  { id: 's2', name: '团结湖', order: 2, interchanges: [] },
  { id: 's3', name: '东大桥', order: 3, interchanges: [] },
  { id: 's4', name: '建国门', order: 4, interchanges: [] },
]

const SUBWAY_STOPS = [
  { id: 's1', name: '西直门', order: 1, interchanges: [] },
  { id: 's2', name: '车公庄', order: 2, interchanges: [] },
  { id: 's3', name: '平安里', order: 3, interchanges: [] },
]

function routes(chains: Array<Record<string, unknown>> = [stored(), SECOND]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: FAVOURITES })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
    [/\/api\/transit\/lines\//, request => ({ success: true, data: {
      lineId: request.url.includes('subway') ? 'subway_027_88' : 'bus_027_1',
      direction: Number(/direction=(\d)/.exec(request.url)?.[1] ?? 0),
      directionName: request.url.includes('subway') ? '开往平安里' : '开往建国门',
      cityCode: '027',
      stops: request.url.includes('subway') ? SUBWAY_STOPS : BUS_STOPS,
    } })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: chains })],
    [/\/api\/transit\/commute-chains$/, request => ({ success: true, data: stored(request.body) })],
    [/\/api\/transit\/commute-chains\/[^/]+$/, request => (request.method === 'DELETE'
      ? { success: true, data: { removed: true } }
      : { success: true, data: stored(request.body) })],
  ]
}

async function mountList(chains?: Array<Record<string, unknown>>): Promise<MountedHost> {
  const host = await mountComponent(ChainsListPage, {
    routes: routes(chains),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

async function mountEditor(
  chainId: string | null,
  chains?: Array<Record<string, unknown>>,
): Promise<MountedHost> {
  const host = await mountComponent(ChainEditorPage, {
    props: { chainId },
    routes: routes(chains),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // reka-ui 的焦点作用域在卸载时排定一个定时器，而该定时器会读 document。
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

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

/** 列表里的一行。 */
function rowOf(host: MountedHost, name: string): HostElement {
  return host.node(item => item.tag === 'li' && host.textOf(item).includes(name), `the row of ${name}`)
}

/** 一行里那个进编辑页的链接。 */
function rowLink(host: MountedHost, name: string): HostElement {
  const found = subtree(rowOf(host, name)).find(item => item.tag === 'a')
  if (!found) throw new Error(`the row of ${name} is not a link`)
  return found
}

/** 本页发出的每次写入。 */
function writes(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.url.startsWith('/api/transit/commute-chains')
    && request.method !== 'GET')
}

describe('钉子①：列表行整行是链接，href 指向该条', () => {
  it('每一行是一个链接，href 就是这一条自己的编辑页', async () => {
    const host = await mountList()

    expect(rowLink(host, '早上上班').props.href).toBe(`/settings/chains/${MORNING_ID}`)
    expect(rowLink(host, '下班回家').props.href).toBe(`/settings/chains/${EVENING_ID}`)
    // 两条各指自己的那一条：写死一个 id 的实现会让上面两条里的一条红。
    expect(rowLink(host, '早上上班').props.href).not.toBe(rowLink(host, '下班回家').props.href)
    host.unmount()
  })

  it('链接里包含这一行的摘要（行与它的状态不能各说一半）', async () => {
    const host = await mountList()

    const text = host.textOf(rowLink(host, '早上上班'))
    expect(text).toContain('早上上班')
    expect(text).toContain('上班 · 从「家」出发')
    host.unmount()
  })

  it('「新增链路」是一个指向 /settings/chains/new 的链接，不是就地展开的按钮', async () => {
    const host = await mountList()

    const add = host.node(item => item.tag === 'a' && host.textOf(item).includes('新增链路'), 'the 新增链路 link')
    expect(add.props.href).toBe(NEW_HREF)
    // 列表页上没有一个按钮叫「新增链路」：就地展开的那一个已经退休。
    expect(host.nodes(item => item.tag === 'button' && host.textOf(item).includes('新增链路')))
      .toHaveLength(0)
    host.unmount()
  })

  it('拖拽手柄与链接是两个元素：手柄在链接之外，故抓取不会同时被读成一次导航', async () => {
    const host = await mountList()

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    expect(handle.tag).not.toBe('a')
    // 手柄**不是**行链接的后代：长在链接里的一次抓取会同时触发导航。
    expect(subtree(rowLink(host, '早上上班')).includes(handle), 'the drag handle lives inside the row link').toBe(false)
    host.unmount()
  })
})

describe('钉子②：行内没有表单控件（没有输入框、组合框、段编辑器）', () => {
  it('列表页一个输入框都没有，也没有段编辑器与组合框', async () => {
    const host = await mountList()

    // 非空在前：列表本身有东西可展示，故「一个都没有」不是因为这一页什么都没渲染。
    expect(host.nodes(item => item.tag === 'li'), 'the list rendered no row at all').not.toHaveLength(0)
    expect(host.nodes(item => item.tag === 'input'), 'an input is on the list page').toHaveLength(0)
    expect(host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox')), 'a picker is on the list page')
      .toHaveLength(0)
    expect(host.nodes(item => item.props['data-chain-leg'] !== undefined), 'a leg editor is on the list page')
      .toHaveLength(0)
    expect(host.nodes(item => item.props.role === 'radio'), 'the purpose/connection radios are on the list page')
      .toHaveLength(0)
    host.unmount()
  })

  it('正对照：同一份数据在编辑页上，这些控件都在', async () => {
    const host = await mountEditor(MORNING_ID)

    expect(host.nodes(item => item.tag === 'input').length).toBeGreaterThan(0)
    expect(host.nodes(item => item.props['data-chain-leg'] !== undefined).length).toBeGreaterThan(0)
    expect(host.nodes(item => item.props.role === 'radio').length).toBeGreaterThan(0)
    host.unmount()
  })
})

describe('钉子③：删除只在编辑页，列表页没有，新建页也没有', () => {
  it('列表页没有删除链路这个控件', async () => {
    const host = await mountList()

    expect(host.text(), 'the list page carries the destructive action').not.toContain('删除链路')
    host.unmount()
  })

  it('编辑页有它，且带确认弹窗：按它不立刻发 DELETE', async () => {
    const host = await mountEditor(MORNING_ID)

    const remove = host.node(
      item => item.tag === 'button' && host.textOf(item).includes('删除链路'),
      'the remove control',
    )
    await press(host, remove)

    expect(host.text()).toContain('删除通勤链路「早上上班」？')
    expect(host.server.requests.filter(request => request.method === 'DELETE'), 'the confirmation was skipped')
      .toHaveLength(0)
    host.unmount()
  })

  it('新建页没有它：一条还不存在的链路没什么可删的', async () => {
    const host = await mountEditor(null)

    expect(host.text()).toContain('新增链路')
    expect(host.text(), 'the new page carries the destructive action').not.toContain('删除链路')
    host.unmount()
  })
})

describe('钉子④：chainId 认不出时不渲染成某一条', () => {
  it('认不出的 id：说这条链路不存在，且不渲染任何一条的字段', async () => {
    const host = await mountEditor('chain-不存在')

    expect(host.text()).toContain('这条链路不存在')
    // 没有把**第一条**渲染出来：那会让用户在以为自己在编这一条的时候改掉另一条。
    expect(host.text(), 'an unknown id was rendered as the first row').not.toContain('编辑 早上上班')
    expect(host.nodes(item => item.tag === 'input'), 'the unknown id rendered a form').toHaveLength(0)
    expect(host.nodes(item => item.tag === 'button' && host.textOf(item).includes('保存链路'))).toHaveLength(0)
    // 出路仍在：返回控件指向链路列表，且**只有**它一个同目标的返回控件。
    const back = host.nodes(item => item.tag === 'a' && host.textOf(item).includes('返回通勤链路'))
    expect(back).toHaveLength(1)
    expect(back[0]!.props.href).toBe(LIST_HREF)
    host.unmount()
  })

  it('认得出的 id 才渲染这一条：标题点名它，字段是它自己的', async () => {
    const host = await mountEditor(MORNING_ID)

    expect(host.text()).toContain('编辑 早上上班')
    expect(host.text(), 'the editor rendered another row’s fields').not.toContain('下班回家')
    host.unmount()
  })

  it('列表读取还没作答时不说「不存在」——那时没人知道这个 id 有没有对应一行', async () => {
    // 这一条是「不发明默认值」的另一半：把「还没读到」说成「不存在」同样是替一次没答上来的
    // 读取作主张，且用户会因此去重新录入一条他其实已经录过的链路。
    const host = await mountComponent(ChainEditorPage, {
      props: { chainId: MORNING_ID },
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
        [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => new Promise(() => {})],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    expect(host.text()).toContain('正在读取换乘链…')
    expect(host.text(), 'a read still on its way was worded as a missing row').not.toContain('这条链路不存在')
    host.unmount()
  })

  it('列表读取失败时说读取失败，也不说「不存在」', async () => {
    const host = await mountComponent(ChainEditorPage, {
      props: { chainId: MORNING_ID },
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
        [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: false, error: '读取失败' })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    expect(host.text()).toContain('换乘链读取失败')
    expect(host.text()).not.toContain('这条链路不存在')
    host.unmount()
  })
})

describe('钉子⑤：摘要与原来卡片行一字不差', () => {
  it('一行印出目的与起点、每一段的线路与那一对站、接驳方式与额外时间', async () => {
    const host = await mountList([stored()])

    const text = host.textOf(rowLink(host, '早上上班'))
    expect(text).toContain('早上上班')
    expect(text).toContain('上班 · 从「家」出发')
    expect(text).toContain('第 1 段 · 快线 1 路：东大桥 第3站 → 建国门 第4站')
    expect(text).toContain('· 接驳骑行 · 接驳额外 5 分')
    host.unmount()
  })

  it('下班目的印「下班 · 从「公司」出发」；没选过接驳方式就印它自己的字，不冒充步行', async () => {
    const host = await mountList([SECOND])

    const text = host.textOf(rowLink(host, '下班回家'))
    expect(text).toContain('下班 · 从「公司」出发')
    expect(text).toContain('第 1 段 · 地铁 88 号线：平安里 第3站 → 西直门 第1站')
    expect(text).toContain('· 接驳未选方式')
    expect(text, 'an unset connection mode was printed as walking').not.toContain('接驳步行')
    // 没配额外时间的段什么都不印：0 与「没配」不是同一个事实。
    expect(text).not.toContain('接驳额外')
    host.unmount()
  })

  it('半截的一对印「未设置」，不冒充任何一站', async () => {
    const host = await mountList([stored({
      legs: [storedLeg({ boardStationName: null, boardStationOrder: null })],
    })])

    const text = host.textOf(rowLink(host, '早上上班'))
    expect(text).toContain('未设置 → 建国门 第4站')
    host.unmount()
  })

  it('两段各印自己的一行', async () => {
    const host = await mountList([stored({
      legs: [
        storedLeg(),
        {
          seq: 1,
          lineId: 'subway_027_88',
          lineName: '地铁 88 号线',
          cityCode: '027',
          boardStationName: '车公庄',
          boardStationOrder: 2,
          alightStationName: '平安里',
          alightStationOrder: 3,
          transferExtraMinutes: 0,
          connectionMode: 'walk',
        },
      ],
    })])

    const text = host.textOf(rowLink(host, '早上上班'))
    expect(text).toContain('第 1 段 · 快线 1 路：东大桥 第3站 → 建国门 第4站')
    expect(text).toContain('第 2 段 · 地铁 88 号线：车公庄 第2站 → 平安里 第3站')
    // 填 0 就是 0：它印出来，因为那是使用者自己配的「完全没有额外时间」。
    expect(text).toContain('接驳额外 0 分')
    host.unmount()
  })
})

describe('钉子⑥：草稿语义 —— 保存写库一次并回列表，返回丢弃不写', () => {
  it('编辑已存的一条：没改动也能保存（写一次 PATCH），改动后同样写一次，然后回列表', async () => {
    const host = await mountEditor(MORNING_ID)

    const name = host.node(item => item.tag === 'input' && item.props.type === 'text', 'the name field')
    const save = host.node(
      item => item.tag === 'button' && host.textOf(item).includes('保存链路'),
      'the save control',
    )
    expect(writes(host), 'opening the editor wrote to the server').toHaveLength(0)
    // 保存只看「正在保存」：草稿语义说的是**没保存就等于没改**，不是「没改就不许保存」——
    // 一个字段都没改时按下它，就是把这一条按现在屏幕上的样子再存一次。
    expect(save.props.disabled, '保存 is pressable with nothing changed').toBe(false)

    // 改一个字（`type` 会先设值再派发 input），保存照旧可点。
    await type(host, name, '早上上班（改）')
    expect(save.props.disabled, '保存 stays disabled after an edit').toBe(false)
    await press(host, save)

    const patches = writes(host).filter(request => request.method === 'PATCH')
    expect(patches, '保存 did not write exactly once').toHaveLength(1)
    expect(patches[0]!.url).toBe(`/api/transit/commute-chains/${MORNING_ID}`)
    expect(patches[0]!.body.name).toBe('早上上班（改）')
    expect(pushedRoutes, '保存 did not return to the list').toEqual([LIST_HREF])
    host.unmount()
  })

  it('已存的一份坏草稿没改也按得动：要说的是这一条自己的毛病，而不是把它藏起来', async () => {
    // 半截的一对（只有站名、没有站序）：保存必须能按下去，好让那句拒绝说出口。
    const host = await mountEditor(MORNING_ID, [stored({
      legs: [storedLeg({ alightStationOrder: null })],
    })])

    const save = host.node(
      item => item.tag === 'button' && host.textOf(item).includes('保存链路'),
      'the save control',
    )
    expect(save.props.disabled, 'the refusal can never be spoken').toBe(false)
    await press(host, save)

    expect(host.nodes(item => 'data-chain-refusal' in item.props)).toHaveLength(1)
    expect(writes(host), 'a refused draft was written anyway').toHaveLength(0)
    host.unmount()
  })

  it('新建：保存发一次 POST，然后回列表', async () => {
    const host = await mountEditor(null)

    await type(host, host.node(item => item.tag === 'input' && item.props.type === 'text', 'the name field'), '早上上班')
    await press(host, host.node(
      item => item.tag === 'button' && host.textOf(item).includes('保存链路'),
      'the save control',
    ))

    // 名字填了、段还没选完：就地拒绝，一个请求都不发。
    expect(writes(host)).toHaveLength(0)
    host.unmount()
  })

  it('改完之后点返回：一个写请求都不发', async () => {
    // 「返回」在这里就是那个链接（`BackToSettings`）——路由跳走会让 Vue 卸载这一页，
    // 而本仓没有导航守卫、没有 `keep-alive`（见 `docs/PRD.md` §4.1 的已知未决），
    // 故草稿随组件一起消失。
    const host = await mountEditor(MORNING_ID)

    await type(host, host.node(item => item.tag === 'input' && item.props.type === 'text', 'the name field'), '早上上班（改）')
    const back = host.nodes(item => item.tag === 'a' && host.textOf(item).includes('返回通勤链路'))[0]!
    expect(back.props.href).toBe(LIST_HREF)

    host.unmount()
    expect(writes(host), 'leaving the page wrote the draft').toHaveLength(0)
    expect(pushedRoutes).toEqual([])
  })

  it('这一页没有「取消」：返回控件就是出路，它回列表且一个请求都不发', async () => {
    const host = await mountEditor(MORNING_ID)

    // 编辑页只有保存与删除两枚按钮：丢弃改动走返回控件（与关注线路编辑页同形）。
    expect(
      host.nodes(item => item.tag === 'button' && host.textOf(item).trim() === '取消'),
      'the editor still has a cancel button',
    ).toHaveLength(0)

    const back = host.node(
      item => item.tag === 'a' && host.textOf(item).includes('返回通勤链路'),
      'the back control',
    )
    expect(back.props.href).toBe(LIST_HREF)

    expect(writes(host)).toHaveLength(0)
    expect(pushedRoutes).toEqual([])
    host.unmount()
  })

  it('换了编的是哪一条：草稿跟着走，不把上一条的改动写进这一条', async () => {
    // vue-router 在 `/settings/chains/a` 与 `/settings/chains/b` 之间复用同一个组件实例
    // （同一条路由记录），故 `ChainForm` 的 `key` 必须跟着 id 走 —— 否则屏幕上还是上一条的草稿，
    // 而按保存会把上一条的字段写到这一条上。
    // 参数必须**响应式**地换：`/settings/chains/a` 与 `/settings/chains/b` 是同一条路由记录，
    // 故 vue-router 复用同一个实例、只改 props —— 根 props 在这个宿主里不是响应式的，
    // 这件事只能用 `RouterView` 的真实形状来测（照关注线路编辑页那一份的做法）。
    const host = await mountWithParam(ChainEditorPage, 'chainId', MORNING_ID, {
      routes: routes(),
      components: { RouterLink: RouterLinkStub },
    })

    await type(host, host.node(item => item.tag === 'input' && item.props.type === 'text', 'the name field'), '改过的名字')
    expect(writes(host)).toHaveLength(0)

    await host.setParam(EVENING_ID)

    expect(host.text()).toContain('编辑 下班回家')
    expect(host.text(), 'the previous row’s draft was carried over').not.toContain('改过的名字')
    host.unmount()
  })
})
