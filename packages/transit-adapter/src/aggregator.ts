import type {
  LineDetail,
  LineSummary,
  LiveLineStatus,
  NearbyStop,
  StationBoard,
} from '@real-time-transport/shared'
import type { ITransitProvider } from './types.js'

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

/**
 * 实时读数在被重新读取之前最长可被沿用多久。
 *
 * 这是实时数据的权威节拍：所有屏幕都经由这个缓存读取；手动刷新
 * 也被限流到不短于这个时长。
 *
 * 默认 18s；实例可被构造参数覆盖 —— 它必须与服务端的轮询间隔同源，
 * 否则调快的轮询会被缓存挡住（硬限制），调慢的轮询则白白浪费上游读取。
 */
export const LIVE_CACHE_TTL_MS = 18 * 1000

export class TransitAggregator {
  private readonly providers: ITransitProvider[]
  private readonly liveCache = new Map<string, CacheEntry<LiveLineStatus>>()
  private readonly detailCache = new Map<string, CacheEntry<LineDetail>>()
  /** 站台到站：键是 `stationId_cityCode`，与实时读数共用同一个 TTL。 */
  private readonly stationCache = new Map<string, CacheEntry<StationBoard>>()
  /**
   * 我附近的站台：键是 `cityCode_lng_lat`（坐标取四位小数 ≈ 11 米），与实时读数共用同一个 TTL。
   *
   * 取整是为了别让 GPS 的抖动把缓存打散：人站着不动时坐标也在跳，而「附近有哪些站」
   * 在这个尺度上不会变 —— 一跳一读等于把上游配额花在同一个问题上。
   */
  private readonly nearbyStopCache = new Map<string, CacheEntry<NearbyStop[]>>()
  private liveCacheTtlMs: number

  constructor(providers: ITransitProvider[], options?: { liveCacheTtlMs?: number }) {
    this.providers = providers
    this.liveCacheTtlMs = options?.liveCacheTtlMs ?? LIVE_CACHE_TTL_MS
  }

  /** 与轮询间隔联动热切换：TTL 永远跟随当前节拍。 */
  setLiveCacheTtlMs(ms: number): void {
    this.liveCacheTtlMs = ms
  }

  /**
   * 丢弃该线路的实时读数，使下一次读取是真实的一次。
   *
   * 两种键都要删：整线读取与每个按站读取（`_target_N`）。首页总览
   * 和站台报站屏走不同的键，只删其中一种，按下按钮的那个屏幕
   * 就会继续显示它本想替换掉的读数。
   *
   * 只动实时缓存：`detailCache` 的长 TTL 数据再问一次也不会变。
   */
  invalidateLive(lineId: string, direction: number): void {
    const wholeLine = `${lineId}_${direction}`
    const perStation = `${wholeLine}_target_`
    for (const key of this.liveCache.keys()) {
      if (key === wholeLine || key.startsWith(perStation)) {
        this.liveCache.delete(key)
      }
    }
  }

  async searchLines(keyword: string, cityCode: string = '027'): Promise<LineSummary[]> {
    const combined: LineSummary[] = []
    for (const provider of this.providers) {
      try {
        const results = await provider.searchLines(keyword, cityCode)
        for (const r of results) {
          const key = `${r.lineId}_${r.direction}`
          if (!combined.some(c => `${c.lineId}_${c.direction}` === key)) {
            combined.push(r)
          }
        }
      }
      catch {
        continue
      }
    }
    return combined
  }

  async getLineDetail(lineId: string, direction: number = 0, cityCode?: string): Promise<LineDetail | null> {
    const cacheKey = `${lineId}_${direction}`
    const cached = this.detailCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    for (const provider of this.providers) {
      try {
        const detail = await provider.getLineDetail(lineId, direction, cityCode)
        if (detail) {
          this.detailCache.set(cacheKey, {
            data: detail,
            expiresAt: Date.now() + 3600 * 1000,
          })
          return detail
        }
      }
      catch {
        continue
      }
    }
    return null
  }

