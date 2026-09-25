import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmapGisService, wgs84ToGcj02 } from '../index.js'

/**
 * `AmapGisService`'s coordinate contract: every public method takes GCJ-02 — the
 * app's normalized system, which is what Amap's REST API speaks — and sends
 * exactly the coordinates it was given, converting nothing.
 *
 * That is a load-bearing split. The conversion lives at the HTTP boundary
 * (`apps/server/src/app.ts`), which is the one place a raw WGS-84 device fix
 * enters the server. A destination here is a STATION coordinate, already GCJ-02,
 * so converting it again moves the walking target ~500 m away and turns a
 * catch-the-bus verdict into its opposite.
 */

/** GCJ-02 fixtures: a user anchor, and a station coordinate as the app holds it. */
const ANCHOR = { lng: 116.403640, lat: 39.910710 }
const STATION = { lng: 116.392540, lat: 39.924299 }

/** Counted stand-in for the Amap upstream: no test here can reach the network. */
function stubUpstream(): string[] {
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
        route: { paths: [{ distance: '1208', duration: '966' }] },
        pois: [],
        regeocode: { addressComponent: { district: '甲区', township: '乙街道', streetNumber: {} } },
      }),
    }
  }))
  return urls
}

/** How a coordinate pair is formatted on the wire. */
function wire(point: { lng: number, lat: number }): string {
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`
}

/** The pair a second (wrong) conversion would produce. */
function doubleConverted(point: { lng: number, lat: number }): string {
  const [gcjLng, gcjLat] = wgs84ToGcj02(point.lng, point.lat)
  return `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AmapGisService takes GCJ-02 and converts nothing', () => {
  it('getWalkingEta forwards the anchor and the station unchanged', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await amap.getWalkingEta(ANCHOR.lng, ANCHOR.lat, STATION.lng, STATION.lat)

    const params = new URL(urls[0]!).searchParams
    expect(params.get('origin')).toBe(wire(ANCHOR))
    expect(params.get('destination')).toBe(wire(STATION))
    expect(params.get('destination')).not.toBe(doubleConverted(STATION))
  })

  it('getNearbyStations forwards the given point unchanged', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await amap.getNearbyStations(ANCHOR.lng, ANCHOR.lat, 800)

    const url = new URL(urls[0]!)
    expect(url.pathname).toBe('/v3/place/around')
    expect(url.searchParams.get('location')).toBe(wire(ANCHOR))
    expect(url.searchParams.get('location')).not.toBe(doubleConverted(ANCHOR))
  })

  it('reverseGeocode forwards the given point unchanged', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await amap.reverseGeocode(ANCHOR.lng, ANCHOR.lat)

    const url = new URL(urls[0]!)
    expect(url.pathname).toBe('/v3/geocode/regeo')
    expect(url.searchParams.get('location')).toBe(wire(ANCHOR))
    expect(url.searchParams.get('location')).not.toBe(doubleConverted(ANCHOR))
  })
})
