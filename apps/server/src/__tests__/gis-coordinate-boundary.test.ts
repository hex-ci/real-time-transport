import { afterEach, describe, expect, it, vi } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { buildApp } from '../app.js'

/**
 * Coordinate systems on the GIS routes.
 *
 * The web app sends the browser's raw `navigator.geolocation` fix unconverted —
 * that is WGS-84. Everything the server already holds — Amap responses, stop
 * coordinates in the line cache — is GCJ-02 (`docs/PRD.md` standardizes every
 * stored and delivered coordinate on GCJ-02). These tests pin the ONE boundary
 * that converts the former into the latter, and pin that a destination which is
 * already GCJ-02 reaches Amap byte-identical.
 */

/** A raw device fix in WGS-84 (the anchor the adapter's walking-ETA tests use). */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/** The same point in GCJ-02, from this repo's own `wgs84ToGcj02`. */
const DEVICE_FIX_AS_GCJ02 = '116.403644,39.910714'

/**
 * A station coordinate as the app holds it: stop coordinates come from Amap's
 * static station sequence, which is already GCJ-02. This value is this repo's
 * own `wgs84ToGcj02(116.3863, 39.9229)` — the stop fixture the adapter tests
 * use — so no coordinate here is invented.
 */
const STATION_GCJ02 = { lng: 116.39254, lat: 39.924299 }
const STATION_AS_HELD = '116.392540,39.924299'

const STATION_NAME = '甲站'

/**
 * Counted stand-in for every upstream the server can reach. All providers issue
 * their HTTP through `fetch`, so this stub is complete: no test here can reach
 * Amap or chelaile for real, and the quota is never spent.
 */
function stubUpstream(): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    urls.push(href)

    if (href.includes('/v3/direction/walking')) {
      return ok({ route: { paths: [{ distance: '1208', duration: '966' }] } })
    }
    if (href.includes('/v3/place/around')) {
      return ok({ pois: [] })
    }
    if (href.includes('/v3/geocode/regeo')) {
      return ok({ regeocode: { addressComponent: { district: '甲区', township: '乙街道' } } })
    }
    if (href.includes('/v3/bus/linename')) {
      return ok({ buslines: [subwayLine] })
    }
    return ok({})
  }))
  return urls
}

/** An Amap v3 success envelope around `payload`. */
function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** Two GCJ-02 stops, so the subway engine can build a line from the stub. */
const subwayLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '乙站',
  start_time: '0510',
  end_time: '2300',
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: `${STATION_GCJ02.lng},${STATION_GCJ02.lat}` },
    { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** The upstream URL for `path` as the stubbed fetch saw it. */
function upstreamUrl(urls: string[], path: string): URL {
  const found = urls.find(u => u.includes(path))
  expect(found, `no upstream call to ${path} (saw: ${urls.join(' ')})`).toBeDefined()
  return new URL(found!)
}

/** The pair `wgs84ToGcj02` turns `point` into, formatted as the wire form. */
function doubleConverted(lng: number, lat: number): string {
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
  return `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GIS routes: a raw WGS-84 device fix is converted exactly once', () => {
  it('walk-eta converts the origin and forwards the GCJ-02 station untouched', async () => {
    const urls = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transit/gis/walk-eta'
          + `?originLng=${DEVICE_FIX.lng}&originLat=${DEVICE_FIX.lat}`
          + `&destLng=${STATION_GCJ02.lng}&destLat=${STATION_GCJ02.lat}`,
      })
      expect(res.statusCode).toBe(200)

      const params = upstreamUrl(urls, '/v3/direction/walking').searchParams
      // The fix enters the server once and is converted once.
      expect(params.get('origin')).toBe(DEVICE_FIX_AS_GCJ02)
      // A station coordinate is NOT a device fix: it is already GCJ-02 and must
      // be sent as held. Converting it again moves the walking destination by
      // ~500 m (measured: 1208 m/16.1 min becomes 2680 m/35.7 min), which
      // inverts a catch-the-bus verdict against a 3-minute wait tolerance.
      expect(params.get('destination')).toBe(STATION_AS_HELD)
      expect(params.get('destination')).not.toBe(doubleConverted(STATION_GCJ02.lng, STATION_GCJ02.lat))
    }
    finally {
      await app.close()
    }
  })

  it('walk-eta does not convert the converted origin a second time', async () => {
    const urls = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // What the server passes onward after the boundary: already GCJ-02. If a
      // second conversion existed anywhere downstream this would double-shift.
      await app.inject({
        method: 'GET',
        url: `/api/transit/gis/walk-eta?originLng=${DEVICE_FIX.lng}&originLat=${DEVICE_FIX.lat}`
          + `&destLng=${STATION_GCJ02.lng}&destLat=${STATION_GCJ02.lat}`,
      })

      const params = upstreamUrl(urls, '/v3/direction/walking').searchParams
      expect(params.get('origin')).not.toBe(doubleConverted(
        Number(DEVICE_FIX_AS_GCJ02.split(',')[0]),
        Number(DEVICE_FIX_AS_GCJ02.split(',')[1]),
      ))
    }
    finally {
      await app.close()
    }
  })

  it('walk-decision converts the origin once and sends the held station coordinate', async () => {
    const urls = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/transit/gis/walk-decision'
          + `?originLng=${DEVICE_FIX.lng}&originLat=${DEVICE_FIX.lat}`
          + `&lineId=subway_027_88&direction=0&stationName=${STATION_NAME}&cityCode=027`,
      })
      expect(res.statusCode).toBe(200)

      const params = upstreamUrl(urls, '/v3/direction/walking').searchParams
      expect(params.get('origin')).toBe(DEVICE_FIX_AS_GCJ02)
      expect(params.get('destination')).toBe(STATION_AS_HELD)
    }
    finally {
      await app.close()
    }
  })

  it('nearby-stations converts the origin once', async () => {
    const urls = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/transit/gis/nearby-stations?lng=${DEVICE_FIX.lng}&lat=${DEVICE_FIX.lat}&radius=800`,
      })
      expect(res.statusCode).toBe(200)
      expect(upstreamUrl(urls, '/v3/place/around').searchParams.get('location')).toBe(DEVICE_FIX_AS_GCJ02)
    }
    finally {
      await app.close()
    }
  })

  it('regeo converts the origin once', async () => {
    const urls = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/transit/gis/regeo?lng=${DEVICE_FIX.lng}&lat=${DEVICE_FIX.lat}`,
      })
      expect(res.statusCode).toBe(200)
      expect(upstreamUrl(urls, '/v3/geocode/regeo').searchParams.get('location')).toBe(DEVICE_FIX_AS_GCJ02)
    }
    finally {
      await app.close()
    }
  })
})
