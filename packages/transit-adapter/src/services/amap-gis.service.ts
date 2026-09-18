import type {
  Station,
} from '@real-time-transport/shared'
import { wgs84ToGcj02 } from '../coords.js'

const AMAP_BASE = 'https://restapi.amap.com'

/**
 * Amap infocodes that mean "retry later", not "this line does not exist":
 * 10002 key expired/limited, 10003 daily quota exceeded, 10014 QPS limit,
 * 10015 invalid key, 10019/10020/10021/10022/10029 various quota & CUQPS
 * throttles. A genuine "no data" response uses infocode 10000 with empty
 * buslines, or 20000/20800-class parameter codes (non-transient).
 */
const TRANSIENT_AMAP_INFOCODES = new Set([
  '10002', '10003', '10004', '10005', '10006', '10007',
  '10008', '10009', '10010', '10011', '10012', '10013',
  '10014', '10015', '10016', '10017', '10019', '10020',
  '10021', '10022', '10029', '10044', '10045',
])

export interface WalkEtaResult {
  distanceMeters: number
  durationSeconds: number
}

export interface NearbyStationResult {
  name: string
  type: 'bus' | 'subway'
  lat: number
  lng: number
  distanceMeters: number
}

/** Rate-limited sequential queue for Amap QPS protection (min interval per request) */
class AmapRateLimiter {
  private lastRequestTime = 0
  private readonly minIntervalMs: number

  constructor(minIntervalMs = 200) {
    this.minIntervalMs = minIntervalMs
  }

  async throttle(): Promise<void> {
    const now = Date.now()
    const wait = this.lastRequestTime + this.minIntervalMs - now
    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    this.lastRequestTime = Date.now()
  }
}

export class AmapGisService {
  private readonly apiKey: string
  private readonly limiter = new AmapRateLimiter(220)
  /** In-process long-lived cache for static line data (stations rarely change) */
  private readonly lineCache = new Map<string, {
    data: AmapLineResult | null
    expiresAt: number
    fetchedAt: number
  }>()

