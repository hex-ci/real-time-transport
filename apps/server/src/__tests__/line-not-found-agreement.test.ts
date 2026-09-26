import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D1 在 HTTP 边界：每条以线路 id 为键的路由，对「上游是否认识这条线路」说的是同一件事。
 *
 * 这里钉的是客户端看到的后果：查不到的 id 在四条以线路为键的路由上一致地 404，而正对照
 * —— 一条真实存在、此刻没有车在途的线路 —— 照旧回 200 与空列表，因为一刀切的拒绝比缺陷
 * 更糟。
 *
 * 甲路 / 乙路 与 `line_027_1` 都是占位：这里不出现任何真实线路或上游 id，也触不到任何
 * 上游 —— 下面的每次读取都是替身。
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const GHOST_LINE = 'NO_SUCH_LINE_999'
/** 上游确实认识、但在这个替身里没有车在途的一条线路。 */
const REAL_LINE = 'line_027_1'
const STATION = '甲路'

const STATIONS = [
  { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
  { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
]

/**
 * 上游对被问到的任何线路的回答。
 *
 * 所有 id 共用一个载荷 —— 对从未听说过的 id，端点真正返回的形状是一个既没有 `line`、
 * 也没有 `stations` 和 `buses` 的外壳；存在的线路用站表作答，没有车在跑时则没有车辆。
 */
function stubUpstream(payload: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonr: { data: payload } }),
    }
  }))
}

const NO_RECORD: Record<string, unknown> = {}
const NO_VEHICLE: Record<string, unknown> = {
  line: { name: '甲路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
  stations: STATIONS,
  buses: [],
}

function lineRoutes(lineId: string): Array<{ route: string, url: string }> {
  const id = encodeURIComponent(lineId)
  return [
    { route: 'line detail', url: `/api/transit/lines/${id}` },
    { route: 'live status', url: `/api/transit/lines/${id}/live` },
    { route: 'station arrivals', url: `/api/transit/lines/${id}/stations/${encodeURIComponent(STATION)}/arrivals` },
    {
      route: 'walk decision',
      url: `/api/transit/gis/walk-decision?originLng=116.4&originLat=39.9`
        + `&lineId=${id}&stationName=${encodeURIComponent(STATION)}`,
    },
  ]
}

describe('G-D1: a line id the upstream has no record of is refused on every line-keyed route', () => {
  it('answers 404 with a legible body, on all four routes', async () => {
    for (const { route, url } of lineRoutes(GHOST_LINE)) {
      stubUpstream(NO_RECORD)
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `${route} answered ${res.statusCode} for a line the upstream does not know`).toBe(404)
        const body = JSON.parse(res.body)
        expect(body.success, route).toBe(false)
        // 拒绝要说清结果，而不是递回一个
        // 读起来像真实答案的值。
        expect(typeof body.error, route).toBe('string')
        expect(body.error.length, route).toBeGreaterThan(0)
      }
      finally {
        await app.close()
      }
    }
  })

  it('answers the routes that can answer 200 for a real line with no vehicle', async () => {
    // 逐路由的正对照：上面的拒绝必须是关于线路的，
    // 而不是关于空列表的。`/live` 是那条
    // 详情路由是实时路由必须与之一致。
    //
    // 步行决策故意不在这个列表里：它通过 Amap 为一段步行
    // 路由定价，而没有 Amap key 的构建对任何线路都答不出来
    // —— 包括真实线路。在那里断言 200 就等于断言
    // key 已配置，那不是本文件要讲的事。
    for (const { route, url } of lineRoutes(REAL_LINE).filter(r => r.route !== 'walk decision')) {
      stubUpstream(NO_VEHICLE)
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `${route} refused a line that exists: ${res.body}`).toBe(200)
      }
      finally {
        await app.close()
      }
    }
  })

  it('answers 200 with an empty vehicle list for a real line with no vehicle', async () => {
    stubUpstream(NO_VEHICLE)
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: `/api/transit/lines/${REAL_LINE}/live` })
      expect(res.statusCode, res.body).toBe(200)
      const data = JSON.parse(res.body).data
      expect(data.buses).toEqual([])
      // 「此刻没车」是一条存在的线路的状态：答案仍然点名它。
      expect(data.lineId).toBe(REAL_LINE)
      expect(data.isDegraded).toBe(false)
    }
    finally {
      await app.close()
    }
  })

  it('refuses a ghost line id even in simulate mode, where an empty reading would be filled', async () => {
    // 编出来的 id 不能靠模拟开关变成真的：
    // 模拟生成器先解析线路详情，并拒绝凭空造一条
    // 线路 —— 见 `TransitService.generateSimulatedLiveStatus`。
    vi.stubEnv('TRANSIT_SIMULATION', 'true')
    stubUpstream(NO_RECORD)
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: `/api/transit/lines/${GHOST_LINE}/live` })
      expect(res.statusCode, res.body).toBe(404)
    }
    finally {
      await app.close()
      vi.unstubAllEnvs()
    }
  })
})
