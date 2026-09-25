import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { arrivalMinutes } from '@real-time-transport/shared'
import { buildApp } from '../app.js'

/**
 * F1's reference row, on the server side of the coordinate boundary.
 *
 * The stored anchor is GCJ-02 — written by `/settings`' PATCH boundary, which
 * converts a raw device fix exactly once — and so is the station coordinate from
 * the cached line detail. Both therefore reach the walking service as held. The
 * HTTP GIS routes convert their origin on entry (they are defined as a RAW
 * WGS-84 device fix), so an anchor that travelled up to the browser and back
 * through them would be converted twice: ~520 m of origin error, which against
 * F1's 3-minute wait tolerance is not a rounding difference but an inverted
 * 出门结论.
 *
 * These tests hold the whole path end to end: the fix goes in through the real
 * PATCH endpoint, the arrivals answer comes back through the real route, and the
 * only thing inspected in between is the walking request the server issued.
 */

/** The raw device fix a phone reports, in WGS-84. */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/** The same point in GCJ-02, from this repo's own converter — the stored form. */
const [ANCHOR_LNG, ANCHOR_LAT] = wgs84ToGcj02(DEVICE_FIX.lng, DEVICE_FIX.lat)

/** The station coordinate as the app holds it (Amap static sequence = GCJ-02). */
const STATION_GCJ02 = { lng: 116.39254, lat: 39.924299 }
const STATION_AS_HELD = '116.392540,39.924299'

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'

/** A 966 s / 1208 m walking leg — the measurement the PRD's example is built on. */
const WALK_SECONDS = 966
const WALK_METERS = 1208

/** Upstream calls the stubbed `fetch` saw, in order. */
let upstream: string[] = []

/**
 * Counted stand-in for every upstream the server can reach: no test here can
 * spend real quota, and no call can leave the process.
 */
function stubUpstream(options: { walking?: boolean } = {}): void {
  upstream = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    upstream.push(href)

    if (href.includes('/v3/direction/walking')) {
      if (options.walking === false) return ok({})
      return ok({ route: { paths: [{ distance: String(WALK_METERS), duration: String(WALK_SECONDS) }] } })
    }
    if (href.includes('/v3/bus/linename')) return ok({ buslines: [subwayLine] })
    if (href.includes('/v3/place/around')) return ok({ pois: [] })
    return ok({})
  }))
}

