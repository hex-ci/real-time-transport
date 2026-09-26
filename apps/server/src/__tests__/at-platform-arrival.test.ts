import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * 服务端的 F-A：上游给的 0 被路由到「正在本站」这个状态。
 *
 * 那个状态本来就在（`isAtStation`、「车辆正在本站」文案、±35 m 窗口），但窗口是按米量的，
 * 而上游对车辆自己的陈述不是：上游的 0 必须落在「正在本站」那一行上，且那一行不渲染分钟。
 * 会把它误定价的位置/停站推算分支已被整个移除（见 `no-estimated-arrival-minute.test.ts`），
 * 所以下面第二个测试讲的是行可能处的另一种状态：车还在路上，而它的读数没有发布到达时刻。
 */

/** 冻结墙上时钟；只伪造 `Date`，别的东西都不会停摆。 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function station(name: string, order: number) {
  return { id: `s${order}`, name, order, lat: 39.9 + order / 100, lng: 116.4 + order / 100, interchanges: [] }
}

/** 三站公交；被查询的站台是沿线上 3000 m 处的 丙站。 */
function busDetail(): LineDetail {
  return {
    lineId: '010-1-0',
    lineName: '1',
    direction: 0,
    directionName: '开往 丙站',
    firstBusTime: '05:00',
    lastBusTime: '22:40',
    cityCode: '010',
    type: 'bus',
    stops: [station('甲站', 1), station('乙站', 2), station('丙站', 3)],
    routeLengthMeters: 3000,
    stationDistances: [0, 1500, 3000],
  }
}

function vehicle(partial: Record<string, unknown>): Record<string, unknown> {
  return { id: 'B1', order: 2, nextOrder: 3, congestion: 'unknown', updatedAt: Date.now(), ...partial }
}

function liveStatus(buses: Array<Record<string, unknown>>): LiveLineStatus {
  return {
    lineId: '010-1-0',
    direction: 0,
    buses: buses as LiveLineStatus['buses'],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: Date.now(),
  }
}

function serviceFor(detail: LineDetail, status: LiveLineStatus): TransitService {
  const db = {
    getCachedLine: async () => detail,
    getUserSettings: async () => null,
    upsertCachedLine: async () => {},
  } as unknown as Database

  // 这里的每个测试按构造都离网：逃出去的调用会抛错，
  // 而不是花掉真实配额。
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))

  const service = new TransitService(db, { amapKey: 'test-key' })
  vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
  return service
}

async function rowsFor(service: TransitService) {
  const result = await service.getStationArrivals('010-1-0', '丙站', 0, 6, '010', 3)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  return result!
}

describe('F-A: an upstream travelTime of 0 is the vehicle being at the platform', () => {
  it('routes it to the at-platform row, which states no minute', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 距站线 60 m：在 ±35 m 窗口之外，所以这一行靠上游自己的 0 落到这里，
    // 而不是靠按米的判断。
    const service = serviceFor(busDetail(), liveStatus([
      vehicle({ travelTimeSec: 0, distanceToWaitStn: 0, distanceFromStart: 2940, speed: 0 }),
    ]))
    try {
      const rows = (await rowsFor(service)).arrivals
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        time: '正在进站',
        etaSeconds: 0,
        isAtStation: true,
        provenance: 'live',
      })
      // 关键就在这：数据源说它就在本站的这个车没有分钟，
      // 而 `stopsAway` 是 0，不是推算分支过去报的整整一跳。
      expect(rows[0]!.time).not.toMatch(/^\d{2}:\d{2}$/)
      expect(rows[0]!.stopsAway).toBe(0)
    }
    finally {
      service.stop()
    }
  })

  it('does not claim the platform for a vehicle the payload says is still on the road', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 完全没有 travels 条目：载荷没有为这辆车给出到达时刻 ——
    // 缺失的时长不是那个表示「已在本站」的 0，所以这一行不是
    // 「正在本站」状态。它也不给分钟（推算已移除，见
    // `no-estimated-arrival-minute.test.ts`），屏幕上拿到的是「没有」
    // 这件事，而不是本应用外推出来的数字。
    const service = serviceFor(busDetail(), liveStatus([
      vehicle({ distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      const rows = (await rowsFor(service)).arrivals
      expect(rows).toHaveLength(1)
      expect(rows[0]!.isAtStation).toBeUndefined()
      expect(rows[0]!.etaSeconds).toBeUndefined()
      expect(rows[0]!.time).toBeUndefined()
      expect(rows[0]!.provenance).toBeNull()
    }
    finally {
      service.stop()
    }
  })
})
