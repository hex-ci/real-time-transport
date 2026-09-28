import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'
import FavoriteEditorPage from '../favorite-editor.vue'
import SchedulePage from '../schedule.vue'
import AnchorsPage from '../anchors.vue'
import AnchorDetailPage from '../anchor-detail.vue'
import ChainsPage from '../chains.vue'
import ChainEditorPage from '../chain-editor.vue'
import RemovalDialog from '../components/removal-dialog.vue'
import OverviewEmptyState from '@/views/overview/components/empty-state.vue'
import ChainEmptyState from '@/views/commute-chain/components/chain-empty-state.vue'
import { emptyStateOf } from '@/views/commute-chain/empty-state'

/**
 * `设置` 拆分成的四个子页面，以及拆分后必须跟上的三个应用内指针。
 *
 * 三项断言，各由**渲染出的东西**而非源码所说守住：
 *
 *  - 每个子页面都是自己的页面：一个真实 `<h2>`，以及一个应用内「返回设置」控件。该返回控件不是浏览器的
 *    返回手势，故必须真实存在；其无障碍名必须**包含**其可见文字（WCAG 2.5.3 名称中标签）——用更短短语
 *    替换「返回设置」的名字，是语音控制用户无法念出调用的控件。本仓库的先例是 `chain-leg-fields.vue` 的
 *    「删除该段（第 1 段）」：可见文字在前，补充在括号里，且 `aria-label` 绝不重复它已渲染的标题。
 *  - 本轮改动提到院内 44px 的四个控件：折叠的通勤时段触发器、该行的 取消关注，以及移除对话框里的两个控件。
 *    该断言只覆盖这四个：同一源码里仍有本轮未动的 44px 以下目标（它们是浏览器侧事实，各自满足 WCAG 2.5.8 的
 *    24×24 下限），而它们都不是那个院内数字。
 *  - 三个应用内指针现在点名它们所关于的**域**，而非整个 `设置`：首页空态关乎关注线路，两个链路指针关乎锚点
 *    ——除了那个直到录制界面存在才变得诚实的，它关乎链路页。`设置` 自己的导航项仍指向索引（`/settings`）
 *    且未被触碰；那是注册表守卫的事。
 *
 * 每个页面应答的 URL 是关于路由表的事实，该表钉在 `settings-index.test.ts`（结构断言）。此处什么都加载不了路径。
 */

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 这些页面发出的读取，全部作答。 */
function routes(options: { favourites?: 'ok' | 'fail', settings?: 'ok' | 'fail' | 'unset', chains?: Array<Record<string, unknown>> } = {}): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => (options.favourites === 'fail'
      ? { success: false, error: '读取失败' }
      : { success: true, data: [{ id: 'fav-1', userId: 'default_user', cityCode: '027', lineId: 'bus_027_1', lineName: '快线 1 路', preferredDirection: 0, displayOrder: 0 }] })],
    // 答案携带 `settingsState`，与端点一致：已存的行与发现没有行的读取是不同的答案，
    // 状态说明这是哪一个。
    [/\/api\/transit\/settings/, () => {
      if (options.settings === 'fail') return { success: false, error: '读取失败' }
      if (options.settings === 'unset') return { success: true, settingsState: 'unset', data: null }
      return {
        success: true,
        settingsState: 'stored',
        data: { morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00', eveningEnd: '22:00', homeLat: 39.9, homeLng: 116.4 },
      }
    }],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: { lineId: 'bus_027_1', direction: 0, directionName: '开往建国门', cityCode: '027', stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }] } })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: options.chains ?? [] })],
  ]
}

