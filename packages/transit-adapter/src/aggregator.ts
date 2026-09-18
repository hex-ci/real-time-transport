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
 * Pluggable provider aggregation layer.
 * Providers are tried in registration order; the first that returns data wins.
 * Any provider that throws or returns null is silently skipped, so a broken
 * upstream API degrades to the next configured source without user impact.
 */
export class TransitAggregator {
  private readonly providers: ITransitProvider[]
  private readonly liveCache = new Map<string, CacheEntry<LiveLineStatus>>()
  private readonly detailCache = new Map<string, CacheEntry<LineDetail>>()

  constructor(providers: ITransitProvider[]) {
    this.providers = providers
  }

  async searchLines(keyword: string, cityCode: string = '027'): Promise<LineSummary[]> {
    // Merge results across providers (bus sources + subway router), deduped by lineId+direction
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
            expiresAt: Date.now() + 3600 * 1000, // 1 hour cache
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

  async getLiveStatus(lineId: string, direction: number = 0, cityCode?: string): Promise<LiveLineStatus | null> {
    const cacheKey = `${lineId}_${direction}`
    const cached = this.liveCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]
      if (!provider) continue

      try {
        const status = await provider.getLiveStatus(lineId, direction, cityCode)
        if (status) {
          if (i > 0) {
            status.isDegraded = true
          }
          this.liveCache.set(cacheKey, {
            data: status,
            expiresAt: Date.now() + 18 * 1000, // 18 seconds cache
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
