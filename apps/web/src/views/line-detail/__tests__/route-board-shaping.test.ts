import { afterEach, describe, expect, it, vi } from 'vitest'
import { distanceToSegment } from '@real-time-transport/shared/geo'
import type { Station } from '@real-time-transport/shared'
import { computeRouteLayout } from '@/composables/use-route-layout'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '../../settings/__tests__/settings-harness'
import LineDetail from '../index.vue'

/**
 * F6：线路拓扑报站屏的**成形数据与站台角标**（界面层）。
 *
 * 画布本身（Konva 图层、机车图元、像素）在这个仓库里没有测试台 —— 没有 jsdom、没有
 * `@vue/test-utils`，也没有 canvas；故此处刻意不碰像素，钉的是画布之外、但决定画什么的那些事实：
 *
 *  - 页面交给报站板的站表序列（数据源自己的顺序，界面不得按站序或名字重排）；
 *  - 页面交给报站板的车辆（每辆车带自己那次读数里的位置，界面不得从站表重算）；
 *  - 板把「离起点距离」投影成拓扑上的点所用的那两个公开函数（站台自己的距离落在该站节点上、
 *    两站之间落在它们之间、折返的第二行沿它自己的方向走）；
 *  - 站台面板每一行陈述自己的到站分钟（有则给数字，没有则陈述缺失）；
 *  - 当前方向上能画出的上车点角标：命名+站序成对认站，故同名站里恰有一个；切到反方向后一个也没有。
 *
 * 画布上那个角标节点（`board-stop-badge-*`）与它画出来的样子属浏览器 e2e。
 */

const ANCHOR = { screenX: 120, screenY: 240, radius: 12, x: 12, y: 24 }
const BADGE_TEXTS = ['🏠 上班方向', '🏢 下班方向']