/** 挂载拆分出的任一页面，并让 `RouterLink` 触达宿主。 */
async function mountPage(
  component: Parameters<typeof mountComponent>[0],
  props: Record<string, unknown> = {},
  options: Parameters<typeof routes>[0] = {},
): Promise<MountedHost> {
  const host = await mountComponent(component, {
    routes: routes(options),
    props,
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 某控件的无障碍名：有 `aria-label` 时用它，否则用它自己的文本。 */
function accessibleName(host: MountedHost, node: HostElement): string {
  const label = node.props['aria-label']
  return label === undefined ? host.textOf(node) : String(label)
}

/** 子页面的返回控件（可见文字为 `words`），或一个点名缺失之物的抛错。 */
function backControl(host: MountedHost, words: string): HostElement {
  const found = host.nodes(item => item.tag === 'a' && host.textOf(item).includes(words))[0]
  if (!found) throw new Error(`the page rendered no 「${words}」 control`)
  return found
}

/** 文本恰为给定文字的控件，或一个抛错。 */
function controlWith(host: MountedHost, words: string): HostElement {
  const found = host.nodes(item => (item.tag === 'a' || item.tag === 'button') && host.textOf(item).trim() === words)[0]
  if (!found) throw new Error(`the page rendered no 「${words}」 control`)
  return found
}

/**
 * 通勤时段卡片折叠的触发器，其两行是卡片的标题**与**摘要。
 *
 * 按携带标题的 `button` 定位：触发器就是卡片折叠成的东西，故其文本**即**用户读到的折叠摘要
 * ——也是 44px 规则所测量的同一元素。
 */
function collapsedHoursTrigger(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).includes('通勤时段'),
    'the collapsed 通勤时段 trigger',
  )
}

/**
 * 院内触摸目标规则，按类所陈述。
 */
const HOUSE_TOUCH_TARGET = /min-h-\[44px\]|min-h-11|h-11/

/**
 * 一条自身详情同时携带**两个**方向的关注线路。
 *
 * `reverseLineId` 是使公交线路双向的东西（`favoriteIsBidirectional`），而单方向线路把其方向渲染为文本
 * 而非选择器——故该夹具是方向单选存在可被测量的唯一形状。
 */
const TWO_WAY_FAVOURITE = {
  id: 'fav-2',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  reverseLineId: 'bus_027_1_rev',
  lineName: '快线 1 路',
  preferredDirection: 0,
  displayOrder: 0,
}

/** 携带站点的详情，使展开的行提供一个可选的上车点。 */
const TWO_WAY_DETAIL = {
  lineId: 'bus_027_1',
  direction: 0,
  directionName: '开往建国门',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '东大桥', order: 1, interchanges: [] },
    { id: 's2', name: '建国门', order: 2, interchanges: [] },
  ],
}

/**
 * 展开行的方向单选。
 *
 * 一个筛选 helper，故调用方先欠一个非空断言：什么都没匹配到的列表会让下面的循环白通过
 * ——正如两个 40px 控件曾满足本规则那样。
 */
function directionRadios(host: MountedHost): HostElement[] {
  return host.nodes(item => item.props.role === 'radio')
}

/**
 * 一条已存链路，供编辑页那一帧用：编辑页的标题点名它正在编的那一条。
 *
 * 参数不合法时**不发明默认值**（那条断言在 `commute-chain-editor.test.ts` 里），故这里给的是
 * 一个真的在列表里的 id —— 这一页的两半（渲染某一条 / 说它不存在）各由自己的测试守。
 */
const STORED_CHAIN: Record<string, unknown> = {
  id: 'chain-1',
  userId: 'default_user',
  name: '早上上班',
  purpose: 'morning',
  displayOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  legs: [{
    seq: 0,
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    cityCode: '027',
    boardStationName: '东大桥',
    boardStationOrder: 1,
    alightStationName: '建国门',
    alightStationOrder: 2,
    transferExtraMinutes: null,
    connectionMode: null,
  }],
}

const PAGES = [
  { name: 'lines', component: LinesPage, heading: '关注线路', props: {} },
  { name: 'schedule', component: SchedulePage, heading: '通勤时段', props: {} },
  { name: 'anchors', component: AnchorsPage, heading: '位置锚点', props: {} },
  // 每个锚点自己的页面也欠同一条：真 `<h2>` 与一个应用内的返回控件。它们退到**锚点列表**
  // 而不是设置索引 —— 从「家」退出去跳过锚点列表那一层，用户就回不到刚才在挑的那个锚点。
  { name: 'anchor-detail(home)', component: AnchorDetailPage, heading: '设置「家」', props: { anchor: 'home' }, back: { href: '/settings/anchors', words: '返回位置锚点' } },
  { name: 'anchor-detail(work)', component: AnchorDetailPage, heading: '设置「公司」', props: { anchor: 'work' }, back: { href: '/settings/anchors', words: '返回位置锚点' } },
  { name: 'chains', component: ChainsPage, heading: '通勤链路', props: {} },
  // 链路的录入与编辑在它自己的两页上，且两页都退到**链路列表**（不是设置索引）——
  // 从一条链路退出去跳过列表那一层，用户就回不到他刚才在编的那一条所在的那一屏。
  { name: 'chain-editor(new)', component: ChainEditorPage, heading: '新增链路', props: { chainId: null }, back: { href: '/settings/chains', words: '返回通勤链路' } },
  { name: 'chain-editor(chain)', component: ChainEditorPage, heading: '编辑 早上上班', props: { chainId: 'chain-1' }, back: { href: '/settings/chains', words: '返回通勤链路' }, chains: [STORED_CHAIN] },
  // 一条关注线路自己的页面：它退到**关注线路列表**，不是设置索引 —— 从这一条退出去跳过列表
  // 那一层，用户就回不到他刚才在编的那一条所在的那一屏。
  { name: 'favorite-editor', component: FavoriteEditorPage, heading: '编辑', props: { favoriteId: 'fav-1' }, back: { href: '/settings/lines', words: '返回关注线路' } },
]

