import { afterEach, describe, expect, it, vi } from 'vitest'
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
 * 详情页「这条线路现在显示的是哪个方向」只能有一个来源。
 *
 * 页面上的方向号有两个体系，混用会让同一屏说一个号、写另一个号：
 *
 *  - payload 自己的方向号（`detail.direction`）：这一页要显示的那条线路自己的号，详情、
 *    到站、步行判断这些读取都按它走（地铁的方向就是它选出来的一条线）；
 *  - 收藏行自己的号（`morningDirection` / `eveningDirection`）：锚在 `preferredDirection`
 *    上，设置页的单选、首页卡片、回填脚本都按它读。
 *
 * 真实数据里这两套可以相反：52 路收藏行长这样 —— `lineId: '010-52-0'`（上游方向 0 的那条）、
 * `preferredDirection: 1`、`morningDirection: 0`（早上坐的是 `010-52-1` 那条）。
 *
 * 这一页以前把「当前方向」读成 URL 查询参数，而 URL 的号是谁写的就带谁的体系：首页卡片写的是
 * 收藏行的号，报站板的切换写的是 payload 的号。于是从报站板切过去的那一页，角标和「设上车点」
 * 一起消失（`matchingFavorite` 按 URL 的号去对收藏行，对不上）；页面显示的方向号和写进收藏行的
 * 号只在两者恰好一致时才相同。
 *
 * 这里钉的是屏幕上的行为：按 payload 的方向显示，写入时换算成收藏行自己的号，换算由
 * `@real-time-transport/shared/line-group` 的 `favoriteDirectionOfLine` 一处给出。
 *
 * 报站板（Konva）没有测试台，所以用桩件替掉，但桩件把收到的 props 原样渲染出来 —— 方向这条
 * 规则中「谁属于谁」的部分由此按行为可查；弹窗本身是真的，按钮也是用户按的那个。
 */

vi.mock('../components', async () => {
  const vue = await import('vue')
  const StationPopover = (await import('../components/station-popover.vue')).default
  // 真实的方向切换条：角标（🏠 上班方向 / 🏢 下班方向）就在它里面，桩件会让这一条断言变空。
  const DesktopActionBar = (await import('../components/desktop-action-bar.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  const RouteBoard = vue.defineComponent({
    name: 'RouteBoardStub',
    // 这一桩件声明的是它与详情页之间那条约定本身：页面要给报站板的东西，都被它原样渲染出来。
    // 其中的方向 props 在修复前根本不存在（今天没人传给报站板），于是断言先红。
    props: {
      lineDetail: { type: Object, default: null },
      shownDirection: { type: Number, default: null },
      morningStopDirection: { type: Number, default: null },
      eveningStopDirection: { type: Number, default: null },
    },
    emits: ['select-station', 'close-station', 'station-anchor-change'],
    setup(props, { emit, attrs, expose }) {
      expose({ getStationAnchor: () => STATION_ANCHOR })
      return () => vue.h(
        'div',
        { 'data-role': 'board', 'data-props': JSON.stringify({ ...props, ...attrs }) },
        [vue.h(
          'button',
          {
            'type': 'button',
            'data-role': 'board-station',
            'onClick': () => {
              const stops = (props.lineDetail as { stops: unknown[] } | null)?.stops ?? []
              emit('select-station', stops[0], STATION_ANCHOR)
            },
          },
          '首站',
        )],
      )
    },
  })
  return {
    RouteBoard,
    StationPopover,
    DesktopActionBar,
    LineHero: Empty,
    LineLoadState: Empty,
    MobileLineHeader: Empty,
  }
})

const FAV_ID = 'fav-52'
const UP = '010-52-0'
const DOWN = '010-52-1'
const DUP = '平乐园'
const STATION_ANCHOR = { screenX: 120, screenY: 240, radius: 12 }

