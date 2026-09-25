import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * F1's reference row on a SUBWAY platform.
 *
 * A `subway_` id is answered by the subway engine and by nothing else: the
 * chelaile provider's own `getLiveStatus` declines every `subway_*` id outright,
 * so the engine is the only source that can answer that line at all — the
 * primary, not a stand-in. Its reading carries `isDegraded: false`, and
 * `arrivalTrust` turns that flag into the trust F1's walk decision is gated on:
 * anything but `ok` suppresses the row (`departureReference`'s
 * `if (params.trust !== 'ok') return null`).
 *
 * Deriving the flag from the answering provider's POSITION in the list made
 * every subway platform read as a fallback's answer, so this row was withheld
 * on a reading that was neither stale nor served by a backup source. The
 * assertion below is what that cost: the platform must be able to carry a
 * conclusion again.
 *
 * Everything here is network-free except the ONE walking request Amap is asked
 * for — which is the point: it is only spent when trust is `ok`.
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

const LINE_ID = 'subway_027_88'
/** Placeholder names: no real line, station or upstream id appears in this file. */
const BOARD_NAME = '戊路'
const BOARD_ORDER = 5

/**
 * A subway line whose service window covers the engine's WHOLE normalized day
 * range (it maps 00:00–03:59 to +24 h, so currentSecOfDay spans
 * [14400, 100799]): the frozen hour below then cannot be an hour with no trains.
 */
function subwayDetail(): LineDetail {
  const stops = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({
    id: `s${i}`,
    name: `${'甲乙丙丁戊己庚辛'[i - 1]}路`,
    order: i,
    // ~1.2 km apart, so the geometry is a plausible track rather than a point.
    lat: 39.95 + i * 0.011,
    lng: 116.30 + i * 0.011,
    interchanges: [],
  }))

  return {
    lineId: LINE_ID,
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 辛路',
    firstBusTime: '01:00',
    lastBusTime: '30:00',
    cityCode: '027',
    type: 'subway',
    stops,
    routeLengthMeters: 40000,
    stationDistances: [0, 2000, 6000, 12000, 18000, 24000, 32000, 40000],
  }
}

/**
 * Amap is reachable and prices a walk; nothing else is. The returned list is the
 * record of what was actually asked for, so a test can tell 「the row was
 * suppressed before the walk was priced」 from 「the walk was priced」.
 */
function stubAmapWalking(): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        route: { paths: [{ distance: '540', duration: '420' }] },
      }),
    }
  }))
  return urls
}

/**
 * The service under test, wired to a stub db whose cached subway row already
 * carries geometry (so no upstream is consulted for static data) and whose
 * stored anchor IS the board platform's own coordinate — a synthetic choice for
 * a test, holding no one's location.
 */
function serviceWithAnchorAtBoard(): TransitService {
  const detail = subwayDetail()
  const board = detail.stops.find(s => s.order === BOARD_ORDER)!

  const db = {
    getCachedLine: async () => detail,
    upsertCachedLine: async () => {},
    getUserSettings: async () => ({
      morningStart: '06:30',
      morningEnd: '11:30',
      eveningStart: '17:00',
      eveningEnd: '22:00',
      homeLat: board.lat,
      homeLng: board.lng,
      workLat: null,
      workLng: null,
    }),
  } as unknown as Database

  return new TransitService(db, { amapKey: 'test-key' })
}

describe('F1 on a subway platform: the engine is the only source that can answer, so its reading is not a fallback\'s', () => {
  it('carries the departure reference instead of suppressing it as degraded', async () => {
    // Inside the morning window, so the anchor that means 「where you are」 is 家.
    freezeAt('2026-09-24T08:30:00')
    const urls = stubAmapWalking()
    const service = serviceWithAnchorAtBoard()
    try {
      const answer = await service.getStationArrivals(LINE_ID, BOARD_NAME, 0, 3, '027', BOARD_ORDER)

      expect(answer).not.toBeNull()
      // The engine's own reading answered, and it carries trains to price.
      expect(answer!.arrivals.length).toBeGreaterThan(0)

      // The row is not withheld. `null` here means the trust gate refused it,
      // and a reading that is neither stale nor from a fallback has no such
      // reason: the anchor is saved and the walk is priceable.
      expect(answer!.reference).not.toBeNull()
      expect(answer!.reference?.status).toBe('advice')

      // And the conclusion was drawn from a walk this service really asked
      // Amap for — the request is only spent once trust is `ok`.
      expect(urls.some(url => url.includes('/v3/direction/walking'))).toBe(true)
    }
    finally {
      service.stop()
    }
  })

  it('still withholds the row when a fallback really answered', async () => {
    // The gate this defect abused must not be loosened: a reading whose source
    // stood in for another one supports no conclusion, and no walking request is
    // spent trying. This is the value the aggregator reported for a subway line
    // before the fix — what F11's refresh test pinned as `isDegraded: true` — and
    // it is driven through the service's own seam so the value under test is the
    // TRUST GATE rather than the provider list.
    freezeAt('2026-09-24T08:30:00')
    const urls = stubAmapWalking()
    const service = serviceWithAnchorAtBoard()
    vi.spyOn(service, 'getLiveStatus').mockResolvedValue({
      lineId: LINE_ID,
      direction: 0,
      buses: [],
      dataSource: 'subway_schedule',
      isDegraded: true,
      updatedAt: Date.now(),
    })
    try {
      const answer = await service.getStationArrivals(LINE_ID, BOARD_NAME, 0, 3, '027', BOARD_ORDER)

      expect(answer).not.toBeNull()
      expect(answer!.reference).toBeNull()
      expect(urls.some(url => url.includes('/v3/direction/walking'))).toBe(false)
    }
    finally {
      service.stop()
    }
  })
})