vi.mock('../components', async () => {
  const vue = await import('vue')
  const StationPopover = (await import('../components/station-popover.vue')).default
  // 真实的两个头部：方向徽标（🏠/🏢）就在它们里面。
  const DesktopActionBar = (await import('../components/desktop-action-bar.vue')).default
  const MobileLineHeader = (await import('../components/mobile-line-header.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  /**
   * 报站板没有测试台（Konva 要 canvas），故用桩件替掉；桩件把收到的 props 原样渲染出来，
   * 并给每一站一个可点的控件 —— 于是「页面交给板的是什么」按行为可查，而不是 grep 源码。
   */
  const RouteBoard = vue.defineComponent({
    name: 'RouteBoardStub',
    props: {
      lineDetail: { type: Object, default: null },
      buses: { type: Array, default: () => [] },
      nearestStation: { type: Object, default: null },
      selectedStation: { type: Object, default: null },
      shownDirection: { type: Number, default: null },
      morningStopName: { type: String, default: null },
      morningStopOrder: { type: Number, default: null },
      morningStopDirection: { type: Number, default: null },
      eveningStopName: { type: String, default: null },
      eveningStopOrder: { type: Number, default: null },
      eveningStopDirection: { type: Number, default: null },
    },
    emits: ['select-station', 'close-station', 'station-anchor-change', 'layout-change'],
    setup(props, { emit, attrs, expose }) {
      expose({ getStationAnchor: () => ANCHOR, setLayoutMode: () => {} })
      return () => {
        const stops = ((props.lineDetail as { stops?: Station[] } | null)?.stops ?? [])
        return vue.h(
          'div',
          { 'data-role': 'board', 'data-props': JSON.stringify({ ...props, ...attrs }) },
          stops.map((stop, index) => vue.h(
            'button',
            {
              'type': 'button',
              'data-role': `board-station-${index}`,
              'onClick': () => emit('select-station', stop, ANCHOR),
            },
            stop.name,
          )),
        )
      }
    },
  })
  return {
    RouteBoard,
    StationPopover,
    DesktopActionBar,
    MobileLineHeader,
    LineHero: Empty,
    LineLoadState: Empty,
  }
})

const UP = '010-52-0'
const DOWN = '010-52-1'

/** 板画的站表：10 站；390px 视口下每行 5 站，于是第二行是折返回来的那一行。 */
const LINE_STOPS: Station[] = Array.from({ length: 10 }, (_, i) => ({
  id: `st-${i + 1}`,
  name: `站${i + 1}`,
  order: i + 1,
  interchanges: [],
}))
/** 每站自起点的里程，与上面那张站表同一份读数。 */
const STATION_DISTANCES = LINE_STOPS.map((_, i) => i * 800)

/** 站表刻意与站序号不同序：数据源给的序列就是线路的遍历顺序。 */
const SHUFFLED_STOPS: Station[] = [
  { id: 'st-丙', name: '丙站', order: 3, interchanges: [] },
  { id: 'st-甲', name: '甲站', order: 1, interchanges: [] },
  { id: 'st-乙', name: '乙站', order: 2, interchanges: [] },
]

/** 同名两站：一个线路上合法地出现两次，认站必须靠 (名字, 站序) 这一对。 */
const TWIN_STOPS: Station[] = [
  { id: 'tw-a1', name: '甲站', order: 2, interchanges: [] },
  { id: 'tw-b', name: '乙站', order: 5, interchanges: [] },
  { id: 'tw-a2', name: '甲站', order: 7, interchanges: [] },
]

/** 52 路的收藏行：存的是上游方向 0 的 lineId，自己把它编号成方向 1，早上坐的是方向 0。 */
const FAVOURITE = {
  id: 'fav-52',
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: '52',
  preferredDirection: 1,
  morningDirection: 0,
  morningStopName: '甲站',
  morningStopOrder: 2,
  displayOrder: 1,
}

interface LiveBus {
  id: string
  order: number
  nextOrder: number
  distanceFromStart: number
  speed: number
}

function detailOf(lineId: string, stops: Station[], direction: number): Record<string, unknown> {
  return {
    lineId,
    direction,
    directionName: direction === 0 ? '开往 靛厂新村' : '开往 潘道庙',
    otherDirectionLineId: direction === 0 ? DOWN : UP,
    cityCode: '027',
    type: 'bus',
    routeLengthMeters: 7200,
    stationDistances: STATION_DISTANCES,
    stops,
  }
}

/** 页面订阅的 WS 推送：桩件只让 `initWs` 挂上侦听，不投递任何消息。 */
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

interface MountOptions {
  lineId: string
  direction: string
  stops: Station[]
  favourites: Array<Record<string, unknown>>
  buses?: LiveBus[]
  arrivals?: Record<string, unknown>
}

function routesFor(options: MountOptions): Route[] {
  const detail = detailOf(options.lineId, options.stops, options.lineId === DOWN ? 1 : 0)
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: options.favourites })],
    [/\/stations\/[^/?]+\/arrivals/, () => ({ success: true, data: options.arrivals })],
    [/\/live\?/, () => ({
      success: true,
      data: {
        lineId: options.lineId,
        direction: detail.direction,
        buses: options.buses ?? [],
        dataSource: 'chelaile',
        isDegraded: false,
        updatedAt: 1_700_000_000_000,
      },
    })],
    [/\/api\/transit\/lines\/[^/?]+\?/, () => ({ success: true, data: detail })],
  ]
}

