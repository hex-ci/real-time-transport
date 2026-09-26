import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '../../settings/__tests__/settings-harness'
import LineDetail from '../index.vue'

/**
 * 详情页弹窗里的上车点写入：写下去的是 (站名, 站序) 一对，清空是两列一起 null。
 *
 * 这一页是第二个能写上车点的地方（第一个是「设置 › 关注线路」的 picker）。同一个契约在这两处
 * 都成立：站名与站序是同一个站的两种说法，只写一半的那一次，读侧只能按名字 `find`，于是使用者
 * 选的「和平东桥 第36站」被读成第 1 站 —— 步行、距离、到站分钟、出门结论全按另一个站台算。
 * 清空也一样：只把站名置空会让站序留在行里，而且服务端会直接 400（两列必须一起给）。
 *
 * 这里钉的是**屏幕上按下去之后真正发出去的 PATCH body**：设站 = 一对 + 当前方向，清空 = 两列
 * 都 null 且不碰方向。报告板（Konva）没有测试台，所以用桩件替掉它 —— 但弹窗本身是真的，按钮
 * 也是使用者按的那个；被钉的是这一页自己拼出来的请求体。
 */

vi.mock('../components', async () => {
  const vue = await import('vue')
  // 真正的弹窗：被测控件是其中的按钮（`设为上班上车点` / `上班上车点 ✓`），
  // 桩件只会断言桩件自己的 emit。
  const StationPopover = (await import('../components/station-popover.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  // 报告板是 Konva，无 DOM 无法挂载：该桩件扮演交互所需的唯一部分——用户点一个站，
  // 带锚点打开弹窗。
  const RouteBoard = vue.defineComponent({
    name: 'RouteBoardStub',
    emits: ['select-station', 'close-station', 'station-anchor-change'],
    setup(_props, { emit, expose }) {
      expose({ getStationAnchor: () => STATION_ANCHOR })
      return () => vue.h(
        'button',
        {
          'type': 'button',
          'data-role': 'board-station',
          'onClick': () => emit('select-station', BOARDED_STATION, STATION_ANCHOR),
        },
        BOARDED_STATION.name,
      )
    },
  })
  return {
    RouteBoard,
    StationPopover,
    LineHero: Empty,
    LineLoadState: Empty,
    MobileLineHeader: Empty,
    DesktopActionBar: Empty,
  }
})

const FAV_ID = 'fav-300'
const UP = 'bus_027_300_0'
const DOWN = 'bus_027_300_1'
const DUP = '和平东桥'

/** 300内 方向 0：同一个名字在首末两站各出现一次（第 1 站与第 36 站）。 */
const BOARDED_STATION = { id: 's36', name: DUP, order: 36, interchanges: [] }
const STATION_ANCHOR = { screenX: 120, screenY: 240, radius: 12 }

const DIR0 = {
  lineId: UP,
  direction: 0,
  directionName: '开往 和平东桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: DUP, order: 1, interchanges: [] },
    { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
    BOARDED_STATION,
  ],
}

/** 已关注的线路，上午方向已选定。 */
const FAVOURITE = {
  id: FAV_ID,
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: '300内',
  preferredDirection: 0,
  displayOrder: 0,
  morningDirection: 0,
}

/**
 * 一个从不连接的 WebSocket：本页在挂载时打开一个，而这里不需要套接字。
 * 构造时 `readyState === OPEN` 使 `initWs` 不重试。
 */
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

function routes(favourite: Record<string, unknown>): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [favourite] })],
    // 仅线路详情：`/live?...` 与 `/stations/…/arrivals?...` 是不同的读取
    // （把详情答案给到站读取会让弹窗的 ETA 分支解引用该答案从不携带的字段）。
    [/\/api\/transit\/lines\/[^/?]+\?/, () => ({ success: true, data: DIR0 })],
    // 写入：用调用方索要的那行作答，使 store 自己的回读成为弹窗徽标状态的来源。
    [/\/api\/transit\/favorites\/fav-300$/, request => ({
      success: true,
      data: { ...favourite, ...(request.body as Record<string, unknown> ?? {}) },
    })],
  ]
}

async function mountDetail(favourite: Record<string, unknown>): Promise<MountedHost> {
  vi.stubGlobal('WebSocket', WebSocketStub)
  // reka-ui 的弹窗在挂载时用 ResizeObserver 量它的内容；本宿主没有，而设置装置的桩件不覆盖该全局。
  // 此处需要的是惰性：什么都不做布局。
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
    props: { id: UP, direction: '0', cityCode: '027' },
    routes: routes(favourite),
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 本页发出的每次写入，连同它发出的 body。 */
function writes(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.method === 'PATCH')
}

/** 在（桩件的）报告板上点一个站，它在上面打开真正的弹窗。 */
async function openPopover(host: MountedHost): Promise<void> {
  const board = host.node(
    item => item.props['data-role'] === 'board-station',
    'the board station control',
  )
  await press(host, board)
}

/** 弹窗自己针对某用途的通勤上车点控件。 */
function toggleStop(host: MountedHost, label: string): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === label,
    `the popover control 「${label}」`,
  )
}

describe('详情页弹窗：设上车点写的是这一对，清空写的是两列 null', () => {
  it('设为上班上车点 → PATCH 带上站名、站序与当前方向（站序是点的那一站）', async () => {
    const host = await mountDetail(FAVOURITE)

    await openPopover(host)
    await press(host, toggleStop(host, '设为上班上车点'))

    const patch = writes(host)
    expect(patch, 'the popover sent no write').toHaveLength(1)
    expect(patch[0]!.url).toContain(`/api/transit/favorites/${FAV_ID}`)
    // 一对随之传递，且站序是被点击的那一站（36，而非首个同名的第 1 站）。屏幕上的方向一并写入：
    // 没有给它编号的方向，这个站定位不到任何东西。
    expect(patch[0]!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36, morningDirection: 0 })
    host.unmount()
  })

  it('再按一次（同一个站）→ PATCH 把两列一起置 null，且不碰方向', async () => {
    const host = await mountDetail(FAVOURITE)

    await openPopover(host)
    await press(host, toggleStop(host, '设为上班上车点'))
    // 写入回读使同一站成为已存的上车点，故控件现在解绑它——那是清空路径。
    await press(host, toggleStop(host, '上班上车点 ✓'))

    const patch = writes(host)
    expect(patch, 'set + clear did not send exactly two writes').toHaveLength(2)
    expect(patch[1]!.body).toEqual({ morningStopName: null, morningStopOrder: null })
    // 方向刻意缺席：清空一个站不影响用户为本段选的方向，故日后重选只需该站。
    expect(patch[1]!.body, 'clearing the stop also cleared the direction').not.toHaveProperty('morningDirection')
    host.unmount()
  })

  it('正对照：清空后再设回同一个站，写的仍是一对（清空没有把设站弄坏）', async () => {
    const host = await mountDetail({
      ...FAVOURITE,
      morningStopName: DUP,
      morningStopOrder: 36,
    })

    await openPopover(host)
    await press(host, toggleStop(host, '上班上车点 ✓'))
    await press(host, toggleStop(host, '设为上班上车点'))

    const patch = writes(host)
    expect(patch, 'clear + re-pick did not send exactly two writes').toHaveLength(2)
    expect(patch[0]!.body).toEqual({ morningStopName: null, morningStopOrder: null })
    expect(patch[1]!.body).toEqual({ morningStopName: DUP, morningStopOrder: 36, morningDirection: 0 })
    host.unmount()
  })
})
