import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpStatus,
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
} from '../../settings/__tests__/settings-harness'
import { refreshFreshnessOf } from '@/stores/transit.store'
import LineDetail from '../index.vue'

/**
 * 移动端抽屉里的刷新入口：按钮坐在抽屉头部那一行（关闭按钮左边），「最后更新 / 状态」那两行字
 * 跟在头部下方。
 *
 * 它原先占着抽屉内容的最后一整行。这里钉的是搬过去之后仍必须成立的四件事：按钮的祖先链在头部
 * 那一行内、不是内容的最后一个子节点；抽屉里只有一个可点的刷新入口（控件被拆成两半不得拆出第二个）；
 * 按钮的 `aria-describedby` 指向的正是那两行字，且那两行字带着 store 交来的字；以及关闭抽屉时
 * 全页只有桌面动作行里那一枚。
 *
 * 报站板（Konva）没有测试台，故用桩件替掉；动作行、移动端头部、刷新控件都是真的。
 */

vi.mock('../components', async () => {
  const vue = await import('vue')
  const StationPopover = (await import('../components/station-popover.vue')).default
  const DesktopActionBar = (await import('../components/desktop-action-bar.vue')).default
  const MobileLineHeader = (await import('../components/mobile-line-header.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  const RouteBoard = vue.defineComponent({
    name: 'RouteBoardStub',
    render: () => vue.h('div', { 'data-role': 'board' }),
  })
  return { RouteBoard, StationPopover, DesktopActionBar, MobileLineHeader, LineHero: Empty, LineLoadState: Empty }
})

const LINE = '010-52-0'
const OPPOSITE = '010-52-1'
const LINE_NAME = '52路'

const LINE_DETAIL = {
  lineId: LINE,
  lineName: LINE_NAME,
  direction: 0,
  directionName: '开往 靛厂新村',
  otherDirectionLineId: OPPOSITE,
  cityCode: '027',
  type: 'bus',
  firstBusTime: '05:00',
  lastBusTime: '23:00',
  stops: [
    { id: 'u1', name: '劲松', order: 12, interchanges: [] },
    { id: 'u2', name: '平乐园', order: 13, interchanges: [] },
  ],
}

const READING_AT = 1_700_000_000_000

/** 一次成功的刷新：取得了一次读数，窗口已关闭。 */
function refreshAnswer(): unknown {
  return {
    success: true,
    data: {
      dataClass: 'live',
      throttled: false,
      lastUpdatedAt: READING_AT,
      nextAllowedAt: READING_AT + 18_000,
      retryAfterSeconds: 18,
      lines: [{ lineId: LINE, direction: 0, lastUpdatedAt: READING_AT, dataSource: 'chelaile', isDegraded: false }],
    },
  }
}

/** 一次被拒绝的按压：什么都没取到，窗口还剩十几秒。 */
function refusalAnswer(): unknown {
  const now = Date.now()
  return httpStatus(429, {
    success: false,
    error: '刷新太频繁',
    data: {
      dataClass: 'live',
      throttled: true,
      lastUpdatedAt: null,
      nextAllowedAt: now + 18_000,
      retryAfterSeconds: 18,
      lines: [],
    },
  })
}

const OBSERVER = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return [] }
}

