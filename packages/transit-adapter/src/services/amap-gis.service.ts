import type {
  Station,
} from '@real-time-transport/shared'
import { statedCoordinate, statedNumber, statedStopOrder } from '@real-time-transport/shared'

const AMAP_BASE = 'https://restapi.amap.com'

/**
 * Ceiling on cached walking ETAs. Entries are keyed by anchor coordinates, so a
 * moving fix mints a fresh key every poll: a long-running process would
 * otherwise keep one entry per position it has ever seen.
 */
export const WALK_ETA_MAX_ENTRIES = 500

/** A fixed (anchor, station) pair barely moves, so a priced walking leg is re-fetched daily. */
const WALK_ETA_TTL_MS = 24 * 3600 * 1000

/** After a transient failure, retry soon but keep serving the last good leg meanwhile. */
const WALK_ETA_RETRY_MS = 30 * 1000

/**
 * Walking-ETA cache key, built from the GCJ-02 pair exactly as sent upstream,
 * rounded to 5 decimals (~1 m). Keying on the coordinates the priced leg belongs
 * to lets two anchors inside one ~1 m cell share an entry, and keeps a change to
 * the conversion from serving a leg priced for another coordinate.
 */
function walkEtaCacheKey(glng: number, glat: number, dlng: number, dlat: number): string {
  return `${glng.toFixed(5)},${glat.toFixed(5)}|${dlng.toFixed(5)},${dlat.toFixed(5)}`
}

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
  /** The POI's own GCJ-02 position, absent when the payload stated no position for it. */
  lat?: number
  lng?: number
  /**
   * Metres to the POI, absent when the payload stated no distance for it.
   *
   * Read through `statedNumber`, so a distance the payload spells as `0` — a POI
   * on the measured point — is a real reading and only an unstated one is absent.
   */
  distanceMeters?: number
}

/**
 * An Amap 「lng,lat」 pair, or undefined when the payload states no position.
 *
 * Amap leaves `location` out for a stop or POI it could not place, and a pair it
 * DID state is taken only as far as {@link statedCoordinate} takes it: a half
 * that is empty, malformed, non-finite or ZERO makes the whole pair absent. The
 * zero is not decorative — no placed stop on this app's GCJ-02 datum sits at 0 on
 * either axis, so a payload spelling one is stating that it could not place the
 * stop, and what a caller must read is the absence rather than a point on the
 * equator or the Greenwich meridian. Both spellings of the pair are read — the
 * REST payloads state it as the string 「lng,lat」, and a two-element array states
 * the same two numbers — and the order is upstream's own: longitude first.
 */
