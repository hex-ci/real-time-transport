import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'

/**
 * F1 在 SUBWAY 站台上的参考行。
 *
 * `subway_` id 只由地铁引擎作答，别的都不行：chelaile provider 自己的 `getLiveStatus` 直接
 * 拒绝每个 `subway_*` id，所以引擎是唯一能答这条线路的来源 —— 是主要来源，不是替身。它的
 * 读数带 `isDegraded: false`，`arrivalTrust` 把这个标志变成 F1 出门结论所依赖的信任：不是
 * `ok` 就压掉这一行（`departureReference` 的 `if (params.trust !== 'ok') return null`）。
 *
 * 这里除了一次 Amap 步行请求外全都离网 —— 而那只在信任为 `ok` 时才会花。
 */

/** 冻结墙上时钟；只伪造 `Date`，别的东西都不会停摆。 */
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
/** 占位名字：本文件里不出现任何真实线路、车站或上游 id。 */
const BOARD_NAME = '戊路'
const BOARD_ORDER = 5

/**
 * 一条地铁线路，其营运窗口覆盖引擎归一化后的整个日范围：下面冻结的那个钟点不可能是没有
 * 车的时刻。
 */
function subwayDetail(): LineDetail {
  const stops = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({
    id: `s${i}`,
    name: `${'甲乙丙丁戊己庚辛'[i - 1]}路`,
    order: i,
    // 相邻站约 1.2 km，所以几何是一条像样的轨道而不是一个点。
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
 * Amap 可达并为步行定价；别的都不可达。返回的列表记录真正被请求过什么，所以测试能分清
 * 「步行定价之前这一行就被压掉了」与「步行已定价」。
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
 * 被测服务，接一个替身 db：它缓存的地铁行已带几何（所以静态数据不问上游），而存下的锚点
 * 就是站牌站台自己的坐标 —— 测试里的合成选择，不指向任何人的位置。
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
    // 在早高峰窗口内，所以表示「你在哪里」的那个锚点是 家。
    freezeAt('2026-09-24T08:30:00')
    const urls = stubAmapWalking()
    const service = serviceWithAnchorAtBoard()
    try {
      const answer = await service.getStationArrivals(LINE_ID, BOARD_NAME, 0, 3, '027', BOARD_ORDER)

      expect(answer).not.toBeNull()
      // 引擎自己的读数作答了，而且带着可以定价的车次。
      expect(answer!.arrivals.length).toBeGreaterThan(0)

      // 这一行没有被压掉。这里的 `null` 意味着信任闸门拒绝了它，
      // 而一个既不过期、也不是兜底来源的读数没有这样的理由：
      // 锚点已保存，步行也可定价。
      expect(answer!.reference).not.toBeNull()
      expect(answer!.reference?.status).toBe('advice')

      // 而且这个结论来自本服务真的向 Amap 要过的一次步行 ——
      // 只有在信任为 `ok` 时才会花这个请求。
      expect(urls.some(url => url.includes('/v3/direction/walking'))).toBe(true)
    }
    finally {
      service.stop()
    }
  })

  it('still withholds the row when a fallback really answered', async () => {
    // 这个缺陷曾利用的闸门不许被放宽：来源是替身的读数支撑不了结论，
    // 也不会因此花掉任何步行请求。这里驱动的是服务自己的接缝，
    // 所以被测的是信任闸门，而不是 provider 列表。
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
