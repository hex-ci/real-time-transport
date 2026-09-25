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
 * How long a real-time reading may be served before it is read again.
 *
 * This is the authoritative cadence for live data: the home overview, the
 * platform board and the WebSocket push all read through this cache, so nothing
 * on any screen can be newer than an entry this interval produced. F11's manual
 * refresh is throttled to at least this long — a button that can be pressed
 * faster than the data can change promises a freshness it cannot deliver.
 */
export const LIVE_CACHE_TTL_MS = 18 * 1000

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

  /**
   * Drop this line's real-time readings so the next read is a real one.
   *
   * Both key shapes go: the whole-line read, and every per-station read
   * (`_target_N`). The home screen's overview and the platform board arrive
   * through different keys, so dropping only one of them would leave whichever
   * screen pressed the button showing the reading it was trying to replace.
   *
   * Only the real-time cache is touched. `detailCache` holds long-TTL data —
   * station sequence, route geometry — which does not change when it is asked
   * again, and re-reading it spends upstream quota for nothing; F11 rules that
   * out explicitly.
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

  /**
   * Read a line's real-time status, through the shared cache.
   *
   * Deliberately no single-flight: two callers that miss the same key at the same
   * time both read upstream, and the later answer replaces the cache entry. A
   * manual refresh racing the 18 s poll for the same key can therefore spend two
   * upstream reads. Bounded by the refresh's own cooldown (equal to this cache's
   * TTL), so the overlap is at most one extra read per key per press; adding
   * locking here would have to cover the whole read, not just the map.
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
          // Degradation is the ANSWERING provider's declaration about its own
          // answer, never a fact about where it sits in the list. Position is
          // not priority here: a subway id is declined outright by the bus
          // sources, so the subway engine answering from position 1 is the only
          // source that CAN answer that line — the primary, not a stand-in. Its
          // `isDegraded: false` is therefore honest, and overwriting it labels a
          // schedule-derived reading 「备用来源」 in F10's chain and suppresses
          // F1's departure conclusion through `arrivalTrust`.
          //
          // A provider that genuinely answers as a stand-in for another source
          // declares that itself (apizero.ts) — so the flag below is the
          // provider's contract, and a provider MUST declare it: the DTO makes
          // `isDegraded` a required boolean, leaving no room for list order to
          // fill in a value no one stated.
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