describe('子页面各自成页：真正的 h2、应用内的返回控件', () => {
  for (const page of PAGES) {
    const back = page.back ?? { href: '/settings', words: '返回设置' }
    it(`${page.name} 页有自己的 h2，并带一个指向 ${back.href} 的「${back.words}」`, async () => {
      const host = await mountPage(page.component, page.props, { chains: page.chains })

      const heading = host.node(item => item.tag === 'h2', `${page.name}'s own heading`)
      expect(host.textOf(heading)).toContain(page.heading)

      const control = backControl(host, back.words)
      expect(control.props.href).toBe(back.href)
      // 名字里包含可见文案：可见的是哪几个字，能念出来的也必须是哪几个字。
      expect(accessibleName(host, control)).toContain(back.words)
      expect(accessibleName(host, control)).toContain(host.textOf(control).trim())
      // 可见文案只写一次：不在 aria-label 里重复一遍标题。
      expect(control.props['aria-label']).toBeUndefined()
      expect(String(control.props.class), `${page.name}'s back control is smaller than 44px`).toMatch(HOUSE_TOUCH_TARGET)
      host.unmount()
    })
  }

  it('每一页渲染的是它自己那一域的内容，不是把四个域又堆在一起', async () => {
    const lines = await mountPage(LinesPage)
    expect(lines.text()).toContain('搜索')
    expect(lines.text()).not.toContain('新增链路')
    lines.unmount()

    const editor = await mountPage(FavoriteEditorPage, { favoriteId: 'fav-1' })
    expect(editor.text()).toContain('编辑')
    expect(editor.text(), 'the editor renders another domain').not.toContain('新增链路')
    editor.unmount()

    const schedule = await mountPage(SchedulePage)
    expect(schedule.text()).toContain('通勤时段')
    expect(schedule.text()).not.toContain('搜索')
    schedule.unmount()

    const anchors = await mountPage(AnchorsPage)
    expect(anchors.text()).toContain('家与公司是步行到站台的起点')
    expect(anchors.text()).not.toContain('新增链路')
    anchors.unmount()

    const anchorDetail = await mountPage(AnchorDetailPage, { anchor: 'home' })
    expect(anchorDetail.text()).toContain('设置「家」')
    expect(anchorDetail.text(), 'the anchor page renders another domain').not.toContain('新增链路')
    anchorDetail.unmount()

    const anchorWork = await mountPage(AnchorDetailPage, { anchor: 'work' })
    expect(anchorWork.text()).toContain('设置「公司」')
    anchorWork.unmount()

    const chains = await mountPage(ChainsPage)
    expect(chains.text()).toContain('新增链路')
    expect(chains.text()).not.toContain('用当前位置设置')
    // 列表页只放列表与它的动作：表单搬到了编辑页上，故这里一个输入框都没有。
    expect(chains.nodes(item => item.tag === 'input'), 'the list page still carries the form').toHaveLength(0)
    chains.unmount()

    const chainEditor = await mountPage(ChainEditorPage, { chainId: null })
    expect(chainEditor.text()).toContain('新增链路')
    expect(chainEditor.text(), 'the chain editor renders another domain').not.toContain('搜索关注')
    chainEditor.unmount()
  })
})