  /**
   * 我附近的站台（该坐标附近约 1 公里内的站，含未关注线路经过的）。
   *
   * 与实时读数共用同一个 TTL：它同样是「此刻这一带」的读数，页面的重读节拍不该比轮询节拍更密。
   * 只有声明了这项能力的 provider 参与；都不声明、或都读不到时返回 null ——
   * 「这里读不了附近站台」与「这附近确实没有站台」是两件事，调用方据此分开说。
   */
  async getNearbyStops(cityCode: string, lng: number, lat: number): Promise<NearbyStop[] | null> {
    const cacheKey = `${cityCode}_${lng.toFixed(4)}_${lat.toFixed(4)}`
    const cached = this.nearbyStopCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    for (const provider of this.providers) {
      if (!provider.getNearbyStops) continue
      try {
        const stations = await provider.getNearbyStops(cityCode, lng, lat)
        if (stations) {
          this.nearbyStopCache.set(cacheKey, {
            data: stations,
            expiresAt: Date.now() + this.liveCacheTtlMs,
          })
          return stations
        }
      }
      catch {
        continue
      }
    }
    return null
  }

  /** 丢弃该站台的读数，使下一次读取是真实的一次。 */
  invalidateStation(stationId: string, cityCode?: string): void {
    this.stationCache.delete(`${stationId}_${cityCode ?? ''}`)
  }

  /**
   * 经由共享缓存读取站台到站（该站台上全部经过线路，含未关注的）。
   *
   * 与实时读数共用同一个 TTL：它同样是实时数据，页面的重读节拍不该比轮询节拍更密。
   * 只有声明了这项能力的 provider 参与；都不声明、或都读不到时返回 null ——
   * 「这座城市读不了站台」与「这站上没有线路」是两件事，调用方据此分开说。
   */
  async getStationBoard(stationId: string, cityCode?: string): Promise<StationBoard | null> {
    const cacheKey = `${stationId}_${cityCode ?? ''}`
    const cached = this.stationCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    for (const provider of this.providers) {
      if (!provider.getStationBoard) continue
      try {
        const readAt = Date.now()
        const lines = await provider.getStationBoard(stationId, cityCode)
        if (lines) {
          const board: StationBoard = { stationId, readAt, dataSource: provider.name, lines }
          this.stationCache.set(cacheKey, {
            data: board,
            expiresAt: Date.now() + this.liveCacheTtlMs,
          })
          return board
        }
      }
      catch {
        continue
      }
    }
    return null
  }

  /**
   * 经由共享缓存读取线路实时状态。
   *
   * 刻意不做 single-flight：两个调用方同时未命中同一个键，会各自
   * 读一次上游。要在这里加锁，锁必须覆盖整个读取过程，而不只是 Map。
   */
  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    const cacheKey = options?.targetOrder
      ? `${lineId}_${direction}_target_${options.targetOrder}`
      : `${lineId}_${direction}`
    const cached = this.liveCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    for (const provider of this.providers) {
      try {
        const status = await provider.getLiveStatus(lineId, direction, cityCode, options)
        if (status) {
          // 降级是「作答方」对自己答案的声明，不是关于它在列表中位置的事实：
          // 公交数据源会直接拒绝地铁 id，所以从位置 1 作答的地铁引擎是唯一
          // 「能」回答该线路的来源 —— 它是主来源而非替代品，它的
          // `isDegraded: false` 因此是诚实的，覆盖它会把排班推演的读数错标成备用。
          //
          // 作为他源替代品作答的 provider 必须自己声明这一点（apizero.ts）：
          // DTO 把 `isDegraded` 定为必填布尔值，不给列表顺序留填空余地。
          this.liveCache.set(cacheKey, {
            data: status,
            expiresAt: Date.now() + this.liveCacheTtlMs,
          })
          return status
        }
      }
      catch {
        continue
      }
    }
    return null
  }
}
