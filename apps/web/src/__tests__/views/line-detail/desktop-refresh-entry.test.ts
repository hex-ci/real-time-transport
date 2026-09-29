import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
} from '../settings/settings-harness'
import LineDetail from '../../../views/line-detail/index.vue'

/**
 * 详情页在桌面端也有刷新入口。
 *
 * 缺陷的样子：F11 那唯一一个控件曾被整个包在移动端底部抽屉里，而那个容器在 md 起是 `display:none`
 * ——桌面端于是**根本没有**刷新入口，动作行里只有方向切换。本文件钉的是修复后的两件事：刷新控件
 * 落在 md 起才播的那条桌面动作行里（且不在 md 起隐藏的抽屉里），以及按下它走的是拥有冷却期的那一个
 * 端点、点名屏幕上这条线路 —— 桌面入口不是第二个冷却。
 *
 * 报站板（Konva）没有测试台，故用桩件替掉；动作行、移动端头部、刷新控件都是真的。
 */

vi.mock('../../../views/line-detail/components', async () => {
  const vue = await import('vue')
  const StationPopover = (await import('../../../views/line-detail/components/station-popover.vue')).default
  const DesktopActionBar = (await import('../../../views/line-detail/components/desktop-action-bar.vue')).default
  const MobileLineHeader = (await import('../../../views/line-detail/components/mobile-line-header.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  const RouteBoard = vue.defineComponent({
    name: 'RouteBoardStub',
    render: () => vue.h('div', { 'data-role': 'board' }),
  })
  return { RouteBoard, StationPopover, DesktopActionBar, MobileLineHeader, LineHero: Empty, LineLoadState: Empty }
})

const LINE = '010-52-0'
const OPPOSITE = '010-52-1'

const LINE_DETAIL = {
  lineId: LINE,
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

/** 一次成功的刷新：取得了一次读数，窗口已关闭。 */
function refreshAnswer(): unknown {
  const at = 1_700_000_000_000
  return {
    success: true,
    data: {
      dataClass: 'live',
      throttled: false,
      lastUpdatedAt: at,
      nextAllowedAt: at + 18_000,
      retryAfterSeconds: 18,
      lines: [{ lineId: LINE, direction: 0, lastUpdatedAt: at, dataSource: 'chelaile', isDegraded: false }],
    },
  }
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

const OBSERVER = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return [] }
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

/** 一个节点到根之间的所有祖先，最近的在前。 */
function ancestorsOf(node: HostElement): HostElement[] {
  const out: HostElement[] = []
  for (let current = node.parent; current; current = current.parent) out.push(current)
  return out
}

/** 一屏上的每一块刷新区域，按文档顺序。 */
function regions(host: MountedHost): HostElement[] {
  return host.nodes(node => node.props['aria-label'] === '数据刷新')
}

function refreshButtonIn(host: MountedHost, region: HostElement): HostElement {
  const found = host.nodes(node => node.tag === 'button' && node.props['aria-label'] === '刷新最新车况')
    .find(node => ancestorsOf(node).includes(region))
  if (!found) throw new Error('the refresh region holds no refresh button')
  return found
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('桌面端的刷新入口', () => {
  it('落在 md 起才播的那条动作行里，而不是 md 起隐藏的抽屉里', async () => {
    const host = await mountDetail()

    const region = regions(host)[0]
    expect(region, 'the page rendered no refresh entry').toBeDefined()

    // 动作行在 md 以下收起（hidden）、md 起才排开（md:flex）：桌面入口就在这一行里。
    const row = ancestorsOf(region!).find(node => classOf(node).includes('md:flex'))
    expect(row, 'the refresh entry is not inside the desktop action row').toBeDefined()
    // ……而它头顶没有任何在 md 起隐藏的祖先 —— 那正是原先把它整个藏掉的容器。
    expect(ancestorsOf(region!).filter(node => classOf(node).includes('md:hidden'))).toHaveLength(0)
    host.unmount()
  })

  it('按下它经拥有冷却期的那一个端点，点名屏幕上显示的这条线路', async () => {
    const host = await mountDetail()
    const button = refreshButtonIn(host, regions(host)[0]!)

    // 页面没有任何别的刷新禁用条件：有线路在屏就该按得下去。
    expect(button.props.disabled).toBe(false)
    await press(host, button)

    const posted = host.server.seen(/\/api\/transit\/refresh$/)
    expect(posted, 'the desktop entry spent no request on the cooldown endpoint').toHaveLength(1)
    expect(posted[0]!.body.lines).toEqual([{ lineId: LINE, direction: 0, cityCode: '027' }])
    host.unmount()
  })

  it('屏幕上两个入口各是各的实例，id 不互相遮挡', async () => {
    const host = await mountDetail()

    // 打开移动端抽屉（它在 md 起才隐藏，故桌面端平时并不渲染它）。
    await press(host, host.node(
      node => node.tag === 'button' && node.props.title === '在途车辆与线路详情',
      'the mobile info control',
    ))

    // 两处入口各一枚（桌面动作行那一份、抽屉那一份）。
    const entries = host.nodes(node => node.tag === 'button' && node.props['aria-label'] === '刷新最新车况')
    expect(entries, 'one of the two entries is missing').toHaveLength(2)

    // 两处入口各描述自己那一行；那两行 id 在整个屏幕上各只有一份，故一个入口的描述指不到另一个入口身上。
    const described = entries.map(button => String(button.props['aria-describedby']))
    expect(new Set(described).size, 'the two entries describe the same line').toBe(2)
    expect(described).toContain('refresh-freshness')
    expect(described).toContain('desktop-refresh-freshness')
    for (const id of ['refresh-freshness', 'desktop-refresh-freshness']) {
      expect(host.nodes(node => node.props.id === id), `${id} is not unique on the screen`).toHaveLength(1)
    }

    // 区域名只属于**两半同处一块**的那一份（桌面动作行里那一个）：抽屉那一份分处两处，两半各拿自己
    // 那一半，若它也取这个名字，同一页上就会有两个同名区域。
    expect(regions(host)).toHaveLength(1)
    expect(
      ancestorsOf(regions(host)[0]!).some(node => String(node.props.class ?? '').includes('md:hidden')),
      'the named region is the drawer half, not the desktop entry',
    ).toBe(false)
    host.unmount()
  })
})
