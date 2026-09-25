import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mountComponent,
  type HostElement,
  type MountedHost,
  type RecordedRequest,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import PlatformPage from '../index.vue'

/**
 * 站台页：刷新不清空已在屏上的行。
 *
 * 车主报告的原话是「站台大屏的刷新每次都清空列表刷新」。机制在页面与看板的接缝上：
 * 每一次重读（12 秒轮询、选站、GPS 对准）都从同一个 load 进入，它一进来就把 `loading`
 * 置真，而看板把整个表体挂在 `v-if="loading"` 上 —— 于是刷新期间行被整体卸载，页面塌成
 * 一行「正在加载车况数据...」，然后行再回来。这里的每条断言钉住修复后的形状：
 *
 * - 刷新进行中，行保持渲染，更新只以不打扰的方式示意（(a)、(d) 修复前为红）；
 * - 首载没有行可保留时，加载态照常出现（(b)，正向对照）；
 * - 刷新失败，行保持渲染，失败由行自己的既有措辞说出，且「最后更新」不被改写（(c)）；
 * - 「最后更新」永远是产生屏上行的那次响应自己的时刻（(d)）；
 * - 换站不是刷新：旧站的行随站而去，绝不留在新站名下（(e)，守卫）。
 *
 * 页面被挂载而不是被 grep，因为「哪一半状态在刷新时被渲染」正是这次改动本身。挂载走
 * 设置页的同一套无 DOM harness（本仓只有这一套，第二套会漂移）；站头换成可查探的惰性
 * 桩 —— 它驱动的原生 `<select>` 的 v-model 要写 `options.length`，这是 harness 有意不
 * 模拟的 DOM API。桩把 change/v-model 两个绑定摊到标记元素上，测试就能按真实顺序驱动
 * 一对：先 v-model 写入，再 change 事件。
 *
 * 默认站由 localeCompare 选出，测试不对它下注：需要「两条方向行都在屏」的场景，先显式
 * 切到两条规则都途经的「共用站」；那一次切换本身就是一次带行刷新，正好铺垫出前提，之后
 * 场景自己的那一次重读才是被断言的刷新。(b) 恰恰相反——它钉的就是首载，所以停在默认站上。
 *
 * 刻意不在测试里做的事：不伪造中间态、不引入时钟 —— 时刻断言用的期望值与页面同一种
 * 算法（本地时区的 HH:MM:SS），因此断言与时区无关。
 */

vi.mock('../components/platform-header.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'PlatformHeaderStub',
      props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
      setup(_props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
        // change / v-model 的 onXxx 绑定不声明为 emits，才落在 attrs 里、被摊到
        // 标记元素上，测试才有得驱动。真实 <select> 的顺序是先写值再发事件。
        return () => h('platform-header-stub', { ...attrs })
      },
    },
  }
})

/** The instants the live responses report as obtained. 2023-11-14, local tz in the assertions. */
const STAMP_A = 1_700_000_010_000
const STAMP_A2 = 1_700_000_030_000
const STAMP_B = 1_700_000_060_000

/** One followed route with both directions, as the store holds it. */
const FAVOURITE: Record<string, unknown> = {
  id: 'fav-1',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  lineName: '快线 1 路',
  preferredDirection: 0,
  reverseLineId: 'bus_027_2',
  displayOrder: 0,
}

/** A per-line detail: direction 0 serves 共用站/甲站/乙站, direction 1 serves 共用站/丙站. */
function detailBody(direction: 0 | 1): Record<string, unknown> {
  return {
    lineId: direction === 0 ? 'bus_027_1' : 'bus_027_2',
    lineName: '快线 1 路',
    direction,
    directionName: direction === 0 ? '开往甲乙方向' : '开往丙方向',
    firstBusTime: '05:00',
    lastBusTime: '23:30',
    cityCode: '027',
    type: 'bus',
    stops: direction === 0
      ? [
          { id: 's1', name: '共用站', order: 1, interchanges: [] },
          { id: 's2', name: '甲站', order: 2, interchanges: [] },
          { id: 's3', name: '乙站', order: 3, interchanges: [] },
        ]
      : [
          { id: 's1', name: '共用站', order: 1, interchanges: [] },
          { id: 's4', name: '丙站', order: 2, interchanges: [] },
        ],
  }
}

/** One targeted live answer: a vehicle priced for the requested stop, stamped by its source. */
function liveBody(lineId: string, stationOrder: number, stamp: number, travelSec: number) {
  return {
    success: true,
    data: {
      lineId,
      direction: 0,
      buses: [{
        id: `v_${lineId}`,
        order: 1,
        nextOrder: stationOrder,
        travelTimeSec: travelSec,
        congestion: 'low',
        updatedAt: stamp,
      }],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: stamp,
    },
  }
}

