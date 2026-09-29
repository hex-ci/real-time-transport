import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import ChainsListPage from '../../../views/settings/chains.vue'
import ChainEditorPage from '../../../views/settings/chain-editor.vue'

/**
 * 链路两页在 320 / 375 / 1024 / 1280 上的宽度与高度预算，按**声明**算出来。
 *
 * 本装置没有排版（见 `settings-harness.ts`），故这里不做像素测量，而是把每一档的可用宽度与每个
 * 控件声明的最小宽度算成一个数，再比大小 —— 与 `favorite-lines-responsive.test.ts` 同一套做法。
 * 真正的像素复量在浏览器侧做（`references/mobile-responsive.md`），本文件守的是「换宽度时哪一个类
 * 会咬住」：`min-w-0` / `truncate` 被删掉、`shrink-0` 加到手柄或箭头以外的东西上、或某个控件降到
 * 44 以下，都会在这里变红。
 *
 * 链路行比关注线路行高：一行里还印着每一段自己的线路与那一对站。故它的**最小宽度**与自然宽度
 * 差得更远 —— 320 上一定是截断的那一档，而 1280 上整行印得下。
 */

const NARROWEST = 320
const PHONE = 375
const LAPTOP = 1024
const DESKTOP = 1280

/** 房规的触控目标。 */
const TOUCH = 44
/** 页面内容的最大宽度（`max-w-3xl`）。 */
const CONTENT_MAX = 768
/** 本仓的 `p-N` 阶梯：4px 一档。 */
const STEP = 4

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

const CHAIN: Record<string, unknown> = {
  id: 'chain-morning',
  userId: 'default_user',
  name: '早上上班',
  purpose: 'morning',
  displayOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  legs: [storedLeg()],
}

const FAVOURITE = {
  id: 'fav-bus-1',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  lineName: '快线 1 路',
  preferredDirection: 0,
  reverseLineId: 'bus_027_1_rev',
  displayOrder: 0,
}

function routes(chains: Array<Record<string, unknown>> = [CHAIN]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: {
      lineId: 'bus_027_1',
      direction: 0,
      directionName: '开往建国门',
      cityCode: '027',
      stops: [
        { id: 's1', name: '十里堡', order: 1, interchanges: [] },
        { id: 's2', name: '团结湖', order: 2, interchanges: [] },
        { id: 's3', name: '东大桥', order: 3, interchanges: [] },
        { id: 's4', name: '建国门', order: 4, interchanges: [] },
      ],
    } })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: chains })],
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

