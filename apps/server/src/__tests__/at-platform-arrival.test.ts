import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * F-A on the server: the upstream's zero is routed to the at-platform state.
 *
 * Reproduced against the real upstream: on a target-ordered read (`?order=N`) a
 * vehicle standing at the stop arrives as `travelTime 0` with `distanceToWaitStn 0`
 * and `speed` ~0, and the board printed 「3 分」 for it — a minute this app made
 * up, because the row fell past the at-platform branch into the position/dwell
 * estimate. The at-platform state already exists (`isAtStation`, the 「车辆正在本站」
 * copy, the ±35 m window) but that window is measured in metres and the upstream's
 * own statement about the vehicle is not.
 *
 * Two things are asserted here, and the second is the one the metre window cannot
 * do: the upstream zero lands on the at-platform row even when the vehicle's
 * reported position is OUTSIDE ±35 m of the stop line, and that row renders no
 * minute at all. The estimate branch that such a row used to fall into has since
 * been removed outright (see `no-estimated-arrival-minute.test.ts`), so the
 * second test below is about the OTHER state a row can be in: a vehicle still on
 * the road whose reading published no arrival time.
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

/** A three-stop bus; the queried platform is 丙站 at 3000 m along the route. */
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

/** The service under test, wired to a stub db so no upstream can be reached. */
function serviceFor(detail: LineDetail, status: LiveLineStatus): TransitService {
  const db = {
    getCachedLine: async () => detail,
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

async function rowsFor(service: TransitService) {
  const result = await service.getStationArrivals('010-1-0', '丙站', 0, 6, '010', 3)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  return result!
}

describe('F-A: an upstream travelTime of 0 is the vehicle being at the platform', () => {
  it('routes it to the at-platform row, which states no minute', async () => {
    freezeAt('2026-09-25T16:10:00')
    // 60 m short of the stop line: outside the ±35 m window, so the row is
    // reached by the upstream's own zero rather than by the metre test. This is
    // the reported shape — the window misses the fact the source stated outright.
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
      // The whole point: no minute is stated for a vehicle the source says is
      // here, and `stopsAway` is zero rather than the one full hop the estimate
      // branch used to report.
      expect(rows[0]!.time).not.toMatch(/^\d{2}:\d{2}$/)
      expect(rows[0]!.stopsAway).toBe(0)
    }
    finally {
      service.stop()
    }
  })

  it('does not claim the platform for a vehicle the payload says is still on the road', async () => {
    freezeAt('2026-09-25T16:10:00')
    // No travels entry at all: the payload stated no arrival time for this vehicle
    // — a missing duration is not the zero that means 「已在本站」, so the row is not
    // the at-platform state. It states no minute either: the estimate that used to
    // fill the gap is gone (see `no-estimated-arrival-minute.test.ts`), and what
    // the screen gets is the absence, not a number this app extrapolated.
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
