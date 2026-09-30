import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WIDE_AT,
  hiddenAt,
  mountChainPage,
  pickPurpose,
  pressRefresh,
  type HostElement,
  type MountedChainPage,
  type Route,
} from './chain-page-harness'
import { chainView, conclusion, leg, refreshAnswer } from './chain-fixtures'

/** 推出去的那句话。本页只评判**没推**什么，故它只需记下来。 */
const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string) => {
      pushed.push(message)
      return pushed.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

/**
 * 链路页的顶部信息区：**两块互斥的工具栏**，各自持有自己那一档的样子。
 *
 * 这一版把刷新读数从两档里撤掉了：一次按下的结局由全局提示说，屏幕上不再有「最后更新 …」那一行。
 * 宽屏那一块（`hidden md:block`）是卡片内的**一行**：目的页签在左，刷新那枚 44 图标按钮贴着卡片右
 * 内边。窄屏那一块（`md:hidden`）是**一行**：页签容器吃满余量、刷新贴在它后面。两块各自完整，没有
 * 一处靠断点前缀替另一档拼行。
 *
 * 「高度」与「一行装不装得下」在本装置里是**算出来的数**：宿主没有排版，故元素要的是哪一档
 * （本仓的 `h-N` 阶梯）以及一行放不放得下（每个子元素的最小宽度加间距比上可用宽度，12px 下一个
 * 汉字占 12px）都在此处按声明算。真正的像素测量在浏览器侧做。
 */

/** 端点按被问的目的作答。 */
const DEDUCTIONS: Route = [
  /commute-chains\/deductions/,
  (request) => {
    const purpose = (/purpose=(\w+)/.exec(request.url)?.[1] ?? 'morning') as 'morning' | 'evening'
    return {
      success: true,
      data: { purpose, chains: [chainView(conclusion([leg({ seq: 0 })]), { purpose })] },
    }
  },
]

/** 通勤时段被读过：于是本页打开时跟随它选定的那个目的。 */
const PROFILE: Route = [/commute-profile/, () => ({
  success: true,
  data: { mode: 'work', description: '早通勤时段', windowState: 'stored' },
})]

const HEAD_ROUTES: Route[] = [DEDUCTIONS, PROFILE]

const NAME = '换乘链路'
const CITY = '北京'
const SUBTITLE = '能不能赶上换乘点那班车'
const DEFAULT_CHIP = '默认按通勤时段选定'
/** 撤掉那一行读数之后，这一串也不该再在这两档里出现。 */
const GONE_READING = '最后更新'
/** 从未取到读数的库存措辞：它只属于 store，本页不再渲染它的那一半。 */
const STORE_ONLY_WORDING = '尚未获取到数据'

const DESKTOP = 1280
const MOBILE = 375
const NARROWEST = 320

/** 本仓的控件高度：房规的触摸目标 44，也是容器与它里面那一项共同的高度。 */
const CONTROL_HEIGHT = 44
/** 一行工具栏允许的高度：一个 44 控件加上它自己的描边余量。 */
const ROW_MAX_HEIGHT = 46
/** 375 上工具栏那一行可用的宽度：信息块自己的左右内边距与描边之后剩下的（本仓的量测值）。 */
const AVAILABLE_AT_375 = 331

const REFRESH_LABEL = '刷新最新车况'
const PURPOSE_GROUP_LABEL = '通勤目的'

/** 一个节点子树里的每个节点，按文档顺序（不含自身）。 */
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

/** 子节点里的元素（注释与文本节点不是元素）。 */
function elements(node: HostElement): HostElement[] {
  return node.children.filter((child: HostElement) => !child.tag.startsWith('#'))
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
 * 这一行必须是横排的 —— 竖排的「一行」只是名字，屏幕上它是两行。
 */
function rowHeightOf(row: HostElement): number {
  const heights = elements(row).map(controlHeightOf)
  if (!tokens(row).includes('flex-col')) return Math.max(...heights)
  return heights.reduce((sum, height) => sum + height, 0) + gapOf(row) * (heights.length - 1)
}

/** 一个节点的类名，按词切开 —— 断言要的是「有这一项」，不是「字符串里出现过」。 */
function tokens(node: HostElement | string): string[] {
  const classes = typeof node === 'string' ? node : String(node.props.class ?? '')
  return classes.split(/\s+/).filter(Boolean)
}

/** 一个元素要的高度（px），取自它自己那一档。 */
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
function minWidthOf(node: HostElement, page: MountedChainPage): number {
  if (tokens(node).includes('h-11') && tokens(node).includes('w-11')) return ICON_BUTTON
  const children = elements(node)
  const inner = children.length === 0
    ? textWidthOf(page.textOf(node))
    : tokens(node).includes('flex')
      ? children.reduce((sum, child) => sum + minWidthOf(child, page), 0) + gapOf(node) * (children.length - 1)
      : Math.max(...children.map(child => minWidthOf(child, page)))
  return inner + 2 * paddingXOf(node) + borderXOf(node)
}

/**
 * 一行在给定宽度下的两端距离：最左的子元素离行的左内边多远，最右的离右内边多远。
 *
 * 宿主没有排版，故这里按 flex 行的规则算：`ms-auto`（或 `ml-auto`）之前的子元素贴左内边（左距 0），
 * 它之后的全部被余量推到右内边（右距 0）；行里一个自动外边距都没有时，右端量不出来（`null`）。
 */
function edgesOf(row: HostElement): { left: number, right: number | null } {
  const children = elements(row)
  const auto = children.findIndex(child => tokens(child).some(token => token === 'ms-auto' || token === 'ml-auto'))
  if (auto === -1) return { left: 0, right: null }
  return { left: 0, right: 0 }
}

/** 那一行里带自动外边距的那个子元素，或 `null`。 */
function pushedRight(row: HostElement): HostElement | null {
  return elements(row).find(child => tokens(child).some(token => token === 'ms-auto' || token === 'ml-auto')) ?? null
}

/** 两块排布各自的根。 */
function narrowBlock(page: MountedChainPage): HostElement {
  return page.node(item => item.props['data-info-area'] === 'narrow', 'the narrow info block')
}

function wideBlock(page: MountedChainPage): HostElement {
  return page.node(item => item.props['data-info-area'] === 'wide', 'the wide info block')
}

/** 某一档那一行控件。 */
function toolbar(page: MountedChainPage, which: 'narrow' | 'wide'): HostElement {
  return page.node(item => item.props['data-toolbar'] === which, `the ${which} toolbar row`)
}

/** 某一档里的目的页签容器。 */
function purposeContainer(row: HostElement): HostElement {
  const found = elements(row).find(item => item.props.role === 'radiogroup')
  if (!found) throw new Error('this toolbar row holds no purpose radio group')
  return found
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

function purposeItems(row: HostElement): HostElement[] {
  return descendants(purposeContainer(row)).filter((item: HostElement) => item.props.role === 'radio')
}

/** 某一档里那枚刷新入口（按可访问名找那一行里的它）。 */
function refreshIn(row: HostElement): HostElement {
  const found = subtree(row).find(item => item.tag === 'button' && item.props['aria-label'] === REFRESH_LABEL)
  if (!found) throw new Error('this toolbar row renders no refresh entry')
  return found
}

/** 全页上那一行读数（两半的一个 id）：撤掉之后一个都不该在。 */
function readings(page: MountedChainPage): HostElement[] {
  return page.nodes((item: HostElement) => typeof item.props.id === 'string' && item.props.id.endsWith('refresh-freshness'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('信息区是两块互斥的工具栏', () => {
  it('两块各一份，各自只在自己那一档出现', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })

    const narrow = narrowBlock(page)
    const wide = wideBlock(page)
    expect(descendants(page.root).indexOf(narrow)).toBeLessThan(descendants(page.root).indexOf(wide))
    expect(hiddenAt(narrow, DESKTOP)).toBe(true)
    expect(hiddenAt(narrow, MOBILE)).toBe(false)
    expect(hiddenAt(wide, MOBILE)).toBe(true)
    expect(hiddenAt(wide, DESKTOP)).toBe(false)
    // 各档那一行各自一份，且都只在自己那一档出现。
    expect(page.nodes(item => item.props['data-toolbar'] === 'narrow')).toHaveLength(1)
    expect(page.nodes(item => item.props['data-toolbar'] === 'wide')).toHaveLength(1)
    page.unmount()
  })
})

describe('刷新读数从两档工具栏里撤掉', () => {
  it('两档工具栏的字里都没有「最后更新」，全页也没有那一行读数', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })

    for (const which of ['narrow', 'wide'] as const) {
      const text = page.textOf(toolbar(page, which))
      expect(text, `${which} still prints a reading`).not.toContain(GONE_READING)
      expect(text, `${which} still prints the store wording for a reading it has not got`).not.toContain(STORE_ONLY_WORDING)
    }
    expect(readings(page), 'a reading half is still rendered somewhere').toHaveLength(0)
    page.unmount()
  })

  it('两枚刷新按钮仍带着可访问名，也仍不描述任何一处虚空', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })

    for (const which of ['narrow', 'wide'] as const) {
      const button = refreshIn(toolbar(page, which))
      expect(button.props['aria-label']).toBe(REFRESH_LABEL)
      // 屏幕上没有读数那一半了，故描述接到了虚空：这个属性必须整个不在。
      expect(button.props['aria-describedby'], `${which} describes a line that is not rendered`).toBeUndefined()
      expect(tokens(button)).toContain('h-11')
      expect(tokens(button)).toContain('w-11')
    }
    page.unmount()
  })
})

