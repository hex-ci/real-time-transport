import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import OverviewPage from '../../../views/overview/index.vue'

/**
 * 关注线路页的顶部信息区：**两块互斥的工具栏**，各自持有自己那一档的样子。
 *
 * 这一版把刷新读数从两档里撤掉了：一次按下的结局由全局提示说，屏幕上不再有「最后更新 …」那一行。
 * 宽屏那一块（`hidden md:block`）是卡片内的**一行**：模式页签在左，定位与刷新两枚 44 图标按钮贴着
 * 卡片右内边。窄屏那一块（`md:hidden`）是**一行**：模式容器吃满余量、两枚图标贴在它后面 —— 故分段项
 * 不带图标（带图标时 375 装不下这一行）。两块各自完整，没有一处靠断点前缀替另一档拼行。
 *
 * 「高度」与「一行装不装得下」在本装置里是**算出来的数**：宿主没有排版，故元素要的是哪一档
 * （本仓的 `h-N` 阶梯，`h-11` 即 44px）以及一行放不放得下（每个子元素的最小宽度加间距比上可用宽度，
 * 12px 下一个汉字占 12px）都在此处按声明算。真正的像素测量在浏览器侧做。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

const REFRESH_LABEL = '刷新最新车况'
const LOCATE_LABEL = '定位最近站'
const GONE_BLURB = '点击卡片查看该线路的在途车辆与到站时刻'
const GONE_WORDS = ['早通勤', '晚通勤', '非通勤']
const CITY = '北京'
/** 撤掉那一行读数之后，这一串也不该再出现在两档工具栏里。 */
const GONE_READING = '最后更新'
/** 从未取到读数的库存措辞：它只属于 store，本页不再渲染它的那一半。 */
const STORE_ONLY_WORDING = '尚未获取到数据'

const BREAKPOINT = 768
const NARROW_WIDTH = 375
const WIDE_WIDTH = 1280
/** 最窄的那个屏幕：这一行在那里允许换行，但一个字都不许被裁掉。 */
const NARROWEST_WIDTH = 320

/** 本仓的控件高度：房规的触摸目标 44，也是容器与它里面那一项共同的高度。 */
const CONTROL_HEIGHT = 44
/** 一行工具栏允许的高度：一个 44 控件加上它自己的描边余量。 */
const ROW_MAX_HEIGHT = 46

/**
 * 375 上工具栏那一行可用的宽度：信息块自己的左右内边距与描边之后剩下的。
 * 取值来自本仓的量测（带图标的分段要 ≈372，而 375 上只有 331），故「去掉图标的这一行装得下」
 * 是一件可算的事，而不只是「类名里没有 `flex-wrap`」。
 */
const AVAILABLE_AT_375 = 331

/** 夹具报告为取得的瞬间。2023-11-14T22:13:20Z。 */
const OBTAINED_AT = 1_700_000_000_000

/** 一条关注线路，早上那站已选好 —— 于是本屏真的有一行可重读，刷新按钮才按得下。 */
function favourite(): Record<string, unknown> {
  return {
    id: 'fav-1',
    userId: 'default_user',
    cityCode: '027',
    lineId: 'bus_027_1',
    reverseLineId: 'bus_027_2',
    lineName: '快线 1 路',
    preferredDirection: 0,
    morningDirection: 0,
    morningStopName: '东大桥',
    morningStopOrder: 1,
    displayOrder: 0,
  }
}

const LINE_DETAIL = {
  lineId: 'bus_027_1',
  direction: 0,
  directionName: '开往建国门',
  cityCode: '027',
  type: 'bus',
  stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }],
}

/** 一次成功的刷新：它自己取到的那个时刻，以及仍关着的窗口。 */
function refreshOk(): unknown {
  return {
    success: true,
    data: {
      dataClass: 'live',
      throttled: false,
      lastUpdatedAt: OBTAINED_AT,
      nextAllowedAt: OBTAINED_AT + 18_000,
      retryAfterSeconds: 18,
      lines: [{
        lineId: 'bus_027_1',
        direction: 0,
        lastUpdatedAt: OBTAINED_AT,
        dataSource: 'chelaile',
        isDegraded: false,
      }],
    },
  }
}