/** A promise a test resolves itself, so one round of answers can be held open. */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * Script the live route per lineId: each round consumes the next scripted step
 * (a value, or a deferred promise to hold open); past the script, nothing.
 */
function liveRounds(script: Record<string, Array<unknown>>): (request: RecordedRequest) => unknown {
  const round: Record<string, number> = {}
  return (request) => {
    const lineId = /\/lines\/([^/]+)\/live/.exec(request.url)?.[1] ?? ''
    const index = (round[lineId] = (round[lineId] ?? 0) + 1)
    const step = script[lineId]?.[index - 1]
    if (step === undefined) return { success: false }
    return step
  }
}

/** The shared station's fixed readings: 120 s and 300 s priced by their own source. */
const READ_A_1 = liveBody('bus_027_1', 1, STAMP_A, 120)
const READ_A_2 = liveBody('bus_027_2', 1, STAMP_A, 300)

function routes(live: (request: RecordedRequest) => unknown): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/bus_027_1\?/, () => ({ success: true, data: detailBody(0) })],
    [/\/api\/transit\/lines\/bus_027_2\?/, () => ({ success: true, data: detailBody(1) })],
    [/\/api\/transit\/lines\/.+\/live/, live],
  ]
}

async function mountPlatform(live: (request: RecordedRequest) => unknown): Promise<MountedHost> {
  const host = await mountComponent(PlatformPage, { routes: routes(live) })
  await host.flush()
  return host
}

/** Drive the station picker the way a real select does: v-model writes, then change fires. */
async function selectStation(host: MountedHost, name: string): Promise<void> {
  const stub = host.node(item => item.tag === 'platform-header-stub', 'station header stub')
  const write = stub.props['onUpdate:modelValue']
  const change = stub.props.onChange
  if (typeof write !== 'function' || typeof change !== 'function') {
    throw new Error('the header stub carries no v-model write or change handler')
  }
  ;(write as (value: string) => void)(name)
  ;(change as (event: unknown) => void)({ type: 'change', target: stub })
  await host.flush()
}

/**
 * Land the deterministic precondition: both direction rows for 共用站 on screen.
 * The switch itself is a refresh with rows in play, so by the time it returns
 * the screen holds two rows stamped STAMP_A — the state every scenario starts from.
 */
async function showBothRowsAtSharedStation(host: MountedHost): Promise<void> {
  await selectStation(host, '共用站')
  expect(rowTerminals(host)).toHaveLength(2)
}

/** The terminal spans, one per rendered row — the row count as the user sees it. */
function rowTerminals(host: MountedHost): string[] {
  return host
    .nodes((item: HostElement) => item.tag === 'span' && item.text.includes('开往'))
    .map(item => item.text.trim())
}

/** The minute values on screen — empty whenever no row carries a number. */
function minuteSpans(host: MountedHost): string[] {
  return host
    .nodes((item: HostElement) => item.tag === 'span' && /^\d+$/.test(item.text.trim()))
    .map(item => item.text.trim())
}