describe('44px 房规：这次量出来低于它的四个控件都补上了', () => {
  it('折叠态的通勤时段按钮：它现在也是 44px', async () => {
    const host = await mountPage(SchedulePage)

    const trigger = collapsedHoursTrigger(host)
    expect(String(trigger.props.class), 'the collapsed trigger is smaller than the house touch target')
      .toMatch(HOUSE_TOUCH_TARGET)
    host.unmount()
  })

  it('取消关注：编辑页底部的那个控件，以及对话框里的两个', async () => {
    const host = await mountPage(FavoriteEditorPage, { favoriteId: 'fav-1' })

    // 取消关注现在住在编辑页里（列表行上不再有它），且不藏在任何展开态之后。
    const unfollow = controlWith(host, '取消关注')
    expect(String(unfollow.props.class), '取消关注 is smaller than the house touch target').toMatch(HOUSE_TOUCH_TARGET)
    host.unmount()

    // 对话框的两个控件，以上流程把它们置于的状态挂载。
    const dialog = await mountPage(RemovalDialog, { open: true, lineName: '快线 1 路', removing: false, error: null })
    for (const words of ['保留', '确认取消关注']) {
      const control = controlWith(dialog, words)
      expect(String(control.props.class), `${words} is smaller than the house touch target`).toMatch(HOUSE_TOUCH_TARGET)
    }
    dialog.unmount()
  })

  it('编辑页的方向单选也是 44px（这一处此前是 36px）', async () => {
    // 方向药丸是本屏仍被测量为低于院内数字的那一个控件：`min-h-[36px]`，它满足 WCAG 2.5.8 的 24×24
    // 又不是 44。双向线路是唯一渲染它们的形状（单方向线路把方向显示为文本），
    // 故夹具是一条带 `reverseLineId` 的关注线路。
    const host = await mountComponent(FavoriteEditorPage, {
      props: { favoriteId: TWO_WAY_FAVOURITE.id },
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [TWO_WAY_FAVOURITE] })],
        [/\/api\/transit\/lines\//, () => ({ success: true, data: TWO_WAY_DETAIL })],
        [/\/api\/transit\/settings/, () => ({ success: true, data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    const radios = directionRadios(host)
    // 非空在前，因为这个列表来自筛选 helper：空列表会让下面的循环在什么都没测量时通过。
    // 两个用途 × 两个方向即该页显示的四个药丸。
    expect(radios.length, 'the editor rendered no direction radio to measure').toBe(4)
    for (const radio of radios) {
      expect(String(radio.props.class), `a direction radio is smaller than the house touch target: ${String(radio.props.class)}`)
        .toMatch(HOUSE_TOUCH_TARGET)
    }
    host.unmount()
  })

  it('列表行的拖拽手柄 ≥44px，且行内没有编辑控件（组合框一个都没有）', async () => {
    // 展开退休之后，列表行只剩「手柄 + 链接」两件：整行是进编辑页的链接，行内不放编辑器。
    // 故这一条同时钉两件事：手柄的触控目标，以及行内一个组合框都没有。
    const host = await mountComponent(LinesPage, {
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [TWO_WAY_FAVOURITE] })],
        [/\/api\/transit\/lines\//, () => ({ success: true, data: TWO_WAY_DETAIL })],
        [/\/api\/transit\/settings/, () => ({ success: true, data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    expect(String(handle.props.class), 'the drag handle is smaller than the house touch target').toMatch(HOUSE_TOUCH_TARGET)
    expect(String(handle.props.class), 'the drag handle is narrower than a finger').toMatch(/w-11|w-\[44px\]|min-w-11|min-w-\[44px\]/)

    expect(directionRadios(host), 'the list row still carries the editor’s controls').toHaveLength(0)
    expect(
      host.nodes(item => item.tag === 'button' && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox')),
      'the list row still carries a stop picker',
    ).toHaveLength(0)
    host.unmount()
  })
})

/**
 * 通勤时段子页**自己**的折叠摘要，在此守住，而非只经索引行。
 *
 * 两者按设计共用一个措辞函数（`index-summary.ts` 的 `hoursText`），故同一存储时刻不会有两种读法——
 * 但**读取**是本页自己的：本页自己取 `/api/transit/settings` 并自己决定三种状态。别的都守不住这一点：
 * 此处一个恢复 `06:30–11:30` 的 `catch` 会让本页用用户自己配置的衣服陈述默认值，而索引行的测试会保持绿，
 * 因为它们挂载的是另一个文件。
 */
describe('通勤时段子页的折叠摘要自己说三态', () => {
  /** 折叠摘要自己的措辞，逐字。 */
  const HOURS_SUMMARY = '06:30–11:30 · 17:00–22:00'

  it('读到：摘要就是那四个已保存的时刻', async () => {
    const host = await mountPage(SchedulePage)

    expect(host.textOf(collapsedHoursTrigger(host))).toContain(HOURS_SUMMARY)
    host.unmount()
  })

  it('读失败：摘要说「未读到」，不给默认的 06:30–11:30', async () => {
    const host = await mountPage(SchedulePage, {}, { settings: 'fail' })

    const summary = host.textOf(collapsedHoursTrigger(host))
    expect(summary).toContain('未读到')
    expect(summary, 'the default hours look like the user’s own configuration').not.toContain('06:30')
    expect(summary).not.toContain('17:00')
    host.unmount()
  })

  it('没存过：摘要说「未设置」，也不是那个默认时段', async () => {
    // 本页上的第四种状态：读取作答且没找到行。它曾由内置窗口作答，而本摘要把它印成用户自己的时刻
    // ——比失败离真相更远一步，因为什么都没失败。
    const host = await mountPage(SchedulePage, {}, { settings: 'unset' })

    const summary = host.textOf(collapsedHoursTrigger(host))
    expect(summary).toContain('未设置')
    expect(summary, 'the built-in window is printed for a user who never saved one').not.toContain('06:30')
    expect(summary).not.toContain('17:00')
    expect(summary).not.toContain('未读到')
    host.unmount()
  })
})

describe('设置拆分后，应用内的指向各自落在那一域的那一页', () => {
  it('首页空态：去搜索并关注线路 → /settings/lines', async () => {
    const host = await mountPage(OverviewEmptyState, { cityName: '北京市' })

    const link = controlWith(host, '去搜索并关注线路')
    expect(link.props.href).toBe('/settings/lines')
    host.unmount()
  })

  it('链路空态的锚点原因 → /settings/anchors，文案不变', async () => {
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: false }),
    })

    expect(host.text()).toContain('未设置「家」位置')
    expect(controlWith(host, '去设置起点位置').props.href).toBe('/settings/anchors')
    host.unmount()
  })

  it('链路空态的「还没有录入」原因 → /settings/chains：录入界面存在了，这条指向才诚实', async () => {
    // 本条目在构建尚无录制界面时不存在（那时空态不承诺任何可供性，这是对的）。`/settings/chains` 是
    // 记录链路之处，故用户可行动的成因现在有了屏幕——而上面的锚点成因保留自己的屏幕，而非被这一个替换。
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: true }),
    })

    expect(controlWith(host, '去设置里录入链路').props.href).toBe('/settings/chains')
    host.unmount()
  })

  it('链路空态的锚点读不到：仍然给录入入口，且一个字都不说锚点', async () => {
    // 未读的锚点行不作任何方向的断言，而录制界面不是对它的断言：链接通向链路页，绝不通向锚点行。
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: null }),
    })

    expect(host.text()).not.toContain('未设置')
    expect(controlWith(host, '去设置里录入链路').props.href).toBe('/settings/chains')
    host.unmount()
  })
})