/** 页面挂载时发出的读取；只有测试关心的那一路由测试控制。 */
function routes(refresh: () => unknown, profile?: unknown, favourites?: () => unknown): Route[] {
  return [
    [/\/api\/transit\/favorites$/, favourites ?? (() => ({ success: true, data: [favourite()] }))],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/commute-profile/, () => profile ?? ({ success: true, data: { mode: 'work', description: '早通勤', windowState: 'stored' } })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/refresh$/, refresh],
    [/\/api\/transit\/lines\/[^/?]+\?/, () => ({ success: true, data: LINE_DETAIL })],
    [/\/arrivals\?/, () => ({
      success: true,
      data: {
        arrivals: [],
        operatingStatus: { state: 'operating', firstDeparture: '05:16', lastDeparture: '23:06' },
        reference: null,
      },
    })],
  ]
}

async function mountOverview(
  options: { refresh?: () => unknown, profile?: unknown, favourites?: () => unknown } = {},
): Promise<MountedHost> {
  const host = await mountComponent(OverviewPage, {
    routes: routes(options.refresh ?? refreshOk, options.profile, options.favourites),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 一份 `commute-profile` 答案：`windowState` 决定它说的是「没设过」还是「存过」。 */
function profile(windowState: string): unknown {
  return { success: true, data: { mode: 'auto', description: '未设置通勤时段', windowState } }
}

/**
 * 那一行声明出来的宽度下限。
 *
 * 类名存在不等于下限存在：`min-w-max-content` 在主题里不是任何一档，不生成规则，
 * 等于没有下限 —— 于是容器被压到比四个档位还窄。故断言分两类：真的那一档必须在，假的那个不许回来。
 */
function declaredMinWidths(row: HostElement): string[] {
  return [modeBox(row), ...modeItems(row)]
    .flatMap(node => tokens(node).filter(token => token.startsWith('min-w-')))
}

/** 一个节点子树里的每个节点，按文档顺序。宿主节点带 `children`，故这里自己走一遍。 */
function descendants(node: HostElement): HostElement[] {
  const out: HostElement[] = []
  const visit = (current: HostElement): void => {
    for (const child of current.children) {
      out.push(child)
      visit(child)
    }
  }
  visit(node)
  return out
}

/** 一个节点自己的整棵子树，含自身。 */
function subtree(node: HostElement): HostElement[] {
  return [node, ...descendants(node)]
}

/** 一个节点的类名，按词切开 —— 断言要的是「有这一项」，不是「字符串里出现过」。 */
function tokens(node: HostElement | string): string[] {
  const classes = typeof node === 'string' ? node : String(node.props.class ?? '')
  return classes.split(/\s+/).filter(Boolean)
}

/** 子节点里的元素（注释与文本节点不是元素）。 */
function elements(node: HostElement): HostElement[] {
  return node.children.filter(child => !child.tag.startsWith('#'))
}

/**
 * 一个元素子树里声明的最大高度：刷新那一枚装在页面给的一个外壳里，那一档写在按钮自己身上。
 * 故「这一行有多高」要往下看一层，而不是只看行的直接子节点。
 */
function controlHeightOf(node: HostElement): number {
  return Math.max(...subtree(node).map(child => heightOf(child) ?? 0))
}

/**
 * 这一行的高度（px）：横排是其中最高的那一个（各项并排），竖排（`flex-col`）是它们之和（各项叠起来）。
 * 这一行必须是横排的 —— 竖排的「一行」只是名字，屏幕上它是三行。
 */
function rowHeightOf(row: HostElement): number {
  const heights = elements(row).map(controlHeightOf)
  if (!tokens(row).includes('flex-col')) return Math.max(...heights)
  return heights.reduce((sum, height) => sum + height, 0) + gapOf(row) * (heights.length - 1)
}

/**
 * 一个元素在给定宽度下是否被 CSS 藏起来。
 *
 * 「按断点成立」不能停在「类名里有 md:」上：`hidden md:block` 在 375 与 1280 上的答案相反。故这里把
 * 本仓那两种写法按宽度求值 —— `hidden`（窄屏藏；宽屏由同一元素的 `md:` 显示项翻回来）与
 * `md:hidden`（宽屏藏）。本装置背后没有样式引擎，故这条规则只认这两种写法。
 */
function hiddenAt(node: HostElement, width: number): boolean {
  for (let current: HostElement | null = node; current; current = current.parent) {
    const list = tokens(current)
    if (width >= BREAKPOINT) {
      if (list.includes('md:hidden')) return true
      continue
    }
    if (list.includes('hidden')) return true
  }
  return false
}

/**
 * 一个元素要的高度（px），取自它自己那一档：`h-11` / `min-h-11` 是 44。
 *
 * 宿主没有排版，故「量到的」是它声明的档位；真正的盒子高度由浏览器量。断言因此仍是数字 ——
 * 一档改了它就红。
 */
function heightOf(node: HostElement): number | null {
  const scales = tokens(node)
    .map(token => /^(?:min-)?h-(\d+)$/.exec(token))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => Number(match[1]) * 4)
  return scales.length > 0 ? Math.max(...scales) : null
}

/** 一个元素声明的水平内边距，按本仓的 `p-N` / `px-N` 阶梯（4px 一档）。 */
function paddingXOf(node: HostElement): number {
  const list = tokens(node)
  const horizontal = list.map(token => /^px-([\d.]+)$/.exec(token)).find(match => match !== null)
  const all = list.map(token => /^p-([\d.]+)$/.exec(token)).find(match => match !== null)
  return Number(horizontal?.[1] ?? all?.[1] ?? 0) * 4
}

/** 一个元素声明的子元素间距（`gap-N`）。 */
function gapOf(node: HostElement): number {
  const found = tokens(node).map(token => /^gap-([\d.]+)$/.exec(token)).find(match => match !== null)
  return Number(found?.[1] ?? 0) * 4
}

/** 一个元素声明的左右描边：`border` 是一侧 1px。 */
function borderXOf(node: HostElement): number {
  return tokens(node).includes('border') ? 2 : 0
}

/** 12px 下一段文字的宽度：本仓这一族标签全是汉字，一个汉字占它自己那一个字号。 */
function textWidthOf(text: string): number {
  return [...text.replace(/\s+/g, '')].length * 12
}

/** 一枚纯图标按钮的边长：本仓的 44 触摸目标。 */
const ICON_BUTTON = 44

/**
 * 一个元素的最小内容宽度（px）：不换行也不截断时它至少要占的地方。
 *
 * 一行装不装得下由此判定 —— 把每个子元素的最小宽度与它们之间的间距加起来，与那一行可用的宽度比。
 * 这比「类名里有 `flex-1`」多一步：它给的是一个数。
 */
function minWidthOf(node: HostElement, host: MountedHost): number {
  if (tokens(node).includes('h-11') && tokens(node).includes('w-11')) return ICON_BUTTON
  const children = elements(node)
  const inner = children.length === 0
    ? textWidthOf(host.textOf(node))
    : tokens(node).includes('flex')
      ? children.reduce((sum, child) => sum + minWidthOf(child, host), 0) + gapOf(node) * (children.length - 1)
      : Math.max(...children.map(child => minWidthOf(child, host)))
  return inner + 2 * paddingXOf(node) + borderXOf(node)
}

/**
 * 一行在给定宽度下的两端距离：最左的子元素离行的左内边多远，最右的离右内边多远。
 *
 * 宿主没有排版，故这里按 flex 行的规则算：`ms-auto`（或 `ml-auto`）之前的子元素贴左内边（左距 0），
 * 它之后的全部被余量推到右内边（右距 0）；行里一个自动外边距都没有时，右端量不出来（`null`）——
 * 那就是「左对齐的一行」，不是「贴着右内边的一行」。
 */
function edgesOf(row: HostElement): { left: number, right: number | null } {
  const children = elements(row)
  const auto = children.findIndex(child => tokens(child).some(token => token === 'ms-auto' || token === 'ml-auto'))
  if (auto === -1) return { left: 0, right: null }
  // 自动外边距吃掉行里所有的余量，故从带它的那个子元素起到行尾都贴着右内边。
  return { left: 0, right: 0 }
}

/** 那一行里带自动外边距的那个子元素，或 `null`。 */
function pushedRight(row: HostElement): HostElement | null {
  return elements(row).find(child => tokens(child).some(token => token === 'ms-auto' || token === 'ml-auto')) ?? null
}

/** 两块排布各自的根。 */
function narrowBlock(host: MountedHost): HostElement {
  return host.node(node => node.props['data-info-area'] === 'narrow', 'the narrow info block')
}

function wideBlock(host: MountedHost): HostElement {
  return host.node(node => node.props['data-info-area'] === 'wide', 'the wide info block')
}

/** 各档那一行控件。 */
function toolbar(host: MountedHost, which: 'narrow' | 'wide'): HostElement {
  return host.node(node => node.props['data-toolbar'] === which, `the ${which} toolbar row`)
}

/** 一档里那个模式容器（四项等分的那个盒子）。 */
function modeBox(row: HostElement): HostElement {
  const box = elements(row).find(node => tokens(node).includes('h-11') && tokens(node).includes('rounded-xl'))
  if (!box) throw new Error('the toolbar row renders no mode container')
  return box
}

function modeItems(row: HostElement): HostElement[] {
  return elements(modeBox(row))
}

/**
 * 容器里那一项的两个数：它要的高度，以及它自己的盒顶相对容器外顶边的偏移。
 *
 * 宿主没有排版，但这一族控件的盒子写在声明里 —— `h-11` 是 44、`border` 是 1 —— 故「项与容器同高、
 * 且与相邻那枚 44 图标按钮齐平」是可算的数：偏移 0 就是上下边缘同一条线。
 */
function itemBoxIn(container: HostElement, item: HostElement): { height: number, offset: number } {
  const box = tokens(container)
  const border = box.includes('border') ? 1 : 0
  const padding = box.includes('p-1') ? 4 : 0
  const content = (heightOf(container) ?? 0) - 2 * border - 2 * padding
  const height = heightOf(item) ?? 0
  return { height, offset: border + padding + (content - height) / 2 }
}

/** 一档里某一枚动作按钮：按可访问名找那一行里的它。 */
function actionIn(row: HostElement, label: string): HostElement {
  const found = subtree(row).find(node => node.tag === 'button' && node.props['aria-label'] === label)
  if (!found) throw new Error(`this toolbar row renders no ${label}`)
  return found
}

/** 全页上那一行读数（两半的一个 id）：撤掉之后一个都不该在。 */
function readings(host: MountedHost): HostElement[] {
  return host.nodes((node: HostElement) => typeof node.props.id === 'string' && node.props.id.endsWith('refresh-freshness'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('信息区是两块互斥的工具栏', () => {
  it('两块各一份，各自只在自己那一档出现', async () => {
    const host = await mountOverview()

    const narrow = narrowBlock(host)
    const wide = wideBlock(host)
    // 窄屏那一块在文档里靠前：e2e 量高度的就是页面的第一块。
    expect(descendants(host.root).indexOf(narrow)).toBeLessThan(descendants(host.root).indexOf(wide))

    expect(hiddenAt(narrow, NARROW_WIDTH)).toBe(false)
    expect(hiddenAt(narrow, WIDE_WIDTH)).toBe(true)
    expect(hiddenAt(wide, NARROW_WIDTH)).toBe(true)
    expect(hiddenAt(wide, WIDE_WIDTH)).toBe(false)
    host.unmount()
  })
})

describe('刷新读数从两档工具栏里撤掉', () => {
  it('两档工具栏的字里都没有「最后更新」，全页也没有那一行读数', async () => {
    const host = await mountOverview()

    // 只断言工具栏内：卡片自己带的时间与本块无关。
    for (const which of ['narrow', 'wide'] as const) {
      const text = host.textOf(toolbar(host, which))
      expect(text, `${which} still prints a reading`).not.toContain(GONE_READING)
      expect(text, `${which} still prints the store wording for a reading it has not got`).not.toContain(STORE_ONLY_WORDING)
    }
    // 那一行是两半之间唯一的约定，故它自己也不该在：没有一半，id 就没有对方可描述。
    expect(readings(host), 'a reading half is still rendered somewhere').toHaveLength(0)
    host.unmount()
  })

  it('两枚刷新按钮仍带着本页给它们的可访问名，也仍不描述任何一处虚空', async () => {
    const host = await mountOverview()

    for (const which of ['narrow', 'wide'] as const) {
      const button = actionIn(toolbar(host, which), REFRESH_LABEL)
      expect(button.props['aria-label']).toBe(REFRESH_LABEL)
      // 屏幕上没有读数那一半了，故描述接到了虚空：这个属性必须整个不在。
      expect(button.props['aria-describedby'], `${which} describes a line that is not rendered`).toBeUndefined()
      expect(tokens(button)).toContain('h-11')
      expect(tokens(button)).toContain('w-11')
    }
    host.unmount()
  })
})

describe('宽屏：页签在左，定位与刷新贴着卡片右内边', () => {
  it('三个元素同处一行、同族高度，且这一行装得下', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'wide')

    expect(tokens(row)).toContain('flex')
    // 不换行、也不竖排：宽屏这一档正是「一行排得开」的那一档。
    expect(tokens(row)).not.toContain('flex-wrap')
    expect(tokens(row)).not.toContain('flex-col')
    expect(elements(row)).toHaveLength(3)

    const children = elements(row)
    expect(modeBox(row)).toBe(children[0])
    expect([modeBox(row), actionIn(row, LOCATE_LABEL), actionIn(row, REFRESH_LABEL)].map(heightOf))
      .toEqual([CONTROL_HEIGHT, CONTROL_HEIGHT, CONTROL_HEIGHT])
    for (const item of modeItems(row)) {
      // 容器里面的项也是这同一个 44：PC 这一档的项不是另一档的更矮版本。
      expect(itemBoxIn(modeBox(row), item)).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    }

    // 一行装得下是个数：子元素的最小宽度加间距，比这一行的可用宽度小。
    const needed = minWidthOf(row, host)
    expect(needed, 'the wide row cannot fit on one line').toBeLessThanOrEqual(WIDE_WIDTH - 2 * 24)
    host.unmount()
  })

  it('两端距离：模式容器贴左内边（0），两枚动作贴右内边（0）', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'wide')
    const children = elements(row)

    // 行里唯一的自动外边距落在**第一枚动作**上：它把余量全吃掉，故两枚动作一起停在右端。
    expect(pushedRight(row)).toBe(actionIn(row, LOCATE_LABEL))
    expect(children.at(-1)).toBe(actionIn(row, REFRESH_LABEL).parent)
    expect(edgesOf(row)).toEqual({ left: 0, right: 0 })

    // ……而左端那一个是模式页签：它自己没有自动外边距，故它从卡片左内边开始排。
    expect(tokens(children[0]!)).not.toContain('ms-auto')
    expect(children.indexOf(pushedRight(row)!)).toBe(children.length - 2)
    host.unmount()
  })
})

describe('窄屏：一行，模式容器吃满余量与两枚图标同排', () => {
  it('行高就是那一行里最高的那一个：44，不超过 46', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'narrow')
    const children = elements(row)

    // 三样东西按顺序：模式容器、定位、刷新 —— 刷新那一枚坐在一个小外壳里（与行里其他项一样不被挤压）。
    expect(children).toHaveLength(3)
    expect(children[0]).toBe(modeBox(row))
    expect(children[1]).toBe(actionIn(row, LOCATE_LABEL))
    expect(children[2]).toBe(actionIn(row, REFRESH_LABEL).parent)

    expect(rowHeightOf(row), 'the narrow toolbar row is taller than one control row').toBeLessThanOrEqual(ROW_MAX_HEIGHT)
    expect(rowHeightOf(row)).toBe(CONTROL_HEIGHT)
    host.unmount()
  })

  it('375 上装得下这一行：算出来的最小宽度不超过那一行可用的宽度', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'narrow')

    const needed = minWidthOf(row, host)
    expect(needed, 'the narrow row cannot fit on one line at 375').toBeLessThanOrEqual(AVAILABLE_AT_375)
    // 320 上余量还少 55：那里允许换行，但一个字都不许被裁掉。
    expect(tokens(row)).toContain('flex-wrap')
    for (const item of modeItems(row)) {
      expect(tokens(item), `${item.tag} truncates`).not.toContain('truncate')
      expect(tokens(item), `${item.tag} clips`).not.toContain('overflow-hidden')
    }
    // 容器自己不许被压到它的字以下：下限是它内容的最大宽度，故装不下时换行的是整行，不是字。
    // 下限必须是框架里真有的那一档：`min-w-max`（主题的 `minWidth.max` → `max-content`）。
    // `min-w-max-content` 不是任何一档 —— 它不生成规则，等于没有下限，而容器一旦没有下限就会被
    // 压到比四个档位还窄（真机上量到过：375 上被裁 55px、320 上被裁 110px）。故两个都钉。
    expect(tokens(modeBox(row))).toContain('min-w-max')
    expect(declaredMinWidths(row)).not.toContain('min-w-max-content')
    expect(hiddenAt(row, NARROWEST_WIDTH)).toBe(false)
    host.unmount()
  })

  it('提示在场时工具行仍然装得下：那一句不在工具行里，故不动它的算术', async () => {
    // 这是用户踩到的那一格：通勤时段没设过 → 提示出现 → 四个档位被压到字以下。
    // 提示若在工具行里，这一行要的地方会多出它的整句宽度；现在它在提示位，故两个 profile 下
    // 工具行要的宽度**相等** —— 这个等式就是「提示不再参与工具行的算术」的证据。
    const withoutHint = await mountOverview()
    const withHint = await mountOverview({ profile: profile('unchosen') })

    expect(minWidthOf(toolbar(withHint, 'narrow'), withHint))
      .toBe(minWidthOf(toolbar(withoutHint, 'narrow'), withoutHint))
    expect(minWidthOf(toolbar(withHint, 'narrow'), withHint)).toBeLessThanOrEqual(AVAILABLE_AT_375)

    withoutHint.unmount()
    withHint.unmount()
  })

  it('模式容器吃满余量、四项等分，且都带内容宽度的下限', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'narrow')
    const box = modeBox(row)

    expect(tokens(box)).toContain('flex-1')
    expect(tokens(box)).toContain('min-w-max')
    expect(tokens(row)).toContain('flex-wrap')

    const items = modeItems(row)
    expect(items).toHaveLength(4)
    for (const item of items) {
      expect(tokens(item)).toContain('flex-1')
      expect(tokens(item)).toContain('min-w-max')
      expect(tokens(item)).toContain('whitespace-nowrap')
      // 项与容器同高，且自己的盒顶落在容器的外顶边上 —— 与相邻那枚 44 图标按钮同一条线。
      expect(itemBoxIn(box, item)).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    }
    expect(heightOf(box)).toBe(CONTROL_HEIGHT)
    expect(itemBoxIn(box, actionIn(row, LOCATE_LABEL))).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    // 容器自己没有内边距：项与它同高，故那一圈只会是容器自己的内圈，项永远填不满它。
    expect(tokens(box)).toContain('p-0')
    // 容器自己裁的是选中项那一圈圆角：它和项同高，故裁不到字。
    expect(tokens(box)).toContain('overflow-hidden')
    host.unmount()
  })

  it('两枚动作停在模式容器后面，且贴右内边（0）', async () => {
    const host = await mountOverview()
    const row = toolbar(host, 'narrow')
    const children = elements(row)

    expect(pushedRight(row)).toBe(children[1])
    expect(edgesOf(row)).toEqual({ left: 0, right: 0 })
    expect([actionIn(row, LOCATE_LABEL), actionIn(row, REFRESH_LABEL)].map(heightOf))
      .toEqual([CONTROL_HEIGHT, CONTROL_HEIGHT])
    expect(tokens(children[1]!)).toContain('shrink-0')
    expect(tokens(children[2]!)).toContain('shrink-0')
    host.unmount()
  })
})