function parseAmapLocation(location: unknown): { lng: number, lat: number } | undefined {
  const pair = Array.isArray(location)
    ? location
    : (typeof location === 'string' ? location.split(',') : null)
  if (!pair) return undefined
  const lng = statedCoordinate(pair[0])
  const lat = statedCoordinate(pair[1])
  return lng === undefined || lat === undefined ? undefined : { lng, lat }
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

/**
 * Amap Web-Service GIS client.
 *
 * COORDINATE CONTRACT: every public method that takes coordinates takes
 * **GCJ-02** — the app's normalized system, which is also what Amap's REST API
 * speaks — and performs no conversion. A raw device fix is WGS-84
 * (`navigator.geolocation` reports it unconverted, and the web app sends it
 * as-is), so it must be converted with `wgs84ToGcj02` at the HTTP boundary,
 * exactly once, BEFORE it reaches this service. Converting here as well would
 * shift an origin by ~500 m; converting a destination here is worse still,
 * because every station coordinate the app holds is already GCJ-02 (Amap static
 * station sequence — `docs/PRD.md` standardizes all stored and delivered
 * coordinates on GCJ-02), so it would be converted a second time.
 */
export class AmapGisService {
  private readonly apiKey: string
  private readonly limiter = new AmapRateLimiter(220)
  /** In-process long-lived cache for static line data (stations rarely change) */
  private readonly lineCache = new Map<string, {
    data: AmapLineResult | null
    expiresAt: number
    fetchedAt: number
  }>()

  /**
   * Walking ETAs are stable for a fixed (anchor, station) pair, so they are
   * cached long. Without this the home screen's polling alone would exceed the
   * AMap monthly quota.
   */
  private readonly walkEtaCache = new Map<string, { meters: number, seconds: number, expiresAt: number }>()

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
      const location = parseAmapLocation(stop.location)
      return {
        id: String(stop.id || `amap_stop_${idx + 1}`),
        name: String(stop.name || ''),
        order: statedStopOrder(stop.sequence, idx + 1),
        // A stop Amap could not place stays unplaced — whether the payload left
        // `location` out or spelled it with a zero. See `parseAmapLocation`.
        lat: location?.lat,
        lng: location?.lng,
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
   * Drop walking ETAs that have expired, returning how many were dropped. A
   * long-running process sees a new anchor with every GPS fix, so the map is
   * pruned while it is being written rather than left to grow.
   */
  clearExpired(): number {
    const now = Date.now()
    let dropped = 0
    for (const [key, entry] of this.walkEtaCache) {
      if (entry.expiresAt <= now) {
        this.walkEtaCache.delete(key)
        dropped += 1
      }
    }
    return dropped
  }

  /**
   * Shed the longest-held entries until there is room for another, so a drifting
   * fix cannot push the map past WALK_ETA_MAX_ENTRIES. Map iteration follows
   * insertion order, so what is dropped is the oldest anchor rather than the
   * one just priced.
   */
  private dropOldestWalkingEta(): void {
    while (this.walkEtaCache.size >= WALK_ETA_MAX_ENTRIES) {
      const oldest = this.walkEtaCache.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.walkEtaCache.delete(oldest)
    }
  }

  private storeWalkingEta(key: string, meters: number, seconds: number): void {
    this.clearExpired()
    this.dropOldestWalkingEta()
    this.walkEtaCache.set(key, { meters, seconds, expiresAt: Date.now() + WALK_ETA_TTL_MS })
  }

  /**
   * Real-road walking route planning (v3/direction/walking).
   * Used to compute "should I run for the bus?" decision.
   *
   * Both ends are GCJ-02 and are sent upstream exactly as given: the origin is a
   * position in the app's normalized system, and the destination is a stored
   * station coordinate, which is already in it. See the class contract.
   */
  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number): Promise<WalkEtaResult | null> {
    const cacheKey = walkEtaCacheKey(originLng, originLat, destLng, destLat)

    const cached = this.walkEtaCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { distanceMeters: cached.meters, durationSeconds: cached.seconds }
    }

    const { json, transient } = await this.requestDetailed('/v3/direction/walking', {
      origin: `${originLng.toFixed(6)},${originLat.toFixed(6)}`,
      destination: `${destLng.toFixed(6)},${destLat.toFixed(6)}`,
    })

    const path = json?.route?.paths?.[0]
    if (!path) {
      // Transient failure (QPS/quota/network): NEVER poison good data. A leg
      // priced earlier is still the best answer available for this pair, so
      // serve it and mark the entry for an early retry rather than reporting
      // the stop unreachable. With nothing priced yet there is no answer to
      // give, and null is the signal the callers already degrade on.
      if (transient && cached) {
        this.walkEtaCache.set(cacheKey, { ...cached, expiresAt: Date.now() + WALK_ETA_RETRY_MS })
        return { distanceMeters: cached.meters, durationSeconds: cached.seconds }
      }
      return null
    }

    // A path that exists but does not price both ends is the same class of answer
    // as the empty `paths` list above — upstream's own 「no route for this pair」
    // — and it is what a SUCCESSFUL response can carry, so the stale entry is not
    // served in its place: the current truth is that this pair has no price. The
    // two numbers as the payload states them, or nothing at all. A stated `0` is
    // kept: the upstream's shortest priced walk is one second and two coincident
    // points are a legal 0-metre leg, so zero is a price it really states.
    const distanceMeters = statedNumber(path.distance)
    const durationSeconds = statedNumber(path.duration)
    if (distanceMeters === undefined || durationSeconds === undefined) {
      return null
    }

    const result: WalkEtaResult = { distanceMeters, durationSeconds }
    this.storeWalkingEta(cacheKey, result.distanceMeters, result.durationSeconds)
    return result
  }

  /**
   * Nearby bus/subway stations radar (v3/place/around).
   * type: 150700 = 公交车站, 150500 = 地铁站
   *
   * `lng`/`lat` are GCJ-02 and are sent upstream as given — see the class
   * contract. The results come back in GCJ-02 too.
   */
  async getNearbyStations(lng: number, lat: number, radiusMeters: number = 800): Promise<NearbyStationResult[]> {
    const json = await this.request('/v3/place/around', {
      location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
      types: '150700|150500',
      radius: String(radiusMeters),
      sortrule: 'distance',
      offset: '20',
    })

    const pois = Array.isArray(json?.pois) ? json.pois : []
    return pois.map((poi: any) => {
      const location = parseAmapLocation(poi.location)
      return {
        name: String(poi.name || ''),
        type: String(poi.type || '').includes('地铁站') ? 'subway' : 'bus',
        // A POI Amap could not place — or marks with a zero — keeps no position:
        // it is still a station name with a stated distance, which is what this
        // radar is read for.
        lat: location?.lat,
        lng: location?.lng,
        // The distance the payload STATES, or absent when it states none.
        // Deliberately not a coordinate read: a stated 0 is a real distance to a
        // POI on the measured point, whereas a 0 coordinate is a stop nobody
        // placed. `Number(poi.distance || 0)` answered a real-looking 「0m」 for a
        // POI the radar never measured, which the landmark hint rendered as a
        // distance.
        distanceMeters: statedNumber(poi.distance),
      }
    })
  }

  /**
   * Reverse geocoding (v3/geocode/regeo): a GCJ-02 point -> human-readable
   * landmark description. `lng`/`lat` are sent upstream as given — see the class
   * contract.
   */
  async reverseGeocode(lng: number, lat: number): Promise<string | null> {
    const json = await this.request('/v3/geocode/regeo', {
      location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
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
