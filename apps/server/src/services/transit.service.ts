import type { WebSocket } from 'ws'
import {
  ChelaileProvider,
  ApizeroProvider,
  UniversalSubwayEngine,
  SubwayRouterProvider,
  TransitAggregator,
  AmapGisService,
  StationTimetableService,
  LIVE_CACHE_TTL_MS,
} from '@real-time-transport/transit-adapter'
import type {
  ArrivalBasis,
  ArrivalRow,
  ChainConnectionUnpricedReason,
  ChainLegInput,
  ChainLegLive,
  CommuteChainAnchor,
  CommuteChainDeduction,
  CommuteChainDeductionView,
  CommuteChainPurpose,
  CommuteHours,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  OperatingStatus,
  Station,
  UserFavoriteLine,
  WsServerMessage,
  TransitCity,
  WalkDecision,
  DepartureReference,
  DepartureTrust,
  RefreshLiveLineResult,
  RefreshLiveRequest,
  RefreshLiveResult,
} from '@real-time-transport/shared'
import {
  CITY_DICTIONARY,
  HOT_CITY_META,
  DEFAULT_CITY_CODE,
  DEFAULT_COMMUTE_HOURS,
  DEFAULT_USER_ID,
  anchorLegAt,
  arrivalProvenanceOf,
  arrivalTrust,
  deduceCommuteChain,
  departureAdvice,
  operatingDaySecondsOf,
  operatingStatusOf,
  statedArrivalMinutes,
  statedCoordinate,
  vehicleProvenanceOf,
} from '@real-time-transport/shared'
import type {
  Database,
  StoredCommuteChainLeg,
  StoredUserSettings,
} from '../db/client.js'
import { legLiveReading, pairTargetedReads, type TargetedArrival } from './commute-chain-assembly.js'

/**
 * The current local `HH:MM` — the form the stored commute windows are written in.
 *
 * Local rather than Beijing on purpose: it is the clock the commute profile
 * already reads, so the leg this row prices is the leg the card is showing.
 */