/** 「HH:MM:SS」 in the reader's own zone — the same shape the freshness line prints. */
function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('站台页：刷新不清空已在屏上的行', () => {
  it('(a) 刷新进行中：已在屏上的行保持渲染，加载态不出现', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gate1.promise],
      bus_027_2: [READ_A_2, gate2.promise],
    }))
    await showBothRowsAtSharedStation(host)

    // A same-station re-read: the refresh whose behaviour is under test.
    await selectStation(host, '共用站')
    await host.flush()

    // In flight: the SAME two rows are still on screen, minutes included, and
    // the board says an update is running instead of trading the list away.
    expect(rowTerminals(host), 'the rows must survive the in-flight refresh')
      .toHaveLength(2)
    expect(minuteSpans(host)).toEqual(expect.arrayContaining(['2', '5']))
    expect(host.text()).toContain('开往丙方向')
    expect(host.text()).not.toContain('正在加载车况数据')
    expect(host.text()).toContain('正在刷新…')

    gate1.resolve(liveBody('bus_027_1', 1, STAMP_A2, 240))
    gate2.resolve(liveBody('bus_027_2', 1, STAMP_A2, 600))
    await host.flush()

    // The new read lands into the kept rows.
    expect(minuteSpans(host)).toEqual(expect.arrayContaining(['4', '10']))
    expect(host.text()).not.toContain('正在刷新…')
    host.unmount()
  })

  it('(b) 首载还没有行：加载态照常渲染（正向对照）', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      // The default station is whichever localeCompare picks; direction 1 may
      // never be asked. Both gates are resolved either way — an unanswered
      // gate holds nothing that is awaited.
      bus_027_1: [gate1.promise],
      bus_027_2: [gate2.promise],
    }))

    // Nothing to show yet: the loading body is the honest state.
    expect(host.text()).toContain('正在加载车况数据...')
    expect(rowTerminals(host)).toEqual([])
    expect(minuteSpans(host)).toEqual([])

    // Direction 0's default station is its order-3 stop (乙站); direction 1's
    // shared-station answer would only be consumed if the default were 共用站.
    gate1.resolve(liveBody('bus_027_1', 3, STAMP_A, 120))
    gate2.resolve(READ_A_2)
    await host.flush()

    expect(minuteSpans(host)).toContain('2')
    expect(rowTerminals(host).length).toBeGreaterThan(0)
    expect(host.text()).not.toContain('正在加载车况数据...')
    host.unmount()
  })

  it('(c) 刷新失败：行保持渲染，由行说出失败，时刻不被改写', async () => {
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1],
      bus_027_2: [READ_A_2, READ_A_2],
    }))
    await showBothRowsAtSharedStation(host)
    const stampText = `最后更新 ${clockOf(STAMP_A)}`

    // The refresh never reaches an answer: every live request dies on the wire.
    host.server.on(/\/api\/transit\/lines\/.+\/live/, () => {
      throw new Error('upstream down')
    })
    await selectStation(host, '共用站')
    await host.flush()

    // The rows stay, and each states the failure with the board's own wording.
    expect(rowTerminals(host), 'a failed refresh must not trade the rows away')
      .toHaveLength(2)
    expect(host.text()).toContain('无法获取')
    expect(host.text()).toContain('数据暂不可用')
    // The board states the refresh failed, in the refresh family's own wording —
    // never left to be inferred from the rows.
    expect(host.text()).toContain('刷新失败')
    expect(host.text()).not.toContain('正在加载车况数据')
    // The instant on screen still describes the read the rows came from.
    expect(host.text()).toContain(stampText)
    host.unmount()
  })

  it('(d) 刷新进行中：「最后更新」仍是产生屏上行的那次读取的时刻', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gate1.promise],
      bus_027_2: [READ_A_2, READ_A_2, gate2.promise],
    }))
    await showBothRowsAtSharedStation(host)
    const stampText = `最后更新 ${clockOf(STAMP_A)}`

    await selectStation(host, '共用站')
    await host.flush()

    // In flight the instant is untouched — never stamped at request time —
    // and the busy word sits beside it, not instead of it.
    expect(host.text()).toContain(stampText)
    expect(host.text()).toContain('正在刷新…')
    expect(host.text()).not.toContain(clockOf(STAMP_A2))

    gate1.resolve(liveBody('bus_027_1', 1, STAMP_A2, 240))
    gate2.resolve(liveBody('bus_027_2', 1, STAMP_A2, 600))
    await host.flush()

    // Only the read that produced the NEW rows moves the line.
    expect(host.text()).toContain(`最后更新 ${clockOf(STAMP_A2)}`)
    expect(host.text()).not.toContain(stampText)
    expect(host.text()).not.toContain('正在刷新…')
    host.unmount()
  })

  it('(e) 换站不是刷新：旧站的行随站而去', async () => {
    const gateB = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gateB.promise],
      bus_027_2: [READ_A_2, READ_A_2],
    }))
    await showBothRowsAtSharedStation(host)

    // 甲站 is served by one direction only, and its answer is held open.
    await selectStation(host, '甲站')
    await host.flush()

    // In flight the board holds NOTHING of either station: the previous
    // station's rows left with the station, and the old stamp went with them.
    expect(host.text()).toContain('正在加载车况数据...')
    expect(rowTerminals(host)).toEqual([])
    expect(minuteSpans(host)).toEqual([])
    expect(host.text()).not.toContain('最后更新')

    gateB.resolve(liveBody('bus_027_1', 2, STAMP_B, 300))
    await host.flush()

    // The new station's single row, with its own read instant.
    expect(rowTerminals(host)).toEqual(['开往甲乙方向'])
    expect(minuteSpans(host)).toContain('5')
    expect(host.text()).toContain(`最后更新 ${clockOf(STAMP_B)}`)
    expect(host.text()).not.toContain('正在加载车况数据...')
    host.unmount()
  })
})
