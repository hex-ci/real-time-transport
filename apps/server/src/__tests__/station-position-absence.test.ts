import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import type { Database, StoredCommuteChain, StoredCommuteChainLeg, StoredUserSettings } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'

/**
 * A stored stop marked (0, 0) is no more placeable than an unplaced one.
 *
 * A line-detail row can carry `{lat: 0, lng: 0}` for a stop the upstream never
 * placed. No placed stop on this app's GCJ-02 datum sits at 0, so the row states
 * no position for that stop, and every path that needs a point must read it as
 * the absence it is: a walk priced to (0, 0) is a real route to a point in the
 * Atlantic, and a deduction built on one carries a band nobody can act on. This
 * is the same rule `line-group.ts` states for a stop the list "marks with a
 * zero", applied where the chain prices its connections.
 *
 * 101 / 甲路 / 乙路 / 丙路 are placeholders: no real route, station or upstream
 * id appears here, and no upstream is reachable — the stop list is a stub row and
 * the only fetch allowed is the walking route.
 */

/** Frozen clock: the engine judges the AGE of a reading, never the wall clock. */
const NOW_MS = 1_700_000_000_000
/** The walking duration the path-service stub prices every connection at. */
const WALK_SECONDS = 300

const LINE_A = '101'
const STOPS = ['甲路', '乙路', '丙路']

/** The stored row of a user who saved 家 and nothing else. */
const SETTINGS: StoredUserSettings = {
  ...DEFAULT_COMMUTE_HOURS,
  homeLat: 39.9,
  homeLng: 116.4,
  workLat: null,
  workLng: null,
}

const LEG_A: StoredCommuteChainLeg = {
  seq: 0,
  lineId: LINE_A,
  lineName: '101路',
  cityCode: '027',
  boardStationName: '乙路',
  boardStationOrder: 2,
  alightStationName: '丙路',
  alightStationOrder: 3,
  transferExtraMinutes: null,
}

function freezeAt(epochMs: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(epochMs))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function storedChain(legs: StoredCommuteChainLeg[]): StoredCommuteChain {
  return {
    id: '3f1c2f9e-0000-4000-8000-00000000000a',
    userId: 'default_user',
    name: '上班链路',
    originAnchor: 'home',
    purpose: 'morning',
    displayOrder: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    legs,
  }
}

/**
 * One line's stored detail, with `zeroed` naming the stops this row carries at
 * (0, 0) instead of stating no coordinate for them — the shape the absence was
 * written into a row as before it was allowed to stay absent.
 */
function detailFor(zeroed: readonly string[] = []): LineDetail {
  const stationDistances = STOPS.map((_, i) => i * 1000)
  return {
    lineId: LINE_A,
    lineName: LINE_A,
    direction: 0,
    directionName: `开往 ${STOPS[STOPS.length - 1]}`,
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    // Geometry present, so the static read is served from the db row and no
    // geometry backfill ever reaches the upstream.
    routeLengthMeters: stationDistances[stationDistances.length - 1] ?? 0,
    stationDistances,
    stops: STOPS.map((name, i) => ({
      id: `s${i + 1}`,
      name,
      order: i + 1,
      ...(zeroed.includes(name)
        ? { lat: 0, lng: 0 }
        : { lat: 39.9 + (i + 1) / 100, lng: 116.4 + (i + 1) / 100 }),
      interchanges: [],
    })),
  }
}

/**
 * A vehicle heading to the order the request named, with the upstream's own
 * arrival minute — no `distanceFromStart`, so no row can be read as
 * 「正在进站」 by accident.
 */
function targetedReads(): LiveLineStatus {
  return {
    lineId: LINE_A,
    direction: 0,
    buses: [{ id: 'v1', order: 1, nextOrder: 2, travelTimeSec: 900, congestion: 'unknown', updatedAt: NOW_MS }],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: NOW_MS,
  }
}

/** The service under test, with a stub db and no upstream but the walking route. */
function serviceFor(options: { zeroedStops?: readonly string[] }): { service: TransitService, walking: string[] } {
  const db = {
    getCachedLine: async () => detailFor(options.zeroedStops),
    upsertCachedLine: async () => {},
    getUserSettings: async () => SETTINGS,
    getCommuteChains: async () => [storedChain([LEG_A])],
  } as unknown as Database

  const walking: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    // Every test here is network-free by construction: a call that escaped would
    // throw rather than spend real quota.
    if (!href.includes('/v3/direction/walking')) throw new Error(`unexpected upstream call: ${href}`)
    walking.push(href)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        route: { paths: [{ distance: 400, duration: WALK_SECONDS }] },
      }),
    }
  }))

  return { service: new TransitService(db, { amapKey: 'test-key' }), walking }
}

/** The engine's answer for the only chain in the fixture. */
async function onlyDeduction(service: TransitService) {
  const views = await service.deduceCommuteChains({ purpose: 'morning' })
  expect(views, 'no chain was answered at all').toHaveLength(1)
  return views[0]!
}

describe('F10 server: a stored stop marked (0, 0) is not walked to', () => {
  it('refuses the leg and prices no walk when its BOARD stop is marked (0, 0)', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ zeroedStops: ['乙路'] })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads()
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        // The engine's own `station-without-coordinate` cause, as the wire
        // carries it: the anchor WAS saved and the stored pair DID locate in this
        // direction, so what is missing is the platform's own position — which
        // leaves the user no action, hence the generic connection code rather
        // than 设置.
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Nothing is priced and nothing is read: a stop the row marks at 0 has no
      // point to walk to, so no route is requested and no platform is read — a
      // walk to (0, 0) would be a real route to a place nobody named and would
      // make the leg look located enough to conclude from.
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses the leg whose ALIGHT stop is marked (0, 0), at that leg', async () => {
    freezeAt(NOW_MS)
    // The point a leg is left at is its ALIGHT station's, so a leg left at a stop
    // the row marks at 0 would hand the next leg an origin nobody can walk from,
    // and that next leg would answer with the chain's anchor — blaming a settings
    // row that is complete. The refusal belongs to the leg that cannot be placed.
    const { service, walking } = serviceFor({ zeroedStops: ['丙路'] })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads()
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // The board platform is placeable, but the leg is not concluded from: a
      // stop the row marks at 0 is not a point to leave the ride at, so no route
      // is priced and no platform is read.
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})