/**
 * 52 路收藏行：存的是上游方向 0 的 lineId，自己却把它编号成方向 1；早上坐的是方向 0，
 * 也就是 `010-52-1` 那条线。上车点只存了站名（005 之前的行）。
 */
const FAVOURITE = {
  id: FAV_ID,
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: '52',
  preferredDirection: 1,
  morningDirection: 0,
  morningStopName: DUP,
  displayOrder: 1,
}

/** 上游方向 0 的那条线（收藏行编号里的方向 1）。桩件点的是首站，所以首站不是上车点那一站。 */
const DETAIL_UP = {
  lineId: UP,
  direction: 0,
  directionName: '开往 靛厂新村',
  otherDirectionLineId: DOWN,
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 'u1', name: '劲松', order: 12, interchanges: [] },
    { id: 'u2', name: DUP, order: 13, interchanges: [] },
  ],
}

/** 上游方向 1 的那条线（收藏行编号里的方向 0，也就是早上那条）。 */
const DETAIL_DOWN = {
  lineId: DOWN,
  direction: 1,
  directionName: '开往 潘道庙',
  otherDirectionLineId: UP,
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 'd1', name: '劲松', order: 7, interchanges: [] },
    { id: 'd2', name: DUP, order: 8, interchanges: [] },
  ],
}

/** 地铁：两个方向共用一条 lineId，payload 自己的号就是收藏行的号。 */
const SUBWAY_FAVOURITE = {
  id: 'fav-subway',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'subway_027_1',
  reverseLineId: 'subway_027_1',
  lineName: '地铁1号线支线',
  preferredDirection: 0,
  morningDirection: 1,
  displayOrder: 2,
}

const SUBWAY_DETAIL = {
  lineId: 'subway_027_1',
  direction: 1,
  directionName: '开往 青龙湖东',
  otherDirectionLineId: 'subway_027_1',
  cityCode: '027',
  type: 'subway',
  stops: [
    { id: 'm1', name: '八角游乐园', order: 4, interchanges: [] },
    { id: 'm2', name: '青龙湖东', order: 5, interchanges: [] },
  ],
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

/** 每一条线路的详情按它自己的 lineId 作答（两个方向是两条上游线路）。 */
function detailOf(url: string): Record<string, unknown> {
  if (url.includes(encodeURIComponent(DOWN))) return DETAIL_DOWN
  if (url.includes(encodeURIComponent('subway_027_1'))) return SUBWAY_DETAIL
  return DETAIL_UP
}

function routes(favourites: Array<Record<string, unknown>>): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: favourites })],
    [/\/api\/transit\/lines\/[^/?]+\?/, request => ({ success: true, data: detailOf(request.url) })],
    // 写入：按调用方送来的那一行作答，store 自己的回读就是弹窗角标状态的来源。
    [/\/api\/transit\/favorites\/[^/?]+$/, request => ({
      success: true,
      data: { ...FAVOURITE, ...(request.body as Record<string, unknown> ?? {}) },
    })],
  ]
}

async function mountDetail(
  id: string,
  direction: string,
  favourites: Array<Record<string, unknown>>,
): Promise<MountedHost> {
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
    props: { id, direction, cityCode: '027' },
    routes: routes(favourites),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

function writes(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.method === 'PATCH')
}

async function openPopover(host: MountedHost): Promise<void> {
  const board = host.node(
    item => item.props['data-role'] === 'board-station',
    'the board station control',
  )
  await press(host, board)
}

function toggleStop(host: MountedHost, label: string): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === label,
    `the popover control 「${label}」`,
  )
}

/** 报站板桩件收到的 props，键名统一成驼峰（模板里的 kebab 属性名也算在内）。 */
function boardProps(host: MountedHost): Record<string, any> {
  const board = host.node(item => item.props['data-role'] === 'board', 'the board')
  const raw = JSON.parse(String(board.props['data-props'])) as Record<string, any>
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value
  }
  return out
}

