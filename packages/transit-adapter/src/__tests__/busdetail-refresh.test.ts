import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChelaileProvider } from '../providers/chelaile.js'

/**
 * 实时轮询走轻量接口。
 *
 * 官方小程序也是双接口结构：首屏 `encryptedLineDetail` 拿全量，
 * 30 秒轮询用 `encryptedBusDetail` 只拿车辆明细（实测体积小约 65%，
 * `buses[]` 字段一致，只是不带 `stations` 站表）。
 *
 * 本 provider 的 getLiveStatus 同样轻量优先、全量回退。回退保证
 * 上游接口变化时可用性不降级 —— 最坏情况就是回到改动前。
 *
 * 下面每一次读取都是桩，永不触达上游。
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LIGHT_BUS = {
  busId: 'b1',
  order: 18,
  speed: 5,
  distanceToWaitStn: 1225,
  lat: 39.8754,
  lng: 116.6592,
  mileage: 8768,
  licence: '',
  busTagList: [{ dispatch: false, imageUrlKey: '拥挤度_1', sort: 5, title: '不拥挤' }],
  travels: [{ order: 20, travelTime: 120 }],
}

/** 轻量接口的回答：有车辆、有线路名、无站表（与实测一致）。 */
const LIGHT_PAYLOAD = {
  line: { name: '913', direction: 0 },
  buses: [LIGHT_BUS],
}

/** 全量接口的回答：轻量载荷 + 站表。 */
const FULL_PAYLOAD = {
  ...LIGHT_PAYLOAD,
  stations: [
    { sId: 's1', sn: '甲站', order: 1, lat: 39.9, lng: 116.4 },
    { sId: 's2', sn: '乙站', order: 2, lat: 39.91, lng: 116.41 },
  ],
}

function envelope(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ jsonr: { data: payload } }),
  }
}

/** 记录命中的端点，并按端点作答。 */
function stubEndpoints(handlers: Record<string, (href: string) => unknown>) {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    seen.push(href)
    for (const [key, handler] of Object.entries(handlers)) {
      if (href.includes(key)) return handler(href)
    }
    throw new Error(`unexpected upstream call: ${href}`)
  }))
  return seen
}

describe('getLiveStatus prefers the lightweight busDetail endpoint', () => {
  it('calls encryptedBusDetail (not the full endpoint) and parses buses identically', async () => {
    const seen = stubEndpoints({
      encryptedBusDetail: () => envelope(LIGHT_PAYLOAD),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })

    const status = await new ChelaileProvider().getLiveStatus('line_913', 0, '027', { targetOrder: 20 })

    expect(seen.some(h => h.includes('encryptedBusDetail')), 'light endpoint was not called').toBe(true)
    // 车辆读取本身走轻量接口；全量接口只在道路几何缓存未命中时被调一次（取 jxPath）
    expect(seen[0]).toMatch(/encryptedBusDetail/)
    const fullCalls = seen.filter(h => h.includes('encryptedLineDetail'))
    expect(fullCalls.length).toBeLessThanOrEqual(1)
    // cshow=busDetail 是官方小程序同款参数
    expect(seen.find(h => h.includes('encryptedBusDetail'))).toMatch(/cshow=busDetail/)
    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
    expect(status?.buses[0]?.travelTimeSec).toBe(120)
    expect(status?.buses[0]?.congestion).toBe('low')
  })

  it('falls back to the full endpoint when the light one throws', async () => {
    const seen = stubEndpoints({
      encryptedBusDetail: () => { throw new Error('upstream 500') },
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })

    const status = await new ChelaileProvider().getLiveStatus('line_913', 0, '027', { targetOrder: 20 })

    expect(seen.some(h => h.includes('encryptedBusDetail'))).toBe(true)
    expect(seen.some(h => h.includes('encryptedLineDetail')), 'fallback did not happen').toBe(true)
    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
  })

  it('falls back to the full endpoint when the light payload has no buses array', async () => {
    const seen = stubEndpoints({
      // 形态不对的轻量回答：没有 buses 数组
      encryptedBusDetail: () => envelope({ line: { name: '913' } }),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })

    const status = await new ChelaileProvider().getLiveStatus('line_913', 0, '027')

    expect(seen.some(h => h.includes('encryptedLineDetail')), 'fallback did not happen').toBe(true)
    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
  })
})

describe('station count without stations in the light payload', () => {
  it('uses the cached count from getLineDetail to clamp nextOrder', async () => {
    stubEndpoints({
      encryptedBusDetail: () => envelope(LIGHT_PAYLOAD),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })
    const provider = new ChelaileProvider()

    // 先走一次详情：2 个站，写入 stationCountCache
    await provider.getLineDetail('line_913', 0, '027')
    // 轻量回答无站表、无 targetOrder；车辆 order=18（正前往第 18 站）
    const status = await provider.getLiveStatus('line_913', 0, '027')

    // nextOrder 被钳制在总站数 2，而不是兜底的 1
    expect(status?.buses[0]?.nextOrder).toBe(2)
  })

  it('falls back to 1 when neither the payload nor the cache has a station count', async () => {
    stubEndpoints({
      encryptedBusDetail: () => envelope(LIGHT_PAYLOAD),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })

    // 没调过 getLineDetail：缓存是空的
    const status = await new ChelaileProvider().getLiveStatus('line_913', 0, '027')

    expect(status?.buses[0]?.nextOrder).toBe(1)
  })
})

describe('non-chelaile cities (amap_ placeholder codes)', () => {
  it('searchLines returns [] without hitting upstream', async () => {
    const seen = stubEndpoints({
      encryptedBusDetail: () => envelope(LIGHT_PAYLOAD),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })
    const result = await new ChelaileProvider().searchLines('1路', 'amap_120000')
    expect(result).toEqual([])
    expect(seen, 'upstream should not be called for amap_ cities').toEqual([])
  })

  it('getLineDetail and getLiveStatus return null without hitting upstream', async () => {
    const seen = stubEndpoints({
      encryptedBusDetail: () => envelope(LIGHT_PAYLOAD),
      encryptedLineDetail: () => envelope(FULL_PAYLOAD),
    })
    const provider = new ChelaileProvider()
    expect(await provider.getLineDetail('line_1', 0, 'amap_440100')).toBeNull()
    expect(await provider.getLiveStatus('line_1', 0, 'amap_440300')).toBeNull()
    expect(seen, 'upstream should not be called for amap_ cities').toEqual([])
  })
})