  constructor(apiKey?: string) {
    // Explicit argument (even '') wins; undefined falls back to environment
    this.apiKey = apiKey !== undefined ? apiKey : (process.env.AMAP_MAPS_API_KEY || '')
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  /**
   * Amap request with an explicit failure classification.
   *
   * `transient` distinguishes a retryable condition (no key, network error,
   * timeout, HTTP 5xx, or Amap QPS/quota infocodes like 10002/10003/10014/
   * 10019/10020/10021/10022/10029) from a genuine "valid response, but no
   * matching data" result. Callers use this to decide whether serving stale
   * cache is appropriate — a transient blip must never poison good data.
   */
  private async requestDetailed(
    path: string,
    params: Record<string, string>,
  ): Promise<{ json: any | null, transient: boolean }> {
    if (!this.apiKey) {
      return { json: null, transient: true }
    }

    await this.limiter.throttle()

    const qs = new URLSearchParams({ key: this.apiKey, ...params })
    const url = `${AMAP_BASE}${path}?${qs.toString()}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        // 5xx = upstream trouble (transient); 4xx = our request is wrong
        return { json: null, transient: res.status >= 500 }
      }
      const json = await res.json() as any
      if (json.status !== '1' || json.infocode !== '10000') {
        return { json: null, transient: TRANSIENT_AMAP_INFOCODES.has(String(json?.infocode)) }
      }
      return { json, transient: false }
    }
    catch {
      // Network error / timeout / abort — always retryable
      return { json: null, transient: true }
    }
    finally {
      clearTimeout(timer)
    }
  }

  private async request(path: string, params: Record<string, string>): Promise<any> {
    const { json } = await this.requestDetailed(path, params)
    return json
  }

  /**
   * Fetch static line info (stations with coordinates) for any city / any line.
   * Used for: subway lines nationwide (Beijing 1~19, Shanghai 2, Guangzhou 3, ...),
   * and as a fallback for bus lines that Chelaile cannot find.
   * Results cached for 24 hours in-process, persisted upstream by the server DB.
   */
  async getLineByName(cityNameOrAdcode: string, keyword: string): Promise<AmapLineResult | null> {
    const cacheKey = `${cityNameOrAdcode}_${keyword}`
    const cached = this.lineCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    const { json, transient } = await this.requestDetailed('/v3/bus/linename', {
      city: cityNameOrAdcode,
      keywords: keyword,
      extensions: 'all',
      offset: '1',
      page: '1',
    })

    const raw = json?.buslines?.[0] || null
    if (!raw) {
      // Transient failure (QPS/quota/network): NEVER poison good cached data.
      // Station sequences are extremely stable, so serving previously fetched
      // data always beats returning a 404 for a line that really exists.
      if (transient) {
        if (cached?.data) {
          // Keep the real data but mark it expired so the next call retries.
          this.lineCache.set(cacheKey, {
            data: cached.data,
            expiresAt: Date.now() + 30 * 1000,
            fetchedAt: cached.fetchedAt,
          })
          return cached.data
        }
        this.lineCache.set(cacheKey, { data: null, expiresAt: Date.now() + 30 * 1000, fetchedAt: Date.now() })
        return null
      }
      // Genuine miss (valid response, no such line): short negative cache so a
      // typo search is not hammered upstream, but recovery stays fast.
      this.lineCache.set(cacheKey, { data: null, expiresAt: Date.now() + 30 * 1000, fetchedAt: Date.now() })
      return null
    }

    const busstops = Array.isArray(raw.busstops) ? raw.busstops : []
    const stations: Station[] = busstops.map((stop: any, idx: number) => {
      const [lng, lat] = String(stop.location || '0,0').split(',').map(Number)
      return {
        id: String(stop.id || `amap_stop_${idx + 1}`),
        name: String(stop.name || ''),
        order: Number(stop.sequence || idx + 1),
        lat,
        lng,
        interchanges: [],
      }
    })

    const result: AmapLineResult = {
      amapLineId: String(raw.id || ''),
      lineName: String(raw.name || keyword),
      type: isSubwayType(raw) ? 'subway' : 'bus',
      startStop: String(raw.start_stop || ''),
      endStop: String(raw.end_stop || ''),
      firstTime: normalizeAmapTime(Array.isArray(raw.start_time) ? raw.start_time[0] : raw.start_time),
      lastTime: normalizeAmapTime(Array.isArray(raw.end_time) ? raw.end_time[0] : raw.end_time),
      stations,
    }

    this.lineCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + 24 * 3600 * 1000,
      fetchedAt: Date.now(),
    })
    return result
  }

  /**
   * Real-road walking route planning (v3/direction/walking).
   * Used to compute "should I run for the bus?" decision.
   */
  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number): Promise<WalkEtaResult | null> {
    const [gcjOriginLng, gcjOriginLat] = wgs84ToGcj02(originLng, originLat)
    const [gcjDestLng, gcjDestLat] = wgs84ToGcj02(destLng, destLat)
    const json = await this.request('/v3/direction/walking', {
      origin: `${gcjOriginLng.toFixed(6)},${gcjOriginLat.toFixed(6)}`,
      destination: `${gcjDestLng.toFixed(6)},${gcjDestLat.toFixed(6)}`,
    })

    const path = json?.route?.paths?.[0]
    if (!path) {
      return null
    }

    return {
      distanceMeters: Number(path.distance || 0),
      durationSeconds: Number(path.duration || 0),
    }
  }

  /**
   * Nearby bus/subway stations radar (v3/place/around).
   * type: 150700 = 公交车站, 150500 = 地铁站
   */
  async getNearbyStations(lng: number, lat: number, radiusMeters: number = 800): Promise<NearbyStationResult[]> {
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
    const json = await this.request('/v3/place/around', {
      location: `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`,
      types: '150700|150500',
      radius: String(radiusMeters),
      sortrule: 'distance',
      offset: '20',
    })

    const pois = Array.isArray(json?.pois) ? json.pois : []
    return pois.map((poi: any) => ({
      name: String(poi.name || ''),
      type: String(poi.type || '').includes('地铁站') ? 'subway' : 'bus',
      lat: Number(poi.location?.split(',')?.[1] || 0),
      lng: Number(poi.location?.split(',')?.[0] || 0),
      distanceMeters: Number(poi.distance || 0),
    }))
  }

  /**
   * Reverse geocoding (v3/geocode/regeo): GPS -> human-readable landmark description.
   */
  async reverseGeocode(lng: number, lat: number): Promise<string | null> {
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
    const json = await this.request('/v3/geocode/regeo', {
      location: `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`,
      extensions: 'base',
    })

    const comp = json?.regeocode?.addressComponent
    if (!comp) {
      return null
    }

    const parts = [comp.district, comp.township].filter(Boolean)
    const street = json?.regeocode?.addressComponent?.streetNumber
    if (street && street.street) {
      parts.push(street.street)
    }
    return parts.join('') || null
  }
}

/**
 * Amap v3/bus/linename returns start_time/end_time in HHMM form ("0509")
 * or occasionally already colon-separated ("05:09"). Normalize to HH:MM.
 */
export function normalizeAmapTime(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  const s = String(raw).trim()
  if (!s) return ''
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':')
    return `${h!.padStart(2, '0')}:${m}`
  }
  if (/^\d{3,4}$/.test(s)) {
    const padded = s.padStart(4, '0')
    return `${padded.slice(0, 2)}:${padded.slice(2)}`
  }
  return s
}

/** Detect subway/metro type from an amap busline record (type strings vary: "地铁线路", "150500", "地铁"). */
function isSubwayType(raw: any): boolean {
  const t = String(raw?.type || '')
  const name = String(raw?.name || '')
  return t.includes('地铁') || t.includes('150500') || /^地铁/.test(name)
}

export interface AmapLineResult {
  amapLineId: string
  lineName: string
  type: 'bus' | 'subway'
  startStop: string
  endStop: string
  firstTime: string
  lastTime: string
  stations: Station[]
}