class WebSocketStub {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = WebSocketStub.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

async function mountDetail(): Promise<MountedHost> {
  vi.stubGlobal('WebSocket', WebSocketStub)
  vi.stubGlobal('ResizeObserver', OBSERVER)
  vi.stubGlobal('MutationObserver', OBSERVER)
  vi.stubGlobal('IntersectionObserver', OBSERVER)
  const host = await mountComponent(LineDetail, {
    props: { id: LINE, direction: '0', cityCode: '027' },
    routes: [
      [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
      [/\/api\/transit\/refresh$/, () => refreshAnswer()],
      [/\/api\/transit\/lines\/[^/?]+\?/, () => ({ success: true, data: LINE_DETAIL })],
    ],
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

function classOf(node: HostElement): string {
  return String(node.props.class ?? '')
}

/**
 * 宿主树里元素节点与文本/注释节点的区分只有标签名前缀。
 *
 * 断言一律落到数字或布尔上，不把节点交给 `expect`：本宿主没有 `getAttributeNames`，
 * 一行失败的元素数组会变成序列化器的崩溃，把真正的原因盖掉。
 */
function isElement(node: HostElement): boolean {
  return !node.tag.startsWith('#')
}

function countOf(nodes: HostElement[]): number {
  return nodes.length
}

/** 一个节点到根之间的所有祖先，最近的在前。 */
function ancestorsOf(node: HostElement): HostElement[] {
  const out: HostElement[] = []
  for (let current = node.parent; current; current = current.parent) out.push(current)
  return out
}

/** 抽屉内容块里直接排着的那些元素，注释与空白文本不算。 */
function blocksOf(content: HostElement): HostElement[] {
  return content.children.filter(isElement)
}

function refreshEntries(host: MountedHost): HostElement[] {
  return host.nodes(node => node.tag === 'button' && node.props['aria-label'] === '刷新最新车况')
}

/** 抽屉内容本身：刷新按钮头顶那个在 md 起隐藏的容器。 */
function drawerContent(host: MountedHost): HostElement {
  const button = drawerRefreshButton(host)
  const content = ancestorsOf(button).find(node => classOf(node).includes('md:hidden'))
  if (!content) throw new Error('the drawer refresh button has no drawer around it')
  return content
}

/** 抽屉内容里那块可点的刷新入口。 */
function drawerRefreshButton(host: MountedHost): HostElement {
  const button = refreshEntries(host)
    .find(node => ancestorsOf(node).some(parent => classOf(parent).includes('md:hidden')))
  if (!button) throw new Error('the drawer holds no refresh entry')
  return button
}

/**
 * 那一行读数所占的那一块：它自己就是抽屉内容的直接子块 —— 读数那一半的根就是那一行字，
 * 故没有任何一层外壳隔着它。
 */
function linesBlock(host: MountedHost): HostElement {
  const line = freshnessLine(host)
  if (line.parent !== drawerContent(host)) throw new Error('the reading is not a block of the drawer content')
  return line
}

function drawerEntryCount(host: MountedHost, block: HostElement): number {
  return refreshEntries(host).filter(node => ancestorsOf(node).some(parent => parent === block)).length
}

async function openDrawer(host: MountedHost): Promise<void> {
  await press(host, host.node(
    node => node.tag === 'button' && node.props.title === '在途车辆与线路详情',
    'the mobile info control',
  ))
}

function freshnessLine(host: MountedHost): HostElement {
  return host.node(node => node.props.id === 'refresh-freshness', 'the freshness line')
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('移动端抽屉里的刷新入口', () => {
  it('按钮坐在抽屉头部那一行：与关闭按钮同一行，且不再是内容末尾的一整行', async () => {
    const host = await mountDetail()
    await openDrawer(host)

    const button = drawerRefreshButton(host)
    const close = host.node(
      node => node.tag === 'button' && node.props['aria-label'] === '关闭线路信息',
      'the close control',
    )
    const content = drawerContent(host)
    const blocks = blocksOf(content)

    const row = ancestorsOf(button).find(node => classOf(node).includes('justify-between'))
    expect(row, 'the refresh button is not in the drawer header row').toBeDefined()
    // 那一行是内容的头一块，且它同时装着线路名与关闭控件 —— 是整条头部，不是头部右边那一小组。
    expect(row!.parent === content, 'the header row is not the drawer content\'s own child').toBe(true)
    expect(blocks[0] === row, 'the header row is no longer the first block').toBe(true)
    expect(ancestorsOf(close).includes(row!), 'the close control is not in that row').toBe(true)
    expect(host.textOf(row!).includes(LINE_NAME), 'the header row is not the one naming the line').toBe(true)

    // 旧缺陷的样子：控件自己就是内容的最后一个子节点。
    expect(blocks[blocks.length - 1] === row, 'the refresh entry is still the content\'s last block').toBe(false)
  })

  it('那一行读数跟在头部下方，是内容里紧接头部的下一块', async () => {
    const host = await mountDetail()
    await openDrawer(host)

    const content = drawerContent(host)
    const block = linesBlock(host)
    const blocks = blocksOf(content)
    expect(blocks[0] !== block, 'the reading took the header row\'s place').toBe(true)
    expect(blocks[1] === block, 'the reading is not directly under the header').toBe(true)
    // 那一块就是这一行字本身：读数那一半的根是它，故没有外壳。
    expect(block === freshnessLine(host), 'the reading is not the block').toBe(true)
    // 头部与那一行读数都排在内容里，故「头部下方」是同一块里的相邻两块，而不是搬到了别处。
    expect(ancestorsOf(block).includes(content)).toBe(true)
  })

  it('抽屉里只有一个可点的刷新入口', async () => {
    const host = await mountDetail()
    await openDrawer(host)

    const content = drawerContent(host)
    // 两个布局各一枚 —— md 起只有动作行里那枚可见，md 以下只有抽屉里这枚。
    expect(countOf(refreshEntries(host)), 'the page no longer holds one entry per layout').toBe(2)
    expect(countOf(refreshEntries(host).filter(node => ancestorsOf(node).includes(content))),
      'the drawer grew a second entry').toBe(1)

    // 那两行字那一半一个可点的东西都没有。
    expect(drawerEntryCount(host, linesBlock(host)), 'the two-line half grew a clickable half').toBe(0)
    expect(countOf(host.nodes(node => node.tag === 'button' && ancestorsOf(node).includes(linesBlock(host)))),
      'the two-line half holds a control').toBe(0)
  })

  it('按钮说明的正是头部下方那一行读数，且它带着 store 交来的字', async () => {
    const host = await mountDetail()
    await openDrawer(host)
    await press(host, drawerRefreshButton(host))

    const content = drawerContent(host)
    const ids = String(drawerRefreshButton(host).props['aria-describedby']).split(' ')
    // 一次让界面持有读数的答案，故那一行有话可说，而按钮描述的就是它。
    expect(ids).toEqual(['refresh-freshness'])

    const described = host.nodes(node => node.props.id === ids[0]!)
    expect(countOf(described), `${ids[0]} is not rendered exactly once`).toBe(1)
    expect(ancestorsOf(described[0]!).includes(content), `${ids[0]} sits outside the drawer`).toBe(true)
    expect(described[0] === freshnessLine(host), 'the button describes something other than the reading').toBe(true)

    // 它逐字等于 store 那一句。
    expect(host.textOf(described[0]!)).toBe(refreshFreshnessOf(host.store.refreshReading).text)
  })

  it('被拒绝的那一次：这一次的结局不落在页面上', async () => {
    const host = await mountDetail()
    await openDrawer(host)
    host.server.on(/\/api\/transit\/refresh$/, () => refusalAnswer())

    await press(host, drawerRefreshButton(host))

    expect(host.store.refreshOutcome).toBe('throttled')
    // 读数仍是 store 那一句原文：拒绝不给它添一个字，也不替它改一个字。
    expect(host.textOf(freshnessLine(host))).toBe(refreshFreshnessOf(host.store.refreshReading).text)
    // 而那个结局由全局提示说：页面上一个状态词都没有。
    expect(host.text()).not.toContain('刷新太频繁')
    expect(host.nodes(node => node.props.id === 'refresh-status')).toHaveLength(0)
  })

  it('抽屉关着时全页只有桌面动作行里那一枚', async () => {
    const host = await mountDetail()

    const entries = refreshEntries(host)
    expect(countOf(entries), 'the closed drawer left a second entry on the page').toBe(1)

    const desktop = entries[0]!
    expect(ancestorsOf(desktop).some(node => classOf(node).includes('md:flex')),
      'the remaining entry is not the desktop action row\'s one').toBe(true)
    expect(countOf(ancestorsOf(desktop).filter(node => classOf(node).includes('md:hidden'))),
      'the desktop entry sits under a container md hides').toBe(0)
  })
})