/** An Amap v3 success envelope around `payload`. */
function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** A two-stop GCJ-02 subway line, so the engine can build a detail from the stub. */
const subwayLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '乙站',
  start_time: '0516',
  end_time: '2306',
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: `${STATION_GCJ02.lng},${STATION_GCJ02.lat}` },
    { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** The walking request the server made, as it saw it. */
function walkingRequest(): URL | undefined {
  const found = upstream.find(u => u.includes('/v3/direction/walking'))
  return found ? new URL(found) : undefined
}

/**
 * The pair this repo's own converter turns `point` into — i.e. the stored form
 * of a raw fix.
 */
function convertedOnce(lng: number, lat: number): string {
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
  return `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`
}

/**
 * Freeze the wall clock inside the morning commute window, so which anchor means
 * 「where you are」 is a fact of the fixture rather than of when the suite ran.
 * The date is a Thursday, i.e. an operating workday for the timetable fixture.
 *
 * Only `Date` is faked: the timers stay real, because the app under test polls
 * and the providers use request timeouts.
 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** PATCH the stored settings through the real endpoint. */
async function patchSettings(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/transit/settings', payload: body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { success: boolean, data: Record<string, unknown> }
}

/** The arrivals answer for the fixture station, through the real route. */
async function arrivals(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION_NAME)}/arrivals`
      + '?direction=0&count=3&cityCode=027',
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().data as {
    isExact: boolean
    arrivals: Array<{ etaSeconds: number }>
    reference: null | { status: string, anchor?: string, advice?: Record<string, unknown> }
  }
}

describe('F1 reference: the anchor is resolved server-side, in the datum it is stored in', () => {
  beforeEach(() => {
    freezeAt('2026-09-24T08:30:00')
  })

  it('prices the walk from the stored GCJ-02 anchor, converting nothing', async () => {
    void stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })

      const data = await arrivals(app)
      const walk = walkingRequest()
      expect(walk, `no walking call was made (saw: ${upstream.join(' ')})`).toBeDefined()

      // The fix entered once, at the PATCH boundary, and is sent as stored.
      expect(walk!.searchParams.get('origin')).toBe(convertedOnce(DEVICE_FIX.lng, DEVICE_FIX.lat))
      // A second conversion is what a browser round-trip through the GIS routes
      // would have produced: ~520 m off, and a different verdict.
      expect(walk!.searchParams.get('origin')).not.toBe(convertedOnce(ANCHOR_LNG, ANCHOR_LAT))
      // The station end is a stored coordinate too: forwarded as held, byte for byte.
      expect(walk!.searchParams.get('destination')).toBe(STATION_AS_HELD)

      expect(data.reference?.status).toBe('advice')
    }
    finally {
      await app.close()
    }
  })

  it('draws its minutes from the same arrivals the list shows', async () => {
    void stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })

      const data = await arrivals(app)
      const advice = data.reference?.advice as { walkMinutes: number, nextArrivalMinutes: number } | undefined
      const first = data.arrivals[0]

      expect(first).toBeDefined()
      // 966 s of real walking, rounded the way the row displays it.
      expect(advice?.walkMinutes).toBe(16)
      // Not a second opinion about the same bus: the verdict's eta₁ IS the
      // list's first row, so the row and the minutes beside it cannot disagree.
      expect(advice?.nextArrivalMinutes).toBe(arrivalMinutes(first!.etaSeconds))
    }
    finally {
      await app.close()
    }
  })

  it('reports an unsaved anchor as unset, and spends no walking request on it', async () => {
    void stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // Commute hours only: 家 was never saved.
      await patchSettings(app, { morningStart: '06:30', morningEnd: '11:30' })

      const data = await arrivals(app)

      expect(data.reference).toEqual({ status: 'anchor-unset', anchor: 'home' })
      expect(walkingRequest()).toBeUndefined()
    }
    finally {
      await app.close()
    }
  })
})

describe('F1 reference: no anchor means 「where you are」, so no conclusion', () => {
  it('draws no reference outside both commute windows', async () => {
    void stubUpstream()
    // 15:00 is between the morning and evening windows.
    freezeAt('2026-09-24T15:00:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await patchSettings(app, {
        homeLat: DEVICE_FIX.lat,
        homeLng: DEVICE_FIX.lng,
        morningStart: '06:30',
        morningEnd: '11:30',
        eveningStart: '17:00',
        eveningEnd: '22:00',
      })

      const data = await arrivals(app)

      expect(data.arrivals.length).toBeGreaterThan(0)
      expect(data.reference).toBeNull()
      expect(walkingRequest()).toBeUndefined()
    }
    finally {
      await app.close()
    }
  })

  it('uses 公司 for the evening leg instead of 家', async () => {
    void stubUpstream()
    freezeAt('2026-09-24T18:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await patchSettings(app, {
        homeLat: DEVICE_FIX.lat,
        homeLng: DEVICE_FIX.lng,
        workLat: 39.95,
        workLng: 116.45,
      })

      const data = await arrivals(app)

      expect(data.reference?.status).toBe('advice')
      expect(data.reference?.anchor).toBe('work')
      // The evening origin is the 公司 anchor — its stored form, converted once
      // by the PATCH that wrote it and never again here.
      const walk = walkingRequest()
      expect(walk!.searchParams.get('origin')).toBe(convertedOnce(116.45, 39.95))
    }
    finally {
      await app.close()
    }
  })

  it('gives no conclusion when no walking route can be priced', async () => {
    stubUpstream({ walking: false })
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })

      const data = await arrivals(app)

      // The arrivals still answer; only the reference is withheld, because
      // there is no walk to compare them against (no speed, no estimate).
      expect(data.arrivals.length).toBeGreaterThan(0)
      expect(data.reference).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})
