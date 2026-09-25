import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * The position/dwell estimate must not state a minute at all.
 *
 * `vehicleArrivals` used to price a targeted bus row three ways: the payload's
 * own `travelTimeSec`, the subway engine's 135 s/station model, and — when a
 * targeted reading published no arrival time for the vehicle — this app's own
 * arithmetic over the vehicle's SNAPSHOT speed and a nominal per-stop dwell
 * (`remainingMeters / speed + (stopsAway - 1) * 30`, floored at 30 s; or a flat
 * `stopsAway * 150` when the payload carried no usable geometry).
 *
 * That third arithmetic extrapolates two unmeasured quantities across every
 * remaining stop, and its measured error against real data has NO fixed sign:
 * ~12 minutes mean, worst 28 minutes LATE on a long loop line, 5-10 minutes
 * EARLY on a short busy one. Marking it 位置推算 was honest about its author and
 * useless about its quality — the user acts on the number, not the mark — so the
 * owner's decision is that it is not stated at all. The row states the absence
 * the platform board already has for an unknown arrival instead, and carries no
 * provenance mark, because a mark qualifies a NUMBER and this row has none.
 *
 * What must NOT change with it is the other side of the same branch: a real
 * targeted `travelTimeSec` is still served as its own minute marked 实时 (pin b),
 * and the at-platform state is still an observation with no minute (pin c). Those
 * two are the control — without them a rule that swallowed the real data would
 * pass pin (a) exactly as this one does.
 */

/** Freeze the wall clock; only `Date` is faked, so nothing else stalls. */
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

/** A three-stop bus, with geometry, whose middle platform is the one queried. */
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

/** The service under test, wired to a stub db so no upstream can be reached. */
function serviceFor(status: LiveLineStatus): TransitService {
  const db = {
    getCachedLine: async () => busDetail(),
    getUserSettings: async () => null,
    upsertCachedLine: async () => {},
  } as unknown as Database

  // Every test here is network-free by construction: a call that escaped would
  // throw rather than spend real quota.
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))

  const service = new TransitService(db, { amapKey: 'test-key' })
  vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
  return service
}

/** One served arrivals row, as the web app receives it. */
async function firstRow(service: TransitService) {
  const result = await service.getStationArrivals('010-1-0', '丙站', 0, 6, '027', 3)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  expect(result!.arrivals.length, 'the fixture served no row').toBeGreaterThan(0)
  return result!.arrivals[0]!
}

describe('an extrapolated arrival minute is not stated', () => {
  it('(a) serves no minute and no provenance mark when the targeted reading published none', async () => {
    freezeAt('2026-09-25T16:10:00')
    // A real vehicle, a real odometer, a real speed — and no upstream arrival
    // time for this platform. This is the shape that used to be answered with
    // `max(30, 2000 / 6 + 0)` = 333 s, i.e. 「6 分钟」 this app made up.
    const service = serviceFor(liveStatus([vehicle({ distanceFromStart: 1000, speed: 6 })]))
    try {
      const row = await firstRow(service)
      expect(row.etaSeconds, 'a minute this app extrapolated was served').toBeUndefined()
      expect(row.time, 'a clock was served for a minute nobody published').toBeUndefined()
      expect(row.provenance, 'a provenance mark rode on a row that states no number').toBeNull()
      // The vehicle itself is still reported — it is really on its way, and the
      // row says what IS observed about it.
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
    // No `distanceFromStart`, so the estimate branch's `stopsAway * 150` path is
    // the one that used to answer 「3 分钟」.
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
    // The upstream's own zero, 60 m short of the stop line so the metre window
    // cannot be what routes it here.
    const service = serviceFor(liveStatus([
      vehicle({ travelTimeSec: 0, distanceToWaitStn: 0, distanceFromStart: 2940, speed: 0 }),
    ]))
    try {
      const row = await firstRow(service)
      expect(row.time).toBe('正在进站')
      expect(row.isAtStation).toBe(true)
      expect(row.etaSeconds).toBe(0)
      // No clock: the at-platform state is an observation, not a minute.
      expect(row.time).not.toMatch(/\d{2}:\d{2}/)
    }
    finally {
      service.stop()
    }
  })
})