describe('窄屏的分段项：图标撤掉，字与可访问名照旧', () => {
  it('四项的字还是那四个词，可访问名就是它渲染出来的字', async () => {
    const host = await mountOverview()
    const items = modeItems(toolbar(host, 'narrow'))

    expect(items.map(item => host.textOf(item))).toEqual(['自动', '上班', '下班', '附近'])
    for (const item of items) {
      // 可访问名不变：名字仍来自它自己的字，没有任何一处替它另起一个名字。
      expect(item.props['aria-label']).toBeUndefined()
      // ……而每一个分段标签里都不再有图标。
      expect(item.children.filter((child: HostElement) => child.tag === 'svg'), `${host.textOf(item)} still carries an icon`).toHaveLength(0)
    }
    host.unmount()
  })

  it('PC 那一档的分段项仍带图标（撤的只是窄屏这一份）', async () => {
    const host = await mountOverview()
    const items = modeItems(toolbar(host, 'wide'))

    expect(items.map(item => host.textOf(item))).toEqual(['自动', '上班', '下班', '附近'])
    for (const item of items) {
      expect(item.children.filter((child: HostElement) => child.tag === 'svg')).toHaveLength(1)
    }
    host.unmount()
  })
})

describe('未设置通勤时段：进提示位的一句话，不是工具行里的控件', () => {
  it('两档都只在没设过时出现，且它不在工具行里、是整行 44px 的入口', async () => {
    for (const windowState of ['unset', 'unchosen']) {
      const host = await mountOverview({ profile: profile(windowState) })

      for (const which of ['narrow', 'wide'] as const) {
        const block = which === 'narrow' ? narrowBlock(host) : wideBlock(host)
        const area = subtree(block).find(node => node.props['data-prompt-area'] === which)
        expect(area, `${which} has no prompt area`).toBeTruthy()
        const hints = subtree(area!).filter(node => node.props.href === '/settings/schedule')
        expect(hints, `${which} has no hint for ${windowState}`).toHaveLength(1)

        // 它不在工具行里 —— 这是它原来被挤到字以下的位置。
        const row = toolbar(host, which)
        expect(subtree(row).some(node => host.textOf(node).includes('未设置通勤时段')),
          `${which}: the hint is back inside the toolbar row`).toBe(false)

        // 它是整行 44px 的入口，点名它自己那一页（不再是不可点的纯文字）。
        expect(tokens(hints[0]!)).toContain('min-h-11')
        expect(tokens(hints[0]!)).toContain('flex')
        expect(minWidthOf(hints[0]!, host)).toBeLessThanOrEqual(NARROWEST_WIDTH - 2 * 10)
      }
      host.unmount()
    }
  })

  it('存过通勤时段就一句都不出现', async () => {
    const host = await mountOverview({ profile: profile('stored') })

    expect(host.text()).not.toContain('未设置通勤时段')
    expect(host.nodes(node => tokens(node).includes('text-amber-400'))).toHaveLength(0)
    host.unmount()
  })
})