describe('宽屏：页签在左，刷新贴着卡片右内边', () => {
  it('页签容器 44、项也是 44，刷新 44×44，三者同处一行且装得下', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })
    const row = toolbar(page, 'wide')

    expect(tokens(row)).toContain('flex')
    // 不换行、也不竖排：宽屏这一档正是「一行排得开」的那一档。
    expect(tokens(row)).not.toContain('flex-wrap')
    expect(tokens(row)).not.toContain('flex-col')
    const container = purposeContainer(row)
    expect(heightOf(container)).toBe(CONTROL_HEIGHT)
    for (const item of purposeItems(row)) {
      // 项与容器同高，且自己的盒顶落在容器的外顶边上 —— 与相邻那枚 44 图标按钮同一条线。
      expect(itemBoxIn(container, item)).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    }
    expect(row.children.every((child: HostElement) => !tokens(child).includes('w-full'))).toBe(true)

    const refresh = refreshIn(row)
    expect(tokens(refresh)).toContain('h-11')
    expect(itemBoxIn(container, refresh)).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    expect(minWidthOf(row, page), 'the wide row cannot fit on one line').toBeLessThanOrEqual(DESKTOP - 2 * 20)
    page.unmount()
  })

  it('两端距离：页签贴左内边（0），刷新贴右内边（0）', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })
    const row = toolbar(page, 'wide')
    const children = elements(row)

    // 行里唯一的自动外边距落在最后一枚（刷新）上：它把余量全吃掉，故自己停在右端。
    expect(pushedRight(row)).toBe(children.at(-1))
    expect(edgesOf(row)).toEqual({ left: 0, right: 0 })
    // ……而左端那个是页签容器：它自己没有自动外边距，故从卡片左内边开始排。
    expect(children[0]).toBe(purposeContainer(row))
    expect(tokens(children[0]!)).not.toContain('ms-auto')
    expect(children.indexOf(pushedRight(row)!)).toBe(children.length - 1)
    page.unmount()
  })
})

