import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { arrivalMinutes } from '@real-time-transport/shared'
import { buildApp } from '../app.js'

/**
 * F1 的参考行，在坐标边界的服务端一侧。
 *
 * 存下的锚点是 GCJ-02（由 `/settings` 的 PATCH 边界写入，那里只把原始设备定位转换一次），
 * 缓存线路详情里的站点坐标也是 GCJ-02，所以两者都原样到达步行服务。HTTP 的 GIS 路由在入口
 * 转换它们的 origin（它们的定义就是原始 WGS-84 设备定位），所以一个经浏览器走一趟 GIS 路由
 * 再回来的锚点会被转换两次。
 *
 * 这些测试端到端跑整条路径：定位经真实的 PATCH 端点进入，到达答案经真实路由返回，中间唯一
 * 被检查的是服务端发出的那次步行请求。
 */

/** 手机上报的原始设备定位，WGS-84。 */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/** 同一个点的 GCJ-02 结果，即存储形式。 */
const [ANCHOR_LNG, ANCHOR_LAT] = wgs84ToGcj02(DEVICE_FIX.lng, DEVICE_FIX.lat)

/** 应用持有的站点坐标（Amap 静态站序 = GCJ-02）。 */
const STATION_GCJ02 = { lng: 116.39254, lat: 39.924299 }
const STATION_AS_HELD = '116.392540,39.924299'

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'

const WALK_SECONDS = 966
const WALK_METERS = 1208

/** 替身 `fetch` 看到的上游调用，按顺序。 */
let upstream: string[] = []

/**
 * 服务端能触达的每个上游的带计数替身：这里没有测试能花真实配额，也不会有调用离开进程。
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

function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** 一条两站 GCJ-02 地铁线路，引擎才能从替身建出详情。 */
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

function walkingRequest(): URL | undefined {
  const found = upstream.find(u => u.includes('/v3/direction/walking'))
  return found ? new URL(found) : undefined
}

function convertedOnce(lng: number, lat: number): string {
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
  return `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`
}

/**
 * 把墙上时钟冻结在早通勤窗口内，所以「你在哪里」指哪个锚点是夹具的事实，而不是套件何时跑
 * 的事实。日期是周四，即时时刻表夹具的营运工作日。
 *
 * 只伪造 `Date`：定时器保持真实，因为被测应用在轮询、provider 也用请求超时。
 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function patchSettings(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/transit/settings', payload: body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { success: boolean, data: Record<string, unknown> }
}

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

      // 定位在 PATCH 边界只进入一次，并按存储形式发出。
      expect(walk!.searchParams.get('origin')).toBe(convertedOnce(DEVICE_FIX.lng, DEVICE_FIX.lat))
      // 第二次转换是浏览器经 GIS 路由走一趟会产生的，
      // 会给出不同的结论。
      expect(walk!.searchParams.get('origin')).not.toBe(convertedOnce(ANCHOR_LNG, ANCHOR_LAT))
      // 站点那一端也是存储坐标：原样转发，逐字节。
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
      // 真实的 966 s 步行，按行的显示方式取整。
      expect(advice?.walkMinutes).toBe(16)
      // 不是对同一趟车的第二种意见：结论里的 eta₁ 就是
      // 列表的第一行，所以行与旁边的分钟不可能互相矛盾。
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
      // 只有通勤时刻：家 从未保存过。
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
    // 15:00 落在早高峰与晚高峰之间。
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
      // 晚上的起点是 公司 锚点 —— 它的存储形式，由写入它的那次
      // PATCH 转换一次，在这里不再转换。
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

      // 到达照旧作答；只有参考行被压掉，因为
      // 没有步行可以拿来对照（没有速度，也没有推算）。
      expect(data.arrivals.length).toBeGreaterThan(0)
      expect(data.reference).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})
