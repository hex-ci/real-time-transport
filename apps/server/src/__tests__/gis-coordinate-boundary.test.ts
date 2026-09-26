import { afterEach, describe, expect, it, vi } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { buildApp } from '../app.js'

/**
 * GIS 路由上的坐标系。
 *
 * 网页端发来的是浏览器 `navigator.geolocation` 的原始定位，未做转换 —— 那是 WGS-84；
 * 服务端已有的一切（Amap 响应、线路缓存里的站点坐标）都是 GCJ-02。这些测试钉住把前者
 * 转成后者的那唯一一处边界，并钉住已经是 GCJ-02 的目的地原样到达 Amap。
 */

/** WGS-84 的原始设备定位。 */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/** 同一个点经 `wgs84ToGcj02` 得到的 GCJ-02 值。 */
const DEVICE_FIX_AS_GCJ02 = '116.403644,39.910714'

/** 站点坐标：来自 Amap 静态站序，本身已是 GCJ-02，即 `wgs84ToGcj02(116.3863, 39.9229)`。 */
const STATION_GCJ02 = { lng: 116.39254, lat: 39.924299 }
const STATION_AS_HELD = '116.392540,39.924299'

const STATION_NAME = '甲站'

/**
 * 服务端能触达的每个上游的带计数替身。所有 provider 的 HTTP 都走 `fetch`，所以这个替身
 * 是完整的：这里没有测试能真的触到 Amap 或 chelaile，配额永远不花。
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

function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** 两个 GCJ-02 站点，地铁引擎才能从替身建出一条线路。 */
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

function upstreamUrl(urls: string[], path: string): URL {
  const found = urls.find(u => u.includes(path))
  expect(found, `no upstream call to ${path} (saw: ${urls.join(' ')})`).toBeDefined()
  return new URL(found!)
}

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
      // 定位只进入服务端一次，也只转换一次。
      expect(params.get('origin')).toBe(DEVICE_FIX_AS_GCJ02)
      // 站点坐标不是设备定位：它已经是 GCJ-02，必须原样发出。
      // （再转一次会挪动目的地，足以颠倒赶车结论。）
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
      // 边界之后服务端继续传下去的东西：已经是 GCJ-02。若下游还存在
      // 第二次转换，这里会看到双重偏移。
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
