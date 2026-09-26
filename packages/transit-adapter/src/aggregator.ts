import type {
  LineDetail,
  LineSummary,
  LiveLineStatus,
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
 */
export const LIVE_CACHE_TTL_MS = 18 * 1000

export class TransitAggregator {
  private readonly providers: ITransitProvider[]
  private readonly liveCache = new Map<string, CacheEntry<LiveLineStatus>>()
  private readonly detailCache = new Map<string, CacheEntry<LineDetail>>()

  constructor(providers: ITransitProvider[]) {
    this.providers = providers
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
            expiresAt: Date.now() + LIVE_CACHE_TTL_MS,
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