describe('窄屏：一行，页签容器吃满余量与刷新同排', () => {
  it('行高就是那一行里最高的那一个：44，不超过 46', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })
    const row = toolbar(page, 'narrow')
    const children = elements(row)

    expect(children).toHaveLength(2)
    expect(children[0]).toBe(purposeContainer(row))
    expect(children[1]).toBe(refreshIn(row).parent)

    expect(rowHeightOf(row), 'the narrow toolbar row is taller than one control row').toBeLessThanOrEqual(ROW_MAX_HEIGHT)
    expect(rowHeightOf(row)).toBe(CONTROL_HEIGHT)
    page.unmount()
  })

  it('375 上装得下这一行：算出来的最小宽度不超过那一行可用的宽度', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })
    const row = toolbar(page, 'narrow')

    expect(minWidthOf(row, page), 'the narrow row cannot fit on one line at 375').toBeLessThanOrEqual(AVAILABLE_AT_375)
    // 320 上余量更少：那里允许换行，但一个字都不许被裁掉。
    expect(tokens(row)).toContain('flex-wrap')
    for (const node of purposeItems(row)) {
      expect(tokens(node), `${node.tag} truncates at ${NARROWEST}`).not.toContain('truncate')
      expect(tokens(node), `${node.tag} clips at ${NARROWEST}`).not.toContain('overflow-hidden')
    }
    // 容器自己裁的是选中项那一圈圆角：它和项同高，故裁不到字。
    expect(tokens(purposeContainer(row)), 'the container does not clip')
      .toContain('overflow-hidden')
    expect(hiddenAt(row, NARROWEST)).toBe(false)
    page.unmount()
  })

  it('页签吃满余量，两项等分，且都带内容宽度的下限', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })
    const row = toolbar(page, 'narrow')
    const group = purposeContainer(row)

    expect(tokens(group)).toContain('flex-1')
    expect(tokens(group)).toContain('min-w-max')
    expect(tokens(row)).toContain('flex-wrap')
    expect(heightOf(group)).toBe(CONTROL_HEIGHT)

    const items = purposeItems(row)
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(tokens(item)).toContain('flex-1')
      expect(tokens(item)).toContain('min-w-max')
      expect(tokens(item)).toContain('whitespace-nowrap')
      expect(itemBoxIn(group, item)).toEqual({ height: CONTROL_HEIGHT, offset: 0 })
    }
    // 容器自己没有内边距：项与它同高，故那一圈只会是容器自己的内圈，项永远填不满它。
    expect(tokens(group)).toContain('p-0')

    // 刷新那一枚贴在页签后面，且这一行余量全部落在它前面（两端距离的右端是 0）。
    const refresh = refreshIn(row)
    expect(heightOf(refresh)).toBe(CONTROL_HEIGHT)
    expect(tokens(refresh)).toContain('shrink-0')
    expect(pushedRight(row)).toBe(refresh.parent)
    expect(edgesOf(row)).toEqual({ left: 0, right: 0 })
    page.unmount()
  })
})

