import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { operatingDaySecondsOf } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream, type LineFixture } from './support/upstream-mock.js'

/**
 * F3：收班与末班表达。
 *
 * 三态由**线路自己的首末班**判定，因此夹具直接给那两个时刻。两条约束是本文件的重点：
 * 「读不到时刻」与「确实不运营」是两个答案，不得互相冒充；而没有车（空到站列表）与已收班
 * 也不是同一个答案 —— 因此下面有一对同样的空列表、两个不同的状态。
 *
 * 窗口按运营日相对此刻取：04:00 是运营日的起点，可表达的最早边界就是它、最晚是次日 03:59，
 * 因此在 04:00 前后各一分钟里这些状态表达不出来（04:00–04:02 尤其）。那是运营日模型的
 * 边界，不是被测逻辑的边界。
 */

const DAY_SECONDS = 24 * 3600

/** 运营日里能表达的最早 / 最晚边界（04:00 与次日 03:59）。 */
const EARLIEST = 4 * 3600
const LATEST = 100740

/** 运营日秒数 → 上游「HH:MM」写法；能原样过读侧 <04:00 时 +24h 的归一化。 */
function clockInOperatingDay(seconds: number): string {
  const daySeconds = ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS
  const hour = Math.floor(daySeconds / 3600)
  const minute = Math.floor((daySeconds % 3600) / 60)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 首末班只到分钟，因此所有相对窗口先向下取整到整分。 */
function minuteFloor(seconds: number): number {
  return Math.floor(seconds / 60) * 60
}

interface OperatingStatusView {
  state: string
  firstDeparture: string | null
  lastDeparture: string | null
}

interface StationsView {
  arrivals: unknown[]
  operatingStatus: OperatingStatusView
}

describeEachStore('F3 · 运营状态', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /**
   * 两站的线路夹具；站台没有坐标，因此运营状态与参考行互不牵连。
   * `label` 必须逐条不同：夹具 id 是「本次运行 + 标签」，同标签的两条线路会撞成同一个 id。
   */
  function fixture(label: string, times: { firstTime?: string, lastTime?: string }): LineFixture {
    return {
      lineId: api.fixtureId(label),
      lineName: '夹具线路',
      stops: [{ name: '站1' }, { name: '站2' }],
      ...times,
    }
  }

  async function statusOf(lineId: string): Promise<StationsView> {
    const res: LightMyRequestResponse = await api.inject({
      method: 'GET',
      url: `/api/transit/lines/${lineId}/stations/${encodeURIComponent('站1')}/arrivals`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: StationsView }).data
  }

  it('没有在途车时：有窗口是「运营中」，窗口之外是「末班车已过」—— 同一个空列表，两个答案', async () => {
    const nowSec = operatingDaySecondsOf()
    const endedSec = Math.max(EARLIEST + 60, minuteFloor(nowSec) - 60)
    const open = fixture('open', { firstTime: '04:00', lastTime: '03:59' })
    const closed = fixture('closed', { firstTime: '04:00', lastTime: clockInOperatingDay(endedSec) })
    installUpstream(api.upstream, { lines: [open, closed] })

    const openBody = await statusOf(open.lineId)
    const closedBody = await statusOf(closed.lineId)

    // 两者的到站列表都是空的：空列表本身分不出「运营中但没有车」与「今天已经收班」。
    expect(openBody.arrivals).toEqual([])
    expect(closedBody.arrivals).toEqual([])
    expect(openBody.operatingStatus).toEqual({
      state: 'operating',
      firstDeparture: '04:00',
      lastDeparture: '03:59',
    })
    expect(closedBody.operatingStatus).toEqual({
      state: 'after_last',
      firstDeparture: '04:00',
      lastDeparture: clockInOperatingDay(endedSec),
    })
  })

  it('此刻在首班之前 → 首班车之前，并给出今天那一刻', async () => {
    const nowSec = operatingDaySecondsOf()
    const firstSec = Math.min(LATEST - 60, minuteFloor(nowSec) + 60)
    const line = fixture('before-first', { firstTime: clockInOperatingDay(firstSec), lastTime: '03:59' })
    installUpstream(api.upstream, { lines: [line] })

    const body = await statusOf(line.lineId)
    expect(body.arrivals).toEqual([])
    expect(body.operatingStatus).toEqual({
      state: 'before_first',
      firstDeparture: clockInOperatingDay(firstSec),
      lastDeparture: '03:59',
    })
  })

  it('首末班都读不到 → 未知，绝不默认成运营中', async () => {
    const line = fixture('no-hours', {})
    installUpstream(api.upstream, { lines: [line] })

    const body = await statusOf(line.lineId)
    // 未知是「什么都没有读到」这个事实，不是一个较差的运营中：两个端点都给 null。
    expect(body.operatingStatus).toEqual({ state: 'unknown', firstDeparture: null, lastDeparture: null })
  })

  it('只读到一端 → 未知，但已读到的那一端如实回报', async () => {
    const line = fixture('half-window', { firstTime: '06:00' })
    installUpstream(api.upstream, { lines: [line] })

    const body = await statusOf(line.lineId)
    // 服务窗口是一对：半截窗口说明不了什么，因此状态未知，但已持有的值不得被丢掉。
    expect(body.operatingStatus).toEqual({ state: 'unknown', firstDeparture: '06:00', lastDeparture: null })
  })

  it('窗口终点不晚于起点 → 未知，不得断成运营中', async () => {
    const line = fixture('contradictory', { firstTime: '22:00', lastTime: '06:00' })
    installUpstream(api.upstream, { lines: [line] })

    const body = await statusOf(line.lineId)
    // 报运营中等于同时断言两个不可能为真的时刻，因此这里只能说未知（并把读到的值照报）。
    expect(body.operatingStatus).toEqual({ state: 'unknown', firstDeparture: '22:00', lastDeparture: '06:00' })
  })
})
