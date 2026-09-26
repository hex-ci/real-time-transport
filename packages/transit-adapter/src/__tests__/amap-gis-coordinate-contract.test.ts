import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmapGisService, wgs84ToGcj02 } from '../index.js'

/**
 * `AmapGisService` 的坐标契约：每个公开方法接收 GCJ-02 —— 应用的归一化
 * 坐标系，也正是高德 REST API 使用的坐标系 —— 并且原样发出收到的坐标，
 * 不做任何转换。
 *
 * 这是一个承重的分工：转换在 HTTP 边界（`apps/server/src/app.ts`）完成，
 * 那是原始 WGS-84 设备定位进入服务端的唯一入口。这里的终点是站点坐标，
 * 已经是 GCJ-02，再转一次会把步行目标挪开，并把赶车结论翻成相反的。
 */

const ANCHOR = { lng: 116.403640, lat: 39.910710 }
const STATION = { lng: 116.392540, lat: 39.924299 }

/** 计数版的高德上游替身：本文件任何测试都不触网。 */
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

function wire(point: { lng: number, lat: number }): string {
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`
}

/** 第二次（错误的）转换会产生的坐标对。 */
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