describe('窄屏的目的项：没有图标，字与可访问名照旧', () => {
  it('两个词与它们自己那一份可访问名都在，且不带图标', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })
    const items = purposeItems(toolbar(page, 'narrow'))

    expect(items.map(item => page.textOf(item))).toEqual(['上班', '下班'])
    expect(items.map(item => item.props.value)).toEqual(['morning', 'evening'])
    for (const item of items) {
      // 名字仍来自它自己的字（没有一处替它另起一个名字），而每一项都不带图标。
      expect(item.props['aria-label']).toBeUndefined()
      expect(item.children.filter((child: HostElement) => child.tag === 'svg'), `${page.textOf(item)} carries an icon`).toHaveLength(0)
    }
    // 单选组本身也没变：同一个可访问名，同一个 role。
    expect(purposeContainer(toolbar(page, 'narrow')).props['aria-label']).toBe(PURPOSE_GROUP_LABEL)
    expect(purposeContainer(toolbar(page, 'narrow')).props.role).toBe('radiogroup')
    page.unmount()
  })
})

describe('删掉的东西一件都不回来', () => {
  it('读数、名字、城市、描述句与默认目的那一句在两档里都没有', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })

    for (const which of ['narrow', 'wide'] as const) {
      const text = page.textOf(which === 'narrow' ? narrowBlock(page) : wideBlock(page))
      expect(text, `${which} still names the page`).not.toContain(NAME)
      expect(text, `${which} still prints the city`).not.toContain(CITY)
      expect(text, `${which} still prints the description sentence`).not.toContain(SUBTITLE)
      expect(text, `${which} still says how the purpose was defaulted`).not.toContain(DEFAULT_CHIP)
      expect(text, `${which} still prints a reading`).not.toContain(GONE_READING)
      // 留下的就是目的页签本身。
      expect(text).toContain('上班')
      expect(text).toContain('下班')
    }
    page.unmount()
  })

  it('没有展开/收起：全页没有开关，也没有哪一处声称自己控制了别处', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })

    expect(page.nodes(item => item.props['aria-expanded'] !== undefined)).toHaveLength(0)
    expect(page.nodes(item => item.props['aria-controls'] !== undefined)).toHaveLength(0)
    expect(page.text()).not.toContain('展开详情')
    expect(page.text()).not.toContain('收起详情')
    page.unmount()
  })
})