function localHHMM(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * The span this engine uses to decide WHICH anchor an unconfigured user is asked
 * about — its own parameter, not the user's settings.
 *
 * The same shape as the subway engine's simulation window (`serviceWindowSeconds`):
 * a model needs a span to enumerate over, and that span is never reported back as
 * the line's service hours. Here the span is needed because F1's reference has to
 * name the anchor this leg starts from, and a user who stated no window has given
 * the engine nothing to read — that is 「没有这一行」 and, since 009, equally
 * 「行在，但四个时刻是 NULL」. What it decides is only which of the two anchors the
 * sentence is about — and a user with no chosen window has stored no anchor either
 * (an anchor is a different column of the same row, and the row may hold one: see
 * `commuteWindowFor`), so 「未保存『家』位置」 and 「未保存『公司』位置」 are both true of him
 * whenever the sentence is printed.
 *
 * It is deliberately NOT a `StoredUserSettings` value anywhere else: `/settings`
 * answers a row of nulls with the nulls, and this constant must never be handed to
 * a caller as a row, so it carries no anchors (the two spaces the reference reads
 * from) and no other reader may use it.
 */
const UNCONFIGURED_COMMUTE_WINDOW = {
  ...DEFAULT_COMMUTE_HOURS,
  homeLat: null,
  homeLng: null,
  workLat: null,
  workLng: null,
} satisfies StoredUserSettings

/**
 * The span this engine decides `hhmm` against, for a user who stated no window.
 *
 * Every END the user never chose falls back to this engine's OWN parameter
 * (`UNCONFIGURED_COMMUTE_WINDOW`, named above), so a row whose times are NULL is
 * read the same way a store with no row is — which is what keeps the F1 reference
 * reaching its consumer for the state 009 made representable. The stored ends win
 * wherever they exist: a user who chose only a morning window is decided against
 * HIS morning window, and the evening end he never chose is the engine's own span
 * rather than a value pretending to be his.
 *
 * Nothing here is handed back as the user's hours: this value never leaves the
 * engine, and `/settings` and `/commute-profile` report a null as a null.
 */
function commuteWindowFor(stored: StoredUserSettings | null): CommuteHours {
  return {
    morningStart: stored?.morningStart ?? UNCONFIGURED_COMMUTE_WINDOW.morningStart,
    morningEnd: stored?.morningEnd ?? UNCONFIGURED_COMMUTE_WINDOW.morningEnd,
    eveningStart: stored?.eveningStart ?? UNCONFIGURED_COMMUTE_WINDOW.eveningStart,
    eveningEnd: stored?.eveningEnd ?? UNCONFIGURED_COMMUTE_WINDOW.eveningEnd,
  }
}

/**
 * F11's cooldown, per (user, data class).
 *
 * Deliberately the live cache's own TTL rather than a number of its own. That
 * cache is the cadence every screen reads through, so a reading obtained inside
 * its window cannot differ from the one the next poll would have produced — and
 * a button pressable faster than that would claim a freshness it cannot
 * deliver. Tying the two to a single number means they cannot drift apart in
 * the direction that turns the button into a lie.
 */
const REFRESH_COOLDOWN_MS = LIVE_CACHE_TTL_MS

/**
 * The wait, in seconds, until a refresh is allowed again — the form a countdown
 * renders.
 *
 * Derived from `nextAllowedAt` in EVERY outcome rather than stated per branch: a
 * response reporting 0 while its own deadline is a full cadence away tells a
 * screen to offer a refresh it will then refuse. `nextAllowedAt` stays the single
 * source of truth, and this is only that deadline expressed as a wait.
 */
function secondsUntil(nextAllowedAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
}

/**
 * A stop's own point, or null when it carries no position.
 *
 * Everything here that prices a distance or a walking route needs a point at
 * BOTH ends, and an upstream that stated no coordinate has stated no position —
 * so the absence yields null and every caller refuses on it instead of measuring
 * from a stand-in (see `StationSchema`). A zero on EITHER axis is that same
 * absence and not a position: no placed stop on this app's GCJ-02 datum sits at
 * 0, so a stored row carrying `{ lat: 0, lng: 0 }` states no position for that
 * stop. The rule is `statedCoordinate`'s, applied here so a stored row reads no
 * differently from a freshly parsed payload.
 */
function stationPoint(station: Station | null | undefined): { lng: number, lat: number } | null {
  if (!station) return null
  const lat = statedCoordinate(station.lat)
  const lng = statedCoordinate(station.lng)
  return lat === undefined || lng === undefined ? null : { lng, lat }
}

/**
 * One vehicle's arrival at ONE targeted station, as this service priced it.
 *
 * The intermediate the arrivals board and F10's chain deduction share. It carries
 * the vehicle's own id — so two targeted reads can be matched by it — and the
 * BASIS its minute was produced with, and it deliberately leaves F4's mark to the
 * caller: the mark depends on the source that answered, which the caller holds
 * once per reading rather than once per row.
 */
interface VehicleArrival {
  /**
   * The clock this row states, or absent when it states no minute. The two travel
   * together: a row has a `time` exactly when `etaSeconds` is a number.
   */
  time?: string
  /**
   * Seconds until this vehicle reaches the targeted station, or absent when the
   * row states NO minute.
   *
   * Absent is an outcome, not a hole: it is what a targeted reading that published
   * no arrival time for this vehicle produces, and it is served as an absence
   * rather than filled with this app's own arithmetic — see the estimate branch in
   * `vehicleArrivals` for the measurement that removed it.
   */
  etaSeconds?: number
  stopsAway: number
  distanceMeters?: number
  isAtStation?: boolean
  /** `LiveBusSchema.id` — the vehicle itself. */
  vehicleId: string
  /**
   * Which arithmetic produced `etaSeconds`. Absent EXACTLY when the row states no
   * minute, because then no arithmetic produced one.
   */
  basis?: ArrivalBasis
}

export class TransitService {
  private aggregator: TransitAggregator
  private amap: AmapGisService
  private chelaile: ChelaileProvider
  private timetables: StationTimetableService
  /**
   * Keyed by `${lineId}_${direction}`, NOT lineId alone: a subway line serves
   * both directions under one lineId, so keying by lineId froze `direction` at
   * whatever the first subscriber asked for and kept polling the wrong way
   * after the user switched direction.
   */
  private activeSubscriptions = new Map<string, {
    lineId: string
    direction: number
    cityCode: string
    clients: Set<WebSocket>
  }>()

  private pollingTimer: NodeJS.Timeout | null = null
  private readonly pollIntervalMs: number
  private cityListCache: { data: TransitCity[], fetchedAt: number } | null = null

  /**
   * One window per (user, data class) — the whole of F11's throttle.
   *
   * Keyed by the CLASS rather than by the screen or the line: F11 gives the home
   * screen and the line page one entry each, and two entries refreshing once
   * apiece must not equal two upstream reads. The class is part of the key even
   * though real-time is the only class today, so a second class later cannot
   * silently share this window.
   */
  private readonly refreshWindows = new Map<string, {
    /**
     * The newest instant a refresh obtained a reading for this user at, or null
     * if none ever did. Reported while the window is closed, where no new
     * reading exists to report instead.
     */
    lastObtainedAt: number | null
    nextAllowedAt: number
  }>()

  /**
   * How many windows are kept. The key carries a caller-supplied user id and
   * this endpoint is reachable by anyone, so the map must not grow without
   * bound; the least recently refreshed window is the one worth least.
   */
  private static readonly MAX_REFRESH_WINDOWS = 500

  constructor(private readonly db: Database, options?: {
    apizeroKey?: string
    amapKey?: string
    pollIntervalSec?: number
  }) {
    this.amap = new AmapGisService(options?.amapKey || process.env.AMAP_MAPS_API_KEY)
    this.chelaile = new ChelaileProvider()
    this.timetables = new StationTimetableService()
    // Wire the subway engine to this service's cached getLineDetail so the live
    // poll path reuses the DB-backed static geometry instead of re-querying
    // Amap every 18s (one QPS throttle would otherwise 404 a valid line).
    const universalSubway = new UniversalSubwayEngine(this.amap, this.timetables, (lineId, direction, cityCode) =>
      this.getLineDetail(lineId, direction, cityCode))
    const subwayRouter = new SubwayRouterProvider(universalSubway, this.chelaile)

    const providers = [
      this.chelaile,
      subwayRouter,
      new ApizeroProvider(options?.apizeroKey),
    ]
    this.aggregator = new TransitAggregator(providers)
    this.pollIntervalMs = (options?.pollIntervalSec ?? 18) * 1000
    this.startPollingLoop()
  }

  /**
   * City dictionary: merge the auto-generated 497-city chelaile dictionary with
   * curated metro cities that chelaile does not cover (Guangzhou/Shenzhen/Tianjin...).
   */
  getCities(): TransitCity[] {
    const dictByCode = new Map(CITY_DICTIONARY.map(c => [c.code, c]))
    const mergedCodes = new Set<string>()
    const merged: TransitCity[] = []

    // Curated hot cities first, in HOT_CITY_META order (Beijing, Shanghai, Guangzhou...).
    // hasMetro=true for all curated entries: they all operate metro systems, and our
    // UniversalSubwayEngine simulates them via Amap regardless of chelaile coverage.
    for (const c of HOT_CITY_META) {
      const dictEntry = dictByCode.get(c.code)
      merged.push({
        code: c.code,
        name: c.name,
        pinyin: dictEntry?.pinyin || c.pinyin || '',
        hasMetro: true,
        hot: true,
      })
      mergedCodes.add(c.code)
    }

    // Then the full dictionary (hot entries already emitted above)
    for (const c of CITY_DICTIONARY) {
      if (mergedCodes.has(c.code)) continue
      merged.push(c)
      mergedCodes.add(c.code)
    }

    // Keep curated order at the top; sort the remainder by code
    const hotCount = HOT_CITY_META.length
    const rest = merged.slice(hotCount).sort((a, b) => a.code.localeCompare(b.code))
    return [...merged.slice(0, hotCount), ...rest]
  }

  async searchLines(keyword: string, cityCode: string = DEFAULT_CITY_CODE): Promise<LineSummary[]> {
    return this.aggregator.searchLines(keyword, cityCode)
  }

  /**
   * Tracks geometry-backfill attempts for cache rows written before route
   * geometry existed. Without this, every request for such a row would re-query
   * the upstream — and since the subway live poll path resolves static detail
   * through here, that meant an Amap call every 18s per line, amplifying any
   * QPS throttle into user-visible 404s. One attempt per cooldown is enough.
   */
  private readonly geomBackfillAt = new Map<string, number>()
  private static readonly GEOM_BACKFILL_COOLDOWN_MS = 6 * 3600 * 1000

  /**
   * Line detail with static-repository caching:
   * DB hit -> return instantly (zero upstream quota). Miss -> fetch + persist.
   * Rows cached before route geometry existed get at most one backfill attempt
   * per cooldown window; otherwise the cached row is served as-is.
   */
  async getLineDetail(lineId: string, direction: number = 0, cityCode?: string): Promise<LineDetail | null> {
    const cached = await this.db.getCachedLine(lineId, direction)
    const hasGeometry = Boolean(
      cached && Array.isArray(cached.stationDistances) && cached.stationDistances.length > 0,
    )

    if (cached) {
      if (hasGeometry) {
        return cached
      }
      // Geometry-less cached row: only retry upstream once per cooldown window,
      // then keep serving what we have (the client degrades to even spacing).
      const key = `${lineId}_${direction}`
      const lastAttempt = this.geomBackfillAt.get(key) ?? 0
      if (Date.now() - lastAttempt < TransitService.GEOM_BACKFILL_COOLDOWN_MS) {
        return cached
      }
      this.geomBackfillAt.set(key, Date.now())
    }

    const detail = await this.aggregator.getLineDetail(lineId, direction, cityCode)
    if (detail) {
      const source = lineId.startsWith('subway_') ? 'amap' : 'chelaile'
      await this.db.upsertCachedLine(detail, source).catch(() => {})
      return detail
    }
    // Upstream failed but we have an older cached row: serve it (geometry-less
    // fallback still renders; vehicles degrade to even spacing).
    return cached
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    forceSimulate = false,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    const status = await this.aggregator.getLiveStatus(lineId, direction, cityCode, options)
    const isEmpty = !status || status.buses.length === 0
    const shouldSimulate = forceSimulate || this.isSimulationEnabled()

    if (shouldSimulate && isEmpty) {
      return this.generateSimulatedLiveStatus(lineId, direction, cityCode, options)
    }
    return status
  }

  /**
   * Re-read the real-time data for the lines a screen is showing, once per
   * cooldown per user.
   *
   * The outcome is one of three facts and they are not interchangeable:
   * `throttled` — nothing was read at all; `unavailable` — the reads were made
   * and none of them returned a reading; `ok` — at least one did. Only `ok` may
   * carry a new instant, and a failed attempt keeps the instant it already had,
   * because the readings on screen are still the ones from then.
   *
   * Real-time class only: each target's live readings are dropped and re-read,
   * while long-TTL line data is left exactly as cached.
   */
  async refreshLive(params: RefreshLiveRequest): Promise<{
    outcome: 'ok' | 'throttled' | 'unavailable'
    result: RefreshLiveResult
  }> {
    const attemptedAt = Date.now()
    // One window per (user, data class): the class is in the key even though
    // real-time is the only class today, so a second class cannot silently share
    // this window later.
    const key = `${params.userId}:live`
    const held = this.refreshWindows.get(key)

    if (held && attemptedAt < held.nextAllowedAt) {
      return {
        outcome: 'throttled',
        result: {
          dataClass: 'live',
          throttled: true,
          lastUpdatedAt: held.lastObtainedAt,
          nextAllowedAt: held.nextAllowedAt,
          retryAfterSeconds: secondsUntil(held.nextAllowedAt, attemptedAt),
          // No line was read, so there is no per-line outcome to report. Listing
          // them with a null reading would state the opposite: that they were read
          // and answered nothing.
          lines: [],
        },
      }
    }

    // The window opens on the ATTEMPT, not on its result: a failed refresh has
    // already spent its upstream calls, so it must not become a retry loop.
    const nextAllowedAt = attemptedAt + REFRESH_COOLDOWN_MS

    const lines: RefreshLiveLineResult[] = []
    let newestObtainedAt: number | null = null

    // The same line twice is one reading, not two: the request names lines, and
    // a repeated one must not multiply the upstream reads.
    const targets = new Map(params.lines.map(target => [
      `${target.lineId}_${target.direction}`,
      target,
    ]))

    for (const target of targets.values()) {
      // Drops the cached reading so this call is a real one. Overlapping the poll
      // loop can still spend two upstream reads for this key — the aggregator has
      // no single-flight (see `TransitAggregator.getLiveStatus`).
      this.aggregator.invalidateLive(target.lineId, target.direction)
      const status = await this.getLiveStatus(target.lineId, target.direction, target.cityCode)
      // The instant the reading was obtained, as the source that produced it
      // stamped it — never the instant this method answers.
      const obtainedAt = status ? status.updatedAt : null

      lines.push({
        lineId: target.lineId,
        direction: target.direction,
        lastUpdatedAt: obtainedAt,
        // The reading's provenance, carried through from the status that
        // produced it — null when there is no reading at all. A generated
        // reading is stamped with the current time like any other, so the
        // instant alone cannot tell a caller what kind of value it holds.
        dataSource: status?.dataSource ?? null,
        isDegraded: status?.isDegraded ?? null,
      })
      if (obtainedAt !== null && (newestObtainedAt === null || obtainedAt > newestObtainedAt)) {
        newestObtainedAt = obtainedAt
      }
    }

    // A refresh that obtained nothing keeps the newest instant it ever obtained
    // for this user: the reading is still the one from then, and the clock is
    // not a reading.
    const lastObtainedAt = newestObtainedAt ?? held?.lastObtainedAt ?? null
    this.rememberRefreshWindow(key, { lastObtainedAt, nextAllowedAt })

    return {
      outcome: newestObtainedAt === null ? 'unavailable' : 'ok',
      result: {
        dataClass: 'live',
        throttled: false,
        lastUpdatedAt: lastObtainedAt,
        nextAllowedAt,
        // This attempt spent the window whether or not it obtained anything, so
        // the wait is the whole cadence — the same derivation as a refusal, and
        // the same number the deadline above says.
        retryAfterSeconds: secondsUntil(nextAllowedAt, attemptedAt),
        lines,
      },
    }
  }

  /**
   * Record a window, keeping the map bounded.
   *
   * Re-inserted rather than overwritten so iteration order is recency order, and
   * the first key is then the least recently refreshed one — the window worth
   * least when the map is full.
   */
  private rememberRefreshWindow(key: string, window: { lastObtainedAt: number | null, nextAllowedAt: number }): void {
    this.refreshWindows.delete(key)
    this.refreshWindows.set(key, window)

    while (this.refreshWindows.size > TransitService.MAX_REFRESH_WINDOWS) {
      const oldest = this.refreshWindows.keys().next().value
      if (oldest === undefined) return
      this.refreshWindows.delete(oldest)
    }
  }

  /**
   * True when the environment forces generated vehicles instead of upstream
   * live data. Exposed to the web app so the UI can label simulated data
   * unmistakably — a user must never mistake generated vehicles for real ones.
   */
  isSimulationEnabled(): boolean {
    return process.env.TRANSIT_SIMULATION === 'true'
      || process.env.DEMO_MODE === 'true'
  }

  /**
   * 模拟数据生成器：开启模拟模式或无在途车时，生成物理连续的在途模拟运行数据。
   */
  async generateSimulatedLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    const detail = await this.getLineDetail(lineId, direction, cityCode)
    if (!detail || detail.stops.length < 2) return null

    const totalStops = detail.stops.length
    const L = detail.routeLengthMeters && detail.routeLengthMeters > 0
      ? detail.routeLengthMeters
      : (totalStops - 1) * 1000
    const sd = detail.stationDistances && detail.stationDistances.length === totalStops
      ? detail.stationDistances
      : detail.stops.map((_, i) => i * (L / (totalStops - 1)))

    const count = Math.min(6, Math.max(3, Math.floor(totalStops / 7)))
    const now = Date.now()
    const buses: LiveBus[] = []
    const isSubway = detail.type === 'subway' || lineId.startsWith('subway_')

    for (let i = 0; i < count; i++) {
      const baseRatio = (i + 0.6) / (count + 1)
      const timeCycle = ((now / 15000) + (i * 0.33)) % 1
      const stopIdx = Math.max(0, Math.min(totalStops - 2, Math.floor(baseRatio * (totalStops - 1))))
      const s0 = sd[stopIdx] ?? 0
      const s1 = sd[stopIdx + 1] ?? s0
      const currentDist = s0 + (s1 - s0) * timeCycle
      const order = stopIdx + 1

      let travelTimeSec: number | undefined
      let distanceToWaitStn: number | undefined

      if (options?.targetOrder) {
        if (order < options.targetOrder) {
          const stopsAway = options.targetOrder - order - timeCycle
          travelTimeSec = isSubway
            ? Math.max(30, Math.round(stopsAway * 135))
            : Math.max(30, Math.round(stopsAway * 150))
          if (sd[options.targetOrder - 1]) {
            distanceToWaitStn = Math.max(0, Math.round(sd[options.targetOrder - 1]! - currentDist))
          }
        }
      }
      else {
        distanceToWaitStn = Math.max(0, Math.round(L - currentDist))
      }

      buses.push({
        id: `sim_${lineId}_${direction}_${i + 1}`,
        order,
        nextOrder: stopIdx + 2,
        progress: timeCycle,
        speed: 7.5 + (i % 3) * 1.5,
        // A simulated vehicle has no crowding reading and no plate; inventing
        // either dresses it up as an observed one.
        congestion: 'unknown',
        distanceFromStart: Math.round(currentDist),
        distanceToWaitStn,
        travelTimeSec,
        updatedAt: now,
      })
    }

    return {
      lineId,
      direction,
      buses,
      dataSource: 'subway_schedule',
      isDegraded: false,
      updatedAt: now,
    }
  }

  /**
   * Backfill `reverseLineId` for favourites saved before routes were followed
   * as a whole (both directions).
   *
   * Resolved from the line's own cached detail, never guessed:
   * - subway: one upstream lineId serves both directions, so the reverse is the
   *   same id (only the direction param changes)
   * - bus: chelaile issues a distinct lineId per direction, taken from the
   *   provider's `otherDirectionLineId`
   * Rows whose reverse way cannot be resolved stay as they are, and the UI then
   * offers no direction switch for them rather than switching to a wrong line.
   */
  async resolveFavoriteDirections(list: UserFavoriteLine[]): Promise<UserFavoriteLine[]> {
    const resolved: UserFavoriteLine[] = []

    for (const fav of list) {
      if (fav.reverseLineId || !fav.id) {
        resolved.push(fav)
        continue
      }

      try {
        const detail = await this.getLineDetail(fav.lineId, fav.preferredDirection ?? 0, fav.cityCode)
        const reverse = detail
          ? (detail.type === 'subway' ? detail.lineId : detail.otherDirectionLineId)
          : null

        if (reverse) {
          await this.db.updateFavorite(fav.id, { reverseLineId: reverse })
          resolved.push({ ...fav, reverseLineId: reverse })
          continue
        }
      }
      catch {
        // Leave unresolved; the row still works for its stored direction.
      }
      resolved.push(fav)
    }

    return resolved
  }

  /**
   * Walking ETA for a GCJ-02 pair — the origin converted at the HTTP boundary,
   * the destination a stored station coordinate (already GCJ-02). Pass-through:
   * the Amap client takes GCJ-02 and converts nothing.
   */
  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number) {
    return this.amap.getWalkingEta(originLng, originLat, destLng, destLat)
  }

  /**
   * Catch-the-bus decision: compares real-road walking ETA (amap) against the
   * nearest vehicle's remaining travel time for a station on a given line.
   *
   * `origin*` is GCJ-02 (converted at the HTTP boundary); the station's own
   * coordinates come from the cached line detail, which is GCJ-02 as Amap
   * returns it, so both ends of the walking leg are in the same system.
   */
  async getWalkDecision(params: {
    originLng: number
    originLat: number
    lineId: string
    direction: number
    stationName: string
    cityCode?: string
  }): Promise<WalkDecision | null> {
    const detail = await this.getLineDetail(params.lineId, params.direction, params.cityCode)
    if (!detail) return null

    const station = detail.stops.find(s => s.name === params.stationName)
    // A platform the line detail cannot place prices no walk: there is no
    // destination to route to, and a route from a stand-in point would answer
    // about a place nobody named.
    const destination = stationPoint(station)
    if (!destination) return null

    const walk = await this.amap.getWalkingEta(params.originLng, params.originLat, destination.lng, destination.lat)
    if (!walk) return null

    const arrivalsResult = await this.getStationArrivals(params.lineId, params.stationName, params.direction, 1, params.cityCode)
    const nextArrival = arrivalsResult?.arrivals?.[0]
    let vehicleEtaSeconds: number | null = null
    if (nextArrival) {
      // `statedArrivalMinutes` is the one rule for "a minute or none": the
      // at-platform state answers 0, a row that states a minute answers it, and a
      // row whose reading published none leaves this null — no walk comparison
      // against a number nobody stated, rather than a fabricated figure.
      vehicleEtaSeconds = statedArrivalMinutes(nextArrival)
    }

    if (vehicleEtaSeconds === null) {
      return {
        walkSeconds: walk.durationSeconds,
        walkMeters: walk.distanceMeters,
        vehicleEtaSeconds: null,
        bufferSeconds: null,
        decision: 'unknown',
        advice: '当前方向暂无在途车辆或上游未提供到站耗时，可按正常步速前往站台候车',
      }
    }

    const buffer = vehicleEtaSeconds - walk.durationSeconds
    let decision: WalkDecision['decision']
    let advice: string

    if (buffer >= 120) {
      decision = 'comfortable'
      advice = `车还有 ${Math.round(vehicleEtaSeconds / 60)} 分钟到站，步行约 ${Math.round(walk.durationSeconds / 60)} 分钟，时间充裕，从容前往`
    }
    else if (buffer >= -60) {
      decision = 'hurry'
      advice = `车约 ${Math.round(vehicleEtaSeconds / 60)} 分钟后进站，需加快步伐（步行约 ${Math.round(walk.durationSeconds / 60)} 分钟）才赶得上`
    }
    else {
      decision = 'missed'
      advice = '本班车已赶不上，建议等候下一班'
    }

    return {
      walkSeconds: walk.durationSeconds,
      walkMeters: walk.distanceMeters,
      vehicleEtaSeconds,
      bufferSeconds: buffer,
      decision,
      advice,
    }
  }

  /**
   * F1's reference row for one platform: the real walking time from the anchor
   * the user is standing at, and the departure conclusion drawn from it.
   *
   * The anchor is read HERE, server-side, as the stored row holds it — GCJ-02,
   * because the `/settings` PATCH boundary converts a raw device fix exactly
   * once — and is handed to Amap as-is, together with the station coordinate
   * from the cached line detail (GCJ-02 as Amap returns it). The HTTP GIS
   * routes' `originLng/originLat` are, by contract, a RAW WGS-84 device fix and
   * convert on entry, so pushing a stored anchor through them would convert it a
   * second time: ~520 m of origin error, which against F1's 3-minute tolerance
   * inverts the 出门结论. Resolving the origin here also keeps the walking-ETA
   * cache effective — its key is the coordinate pair sent upstream, and a saved
   * anchor is a fixed value rather than a moving GPS stream.
   *
   * Returns null — no row — whenever the answer would be a guess: no anchor
   * means 「where you are」 (outside both commute windows), no vehicle to walk
   * to, no walking route priced, or arrival numbers that are stale or degraded.
   * A platform whose stop states no coordinate is one of those: there is no
   * point to price the walk to. The one non-conclusion it DOES report is an
   * anchor that was never saved, which is a fact about the stored row and points
   * the user at 设置.
   */
  private async departureReference(params: {
    /**
     * The platform's coordinates as the line detail holds them, or null — also
     * when that stop carries no coordinate, which is the same absence for
     * pricing purposes: no position means no walking time to compare against.
     */
    station: { lng: number, lat: number } | null
    /** The arrivals this platform's answer carries, in order. */
    arrivals: readonly ArrivalRow[]
    trust: DepartureTrust
  }): Promise<DepartureReference | null> {
    if (!params.station) return null

    const stored = await this.db.getUserSettings(DEFAULT_USER_ID)
    // Which anchor means 「where you are」 is decided by the commute window — and
    // for a user who has chosen none there is no window of HIS. That is two states
    // now (`/settings` answers `unset` with no row, or a row whose four times are
    // null), and both reach this engine as the same thing: the ends he never chose.
    // The span below is this engine's OWN parameter, named as such — exactly the
    // pattern `serviceWindowSeconds` uses for a line whose service hours nobody
    // stated — and each end he DID choose is used as his. It is never reported as
    // the user's hours: `/settings` answers a row of nulls with the nulls, nothing
    // in this payload carries a window at all, and what the span decides is only
    // WHICH anchor the row asks about. That sentence is true either way: the anchor
    // this names was never saved (a different column of the same row may be set, and
    // the row still holds no position for this leg).
    const hours = commuteWindowFor(stored)
    const leg = anchorLegAt(localHHMM(), hours)
    if (!leg) return null

    // The anchors are read from the STORED row, and only from it: the span above
    // carries none (it is the engine's parameter, not a row), and a store with no row
    // has stored no anchor — so `stored` being null here means the same thing as its
    // anchor columns being null, which is the null below.
    const lng = leg === 'home' ? stored?.homeLng ?? null : stored?.workLng ?? null
    const lat = leg === 'home' ? stored?.homeLat ?? null : stored?.workLat ?? null
    // Unset is reported as unset: the settings screen is where it gets fixed,
    // and the row says so instead of falling back to a coordinate the user
    // never saved.
    if (lng === null || lat === null) return { status: 'anchor-unset', anchor: leg }

    // Nothing to conclude from, and no reason to spend a walking request on
    // either: 「现在就走」 built on an old or degraded reading is the one thing
    // this row must never say.
    if (params.trust !== 'ok') return null
    if (params.arrivals.length === 0) return null

    const walk = await this.amap.getWalkingEta(lng, lat, params.station.lng, params.station.lat)
    if (!walk) return null

    const advice = departureAdvice({
      walkSeconds: walk.durationSeconds,
      nextArrivalSeconds: params.arrivals[0]?.etaSeconds ?? null,
      followingArrivalSeconds: params.arrivals[1]?.etaSeconds ?? null,
      trust: params.trust,
    })
    if (!advice) return null

    return { status: 'advice', anchor: leg, advice }
  }

  /** Nearby radar around a GCJ-02 point (converted at the HTTP boundary). */
  async getNearbyStations(lng: number, lat: number, radius: number = 800) {
    return this.amap.getNearbyStations(lng, lat, radius)
  }

  /** Landmark for a GCJ-02 point (converted at the HTTP boundary). */
  async reverseGeocode(lng: number, lat: number) {
    return this.amap.reverseGeocode(lng, lat)
  }

  /**
   * Station arrivals with precision awareness:
   * - exact minute-level timetable registered for the platform -> official departures
   * - otherwise -> the live reading (or the subway engine's trains), isExact: false
   *
   * Every row carries its own F4 provenance, because the minute can come from three
   * places and only the first of them is the payload's:
   *
   *   1. upstream `travelTimeSec`          -> 实时（上游给的分钟）
   *   2. the subway engine's 135s/station  -> 排班推演
   *   3. nothing — no minute is stated     -> no mark, an absence the UI words
   *
   * Branch 3 is the owner's decision of 2026-09-25. It used to hold two arithmetics
   * of our own (a real position + a nominal dwell per remaining stop, and a flat
   * per-stop constant) both marked 位置推算, and neither is stated any more: they
   * extrapolated a snapshot speed and a nominal dwell across every remaining stop,
   * the error had no fixed sign, and the user acts on the number rather than on the
   * mark that qualifies it. The row is still served — the vehicle IS on its way —
   * with no `time`, no `etaSeconds` and no provenance.
   *
   * A generated vehicle outranks the first two: the engine puts a `travelTimeSec` on
   * every train it invents, so a subway row reaches branch 1 while its train does
   * not exist — hence the vehicle's own provenance is resolved first, and a row can
   * never come back claiming 实时 for a train the model made up.
   *
   * The answer also carries F1's `reference` row for this platform, priced from
   * the anchor the user is at. It rides along here rather than on a route of its
   * own so the walk is compared against the very arrival minutes the caller
   * displays — one fetch, one set of numbers, no second opinion about the same
   * bus.
   */
  async getStationArrivals(
    lineId: string,
    stationName: string,
    direction: number = 0,
    count: number = 6,
    cityCode?: string,
    targetOrderParam?: number,
  ): Promise<{
    isExact: boolean
    arrivals: ArrivalRow[]
    /**
     * F3: whether service is running, derived from the first/last departure the
     * line itself carries. An empty `arrivals` alone cannot tell 首班前 from
     * 已过末班 from 运营中-but-nothing-in-range, and each of those is a different
     * answer for someone standing on the platform.
     */
    operatingStatus: OperatingStatus
    /**
     * F-C: the exact table's own caveat for this platform, verbatim (「0:16 半程至
     * 高楼金」 — a last departure that does not go the whole way), or null when the
     * answering path holds no such caveat. It is carried rather than dropped
     * because it is a fact about the day's remaining service that nothing else in
     * the answer states: the departures list says when the last train leaves, not
     * how far it goes. Only the registered timetable has it — the live and
     * simulated paths hold no such remark and say so with null.
     */
    note: string | null
    /** F1's walking reference, or null when no honest conclusion exists. */
    reference: DepartureReference | null
  } | null> {
    const now = Date.now()
    // Seconds into the Beijing operating day (00:00~28:00). 00:00-03:59 belongs
    // to the previous day's tail, which is why the shift is applied here rather
    // than by reading the calendar date.
    const nowSecOfDay = operatingDaySecondsOf(new Date(now))

    // 1) Station resolution first: both paths below price F1's walk to THIS
    // platform, and `getLineDetail` is cached (the DB row, or the aggregator's
    // hour), so resolving it here adds no upstream call to either path.
    const detail = await this.getLineDetail(lineId, direction, cityCode)
    const station = detail
      ? ((typeof targetOrderParam === 'number' && targetOrderParam > 0)
          ? detail.stops.find(s => s.order === targetOrderParam)
          : (detail.stops.find(s => s.name === stationName) || detail.stops.find(s => s.name.includes(stationName))))
      : undefined

    // 2) Exact timetable overlay
    const exact = this.timetables.query(lineId, stationName, direction, nowSecOfDay, { count })
    if (exact) {
      // A published table is neither an observation nor a model of ours: every row
      // is the timetable itself.
      const arrivals: ArrivalRow[] = exact.arrivals.map(a => ({
        time: a.time,
        etaSeconds: a.etaSeconds,
        provenance: 'exact_timetable',
      }))
      return {
        isExact: true,
        arrivals,
        // The station's own first/last departure decides the state here, not the
        // line's: it is the same table the list above is built from, so the state
        // and the departures beside it cannot disagree about whether service has
        // ended at THIS platform. (`exact.first` / `exact.last` are the window the
        // table's OWN departures imply — see `queryStationArrivals`.)
        operatingStatus: operatingStatusOf({
          firstDeparture: exact.first,
          lastDeparture: exact.last,
          nowSecOfDay,
        }),
        // F-C: the table's own caveat travels with the departures it qualifies.
        // An empty string is not a caveat: the field is null when there is
        // nothing to say, so a renderer's `v-if` states a fact rather than
        // testing for whitespace.
        note: exact.note.trim() ? exact.note : null,
        // A registered timetable is a function of the clock rather than a cached
        // observation, so it is never stale: the walk decision may use it.
        reference: await this.departureReference({ station: stationPoint(station), arrivals, trust: 'ok' }),
      }
    }

    if (!detail || !station) return null
    const targetOrder = station.order

    // F3: the line's own service hours, as the static detail carries them. Absent
    // hours stay absent — the state then says 未知 instead of assuming a window.
    const operatingStatus = operatingStatusOf({
      firstDeparture: detail.firstBusTime,
      lastDeparture: detail.lastBusTime,
      nowSecOfDay,
    })

    // 3) Request live status targeted to this station
    const live = await this.getLiveStatus(lineId, direction, cityCode, false, { targetOrder })
    // A missing reading is a degraded answer for anything derived from it: it can
    // never support a conclusion, and saying so is cheaper than pretending.
    const trust: DepartureTrust = live
      ? arrivalTrust({ isDegraded: live.isDegraded, updatedAt: live.updatedAt })
      : 'degraded'
    if (!live || !live.buses || live.buses.length === 0) {
      // No vehicle to walk to. The reference still reports an anchor that was
      // never saved — a fact about the settings row, not about this platform.
      return {
        isExact: false,
        arrivals: [],
        operatingStatus,
        // No registered table answered here, so this path holds no caveat of its
        // own to state — and it must not borrow the table's.
        note: null,
        reference: await this.departureReference({ station: stationPoint(station), arrivals: [], trust }),
      }
    }

    /**
     * F4: what kind of vehicle these rows are about, from the source that answered
     * — `null` when this build does not know that source, in which case its rows
     * come back unclassified instead of being rounded to 实时.
     */
    const vehicle = vehicleProvenanceOf(live.dataSource)

    const arrivals: ArrivalRow[] = this.vehicleArrivals({ detail, live, targetOrder, now })
      .slice(0, count)
      .map(row => ({
        // A row states its own minute or none, and the two travel together: a row
        // with no `etaSeconds` carries no `time` and no mark either, because a
        // mark qualifies a NUMBER. The vehicle is still named (`busId`) with what
        // is observed about it (`stopsAway`, `distanceMeters`).
        ...(row.time !== undefined ? { time: row.time } : {}),
        ...(row.etaSeconds !== undefined ? { etaSeconds: row.etaSeconds } : {}),
        stopsAway: row.stopsAway,
        ...(row.distanceMeters !== undefined ? { distanceMeters: row.distanceMeters } : {}),
        ...(row.isAtStation ? { isAtStation: true } : {}),
        busId: row.vehicleId,
        provenance: row.basis === undefined ? null : arrivalProvenanceOf({ vehicle, basis: row.basis }),
      }))

    return {
      isExact: false,
      arrivals,
      operatingStatus,
      // The live/simulated paths hold no timetable remark: null, never the
      // table's caveat borrowed for a platform it does not cover.
      note: null,
      reference: await this.departureReference({ station: stationPoint(station), arrivals, trust }),
    }
  }

  /**
   * Price every vehicle a reading carries at ONE targeted station.
   *
   * Extracted from the arrivals board so that the board and F10's chain deduction
   * price a vehicle's minute exactly once and identically: a chain leg's board and
   * alight minutes are the same numbers the platform board shows for the same
   * vehicle at the same station, and a second implementation of this arithmetic
   * would be free to disagree with the screen the user compares it against.
   *
   * EVERY usable row is returned, sorted by arrival; the caller decides how many
   * to keep. The chain deduction must not slice: a vehicle seventh by its alight
   * minute can still be the one a chain boards, and truncating there would drop a
   * catchable bus out of the answer for no reason the user could see.
   *
   * F4 is deliberately NOT applied here: the mark depends on the source that
   * answered, which the caller holds once per reading rather than once per row.
   * Each row therefore carries the BASIS it was priced with, and whoever builds a
   * row turns that into the mark.
   */
  private vehicleArrivals(params: {
    detail: LineDetail | null
    live: LiveLineStatus
    /** The station this read targeted. */
    targetOrder: number
    now: number
  }): VehicleArrival[] {
    const { detail, live, targetOrder, now } = params
    const isSubway = detail !== null && (detail.type === 'subway' || detail.lineId.startsWith('subway_'))
    const sd = detail?.stationDistances
    const targetDist = sd && sd[targetOrder - 1] !== undefined ? sd[targetOrder - 1]! : undefined

    const rows: VehicleArrival[] = []

    for (const b of live.buses) {
      if (typeof b.order !== 'number') continue

      // Upstream -1 sentinel (chelaile): this bus is already past the target station.
      if (b.distanceToWaitStn === -1) continue

      // The vehicle's nose is heading to nextOrder; it has cleared order.
      // A bus serves the target station only when nextOrder === targetOrder.
      //
      // THIS FILTER IS MONOTONE IN `targetOrder`, AND F10 RELIES ON IT: a vehicle
      // not past a LATER order is not past an EARLIER one, so the rows returned for
      // a board order are a subset of the rows returned for an alight order further
      // along the same line. That is what makes F10's two targeted reads
      // intersect — see `readChainLeg`, whose whole pairing depends on it. The
      // subset relation needs the alight order to be FURTHER ALONG than the board one
      // IN THE DIRECTION THE LEG IS READ. The caller resolves a subway leg stored the
      // other way round by reading direction 1 with BOTH orders translated into its
      // numbering (`chainLegInput`), so such a leg arrives here with alight > board
      // like any forward one. A leg that cannot be read that way — a bus stored the
      // wrong way round, a station-to-itself leg — inverts the relation instead, which
      // is why the schema rejects such a record on write and the deduction refuses a
      // stored one as `leg-recorded-backwards`. It is upstream's behaviour, which this
      // repo neither controls nor documents: id matching is the rule (never position),
      // so if a provider ever returned a board row absent from the alight read, the
      // vehicle would simply lose its pair and be dropped rather than have a minute
      // invented for it.
      if (b.nextOrder !== undefined && b.nextOrder > targetOrder) continue
      if (b.nextOrder === undefined && b.order >= targetOrder) continue

      // Currently dwelling at station platform (within 35m of the stop line) —
      // or the source saying so outright. On a target-ordered read chelaile
      // answers `travelTime 0` for a vehicle standing AT the requested stop
      // (observed with `distanceToWaitStn 0` and `speed` ~0), and that zero is a
      // statement about where the vehicle IS: at-platform, not a duration. The
      // metre window above cannot stand in for it — it is measured in metres of
      // this app's own linear reference and the reported reproduction missed it by
      // 60 m — and a row that fell past this branch printed a minute from the
      // position/dwell estimate, which is our arithmetic stating 「3 分」 for a bus
      // on the platform. Read first, so the source's own fact wins.
      const sourceSaysAtPlatform = b.travelTimeSec === 0
      const isAtPlatform = sourceSaysAtPlatform
        || (typeof targetDist === 'number' && typeof b.distanceFromStart === 'number'
          && Math.abs(b.distanceFromStart - targetDist) <= 35)

      if (isAtPlatform) {
        rows.push({
          time: '正在进站',
          etaSeconds: 0,
          stopsAway: 0,
          isAtStation: true,
          vehicleId: b.id,
          // An observation of the vehicle — of a REAL vehicle, which is why the
          // basis and not the branch decides the answer.
          basis: 'at_platform',
        })
        continue
      }

      // Bus is approaching: stopsAway counts full hops from nextOrder to target
      const stopsAway = Math.max(1, targetOrder - (b.nextOrder ?? b.order))
      const distanceMeters = b.distanceToWaitStn && b.distanceToWaitStn > 0 ? b.distanceToWaitStn : undefined

      /**
       * The minute this row states, or `null` when nothing published or modelled
       * one. Only two sources remain: the payload's own arrival time, and the
       * subway engine's declared model.
       */
      let minute: { etaSeconds: number, basis: ArrivalBasis } | null = null

      if (typeof b.travelTimeSec === 'number' && b.travelTimeSec > 0) {
        // The data source's own arrival time for this vehicle.
        minute = { etaSeconds: b.travelTimeSec, basis: 'upstream' }
      }
      else if (isSubway) {
        // 135 s/station is an assumption, not a reading — and it is the subway
        // ENGINE's declared model (`dataSource: 'subway_schedule'`, marked
        // 排班推演 by `arrivalProvenanceOf`), not this app's guess about a bus.
        const progress = typeof b.progress === 'number' ? b.progress : 0
        minute = { etaSeconds: Math.max(30, Math.round((stopsAway - progress) * 135)), basis: 'our_estimate' }
      }

      if (!minute) {
        // NO MINUTE IS STATED. The targeted reading published no arrival time for
        // this bus, and the arithmetic that used to fill the gap extrapolated the
        // vehicle's SNAPSHOT speed and a nominal per-stop dwell across every stop
        // still to come — the remaining metres at a plausible bus speed, plus a
        // fixed dwell per remaining stop, floored; or, with no geometry at all, a
        // flat nominal per-stop constant. Measured against real data its error has
        // no fixed sign: ~12 minutes mean, worst 28 minutes late on a long loop
        // line, 5-10 minutes EARLY on a short busy one — a number the user acts on,
        // so it is not stated at all.
        //
        // The row is still served. The vehicle is really on its way, and what WAS
        // observed about it travels: this stop count and its distance. The
        // caller's contract has no minute to carry, so `time`, `etaSeconds` and
        // `basis` are all absent and the served row's provenance is null — a mark
        // qualifies a NUMBER, and this row has none.
        rows.push({ stopsAway, distanceMeters, vehicleId: b.id })
        continue
      }

      const d = new Date(now + minute.etaSeconds * 1000 + 8 * 3600 * 1000)
      rows.push({
        time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
        etaSeconds: minute.etaSeconds,
        stopsAway,
        distanceMeters,
        vehicleId: b.id,
        basis: minute.basis,
      })
    }

    // Rows that state a minute lead, in minute order. A row that states none
    // cannot be placed in a time order at all, so it follows them, and among
    // themselves those rows keep the one order they do describe — how many stops
    // are left. Putting them last claims nothing about when they arrive;
    // interleaving them would claim they arrive after the bus above.
    return rows.sort((a, b) => {
      const ax = a.etaSeconds ?? Number.POSITIVE_INFINITY
      const bx = b.etaSeconds ?? Number.POSITIVE_INFINITY
      if (ax !== bx) return ax - bx
      if (a.etaSeconds === undefined) return a.stopsAway - b.stopsAway
      return 0
    })
  }

  // ---------- F10 · 换乘链路的实时组装 ----------

  /**
   * F10's server half: the recorded chains of ONE commute purpose, each walked
   * against live readings.
   *
   * What this method may do is deliberately narrow — turn a stored chain into the
   * pure engine's inputs and hand them over. The margin, the band and every
   * 「不给结论」 reason belong to `deduceCommuteChain`; nothing here computes a
   * minute, a distance or a verdict, and wherever a fact is missing the absence
   * travels as `null` rather than as a value, so the engine names the missing fact
   * in its own code instead of concluding on a substitute.
   *
   * Per ride leg:
   *
   *  - the connection INTO the leg is priced by the path service
   *    (`getWalkingEta`), from the point the previous leg was left at — or from
   *    the chain's stored anchor, for the first leg. Both ends are GCJ-02 and are
   *    sent as held; the stored anchor was converted once, at the settings
   *    boundary, and converting it again would move the origin ~500 m.
   *  - the leg's line is read TWICE, once targeted at the board order and once at
   *    the alight order, and the two reads are matched by vehicle id — see
   *    `readChainLeg`.
   *  - the connection's MODE is passed as walking, and that is a known gap rather
   *    than a measurement: neither the chain nor `user_settings` stores one (007
   *    has no such column), so a cycling connection is priced by the walking route
   *    and 「找车与停车」 is not added. The alternative — inventing a cycling
   *    duration — is exactly what this project forbids, so the gap is stated
   *    instead. A leg's own `transferExtraMinutes` is still applied to it, because
   *    that number is the user's and does not depend on the mode we had to guess.
   *
   * The chain ENDS at its last ride leg's alight station. Nothing past it is
   * priced and no total arrival time is produced: the product need is the
   * per-transfer margin (「我能不能赶上这个换乘点的车」), the chain records an ORIGIN
   * anchor and no destination, and walking from the last alight station to a
   * guessed end would be inventing the destination.
   *
   * Reads are spent only where they can change the answer. A leg whose stations are
   * unset, whose connection could not be priced, or which its own record settles as
   * BACKWARDS (a bus stored the wrong way round, or the same station twice) is
   * refused by the engine BEFORE it ever looks at a reading — and the assembly
   * therefore does not read any of them (`chainLegInput`). Once the engine's refusal
   * is settled on some leg, NO later leg is read at all: the engine walks in leg
   * order and returns on the first leg it cannot conclude on, so a later leg's reads
   * could not change the answer. The engine is asked after every leg for exactly
   * that, rather than the rule being copied here.
   *
   * The two reads that ARE spent are the ones the answer depends on: a stale or a
   * degraded reading is discoverable only BY reading, so those are necessarily paid
   * for before the engine can refuse on them — and a leg that is read and then
   * refused spent nothing that could have been predicted.
   */
  async deduceCommuteChains(params: {
    purpose: CommuteChainPurpose
    userId?: string
  }): Promise<CommuteChainDeductionView[]> {
    const userId = params.userId ?? DEFAULT_USER_ID
    const now = Date.now()
    const settings = await this.db.getUserSettings(userId)
    const chains = (await this.db.getCommuteChains(userId))
      .filter(chain => chain.purpose === params.purpose)

    const views: CommuteChainDeductionView[] = []

    for (const chain of chains) {
      // Where the next connection starts: the chain's own anchor for the first
      // leg, then wherever the leg before it was left. Only the anchor can stay
      // unresolved, and only for the FIRST leg: a leg whose alight station cannot
      // be located is refused, the engine answers that refusal for the prefix this
      // loop holds, and the chain ends there — so no later leg is ever assembled
      // from an unresolved point (`chainLegInput` states the one cause there is).
      let from = this.anchorPoint(chain.originAnchor, settings)
      const legs: ChainLegInput[] = []

      // The engine's answer for the legs assembled SO FAR. Asking it after each
      // leg is how the short-circuit stays the engine's rule rather than a second
      // copy of it: an engine that refuses the prefix refuses the whole chain at
      // the same leg (it walks in leg order), and no later read could change that.
      let deduction: CommuteChainDeduction = deduceCommuteChain({ legs, now })

      for (const leg of chain.legs) {
        const { input, alight } = await this.chainLegInput({ leg, from, now })
        legs.push(input)
        from = alight
        deduction = deduceCommuteChain({ legs, now })
        if (deduction.status === 'no-conclusion') break
      }

      views.push({
        chainId: chain.id,
        name: chain.name,
        originAnchor: chain.originAnchor,
        purpose: chain.purpose,
        deduction,
      })
    }

    return views
  }

  /**
   * The stored anchor a chain starts from, as the settings row holds it (GCJ-02),
   * or null when it was never saved.
   *
   * Unset stays null: falling back to a coordinate would put the connection's
   * origin somewhere the user never saved, and a walking route from it would be a
   * real route from the wrong place.
   */
  private anchorPoint(
    anchor: CommuteChainAnchor,
    settings: StoredUserSettings | null,
  ): { lng: number, lat: number } | null {
    if (!settings) return null
    const lng = anchor === 'home' ? settings.homeLng : settings.workLng
    const lat = anchor === 'home' ? settings.homeLat : settings.workLat
    return lng === null || lat === null ? null : { lng, lat }
  }

  /**
   * A station of a stored leg, located in the line's stop list, or null.
   *
   * The stored pair is (name, order) and the ORDER is what locates a station in a
   * stop list (`CommuteChainLegSchema`) — but the name is checked against the stop
   * that order holds, because the two are one value the user chose together. They
   * disagree when the leg was recorded from a different stop list than the one
   * this build reads, and a subway line numbers the same station differently in
   * each direction, so locating by order alone would hand a walking route — and an
   * ETA — the wrong platform: a plausible number about a station the user never
   * named. A mismatch is therefore treated as 「not located」: nothing is priced and
   * nothing is read for that leg (see `chainLegInput`).
   *
   * Being IN the list is all this can promise. Whether the list places the stop
   * anywhere is the second fact a leg needs, and it is not decided here: a stop
   * carried without a coordinate is located and unplaceable at once, and the
   * caller's own branch answers that (`station-without-coordinate`).
   */
  private storedStation(
    detail: LineDetail | null,
    order: number,
    name: string | null,
  ): Station | null {
    if (!detail || name === null) return null
    const stop = detail.stops.find(s => s.order === order)
    return stop && stop.name === name ? stop : null
  }

  /**
   * One stored leg as the engine needs it, plus the point the leg is left at.
   *
   * The leg's DIRECTION is derived from the stored orders, never guessed. The
   * stored pair numbers the stop list the editor showed, which is direction 0's, so
   * both stations are located there first — that is what proves the record's stops
   * exist on this line. Then:
   *
   *  - alight order > board order: the ride runs with direction 0 — read direction
   *    0 at the stored orders, exactly as before;
   *  - alight order < board order on a SUBWAY: the ride runs the other way — read
   *    DIRECTION 1, translating BOTH orders into its numbering first. Two subway
   *    directions share one lineId while numbering the same station oppositely, so
   *    the stored orders are what say which way the leg runs and the translation is
   *    the provider's own construction rather than a guess: it builds direction 1 by
   *    reversing direction 0's station list and renumbering from 1
   *    (`universal-subway.ts` `getLineDetail`), which makes
   *    `directionOrder = totalStops + 1 - storedOrder`;
   *  - alight order < board order on a bus: the two ways there are two distinct
   *    upstream lineIds and the stored `lineId` already names one, so this remains
   *    the recording error it is;
   *  - the two ends equal: not a ride on any line, and still refused.
   *
   * Whichever direction is read, it is priced with THAT direction's geometry:
   * `readChainLeg` receives the direction's own detail, whose `stops` and
   * `stationDistances` are numbered in that direction, so a direction-1 read is
   * never priced against direction 0's platforms.
   *
   * A leg its own record settles as BACKWARDS (a bus stored the wrong way round, or
   * the same station twice on any line) is not read at all: the engine decides that
   * from the stored leg, so two upstream reads could not change the answer.
   *
   * When no connection can be priced, WHY is stated as the engine's input expects
   * it (`connectionUnpricedReason`): the layer that tried to price it is the only
   * one that knows whether the origin was unresolved, the stop list was unreadable,
   * the stored station was not in it, the list carries it there without a
   * coordinate, or the path service gave no duration. The
   * engine turns that into the refusal code the page reads — the anchor case apart,
   * the other causes are one code, so a caller can be exact here without every
   * distinction becoming wire.
   */
  private async chainLegInput(params: {
    leg: StoredCommuteChainLeg
    /**
     * Where the connection into this leg starts, or null when the chain's origin
     * anchor was never saved.
     *
     * A leg after the first starts at the station the leg before it was left at,
     * and that point is always resolved by the time a later leg is assembled: an
     * unresolved one is a refusal the engine answers for the prefix, which ends the
     * chain. Null here therefore names the anchor and nothing else.
     */
    from: { lng: number, lat: number } | null
    now: number
  }): Promise<{ input: ChainLegInput, alight: { lng: number, lat: number } | null }> {
    const { leg, from } = params
    const boardOrder = leg.boardStationOrder
    const alightOrder = leg.alightStationOrder

    // A leg whose stations were never chosen has nothing to locate, nothing to
    // price and nothing to read: the engine answers `station-unset` for it without
    // a reading, so no read is spent here either. No connection is attempted —
    // there is no station to walk to — so this leg's connection states no cause of
    // its own; the engine never reaches that check.
    if (boardOrder === null || alightOrder === null) {
      return {
        input: { leg, connectionSeconds: null, connectionMode: 'walk', live: null },
        alight: null,
      }
    }

    // The chain's origin anchor, settled FIRST and before anything is read. It is
    // the one cause of an unpriced connection the user can act on, and which cause
    // a connection has must not depend on the outcome of an upstream read: an
    // anchor that was never saved leaves no point to walk from at all, so no route
    // can be priced and no station needs locating — the answer is the same
    // whichever of those reads would also have failed, and settling it here spends
    // none of them. The alternative order lets a leg's own unreadable stop list
    // speak for a settings row the user can repair, and sends them nowhere.
    //
    // Reachable for the FIRST leg only: a leg is assembled only while every leg
    // before it was concluded, and returning an unresolved origin — here, or as a
    // leg below whose alight station cannot be located — is a refusal the engine
    // answers for the prefix, which ends the chain.
    if (from === null) {
      return {
        input: {
          leg,
          connectionSeconds: null,
          connectionUnpricedReason: 'anchor-unset',
          connectionMode: 'walk',
          live: null,
        },
        alight: null,
      }
    }

    const detail = await this.getLineDetail(leg.lineId, 0, leg.cityCode)
    const board = this.storedStation(detail, boardOrder, leg.boardStationName)
    const alight = this.storedStation(detail, alightOrder, leg.alightStationName)

    // Both stations, or neither: a leg whose board station is not the one the user
    // stored is not this leg, so nothing about it is priced or read — the engine
    // then refuses on the connection, which has no duration, and no number about a
    // wrong platform is printed in its place. WHICH fact left the pair unlocated is
    // stated: a line this app could not read at all, or a stop list this direction
    // carries at other orders. Both leave the user no action, so both reach the
    // page as one code.
    if (!board || !alight) {
      return {
        input: {
          leg,
          connectionSeconds: null,
          connectionUnpricedReason: detail === null ? 'line-unavailable' : 'station-unlocated',
          connectionMode: 'walk',
          live: null,
        },
        alight: null,
      }
    }

    // A located stop must also be PLACEABLE for anything about this leg to be
    // priced. The connection is a walking route to the BOARD station's own
    // coordinate and the point the leg is left at is the ALIGHT station's, so a
    // stop the direction's list carries without a coordinate leaves both
    // unanswerable: the record is intact and the position is simply what upstream
    // never gave. No route is requested and no platform is read — a walk priced
    // to a substitute point would be a real route to a place nobody named, and it
    // would make the leg look located enough to conclude from.
    const boardPoint = stationPoint(board)
    const alightPoint = stationPoint(alight)
    if (!boardPoint || !alightPoint) {
      return {
        input: {
          leg,
          connectionSeconds: null,
          connectionUnpricedReason: 'station-without-coordinate',
          connectionMode: 'walk',
          live: null,
        },
        alight: null,
      }
    }

    // The connection's duration, from the resolved point to the resolved platform.
    // Nothing is substituted for a missing duration, and the six ways this method
    // can leave one unpriced are each decided at the branch that learns the fact:
    // the chain's anchor was never saved (`anchor-unset`), this build could not
    // read the leg's line (`line-unavailable`), the stored station is not in the
    // direction's stop list (`station-unlocated`), the list carries it there and
    // states no coordinate for it (`station-without-coordinate`) — all four named
    // above, without a route request — and the path service priced no route
    // between two ends that BOTH resolved (`route-unpriced`, below). A leg whose
    // stations were never chosen is the sixth and is named by the engine's own
    // `station-unset`, which it answers before it ever reaches the connection.
    const connectionSeconds = (await this.getWalkingEta(from.lng, from.lat, boardPoint.lng, boardPoint.lat))?.durationSeconds ?? null
    const connectionUnpricedReason: ChainConnectionUnpricedReason | undefined = connectionSeconds === null
      ? 'route-unpriced'
      : undefined

    // Which way the ride runs, from the stored orders alone. The subway test is the
    // project's own convention — a subway id carries the `subway_` prefix, which is
    // what routes a read to the subway engine (`subway-router.ts`,
    // `universal-subway.ts`, and `vehicleArrivals` below) — so this asks the same
    // question of the same field the engine and the schema ask.
    const forward = alightOrder > boardOrder
    const subway = leg.lineId.startsWith('subway_')
    // A subway ride the other way round is REAL; a bus stored the wrong way round,
    // and a station-to-itself leg on any line, are settled from the record. The
    // engine names them `leg-recorded-backwards`, and it decides that without a
    // reading — so the two targeted reads are skipped rather than spent on an
    // answer that cannot move.
    const settledBackwards = !forward && !(subway && alightOrder < boardOrder)

    let live: ChainLegLive | null = null
    if (connectionSeconds !== null && !settledBackwards) {
      // The direction actually travelled, and ITS stop list. A direction-1 read's
      // target orders must address direction 1's numbering, and its geometry must be
      // direction 1's, or the minutes would be about two other platforms.
      const readDetail = forward ? detail : await this.getLineDetail(leg.lineId, 1, leg.cityCode)
      // No stop list for the direction the ride runs in: there is no numbering to
      // target and no geometry to price against, and reading direction 0's platforms
      // instead would state minutes about stations this ride never touches. No read
      // is spent, and the engine answers `no-live` — the leg's line was not read in
      // the direction this leg runs.
      if (readDetail) {
        const totalStops = readDetail.stops.length
        const directionOrder = (order: number): number => totalStops + 1 - order
        live = await this.readChainLeg({
          lineId: leg.lineId,
          direction: forward ? 0 : 1,
          cityCode: leg.cityCode,
          boardOrder: forward ? boardOrder : directionOrder(boardOrder),
          alightOrder: forward ? alightOrder : directionOrder(alightOrder),
          detail: readDetail,
          now: params.now,
        })
      }
    }

    return {
      input: { leg, connectionSeconds, connectionUnpricedReason, connectionMode: 'walk', live },
      alight: alightPoint,
    }
  }

  /**
   * A leg's live reading, built from TWO targeted reads of its line.
   *
   * The adapter answers for ONE requested target station per read — chelaile
   * matches a vehicle's `travels` by the order the request named — so one
   * vehicle's board minute and alight minute cannot come from a single read. Both
   * reads go through the aggregator's per-station cache
   * (`<lineId>_<direction>_target_<order>`, 18 s), which is also what keeps the
   * second read of a platform inside its window free.
   *
   * The two are matched by the provider's stable vehicle id and never by position:
   * each read is ordered by ITS OWN arrival minutes, so the nth row of one read is
   * routinely a different vehicle than the nth of the other. A vehicle only one
   * read carries has no usable pair and is dropped — that is the only pairing rule
   * under which a ride duration cannot end up describing nobody's journey.
   *
   * THE INTERSECTION IS NON-EMPTY ONLY BECAUSE OF AN UPSTREAM INVARIANT this repo
   * does not control or document: `vehicleArrivals` drops every vehicle whose
   * `nextOrder` is past the requested order, a filter monotone in that order, so
   * the board read's rows are a subset of the alight read's and the matched set is
   * the board set. That relation holds FOR A LEG THAT RUNS FORWARD IN THE DIRECTION
   * IT IS READ — its alight order greater than its board order in THAT direction's
   * numbering. The caller resolves the direction from the stored orders and
   * translates both into it (`chainLegInput`), so a subway leg stored the other way
   * round arrives here with alight > board as well. A bus leg stored backwards, and
   * a station-to-itself leg, invert the relation instead — which is why those are
   * refused as `leg-recorded-backwards` before this pairing is ever reached and the
   * schema rejects them on write. Nothing here may lean on it beyond that: the two
   * reads are each answered for their own order, the rows are truncated NOWHERE on
   * this path (the display board's own six-row cap is applied in
   * `getStationArrivals`, not here), and the pairing is by id — so if a future
   * provider broke the invariant, a board-only vehicle would lose its pair and be
   * dropped, never have a minute invented. `boardVehiclesOnTheWay` travels with the
   * leg precisely so that an empty pair can say whether the service was empty or the
   * reading was.
   */
  private async readChainLeg(params: {
    lineId: string
    direction: number
    cityCode?: string
    boardOrder: number
    alightOrder: number
    detail: LineDetail | null
    now: number
  }): Promise<ChainLegLive | null> {
    const [board, alight] = await Promise.all([
      this.getLiveStatus(params.lineId, params.direction, params.cityCode, false, { targetOrder: params.boardOrder }),
      this.getLiveStatus(params.lineId, params.direction, params.cityCode, false, { targetOrder: params.alightOrder }),
    ])

    // Priced ONCE each and kept whole: the board read's own rows are what
    // `boardVehiclesOnTheWay` counts, and its full set is what gets paired.
    const boardArrivals = board
      ? this.vehicleArrivals({ detail: params.detail, live: board, targetOrder: params.boardOrder, now: params.now })
      : []
    const alightArrivals = alight
      ? this.vehicleArrivals({ detail: params.detail, live: alight, targetOrder: params.alightOrder, now: params.now })
      : []

    /**
     * The rows a pair can be built from: the ones that STATE a minute.
     *
     * A ride duration is `alight - board`, so a vehicle priced at neither end has
     * no pair to give and is dropped here instead of being handed over with a
     * substitute — the absence is what upstream published, and inventing the
     * missing half is the one thing this path may not do. On the bus path the row
     * that states no minute is the one whose targeted reading published none (this
     * app's own extrapolation is gone), so a chain leg over such a vehicle reports
     * that it cannot confirm a rideable service rather than a duration built on a
     * snapshot speed.
     */
    const priced = (rows: VehicleArrival[]): TargetedArrival[] =>
      rows.filter((row): row is VehicleArrival & { etaSeconds: number, basis: ArrivalBasis } =>
        row.etaSeconds !== undefined && row.basis !== undefined)

    // F3's service state for THIS leg's line, from the detail this path already
    // resolved to locate the two stations and from the same `now` the reads are
    // judged against — `operatingStatusOf`, the derivation the station board
    // states, so the two screens cannot disagree about one line. Deriving it here
    // costs no upstream call: the detail is the cached line read the leg needed
    // anyway, and the state is a function of it and the clock. An empty chain row
    // needs it to tell 首班前 / 已过末班 from a gap in a service that is running.
    const operatingStatus = operatingStatusOf({
      firstDeparture: params.detail?.firstBusTime,
      lastDeparture: params.detail?.lastBusTime,
      nowSecOfDay: operatingDaySecondsOf(new Date(params.now)),
    })

    return legLiveReading({
      board,
      alight,
      // Only the rows that state a minute can be paired — see `priced`.
      vehicles: pairTargetedReads(priced(boardArrivals), priced(alightArrivals)),
      // Every row the BOARD read carried, minute or no minute. A vehicle we could
      // not price is still a vehicle on its way here, so counting only the priced
      // rows would let an empty pair be reported as an empty SERVICE
      // (`no-vehicle`, 「暂时没有开往这一站的车」) when what is true is that nobody
      // published a time for it (`no-shared-vehicle`).
      boardVehiclesOnTheWay: boardArrivals.length,
      operatingStatus,
    })
  }

  private static subKey(lineId: string, direction: number): string {
    return `${lineId}_${direction}`
  }

  subscribe(ws: WebSocket, lineId: string, direction: number = 0, cityCode: string = DEFAULT_CITY_CODE): void {
    const key = TransitService.subKey(lineId, direction)
    let sub = this.activeSubscriptions.get(key)
    if (!sub) {
      sub = { lineId, direction, cityCode, clients: new Set() }
      this.activeSubscriptions.set(key, sub)
    }
    else {
      // Keep the city in sync with the latest subscriber for this line+direction.
      sub.cityCode = cityCode
    }
    sub.clients.add(ws)

    // Immediately push current status
    void (async () => {
      const status = await this.getLiveStatus(lineId, direction, cityCode)

      if (status && ws.readyState === ws.OPEN) {
        const msg: WsServerMessage = {
          type: 'line_update',
          lineId,
          direction,
          status,
        }
        ws.send(JSON.stringify(msg))
      }
    })()
  }

  /**
   * Drop one client from one subscription. `direction` is required: a subway
   * line has two independent subscriptions under the same lineId, and leaving
   * one must not tear down the other.
   */
  unsubscribe(ws: WebSocket, lineId: string, direction?: number): void {
    if (direction !== undefined) {
      const key = TransitService.subKey(lineId, direction)
      const sub = this.activeSubscriptions.get(key)
      if (sub) {
        sub.clients.delete(ws)
        if (sub.clients.size === 0) {
          this.activeSubscriptions.delete(key)
        }
      }
      return
    }
    // Legacy form: remove this client from every direction of the line.
    for (const [key, sub] of this.activeSubscriptions.entries()) {
      if (sub.lineId !== lineId) continue
      sub.clients.delete(ws)
      if (sub.clients.size === 0) {
        this.activeSubscriptions.delete(key)
      }
    }
  }

  removeClient(ws: WebSocket): void {
    for (const [key, sub] of this.activeSubscriptions.entries()) {
      sub.clients.delete(ws)
      if (sub.clients.size === 0) {
        this.activeSubscriptions.delete(key)
      }
    }
  }

  private startPollingLoop(): void {
    if (this.pollingTimer) return

    this.pollingTimer = setInterval(() => {
      this.pollActiveLines().catch((err) => {
        console.warn('Poll active lines error:', err)
      })
    }, this.pollIntervalMs)
  }

  private async pollActiveLines(): Promise<void> {
    if (this.activeSubscriptions.size === 0) return

    for (const [, sub] of this.activeSubscriptions.entries()) {
      if (sub.clients.size === 0) continue

      try {
        const status = await this.getLiveStatus(sub.lineId, sub.direction, sub.cityCode)
        if (!status) continue

        const payload = JSON.stringify({
          type: 'line_update',
          lineId: sub.lineId,
          direction: sub.direction,
          status,
        } satisfies WsServerMessage)

        for (const ws of sub.clients) {
          if (ws.readyState === ws.OPEN) {
            ws.send(payload)
          }
        }
      }
      catch (err) {
        console.warn(`Failed to poll line ${sub.lineId}:`, err)
      }
    }
  }

  stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer)
      this.pollingTimer = null
    }
  }
}