async function mountEditor(): Promise<MountedHost> {
  const host = await mountComponent(ChainEditorPage, {
    props: { chainId: null },
    routes: routes(),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 从「线路与方向」的下拉里选第一条，按用户读到的那一行文字。 */
async function chooseFirstLine(host: MountedHost): Promise<void> {
  const trigger = host.nodes(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))[0]
  if (!trigger) throw new Error('the leg rendered no 线路与方向 picker')
  const { press } = await import('./settings-harness')
  await press(host, trigger)
  const option = host.nodes(item => item.props.role === 'option')[0]
  if (!option) throw new Error('the 线路与方向 picker listed nothing')
  await press(host, option)
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 一个节点的类名，按词切开 —— 断言要的是「有这一项」，不是「字符串里出现过」。 */
function tokens(node: HostElement | string): string[] {
  const classes = typeof node === 'string' ? node : String(node.props.class ?? '')
  return classes.split(/\s+/).filter(Boolean)
}

function classes(node: HostElement): string {
  return String(node.props.class ?? '')
}

/** 一个元素要的高度（px），取自它自己那一档。 */
function heightOf(node: HostElement): number | null {
  const scales = tokens(node)
    .map(token => /^(?:min-)?h-(\d+)$/.exec(token))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => Number(match[1]) * STEP)
  const brackets = tokens(node)
    .map(token => /^(?:min-)?h-\[(\d+)px\]$/.exec(token))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => Number(match[1]))
  const all = [...scales, ...brackets]
  return all.length > 0 ? Math.max(...all) : null
}

/** 一个元素声明的子元素间距（`gap-N`）。 */
function gapOf(node: HostElement): number {
  const found = tokens(node).map(token => /^gap-([\d.]+)$/.exec(token)).find(match => match !== null)
  return Number(found?.[1] ?? 0) * STEP
}

/** 一个元素声明的左右内边距（`p-N` / `px-N`）。 */
function paddingXOf(node: HostElement): number {
  const list = tokens(node)
  const horizontal = list.map(token => /^px-([\d.]+)$/.exec(token)).find(match => match !== null)
  const all = list.map(token => /^p-([\d.]+)$/.exec(token)).find(match => match !== null)
  return Number(horizontal?.[1] ?? all?.[1] ?? 0) * STEP
}

/** 左右描边：`border` 是一侧 1px。 */
function borderXOf(node: HostElement): number {
  return tokens(node).includes('border') ? 2 : 0
}

/** 一个元素声明的左边距（`-ml-N` 记负）。 */
function marginLeftOf(node: HostElement): number {
  const found = tokens(node).map(token => /^(-?)ml-([\d.]+)$/.exec(token)).find(match => match !== null)
  if (!found) return 0
  return Number(found[2]) * STEP * (found[1] === '-' ? -1 : 1)
}

/**
 * 本仓 `App.vue` 的 `<main>` 在给定宽度下给的横向安全区 gutter。
 * 断点与 `px-safe-offset-3 sm:…-6 lg:…-8 xl:…-10 2xl:…-12` 一致（`env()` 在本机为 0）。
 */
function mainGutter(width: number): number {
  if (width >= 1536) return 48
  if (width >= 1280) return 40
  if (width >= 1024) return 32
  if (width >= 640) return 24
  return 12
}

/** 页面的内容宽度：`main` 的 gutter 之后，再被 `max-w-3xl` 封顶。 */
function contentWidth(width: number): number {
  return Math.min(width - 2 * mainGutter(width), CONTENT_MAX)
}

/** 卡片的内容宽度：内容宽度减去卡片自己的左右内边距（`p-4` / `sm:p-5`）。 */
function cardInner(width: number, cardPadding: number): number {
  return contentWidth(width) - 2 * cardPadding
}

/** 本仓这一族标签全是汉字：一个汉字占它自己那一个字号，12px 下即 12px。 */
function textWidthOf(text: string, size = 12): number {
  return [...text.replace(/\s+/g, '')].length * size
}

/**
 * 一个元素在**不换行也不截断**时的自然宽度（px）：里面每个子元素都按自己的内容算。
 *
 * 这是「这一行会不会溢出」的判据（比可用宽度大就是溢出），也是「屏幕变窄时谁先让位」的判据：
 * 让位的是带 `truncate` 的那一段。
 */
function naturalWidthOf(node: HostElement, host: MountedHost): number {
  const own = tokens(node)
  const fixed = own.map(token => /^w-(\d+)$/.exec(token)).find(match => match !== null)
  if (fixed) return Number(fixed[1]) * STEP

  /** 一段裸文字自己的宽度——它按字排，不换行时与同排的元素相加。 */
  const textWidth = (child: HostElement): number => textWidthOf(child.text)
  const children = node.children
  const blocks = children.filter(child => !child.tag.startsWith('#') && tokens(child).includes('block'))
  // 一排子元素怎么排，看它们自己声明的：带 `block` 的**上下堆叠**（一行的高度与最宽的那个有关），
  // 其余（裸文字与行内元素）**同排相加**。链路一行里两者都有：名字/摘要/各段是三个 `block`，
  // 而一段自己的文字与它尾部的接驳说明在同一行上。
  const stacked = blocks.length > 0
  const stackedWidth = (child: HostElement): number => (child.tag.startsWith('#') ? textWidth(child) : naturalWidthOf(child, host))
  const inlineWidth = (child: HostElement): number => (child.tag.startsWith('#') ? textWidth(child) : naturalWidthOf(child, host))

  const inner = children.length === 0
    ? textWidthOf(host.textOf(node))
    : own.includes('flex') || !stacked
      ? children.reduce((sum, child) => sum + inlineWidth(child), 0) + gapOf(node) * (children.length - 1)
      : Math.max(...children.map(child => stackedWidth(child)))
  return inner + 2 * paddingXOf(node) + borderXOf(node) + marginLeftOf(node)
}

/**
 * 一个元素**必须**占的最小宽度（px）：它自己声明的最小宽度，或它不能压缩时的自然宽度。
 *
 * `min-w-0` 与 `truncate` 让一个元素可以缩到 0（这正是长摘要不把行撑破的办法），
 * 故它们在这里只留自己的内边距与描边。这一族元素的和就是这一行**无论如何**都要占的地方：
 * 比可用宽度大就是溢出。
 */
function minWidthOf(node: HostElement, host: MountedHost): number {
  const own = tokens(node)
  if (own.includes('min-w-0') || own.includes('truncate')) {
    return 2 * paddingXOf(node) + borderXOf(node)
  }
  const fixed = own.map(token => /^w-(\d+)$/.exec(token)).find(match => match !== null)
  if (fixed) return Number(fixed[1]) * STEP
  const children = node.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  const inner = children.length === 0
    ? textWidthOf(host.textOf(node))
    : own.includes('flex')
      ? children.reduce((sum, child) => sum + minWidthOf(child, host), 0) + gapOf(node) * (children.length - 1)
      : Math.max(...children.map(child => minWidthOf(child, host)))
  return inner + 2 * paddingXOf(node) + borderXOf(node) + marginLeftOf(node)
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

/** 列表页那一行。 */
function rowOf(host: MountedHost): HostElement {
  return host.node(item => item.tag === 'li', 'a chain row')
}

/** 一行里那个进编辑页的链接。 */
function rowLink(host: MountedHost): HostElement {
  return host.node(item => item.tag === 'a' && item.parent?.tag === 'li', 'the row link')
}

/** 一行（列表里的 `li`）的最小宽度：手柄 + 链接。 */
function rowMinWidth(host: MountedHost): number {
  const row = rowOf(host)
  const children = row.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  return children.reduce((sum, child) => sum + minWidthOf(child, host), 0) + gapOf(row) * (children.length - 1)
}

/** 一行（列表里的 `li`）的自然宽度：摘要完整印出来时它要多宽。 */
function rowNaturalWidth(host: MountedHost): number {
  const row = rowOf(host)
  const children = row.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  return children.reduce((sum, child) => sum + naturalWidthOf(child, host), 0) + gapOf(row) * (children.length - 1)
}

/** 列表页卡片的左右内边距：`p-4`，`sm:p-5` 起 20。 */
function listCardPadding(width: number): number {
  return width >= 640 ? 20 : 16
}

/** 列表那一行可用的宽度：卡片内宽减去列表自己的左右描边。 */
function rowAvailable(width: number): number {
  return cardInner(width, listCardPadding(width)) - 2
}

const WIDTHS = [NARROWEST, PHONE, LAPTOP, DESKTOP] as const

describe('列表行在 320 / 375 / 1024 / 1280 上都不溢出，手柄与行尾箭头都在屏内', () => {
  it('每一档算出来的最小宽度都不超过那一档可用的宽度', async () => {
    const host = await mountList()

    // 非空在前：没有行的时候，下面的循环什么都没量就通过了。
    expect(host.nodes(item => item.tag === 'li')).toHaveLength(1)

    const measured = WIDTHS.map(width => ({
      width,
      available: rowAvailable(width),
      needed: rowMinWidth(host),
      natural: rowNaturalWidth(host),
    }))

    for (const item of measured) {
      expect(
        item.needed,
        `the row needs ${item.needed}px and only has ${item.available}px at ${item.width}`,
      ).toBeLessThanOrEqual(item.available)
    }
    // 320 是最紧的一档：那一行**必须**占的宽度仍留有余量，而完整的摘要印不下 ——
    // 差额正是名字那一段 `truncate` 吃掉的地方（也就是「320 上名字是被截断的，不是被挤出去的」）。
    const tightest = measured[0]!
    expect(tightest.available - tightest.needed, 'the row has no room left for the name at 320').toBeGreaterThan(0)
    expect(tightest.natural, 'the row fits whole at 320, so nothing was measured').toBeGreaterThan(tightest.available)
    // 1280 上整行印得下：宽屏那一档不是靠截断撑住的。
    const widest = measured.at(-1)!
    expect(widest.natural, 'the row is truncated even on the widest screen').toBeLessThanOrEqual(widest.available)
    host.unmount()
  })

  it('手柄与行尾箭头都是 shrink-0：宽度不够时被压的是中间那一段', async () => {
    const host = await mountList()

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    expect(tokens(handle)).toContain('shrink-0')
    expect(heightOf(handle)).toBe(TOUCH)

    // 行链接是 `flex-1 min-w-0`：它自己先让出宽度，而不是把行撑出卡片。
    const link = rowLink(host)
    expect(tokens(link)).toContain('flex-1')
    expect(tokens(link)).toContain('min-w-0')

    // 名字那一段带 `truncate`（它自己可以缩到 0），故两端的两个元素永远不会被挤出屏幕。
    const name = link.children
      .filter((child: HostElement) => !child.tag.startsWith('#'))
      .flatMap((child: HostElement) => child.children)
      .find((child: HostElement) => tokens(child).includes('truncate'))
    expect(name, 'the row has no truncating name to absorb a narrow screen').toBeDefined()

    // 行尾箭头是 `shrink-0`：它是不许被压缩的那一端。
    const chevron = link.children
      .filter((child: HostElement) => !child.tag.startsWith('#'))
      .find(child => String(child.tag).toLowerCase() === 'svg' && tokens(child).includes('shrink-0'))
    expect(chevron, 'the row has no trailing arrow').toBeDefined()
    host.unmount()
  })

  it('320 上名字仍拿得到地方：最小宽度里扣掉两端之后仍为正', async () => {
    const host = await mountList()

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    const link = rowLink(host)
    const children = link.children.filter((child: HostElement) => !child.tag.startsWith('#'))
    const fixed = children
      .filter(child => !tokens(child).includes('min-w-0'))
      .reduce((sum, child) => sum + minWidthOf(child, host), 0)

    const left = rowAvailable(NARROWEST) - minWidthOf(handle, host) - fixed - gapOf(link) * (children.length - 1)
    expect(left, 'the name gets no room at all at 320').toBeGreaterThan(0)
    host.unmount()
  })

  it('逐宽度的数字：行需要的宽度 / 可用宽度 / 整行完整印出来要多宽', async () => {
    // 报数字的那一条：上面几条钉的是「哪一档会咬住」，这一条把四个宽度的三个数一起印出来，
    // 好让改动的复核者看到余量有多大、以及在哪个宽度上开始截断。
    const host = await mountList()
    const needed = rowMinWidth(host)
    const natural = rowNaturalWidth(host)

    const table = WIDTHS.map(width => ({
      width,
      content: contentWidth(width),
      rowAvailable: rowAvailable(width),
      rowNeeded: needed,
      rowNatural: natural,
    }))

    // 四档的可用宽度都是正数，且随宽度单调不减（否则上面那条比大小就没有意义）。
    for (const item of table) {
      expect(item.rowAvailable, `${item.width} leaves the row no width`).toBeGreaterThan(needed)
    }
    expect(table.map(item => item.rowAvailable)).toEqual([...table.map(item => item.rowAvailable)].sort((a, b) => a - b))

    // 这三个数字就是报告里给出的那一组（320 / 375 / 1024 / 1280 上逐档）。
    expect(table).toEqual([
      { width: 320, content: 296, rowAvailable: 262, rowNeeded: needed, rowNatural: natural },
      { width: 375, content: 351, rowAvailable: 317, rowNeeded: needed, rowNatural: natural },
      { width: 1024, content: 768, rowAvailable: 726, rowNeeded: needed, rowNatural: natural },
      { width: 1280, content: 768, rowAvailable: 726, rowNeeded: needed, rowNatural: natural },
    ])
    host.unmount()
  })

  it('卡片在 1024 与 1280 上都封在 768：与设置页其他子页同一个限宽', async () => {
    const host = await mountList()
    host.node(item => tokens(item).includes('max-w-3xl'), 'the page wrapper')

    for (const width of [LAPTOP, DESKTOP]) {
      expect(contentWidth(width), `${width} does not clamp the card`).toBe(CONTENT_MAX)
    }
    expect(contentWidth(NARROWEST)).toBe(NARROWEST - 24)
    expect(contentWidth(PHONE)).toBe(PHONE - 24)
    host.unmount()
  })
})

describe('编辑页的段编辑器在 320 / 375 上不溢出，控件都是 44', () => {
  it('每个可点的控件都 ≥44px，且不随断点跳尺寸', async () => {
    const host = await mountEditor()

    const controls = host.nodes(item => item.tag === 'button' || item.tag === 'a')
    expect(controls.length, 'the editor rendered nothing to measure').toBeGreaterThan(4)
    for (const control of controls) {
      const height = heightOf(control)
      expect(height, `${control.tag}「${host.textOf(control).slice(0, 8)}」has no height class: ${classes(control)}`).not.toBeNull()
      expect(height!, `${control.tag}「${host.textOf(control).slice(0, 8)}」is below the house touch target`).toBeGreaterThanOrEqual(TOUCH)
    }
    host.unmount()
  })

  it('段编辑器里的三个下拉都能缩：每个都是 w-full + min-w-0，故窄屏压缩的是它自己', async () => {
    const host = await mountEditor()
    // 必须先选一条线路，两个站选择器才存在：没有它，下面的列表只有一个下拉，循环会漏掉两个
    // ——正是两个 40px 控件曾满足 44px 规则的方式。
    await chooseFirstLine(host)

    const triggers = host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))
    // 非空在前：线路与方向那一个也要在，否则下面只量了两个站选择器。
    expect(triggers.length, 'the leg rendered no pickers to measure').toBe(3)
    for (const trigger of triggers) {
      expect(tokens(trigger), 'a picker trigger cannot shrink').toContain('min-w-0')
      expect(tokens(trigger)).toContain('w-full')
      expect(heightOf(trigger)).toBeGreaterThanOrEqual(TOUCH)
    }

    // 每一段的三个下拉都在一个有界的块里：`data-chain-leg` 那一块自己可以缩到 0（它是 `min-w-0`
    // 之外的普通块，宽度由父级给），故 320 上不靠横向滚动也能填完。
    const leg = host.node(item => item.props['data-chain-leg'] !== undefined, 'the first leg block')
    expect(heightOf(host.node(item => item.tag === 'input' && item.props.type === 'number', 'the extra field')))
      .toBeGreaterThanOrEqual(TOUCH)
    expect(classes(leg)).toContain('rounded-xl')
    host.unmount()
  })

  it('段编辑器在 320 上不溢出：段里每个控件要占的宽度都装得进卡片内宽', async () => {
    // 段编辑器是**窄屏最容易溢出**的那一块：线路与方向、上车站、下车站、接驳额外时间、删除该段。
    // 长句子（「列表来自你关注的线路…」）自己换行，故不是溢出的来源；会溢出的只有**不能换行也
    // 不能缩**的控件，故这里逐个量它们**必须**占的宽度，与 320 上卡片自己的内宽（264）比大小。
    const host = await mountEditor()
    await chooseFirstLine(host)

    const leg = host.node(item => item.props['data-chain-leg'] !== undefined, 'the first leg block')
    const controls = subtree(leg).filter(item => item.tag === 'button' || item.tag === 'input')
    // 非空在前：没有控件的时候下面的循环什么都没量就通过了。
    expect(controls.length, 'the leg rendered no control to measure').toBe(7)

    const measured = controls.map(control => minWidthOf(control, host))
    for (const [index, needed] of measured.entries()) {
      expect(
        needed,
        `段里第 ${index + 1} 个控件要 ${needed}px，而 320 上卡片内宽只有 ${cardInner(NARROWEST, 16)}px`,
      ).toBeLessThanOrEqual(cardInner(NARROWEST, 16))
    }
    // 报数字：段里七个控件**必须**占的宽度 —— 删除该段 80、线路与方向 26、两个站选择器各 26、
    // 两个接驳方式药丸各 50、额外分钟输入 26 —— 以及 320 / 375 上卡片自己的内宽。
    // 每一个都远小于 264，故 320 上这一段不溢出，靠的是这些控件**能缩**（`min-w-0`），
    // 而不是靠某个宽度刚好卡住。
    expect({ controls: measured, at320: cardInner(NARROWEST, 16), at375: cardInner(PHONE, 16) })
      .toEqual({ controls: [80, 26, 26, 26, 50, 50, 26], at320: 264, at375: 319 })
    host.unmount()
  })

  it('新建页底部只有保存，它吃满那一行且 ≥44', async () => {
    const host = await mountEditor()

    const save = host.node(item => item.tag === 'button' && host.textOf(item).includes('保存链路'), 'the save button')
    expect(tokens(save)).toContain('flex-1')
    expect(heightOf(save)).toBeGreaterThanOrEqual(TOUCH)

    // 新建页没有删除（一条还不存在的链路没什么可删的），也没有取消：返回控件就是出路。
    expect(
      host.nodes(item => item.tag === 'button' && host.textOf(item).includes('删除链路')),
      'the create page offers a delete',
    ).toHaveLength(0)
    expect(tokens(save.parent!)).toContain('flex-wrap')
    host.unmount()
  })

  it('编辑页的删除与保存同一行、在保存右侧，且两枚都 ≥44', async () => {
    const host = await mountComponent(ChainEditorPage, {
      props: { chainId: CHAIN.id as string },
      routes: routes(),
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    const save = host.node(item => item.tag === 'button' && host.textOf(item).includes('保存链路'), 'the save button')
    const remove = host.node(item => item.tag === 'button' && host.textOf(item).includes('删除链路'), 'the remove button')

    expect(heightOf(remove)).toBeGreaterThanOrEqual(TOUCH)
    // 与关注线路编辑页同形：保存吃满，删除紧挨它右边。
    const row = save.parent!
    expect(row.children.includes(remove), '删除链路 is not in the save row').toBe(true)
    expect(row.children.indexOf(remove)).toBeGreaterThan(row.children.indexOf(save))
    expect(tokens(remove)).toContain('shrink-0')
    host.unmount()
  })

  it('逐宽度的数字：编辑页底部两个按钮的最小宽度、高度，以及段编辑器那三个下拉的高度', async () => {
    const host = await mountEditor()
    const save = host.node(item => item.tag === 'button' && host.textOf(item).includes('保存链路'), 'the save button')
    const trigger = host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))[0]!

    // 保存 34 是它声明 `min-w-0` 之后的**收缩下限**（左右内边距 + 描边），不是它的自然宽度：
    // 它与删除并排时先缩自己（`flex-1`），不会把删除挤出去。段里第一个下拉同理，26。
    expect({
      save: minWidthOf(save, host),
      pickerTrigger: minWidthOf(trigger, host),
      saveHeight: heightOf(save),
      triggerHeight: heightOf(trigger),
    }).toEqual({
      save: 34,
      pickerTrigger: 26,
      saveHeight: TOUCH,
      triggerHeight: TOUCH,
    })

    // 新建页那一行只有保存（删除只在编辑页出现），故它一定放得下。
    expect(minWidthOf(save, host)).toBeLessThanOrEqual(cardInner(NARROWEST, 16))
    host.unmount()
  })

  it('卡片在 1024 与 1280 上都封在 768', async () => {
    const host = await mountEditor()
    host.node(item => tokens(item).includes('max-w-3xl'), 'the page wrapper')

    for (const width of [LAPTOP, DESKTOP]) {
      expect(contentWidth(width), `${width} does not clamp the card`).toBe(CONTENT_MAX)
    }
    expect(host.text()).toContain('新增链路')
    host.unmount()
  })
})