describe('详情页：显示的方向与写下的方向是同一个方向', () => {
  it('报站板切过去的那一页：角标语出这个方向上的通勤目的，写下的号是收藏行自己的号', async () => {
    // 从 /line/010-52-0?direction=0 按「另一个方向」的页签切过来就是这一页：报站板的页签写的是
    // payload 的号（1），而收藏行自己的号是 0 —— 两套号在这一行上恰好相反。
    const host = await mountDetail(DOWN, '1', [FAVOURITE])

    // 屏幕上的方向：这条线是收藏行编号里的方向 0，也就是使用者的上班方向。
    expect(host.text()).toContain('🏠 上班方向')

    await openPopover(host)
    await press(host, toggleStop(host, '设为上班上车点'))

    const patch = writes(host)
    expect(patch, 'the popover sent no write').toHaveLength(1)
    expect(patch[0]!.body).toEqual({ morningStopName: '劲松', morningStopOrder: 7, morningDirection: 0 })
    host.unmount()
  })

  it('正对照：首页卡片给的主方向页（URL 的号与收藏行的号本来就一致），写的仍是收藏行的号', async () => {
    // 首页卡片把收藏行的号写进 URL（方向 1 → lineId 010-52-0），payload 却说自己方向 0。
    const host = await mountDetail(UP, '1', [FAVOURITE])

    expect(host.text(), 'a direction that is not this leg’s purpose showed its badge').not.toContain('上班方向')

    await openPopover(host)
    await press(host, toggleStop(host, '设为上班上车点'))

    const patch = writes(host)
    expect(patch, 'the popover sent no write').toHaveLength(1)
    expect(patch[0]!.body).toEqual({ morningStopName: '劲松', morningStopOrder: 12, morningDirection: 1 })
    host.unmount()
  })

  it('正对照：地铁两个方向共用一条 lineId 时，payload 的号就是收藏行的号', async () => {
    const host = await mountDetail('subway_027_1', '1', [SUBWAY_FAVOURITE])

    expect(host.text()).toContain('🏠 上班方向')

    await openPopover(host)
    await press(host, toggleStop(host, '设为上班上车点'))

    const patch = writes(host)
    expect(patch, 'the popover sent no write').toHaveLength(1)
    expect(patch[0]!.body).toEqual({ morningStopName: '八角游乐园', morningStopOrder: 4, morningDirection: 1 })
    host.unmount()
  })

  it('控制：不是关注的线路，没有角标，也没有设上车点的控件', async () => {
    const host = await mountDetail(UP, '0', [])

    expect(host.text()).not.toContain('方向')
    await openPopover(host)
    expect(
      host.nodes(item => item.tag === 'button' && host.textOf(item).trim() === '设为上班上车点'),
      'an unfollowed line offered to store a board stop',
    ).toHaveLength(0)
    host.unmount()
  })

  it('报站板拿到的是收藏行编号里的方向：屏幕上的方向，以及两个上车点各自属于哪个方向', async () => {
    // 这一页显示的是收藏行编号里的方向 0（早上那条），所以上班上车点属于屏幕上的方向，
    // 下班方向没设置 —— 报站板据此才可能只在该方向标角标。
    const onMorningLine = await mountDetail(DOWN, '1', [FAVOURITE])
    const props = boardProps(onMorningLine)
    expect(props.shownDirection).toBe(0)
    expect(props.morningStopDirection).toBe(0)
    expect(props.eveningStopDirection).toBeNull()
    onMorningLine.unmount()

    // 另一条线是收藏行编号里的方向 1，与上班方向（0）不同：上车点不属于这一屏。
    const onOtherLine = await mountDetail(UP, '1', [FAVOURITE])
    const other = boardProps(onOtherLine)
    expect(other.shownDirection).toBe(1)
    expect(other.morningStopDirection).toBe(0)
    onOtherLine.unmount()
  })
})
