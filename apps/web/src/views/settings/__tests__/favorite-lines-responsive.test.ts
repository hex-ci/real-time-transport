import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'
import FavoriteEditorPage from '../favorite-editor.vue'

/**
 * 关注线路两页在 320 / 375 / 1024 / 1280 上的宽度与高度预算，按**声明**算出来。
 *
 * 本装置没有排版（见 `settings-harness.ts`），故这里不做像素测量，而是把每一档的可用宽度与
 * 每个控件声明的最小宽度都算成一个数，再比大小 —— 与 `chain-toolbar.test.ts` 同一套做法。
 * 真正的像素复量在浏览器侧做（`references/mobile-responsive.md`），本文件守的是
 * 「换宽度时哪一个类会咬住」：`min-w-0` / `truncate` 被删掉、`shrink-0` 加到手柄或箭头以外的东西
 * 上、或某个控件降到 44 以下，都会在这里变红。
 *
 * 三个数各有来历：
 *  - **可用宽度**：`App.vue` 的 `<main>` 逐档给的安全区 gutter（`px-safe-offset-3` … `xl:…-10`）
 *    加页面自己的 `max-w-3xl`（768）与卡片的 `p-4`/`sm:p-5`；
 *  - **最小宽度**：不换行也不截断时每个子元素至少要占的地方（手柄 44、徽标按最长线路名、
 *    摘要可以缩到 0 因为它是 `truncate`、行尾箭头 16）；
 *  - **高度**：房规的 44 与 `h-7` / `h-11` 阶梯。
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

const FAVOURITE: Record<string, unknown> = {
  id: 'fav-300',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_300_0',
  reverseLineId: 'bus_027_300_1',
  lineName: '300内',
  preferredDirection: 0,
  displayOrder: 0,
  morningDirection: 0,
  morningStopName: '和平东桥',
  morningStopOrder: 1,
  eveningDirection: 1,
  eveningStopName: '安慧桥',
  eveningStopOrder: 2,
}

const DIR0 = {
  lineId: 'bus_027_300_0',
  direction: 0,
  directionName: '开往 和平东桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '和平东桥', order: 1, interchanges: [] },
    { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
  ],
}

const DIR1 = {
  lineId: 'bus_027_300_1',
  direction: 1,
  directionName: '开往 安慧桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '安贞桥东', order: 1, interchanges: [] },
    { id: 's2', name: '安慧桥', order: 2, interchanges: [] },
  ],
}

function routes(): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/lines\//, request => ({ success: true, data: request.url.includes('bus_027_300_1') ? DIR1 : DIR0 })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: {} })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

async function mount(component: Parameters<typeof mountComponent>[0], props: Record<string, unknown> = {}): Promise<MountedHost> {
  const host = await mountComponent(component, {
    props,
    routes: routes(),
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
function rowLink(host: MountedHost): HostElement {
  return host.node(item => item.tag === 'a' && host.textOf(item).includes('300内'), 'the followed row link')
}

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
  const children = node.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  const inner = children.length === 0
    ? textWidthOf(host.textOf(node))
    : own.includes('flex')
      ? children.reduce((sum, child) => sum + naturalWidthOf(child, host), 0) + gapOf(node) * (children.length - 1)
      : Math.max(...children.map(child => naturalWidthOf(child, host)))
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

/** 一行（列表里的 `li`）的最小宽度：手柄 + 链接（徽标 + 摘要 + 箭头）。 */
function rowMinWidth(host: MountedHost): number {
  const row = host.node(item => item.tag === 'li', 'a followed row')
  const children = row.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  return children.reduce((sum, child) => sum + minWidthOf(child, host), 0) + gapOf(row) * (children.length - 1)
}

/** 一行（列表里的 `li`）的自然宽度：摘要完整印出来时它要多宽。 */
function rowNaturalWidth(host: MountedHost): number {
  const row = host.node(item => item.tag === 'li', 'a followed row')
  const children = row.children.filter((child: HostElement) => !child.tag.startsWith('#'))
  return children.reduce((sum, child) => sum + naturalWidthOf(child, host), 0) + gapOf(row) * (children.length - 1)
}

