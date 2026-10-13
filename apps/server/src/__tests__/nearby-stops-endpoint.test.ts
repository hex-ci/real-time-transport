import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { NearbyStopSchema } from '@real-time-transport/shared'
import { wgs84ToGcj02 } from '@real-time-transport/shared/geo'
import { buildApp } from '../app.js'

/**
 * 电子站牌（PRD F5）的服务端契约：`GET /api/transit/stations/nearby`。
 *
 * 这条端点存在的理由只有一个：**站的身份**。站点详情只认站 id，而「我附近有哪些站」
 * 是坐标问题 —— 本端点把坐标变成站 id，站牌列表才能把没有关注线路经过的站也列进来。
 *
 * 三件事在这里钉住：
 *  - 坐标在**这个边界**换算（浏览器上报的是 WGS-84，数据源要的是 GCJ-02），且只换算一次；
 *  - 城市码透传给数据源（不给它答空列表）；
 *  - 「读不到」与「附近没有站台」是两件事：前者 404，后者 200 + 空数组。
 *
 * `NN站` / `010-00001` 都是占位：本文件不出现真实站名或上游 id。
 */

const CITY = '027'
/** 设备定位（WGS-84）：换算成 GCJ-02 后才该出现在上游请求里。 */
const DEVICE = { lng: 116.623576, lat: 39.861746 }
const GCJ = wgs84ToGcj02(DEVICE.lng, DEVICE.lat)

const apps: FastifyInstance[] = []
const upstreamCalls: string[] = []

/** 上游那条附近站台接口的线上形态。 */
function nearbyBody(stations: unknown[]): string {
  return JSON.stringify({
    jsonr: {
      data: {
        userLng: -1,
        userLat: -1,
        gpstype: 0,
        nearStations: stations,
      },
    },
  })
}

function stopOf(params: { sId: string, sn: string, distance: number, lat?: number, lng?: number }): unknown {
  return {
    sId: params.sId,
    sn: params.sn,
    distance: params.distance,
    lat: params.lat ?? 39.9,
    lng: params.lng ?? 116.4,
    physicalStId: `phys-${params.distance}`,
    namesakeStId: 'namesake',
    sType: 0,
  }
}

/** 用替身驱动上游；`body` 为 null 表示上游读不到。 */
function stubUpstream(body: string | null): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input)
    const payload = String((init as { body?: unknown } | undefined)?.body ?? '')
    upstreamCalls.push(`${url} ${payload}`)
    if (!url.includes('encryptedNearPhysicalStns')) {
      return { ok: false, status: 404, text: async () => '' }
    }
    if (body === null) throw new Error('上游读不到')
    return { ok: true, status: 200, text: async () => body }
  }))
}

async function app(): Promise<FastifyInstance> {
  const built = await buildApp()
  apps.push(built)
  return built
}

async function readNearby(instance: FastifyInstance, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({
    cityCode: CITY,
    lng: String(DEVICE.lng),
    lat: String(DEVICE.lat),
    ...params,
  })
  return instance.inject({ method: 'GET', url: `/api/transit/stations/nearby?${qs.toString()}` })
}

afterEach(async () => {
  for (const built of apps) await built.close()
  apps.length = 0
  upstreamCalls.length = 0
  vi.unstubAllGlobals()
})

describe('坐标 → 站 id：这条桥的形状', () => {
  it('答复里每个站都带身份与坐标，形状与契约一致', async () => {
    stubUpstream(nearbyBody([
      stopOf({ sId: '010-00001', sn: 'NN站', distance: 0 }),
      stopOf({ sId: '010-00002', sn: 'NN二站', distance: 215 }),
    ]))

    const res = await readNearby(await app())
    expect(res.statusCode, res.body).toBe(200)

    const stations = res.json().data.map((entry: unknown) => NearbyStopSchema.parse(entry))
    expect(stations.map((stop: { stationId: string }) => stop.stationId)).toEqual(['010-00001', '010-00002'])
    expect(stations[0].name).toBe('NN站')
  })

  it('坐标在本边界换算一次：上游收到的是 GCJ-02，不是浏览器上报的 WGS-84', async () => {
    stubUpstream(nearbyBody([stopOf({ sId: '010-00001', sn: 'NN站', distance: 0 })]))

    await readNearby(await app())

    const call = upstreamCalls.find(entry => entry.includes('encryptedNearPhysicalStns')) ?? ''
    const sent = new URLSearchParams(call.slice(call.indexOf('?') + 1))
    expect(Number(sent.get('lng'))).toBeCloseTo(GCJ[0], 6)
    expect(Number(sent.get('lat'))).toBeCloseTo(GCJ[1], 6)
    expect(sent.get('cityId')).toBe(CITY)
    // 换算只做一次、且做在这个边界：送出去的绝不是浏览器上报的那个 WGS-84 值。
    expect(Math.abs(Number(sent.get('lng')) - DEVICE.lng)).toBeGreaterThan(0.001)
    expect(Math.abs(Number(sent.get('lat')) - DEVICE.lat)).toBeGreaterThan(0.001)
  })

  it('缺坐标时 400：没有坐标就没有「附近」这回事', async () => {
    stubUpstream(nearbyBody([]))

    const res = await (await app()).inject({ method: 'GET', url: '/api/transit/stations/nearby?cityCode=027' })
    expect(res.statusCode).toBe(400)
    expect(upstreamCalls).toEqual([])
  })

  it('读不到是 404，附近没有站台是 200 + 空数组', async () => {
    stubUpstream(null)
    const unreadable = await readNearby(await app())
    expect(unreadable.statusCode).toBe(404)
    expect(unreadable.json().data).toBeUndefined()

    upstreamCalls.length = 0
    stubUpstream(nearbyBody([]))
    const empty = await readNearby(await app())
    expect(empty.statusCode, empty.body).toBe(200)
    expect(empty.json().data).toEqual([])
  })

  it('节拍内重复请求只打一次上游：它同样是「此刻这一带」的读数', async () => {
    stubUpstream(nearbyBody([stopOf({ sId: '010-00001', sn: 'NN站', distance: 0 })]))
    const instance = await app()

    await readNearby(instance)
    await readNearby(instance)

    expect(upstreamCalls.filter(entry => entry.includes('encryptedNearPhysicalStns'))).toHaveLength(1)
  })
})