describe('删掉的东西一件都不回来', () => {
  it('读数、状态词、描述句与城市在两档里都没有', async () => {
    const host = await mountOverview()

    for (const which of ['narrow', 'wide'] as const) {
      const text = host.textOf(which === 'narrow' ? narrowBlock(host) : wideBlock(host))

      for (const word of GONE_WORDS) {
        expect(text, `${which} still says ${word}`).not.toContain(word)
      }
      expect(text, `${which} still prints the description sentence`).not.toContain('早通勤')
      expect(text, `${which} still prints the city`).not.toContain(CITY)
      expect(text).not.toContain(GONE_BLURB)
      expect(text, `${which} still prints a reading`).not.toContain(GONE_READING)
      // 留下的就是模式那几个词。
      expect(text).toContain('自动')
      expect(text).toContain('上班')
    }
    host.unmount()
  })

  it('没有展开/收起：全页没有开关，也没有哪一处声称自己控制了别处', async () => {
    const host = await mountOverview()

    expect(host.nodes(node => node.props['aria-expanded'] !== undefined)).toHaveLength(0)
    expect(host.nodes(node => node.props['aria-controls'] !== undefined)).toHaveLength(0)
    expect(host.text()).not.toContain('展开详情')
    expect(host.text()).not.toContain('收起详情')
    // 收起那一枚曾经是纯图标按钮，故它的名字是唯一可查的痕迹。
    expect(host.nodes(node => node.tag === 'button').filter(button => String(button.props['aria-label'] ?? '').includes('详情'))).toHaveLength(0)
    host.unmount()
  })
})

