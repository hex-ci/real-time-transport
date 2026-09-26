import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * 位置/停站推算一个分钟都不许给。
 *
 * 这一行改为给出平台站牌对未知到达本来就有的那个「没有」，也不带来源标记，因为标记修饰的
 * 是一个数字，而这一行没有数字。
 *
 * 不许跟着变的是同一分支的另一半：真实的带目标 `travelTimeSec` 仍旧作为它自己的分钟、标
 * 实时 给出（钉 (b)），「正在本站」也仍旧是一个没有分钟的观测（钉 (c)）。这两条是对照。
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

/** 三站公交，带几何，被查询的是它的中间站台。 */
function busDetail(): LineDetail {
  return {
    lineId: '010-1-0',
    lineName: '1',
    direction: 0,
    directionName: '开往 丙站',
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    stops: [station('甲站', 1), station('乙站', 2), station('丙站', 3)],
    routeLengthMeters: 3000,
    stationDistances: [0, 1500, 3000],
  }
}

function vehicle(partial: Record<string, unknown>): Record<string, unknown> {
  return { id: 'b1', order: 1, nextOrder: 2, congestion: 'unknown', updatedAt: Date.now(), ...partial }
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

function serviceFor(status: LiveLineStatus): TransitService {
  const db = {
    getCachedLine: async () => busDetail(),
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

async function firstRow(service: TransitService) {
  const result = await service.getStationArrivals('010-1-0', '丙站', 0, 6, '027', 3)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  expect(result!.arrivals.length, 'the fixture served no row').toBeGreaterThan(0)
  return result!.arrivals[0]!
}

describe('an extrapolated arrival minute is not stated', () => {
  it('(a) serves no minute and no provenance mark when the targeted reading published none', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 真车、真里程、真速度 —— 而这个站台没有上游到达时刻。
    // 也就是本应用编出来的那种分钟的形状。
    const service = serviceFor(liveStatus([vehicle({ distanceFromStart: 1000, speed: 6 })]))
    try {
      const row = await firstRow(service)
      expect(row.etaSeconds, 'a minute this app extrapolated was served').toBeUndefined()
      expect(row.time, 'a clock was served for a minute nobody published').toBeUndefined()
      expect(row.provenance, 'a provenance mark rode on a row that states no number').toBeNull()
      // 车本身照旧报出来 —— 它确实在路上，
      // 这一行说的是关于它确实观测到的东西。
      expect(row.busId).toBe('b1')
      expect(row.stopsAway).toBe(1)
      expect(row.isAtStation).toBeUndefined()
    }
    finally {
      service.stop()
    }
  })

  it('(a) serves no minute for the geometry-less shape either', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 没有 `distanceFromStart`，于是走的是推算分支里
    // `stopsAway * 150` 那条路。
    const service = serviceFor(liveStatus([vehicle({})]))
    try {
      const row = await firstRow(service)
      expect(row.etaSeconds, 'the flat per-stop minute was still served').toBeUndefined()
      expect(row.provenance).toBeNull()
    }
    finally {
      service.stop()
    }
  })

  it('(b) POSITIVE CONTROL: a real targeted travelTime is still served, as 实时', async () => {
    freezeAt('2026-09-25T16:10:00')
    const service = serviceFor(liveStatus([vehicle({ travelTimeSec: 300 })]))
    try {
      const row = await firstRow(service)
      expect(row.etaSeconds, 'the minute the payload carried was swallowed').toBe(300)
      expect(row.time).toMatch(/^\d{2}:\d{2}$/)
      expect(row.provenance, 'a served minute is not marked 实时').toBe('live')
    }
    finally {
      service.stop()
    }
  })

  it('(c) the at-platform row still says 正在进站 and states no minute', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 上游自己的 0，距站线 60 m，好让米窗口
    // 不可能是把它路由到这里的原因。
    const service = serviceFor(liveStatus([
      vehicle({ travelTimeSec: 0, distanceToWaitStn: 0, distanceFromStart: 2940, speed: 0 }),
    ]))
    try {
      const row = await firstRow(service)
      expect(row.time).toBe('正在进站')
      expect(row.isAtStation).toBe(true)
      expect(row.etaSeconds).toBe(0)
      // 没有时刻表：正在本站是一个观测，不是一个分钟。
      expect(row.time).not.toMatch(/\d{2}:\d{2}/)
    }
    finally {
      service.stop()
    }
  })
})