/**
 * `设置` 的索引行最先学到本规则，它所指向的页面同样欠它：**失败**的关注线路读取留下一个空数组，
 * 把该数组渲染成「暂无关注线路」会告诉用户他们什么都没关注，而真相是「没读到」。措辞不同因为事实不同
 * ——一个点名空集，另一个点名没人完成的读取——且只有后者有能改变答案的重试。
 */
describe('关注线路读不到时，说「未读到」，不说「没有」', () => {
  it('关注线路页：读失败时说未读到并给重试，不给「暂无关注线路」，也不报 0 条', async () => {
    const host = await mountPage(LinesPage, {}, { favourites: 'fail' })

    const text = host.text()
    expect(text, 'an unreadable list must not be worded as an empty one').not.toContain('暂无关注线路')
    expect(text, 'a count taken from an unreadable list is a number nobody obtained').not.toContain('(0)')
    expect(text).toContain('未读到关注线路')
    expect(controlWith(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('关注线路页：按重试，读到了就把列表显示出来，读失败的那句话消失', async () => {
    const host = await mountPage(LinesPage, {}, { favourites: 'fail' })
    expect(host.text()).toContain('未读到关注线路')

    host.server.on(/\/api\/transit\/favorites$/, () => ({
      success: true,
      data: [{ id: 'fav-1', userId: 'default_user', cityCode: '027', lineId: 'bus_027_1', lineName: '快线 1 路', preferredDirection: 0, displayOrder: 0 }],
    }))
    await press(host, controlWith(host, '重试'))

    expect(host.text()).toContain('快线 1 路')
    expect(host.text()).not.toContain('未读到关注线路')
    host.unmount()
  })

  it('通勤链路页的录入：读失败时说未读到，不给「还没有关注线路」这句关于存储行的话', async () => {
    // 链路编辑器的前提是关注集，故失败的读取让它没有线路可提供——
    // 这与「还没有关注线路」**不是**同一个事实。表单现在住在新建页上，故驱动方式随之改到那一页
    // （`chain-editor.vue` 的 `linesRead` 原样来自 `line-stops.ts`，与列表行时代同一个判断）。
    const host = await mountPage(ChainEditorPage, { chainId: null }, { favourites: 'fail' })

    expect(host.text()).not.toContain('还没有关注线路')
    expect(host.text()).toContain('未读到关注线路')
    host.unmount()
  })
})