describe('读数撤掉之后，这两种状态仍有人说出来', () => {
  it('一次都还没取到数据时：页面说它正在读，而不是一片沉默', async () => {
    // 关注线路那一读挂在路上：本页还没有任何答案，故它不该什么都不说。
    const host = await mountOverview({ favourites: () => new Promise(() => {}) })

    expect(readings(host), 'a reading half came back').toHaveLength(0)
    expect(host.text(), 'nothing on the page says why there is no data').toContain('正在读取关注线路…')
    host.unmount()
  })

  it('读取失败时：页面说明失败并给出重试入口', async () => {
    const host = await mountOverview({ favourites: () => ({ success: false, error: '读取失败' }) })

    const text = host.text()
    expect(text, 'a failed read is not worded as an empty list').toContain('未读到关注线路')
    expect(text).not.toContain('还没有关注线路')
    const retry = host.nodes((node: HostElement) => node.tag === 'button' && host.textOf(node).trim() === '重试')
    expect(retry, 'a failed read offered no retry').toHaveLength(1)
    host.unmount()
  })
})

describe('刷新仍是同一个动作与同一个冷却端点', () => {
  it('两处入口都由同一个条件禁用', async () => {
    const host = await mountOverview()

    for (const which of ['narrow', 'wide'] as const) {
      const button = actionIn(toolbar(host, which), REFRESH_LABEL)
      // 屏幕上有可重读的线路、窗口也开着，故两处入口都按得下。
      expect(button.props.disabled).toBe(false)
      expect(button.props['aria-busy']).toBe(false)
    }
    host.unmount()
  })

  it('按下一枚：POST 拥有冷却的那个端点，点名卡片正在读的线路', async () => {
    const host = await mountOverview()

    await press(host, actionIn(toolbar(host, 'narrow'), REFRESH_LABEL))

    // 端点只有一个：两个入口共用一个窗口。
    const sent = host.server.seen(/\/api\/transit\/refresh$/)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('POST')
    expect((sent[0]!.body as { lines: Array<{ lineId: string }> }).lines.map(line => line.lineId))
      .toEqual(['bus_027_1'])
    host.unmount()
  })
})