async function mountDetail(options: MountOptions): Promise<MountedHost> {
  // 页面在真实浏览器里靠这三样活着：WS 推送、reka-ui 弹层的尺寸观察器、以及 vueuse 的间隔助手。
  // 桩件只应答它们的调用，故挂载不会因为环境缺失而失败，也就不会把行为断言变成环境断言。
  vi.stubGlobal('WebSocket', WebSocketStub)
  class ObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return [] }
  }
  vi.stubGlobal('ResizeObserver', ObserverStub)
  vi.stubGlobal('MutationObserver', ObserverStub)
  vi.stubGlobal('IntersectionObserver', ObserverStub)
  const host = await mountComponent(LineDetail, {
    props: { id: options.lineId, direction: options.direction, cityCode: '027' },
    routes: routesFor(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 报站板桩件收到的 props，键名统一成驼峰。 */
function boardProps(host: MountedHost): Record<string, any> {
  const board = host.node(item => item.props['data-role'] === 'board', 'the board')
  const raw = JSON.parse(String(board.props['data-props'])) as Record<string, any>
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value
  }
  return out
}

/** 点中报站板上的第 index 站。 */
async function openStation(host: MountedHost, index: number): Promise<void> {
  const control = host.node(
    item => item.props['data-role'] === `board-station-${index}`,
    `the board station control #${index}`,
  )
  await press(host, control)
}

/** 屏幕上陈述通勤目的的徽标（两个头部各渲染同一句话一次）。 */
function purposeBadges(host: MountedHost): HostElement[] {
  return host.nodes(item => BADGE_TEXTS.includes(host.textOf(item)))
}

describe('F6 · 报站板拿到的数据是这一条线路自己的', () => {
  it('站序顺序不被重排：板上的站表就是数据源给的序列', async () => {
    const host = await mountDetail({ lineId: UP, direction: '1', stops: SHUFFLED_STOPS, favourites: [] })

    const stops = boardProps(host).lineDetail.stops as Station[]
    // 数据源的序列是线路的遍历顺序：按站序号或按名字重排都会让图上的站序与线路实际顺序不一致。
    expect(stops.map(stop => stop.id)).toEqual(['st-丙', 'st-甲', 'st-乙'])
    expect(stops.map(stop => stop.order)).toEqual([3, 1, 2])
    host.unmount()
  })

  it('每辆车带着自己那次读数里的位置：板不从站表重算', async () => {
    const buses: LiveBus[] = [
      { id: 'b1', order: 1, nextOrder: 2, distanceFromStart: 500, speed: 6 },
      { id: 'b2', order: 6, nextOrder: 7, distanceFromStart: 4_600, speed: 0 },
    ]
    const host = await mountDetail({
      lineId: UP,
      direction: '1',
      stops: LINE_STOPS,
      favourites: [],
      buses,
    })

    // 位置是读数的一部分（自起点米数），界面只把它交给板；重算或补一个 0 都会把车画到别处。
    expect(boardProps(host).buses).toEqual(buses)
    host.unmount()
  })
})

describe('F6 · 车辆在拓扑上的投影', () => {
  const layout = computeRouteLayout(LINE_STOPS, {
    mode: 'folded',
    viewportWidth: 390,
    paddingX: 20,
    paddingY: 24,
    rowHeight: 86,
    linearStepX: 96,
  })

  /** 板把米数变成画布上的点：先落在哪一段，再在该段内插值。 */
  function project(distanceFromStart: number): { x: number, y: number, angleDeg: number } {
    const segment = distanceToSegment(distanceFromStart, STATION_DISTANCES)
    expect(segment).not.toBeNull()
    return layout.getInterpolatedPosition(segment!.index + 1, segment!.progress)
  }

  it('站台自己的里程落在该站节点上，两站之间落在它们之间', () => {
    expect(layout.stopsPerRow).toBe(5)
    // 第 3 站自己的里程 → 就是第 3 站那个节点。
    expect(project(STATION_DISTANCES[2]!)).toEqual({
      x: layout.points[2]!.x,
      y: layout.points[2]!.y,
      angleDeg: 0,
    })
    // 第 3 站与第 4 站之间：落在两者之间的同一条线上。
    const between = project(STATION_DISTANCES[2]! + 400)
    expect(between.x).toBeGreaterThan(layout.points[2]!.x)
    expect(between.x).toBeLessThan(layout.points[3]!.x)
    expect(between.y).toBe(layout.points[2]!.y)
  })

  it('折返的第二行沿它自己的方向走：里程增加时位置向左，不是永远向右', () => {
    const rowOneSeventh = layout.points[6]!
    const rowOneEighth = layout.points[7]!
    // 第二行是折返回来的那一行：第 7 站在第 8 站的右边。
    expect(rowOneSeventh.row).toBe(1)
    expect(rowOneSeventh.x).toBeGreaterThan(rowOneEighth.x)

    // 车从第 7 站开到第 8 站，位置沿这一行向左移动，且仍在这一行上。
    const atSeventh = project(STATION_DISTANCES[6]!)
    const midway = project(STATION_DISTANCES[6]! + 400)
    expect(midway.x).toBeGreaterThan(rowOneEighth.x)
    expect(midway.x).toBeLessThan(atSeventh.x)
    expect(midway.y).toBe(rowOneSeventh.y)
  })
})

describe('F6 · 站台面板与上车点角标', () => {
  it('每一行陈述自己的到站分钟：有分钟的给数字，没有的陈述缺失', async () => {
    const withMinute = await mountDetail({
      lineId: UP,
      direction: '1',
      stops: LINE_STOPS,
      favourites: [],
      arrivals: {
        arrivals: [{ busId: 'b1', order: 3, nextOrder: 3, etaSeconds: 420, time: '14:07', stopsAway: 2 }],
        operatingStatus: { state: 'running', firstDeparture: '05:00', lastDeparture: '23:00' },
      },
    })
    await openStation(withMinute, 2)
    expect(withMinute.text()).toContain('预计 7 分钟到达')
    expect(withMinute.text()).not.toContain(ARRIVAL_MINUTE_UNAVAILABLE_TEXT)
    withMinute.unmount()

    const withoutMinute = await mountDetail({
      lineId: UP,
      direction: '1',
      stops: LINE_STOPS,
      favourites: [],
      arrivals: {
        // 数据源对这辆车没有发布到站时间：行还在，分钟不在。
        arrivals: [{ busId: 'b1', order: 3, nextOrder: 3, stopsAway: 3 }],
        operatingStatus: { state: 'running', firstDeparture: '05:00', lastDeparture: '23:00' },
      },
    })
    await openStation(withoutMinute, 2)
    expect(withoutMinute.text()).toContain(ARRIVAL_MINUTE_UNAVAILABLE_TEXT)
    // 缺分钟的一行不得被造出一个数字：这里没有「预计 N 分钟」这种陈述。
    expect(withoutMinute.text()).not.toMatch(/预计\s*\d+\s*分钟/)
    withoutMinute.unmount()
  })

  it('同名的两站里恰有一个算这个目的的上车点：认站靠(名字, 站序)这一对', async () => {
    const host = await mountDetail({
      lineId: UP,
      direction: '1',
      stops: TWIN_STOPS,
      favourites: [FAVOURITE],
    })

    // 收藏行存的是 (甲站, 第 2 站)：这一个才是上车点。
    await openStation(host, 0)
    expect(host.text()).toContain('上班上车点 ✓')
    await press(host, host.node(item => item.props['data-role'] === 'board-station-2', 'the twin station'))
    // 同名但站序不同：它不是使用者选的那一站，绝不能被一起标上。
    expect(host.text()).toContain('设为上班上车点')
    expect(host.text()).not.toContain('上班上车点 ✓')
    host.unmount()
  })

  it('当前方向的角标恰有一个；切到反方向后一个也没有', async () => {
    // 这一屏画的是收藏行编号里的方向 0，也就是早上那条：屏幕上只服务一个目的。
    const onMorningLine = await mountDetail({
      lineId: DOWN,
      direction: '1',
      stops: LINE_STOPS,
      favourites: [FAVOURITE],
    })
    const badges = purposeBadges(onMorningLine)
    expect(new Set(badges.map(badge => onMorningLine.textOf(badge)))).toEqual(new Set(['🏠 上班方向']))
    // 移动头部与桌面操作栏各一处 —— 同一句话，同一个来源。
    expect(badges, 'the two headers do not both state the purpose').toHaveLength(2)
    const morningProps = boardProps(onMorningLine)
    expect(morningProps.shownDirection).toBe(0)
    // 板上只有这一个目的的方向与本屏相同，故画布上的上车点角标至多一个。
    expect([morningProps.morningStopDirection, morningProps.eveningStopDirection]
      .filter((direction: number | null) => direction === morningProps.shownDirection)).toHaveLength(1)
    onMorningLine.unmount()

    // 切到反方向：这一屏不服务任何已存的目的，角标一个都没有。
    const onOtherLine = await mountDetail({
      lineId: UP,
      direction: '1',
      stops: LINE_STOPS,
      favourites: [FAVOURITE],
    })
    expect(purposeBadges(onOtherLine)).toHaveLength(0)
    const otherProps = boardProps(onOtherLine)
    expect(otherProps.shownDirection).toBe(1)
    expect([otherProps.morningStopDirection, otherProps.eveningStopDirection]
      .filter((direction: number | null) => direction === otherProps.shownDirection)).toHaveLength(0)
    onOtherLine.unmount()
  })
})