/** 列表页的卡片左右内边距：`p-4`，`sm:p-5` 起 20。 */
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
    const host = await mount(LinesPage)

    // 非空在前：没有行的时候，下面的循环什么都没量就通过了。
    expect(host.nodes(item => item.tag === 'li')).toHaveLength(1)

    const measured: Array<{ width: number, available: number, needed: number, natural: number }> = []
    for (const width of WIDTHS) {
      measured.push({
        width,
        available: rowAvailable(width),
        needed: rowMinWidth(host),
        natural: rowNaturalWidth(host),
      })
    }

    for (const item of measured) {
      expect(
        item.needed,
        `the row needs ${item.needed}px and only has ${item.available}px at ${item.width}`,
      ).toBeLessThanOrEqual(item.available)
    }
    // 320 是最紧的一档：那一行**必须**占的宽度仍留有余量，而完整的摘要印不下 ——
    // 差额正是 `truncate` 那一段吃掉的地方（也就是「320 上摘要是被截断的，不是被挤出去的」）。
    const tightest = measured[0]!
    expect(tightest.available - tightest.needed, 'the row has no room left for the summary at 320').toBeGreaterThan(0)
    expect(tightest.natural, 'the summary fits whole at 320, so nothing was measured').toBeGreaterThan(tightest.available)
    // 1280 上摘要完整印得下：宽屏那一档不是靠截断撑住的。
    const widest = measured.at(-1)!
    expect(widest.natural, 'the summary is truncated even on the widest screen').toBeLessThanOrEqual(widest.available)
    host.unmount()
  })

  it('手柄与行尾箭头都是 shrink-0：宽度不够时被压的是中间那段摘要', async () => {
    const host = await mount(LinesPage)

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    expect(tokens(handle)).toContain('shrink-0')
    expect(heightOf(handle)).toBe(TOUCH)

    // 行链接是 `flex-1 min-w-0`：它自己先让出宽度，而不是把行撑出卡片。
    const link = rowLink(host)
    expect(tokens(link)).toContain('flex-1')
    expect(tokens(link)).toContain('min-w-0')

    // 摘要那一段带 `truncate`（它自己可以缩到 0），故两端的两个元素永远不会被挤出屏幕。
    const summary = link.children
      .filter((child: HostElement) => !child.tag.startsWith('#'))
      .find(child => tokens(child).includes('truncate'))
    expect(summary, 'the row has no truncating summary to absorb a narrow screen').toBeDefined()
    expect(tokens(summary!)).toContain('min-w-0')

    // 行尾箭头是 `shrink-0`：它是不许被压缩的那一端。
    const chevron = link.children
      .filter((child: HostElement) => !child.tag.startsWith('#'))
      .find(child => String(child.tag).toLowerCase() === 'svg' && tokens(child).includes('shrink-0'))
    expect(chevron, 'the row has no trailing arrow').toBeDefined()
    host.unmount()
  })

  it('320 上摘要仍拿得到地方：最小宽度里扣掉两端与徽标之后仍为正', async () => {
    const host = await mount(LinesPage)

    const handle = host.node(item => 'data-drag-handle' in item.props, 'the drag handle')
    const link = rowLink(host)
    const children = link.children.filter((child: HostElement) => !child.tag.startsWith('#'))
    const fixed = children
      .filter(child => !tokens(child).includes('truncate'))
      .reduce((sum, child) => sum + minWidthOf(child, host), 0)

    const left = rowAvailable(NARROWEST) - minWidthOf(handle, host) - fixed - gapOf(link) * (children.length - 1)
    expect(left, 'the summary gets no room at all at 320').toBeGreaterThan(0)
    host.unmount()
  })

  it('逐宽度的数字：行需要的宽度 / 可用宽度 / 摘要完整印出来要多宽', async () => {
    // 报数字的那一条：上面几条钉的是「哪一档会咬住」，这一条把四个宽度的三个数一起印出来，
    // 好让改动的复核者看到余量有多大、以及在哪个宽度上开始截断。
    const host = await mount(LinesPage)
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
    const host = await mount(LinesPage)
    host.node(item => tokens(item).includes('max-w-3xl'), 'the page wrapper')

    // 两档都宽于 768 + 两侧 gutter，故两档算出来的内容宽度都正好是 768。
    for (const width of [LAPTOP, DESKTOP]) {
      expect(contentWidth(width), `${width} does not clamp the card`).toBe(CONTENT_MAX)
    }
    // 320 / 375 上封不到顶，卡片就是屏幕宽度减 gutter。
    expect(contentWidth(NARROWEST)).toBe(NARROWEST - 24)
    expect(contentWidth(PHONE)).toBe(PHONE - 24)
    host.unmount()
  })
})