describe('读数撤掉之后，这两种状态仍有人说出来', () => {
  it('一次都还没取到数据时：页面说它正在读，而不是一片沉默', async () => {
    // 推导那一读挂在路上：本页还没有任何答案，故它不该什么都不说。
    const page = await mountChainPage({
      routes: [PROFILE, [/commute-chains\/deductions/, () => new Promise(() => {})]],
      viewport: MOBILE,
    })

    expect(readings(page), 'a reading half came back').toHaveLength(0)
    expect(page.text(), 'nothing on the page says why there is no data').toContain('正在读取换乘链…')
    page.unmount()
  })

  it('读取失败时：页面说明失败并给出重试入口', async () => {
    // 推导那一读答了失败：屏幕上一个答案都没有，故这一句就是这一屏唯一的说明。
    const page = await mountChainPage({ routes: [PROFILE], viewport: MOBILE })

    const text = page.text()
    expect(text, 'a failed read is not worded as an empty screen').toContain('换乘链数据读取失败')
    const retry = page.nodes((item: HostElement) => item.tag === 'button' && page.textOf(item).trim() === '重新读取')
    expect(retry, 'a failed read offered no retry').toHaveLength(1)
    page.unmount()
  })
})

describe('页签仍是本仓那一族控件', () => {
  it('两档各一组真的单选，点一下就换目的', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: DESKTOP })

    for (const which of ['narrow', 'wide'] as const) {
      const items = purposeItems(toolbar(page, which))
      expect(items.map(item => item.props.value)).toEqual(['morning', 'evening'])
    }
    expect(page.node(item => item.props.role === 'radiogroup', 'purpose group').props['aria-label']).toBe(PURPOSE_GROUP_LABEL)
    page.unmount()
  })

  it('换目的不推话：那一屏自己立刻换了样', async () => {
    const page = await mountChainPage({ routes: HEAD_ROUTES, viewport: MOBILE })
    pushed.length = 0

    await pickPurpose(page, 'evening')

    // 目的确实换了（同一个 store，同一份状态），而提示一条都没有。
    expect(page.text()).toContain('下班')
    expect(pushed).toEqual([])
    page.unmount()
  })
})

describe('刷新仍是同一个动作与同一个冷却端点', () => {
  it('按下一枚：点名屏幕上的线路，经拥有冷却的那一个端点', async () => {
    const page = await mountChainPage({
      routes: [...HEAD_ROUTES, [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })]],
      viewport: WIDE_AT,
    })

    await pressRefresh(page)

    const sent = page.server.seen(/\/api\/transit\/refresh$/)
    expect(sent).toHaveLength(1)
    expect((sent[0]!.body as { lines: Array<{ lineId: string }> }).lines.map(line => line.lineId))
      .toEqual(['bus_027_1'])
    // 结局不落在页面上任何一处，故屏幕上留下的不是读数，也不是状态词。
    // （卡片自己那一行出处不是本块的东西，本页工具栏里没有读数。）
    expect(page.text()).not.toContain('刷新太频繁')
    expect(page.textOf(toolbar(page, 'wide'))).not.toContain(GONE_READING)
    page.unmount()
  })
})