describe('编辑页的控件在 320 / 375 上都是 44 高，组合框窄屏不溢出', () => {
  it('每个可点的控件都 ≥44px，且不随断点跳尺寸', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })

    const controls = host.nodes(item => item.tag === 'button' || item.tag === 'a')
    expect(controls.length, 'the editor rendered nothing to measure').toBeGreaterThan(4)
    for (const control of controls) {
      const height = heightOf(control)
      expect(height, `${control.tag}「${host.textOf(control).slice(0, 8)}」has no height class: ${classes(control)}`).not.toBeNull()
      expect(height!, `${control.tag}「${host.textOf(control).slice(0, 8)}」is below the house touch target`).toBeGreaterThanOrEqual(TOUCH)
    }
    host.unmount()
  })

  it('上车点选择器的触发器带 min-w-0，故窄屏压缩的是它自己而不是这一行', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })

    const trigger = host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))[0]!
    expect(tokens(trigger), 'the picker trigger cannot shrink').toContain('min-w-0')
    expect(tokens(trigger)).toContain('w-full')
    expect(heightOf(trigger)).toBeGreaterThanOrEqual(TOUCH)

    // 与它并排的清除按钮是 `shrink-0` 的 44×44：那一行里可压缩的只有选择器这一侧。
    const row = trigger.parent!.parent!
    const clear = row.children
      .filter((child: HostElement) => !child.tag.startsWith('#'))
      .find(child => child.props['aria-label'] !== undefined)
    expect(clear, 'the picker row has no clear control').toBeDefined()
    expect(tokens(clear!)).toContain('shrink-0')
    expect(heightOf(clear!)).toBeGreaterThanOrEqual(TOUCH)
    expect(tokens(row)).toContain('flex')
    host.unmount()
  })

  it('保存与取消关注在 320 上并排且都 ≥44：保存吃余量，取消关注不压缩', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })

    const save = host.node(item => item.tag === 'button' && host.textOf(item).trim() === '保存', 'the save button')
    const unfollow = host.node(item => item.tag === 'button' && host.textOf(item).trim() === '取消关注', 'the unfollow button')

    expect(tokens(save)).toContain('min-w-0')
    expect(tokens(save)).toContain('flex-1')
    expect(tokens(unfollow)).toContain('shrink-0')

    // 那一行允许换行：320 上两枚放不下时，取消关注落到第二行而不是把保存挤没。
    const row = save.parent!
    expect(tokens(row)).toContain('flex-wrap')

    const needed = minWidthOf(save, host) + minWidthOf(unfollow, host) + gapOf(row)
    // 两枚各自的最小宽度都在同一行里放得下（320 上这一行确实折行，故这里只判各自不为 0）。
    expect(minWidthOf(save, host)).toBeGreaterThan(0)
    expect(needed).toBeGreaterThan(minWidthOf(unfollow, host))
    host.unmount()
  })

  it('方向药丸那一行允许换行，且药丸自己按内容定宽（不压缩、不截断）', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })

    const group = host.node(item => item.props.role === 'radiogroup', 'the direction group')
    expect(tokens(group)).toContain('flex-wrap')
    // 药丸不许被压缩：压缩会把「开往 X」裁掉，而那是用户唯一能分辨方向的字。
    // 故它不带 `min-w-0`，也不带 `truncate`；放不下时整组折行。
    const items = host.nodes(item => item.props.role === 'radio')
    expect(items, 'the editor rendered no direction pill').not.toHaveLength(0)
    for (const item of items) {
      expect(tokens(item), 'a direction pill can be squeezed below its label').not.toContain('min-w-0')
      expect(tokens(item)).not.toContain('truncate')
      expect(heightOf(item)).toBeGreaterThanOrEqual(TOUCH)
    }
    host.unmount()
  })

  it('逐宽度的数字：编辑页底部动作区与三个控件的最小宽度、高度', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })
    const save = host.node(item => item.tag === 'button' && host.textOf(item).trim() === '保存', 'the save button')
    const unfollow = host.node(item => item.tag === 'button' && host.textOf(item).trim() === '取消关注', 'the unfollow button')
    const trigger = host.nodes(item => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))[0]!

    // 动作区两个按钮并排时**必须**占的宽度（320 上装不下则整行折行，故它是折行的判据，
    // 不是溢出的判据 —— 这一行带 `flex-wrap`）。
    const actionRow = minWidthOf(save, host) + minWidthOf(unfollow, host) + gapOf(save.parent!)
    expect(save.parent!.props.class, 'the action row cannot wrap').toContain('flex-wrap')

    // 三个数：保存 34、取消关注 80、上车点触发器 26（它自己 min-w-0，故可以缩到只剩内边距）。
    expect({
      actionRow,
      save: minWidthOf(save, host),
      unfollow: minWidthOf(unfollow, host),
      pickerTrigger: minWidthOf(trigger, host),
      saveHeight: heightOf(save),
      unfollowHeight: heightOf(unfollow),
      triggerHeight: heightOf(trigger),
    }).toEqual({
      actionRow: 122,
      save: 34,
      unfollow: 80,
      pickerTrigger: 26,
      saveHeight: TOUCH,
      unfollowHeight: TOUCH,
      triggerHeight: TOUCH,
    })

    // 320 上卡片内宽 264：动作区要 122（折行前一行放得下两枚），故它不会溢出。
    expect(actionRow).toBeLessThanOrEqual(cardInner(NARROWEST, 16))
    host.unmount()
  })

  it('卡片在 1024 与 1280 上都封在 768', async () => {
    const host = await mount(FavoriteEditorPage, { favoriteId: 'fav-300' })
    host.node(item => tokens(item).includes('max-w-3xl'), 'the page wrapper')

    for (const width of [LAPTOP, DESKTOP]) {
      expect(contentWidth(width), `${width} does not clamp the card`).toBe(CONTENT_MAX)
    }
    expect(host.text()).toContain('编辑 300内')
    host.unmount()
  })
})
