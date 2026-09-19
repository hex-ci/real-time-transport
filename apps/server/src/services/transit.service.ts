import type { WebSocket } from 'ws'
import {
  ChelaileProvider,
  ApizeroProvider,
  UniversalSubwayEngine,
  SubwayRouterProvider,
  TransitAggregator,
  AmapGisService,
  StationTimetableService,
} from '@real-time-transport/transit-adapter'
import type {
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  UserFavoriteLine,
  WsServerMessage,
  TransitCity,
  WalkDecision,
} from '@real-time-transport/shared'
import {
  CITY_DICTIONARY,
  HOT_CITY_META,
  DEFAULT_CITY_CODE,
} from '@real-time-transport/shared'
import type { Database } from '../db/client.js'

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
        congestion: i % 2 === 0 ? 'low' : 'medium',
        distanceFromStart: Math.round(currentDist),
        distanceToWaitStn,
        travelTimeSec,
        license: `京A·${7800 + (i * 127) % 900}`,
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

  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number) {
    return this.amap.getWalkingEta(originLng, originLat, destLng, destLat)
  }

  /**
   * Catch-the-bus decision: compares real-road walking ETA (amap) against the
   * nearest vehicle's remaining travel time for a station on a given line.
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
    if (!station) return null

    const walk = await this.amap.getWalkingEta(params.originLng, params.originLat, station.lng, station.lat)
    if (!walk) return null

    const arrivalsResult = await this.getStationArrivals(params.lineId, params.stationName, params.direction, 1, params.cityCode)
    const nextArrival = arrivalsResult?.arrivals?.[0]
    let vehicleEtaSeconds: number | null = null
    if (nextArrival) {
      vehicleEtaSeconds = nextArrival.isAtStation ? 0 : nextArrival.etaSeconds
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

  async getNearbyStations(lng: number, lat: number, radius: number = 800) {
    return this.amap.getNearbyStations(lng, lat, radius)
  }

  async reverseGeocode(lng: number, lat: number) {
    return this.amap.reverseGeocode(lng, lat)
  }

  /**
   * Station arrivals with precision awareness:
   * - exact minute-level timetable registered (e.g. Line 7 群芳) -> official departures
   * - otherwise -> simulated engine estimate (isExact: false)
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
    arrivals: Array<{
      time: string
      etaSeconds: number
      stopsAway?: number
      distanceMeters?: number
      isAtStation?: boolean
      busId?: string
    }>
  } | null> {
    const now = Date.now()
    const bjDate = new Date(now + 8 * 3600 * 1000)
    const hours = bjDate.getUTCHours()
    const minutes = bjDate.getUTCMinutes()
    const seconds = bjDate.getUTCSeconds()
    let nowSecOfDay = hours * 3600 + minutes * 60 + seconds
    if (hours < 4) {
      nowSecOfDay += 24 * 3600
    }

    // 1) Exact timetable overlay
    const exact = this.timetables.query(lineId, stationName, direction, nowSecOfDay, { count })
    if (exact) {
      return {
        isExact: true,
        arrivals: exact.arrivals.map(a => ({ time: a.time, etaSeconds: a.etaSeconds })),
      }
    }

    // 2) Station resolution: prefer exact order, then exact name, finally substring
    const detail = await this.getLineDetail(lineId, direction, cityCode)
    if (!detail) return null
    const station = (typeof targetOrderParam === 'number' && targetOrderParam > 0)
      ? detail.stops.find(s => s.order === targetOrderParam)
      : (detail.stops.find(s => s.name === stationName) || detail.stops.find(s => s.name.includes(stationName)))
    if (!station) return null
    const targetOrder = station.order

    // 3) Request live status targeted to this station
    const live = await this.getLiveStatus(lineId, direction, cityCode, false, { targetOrder })
    if (!live || !live.buses || live.buses.length === 0) {
      return { isExact: false, arrivals: [] }
    }

    const isSubway = detail.type === 'subway' || lineId.startsWith('subway_')
    const sd = detail.stationDistances
    const targetDist = sd && sd[targetOrder - 1] !== undefined ? sd[targetOrder - 1]! : undefined

    const arrivals: Array<{
      time: string
      etaSeconds: number
      stopsAway?: number
      distanceMeters?: number
      isAtStation?: boolean
      busId?: string
    }> = []

    for (const b of live.buses) {
      if (typeof b.order !== 'number') continue

      // Upstream -1 sentinel (chelaile): this bus is already past the target station.
      if (b.distanceToWaitStn === -1) continue

      // The vehicle's nose is heading to nextOrder; it has cleared order.
      // A bus serves the target station only when nextOrder === targetOrder.
      if (b.nextOrder !== undefined && b.nextOrder > targetOrder) continue
      if (b.nextOrder === undefined && b.order >= targetOrder) continue

      // Currently dwelling at station platform (within 35m of the stop line)
      const isAtPlatform = typeof targetDist === 'number' && typeof b.distanceFromStart === 'number'
        && Math.abs(b.distanceFromStart - targetDist) <= 35

      if (isAtPlatform) {
        arrivals.push({
          time: '正在进站',
          etaSeconds: 0,
          stopsAway: 0,
          isAtStation: true,
          busId: b.id,
        })
        continue
      }

      // Bus is approaching: stopsAway counts full hops from nextOrder to target
      const stopsAway = Math.max(1, targetOrder - (b.nextOrder ?? b.order))
      let etaSeconds: number
      let time: string

      if (typeof b.travelTimeSec === 'number' && b.travelTimeSec > 0) {
        etaSeconds = b.travelTimeSec
        const d = new Date(now + etaSeconds * 1000 + 8 * 3600 * 1000)
        time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
      }
      else if (isSubway) {
        const progress = typeof b.progress === 'number' ? b.progress : 0
        etaSeconds = Math.max(30, Math.round((stopsAway - progress) * 135))
        const d = new Date(now + etaSeconds * 1000 + 8 * 3600 * 1000)
        time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
      }
      else {
        const sd = detail.stationDistances
        const fallbackTargetDist = sd ? sd[targetOrder - 1] : undefined
        if (typeof fallbackTargetDist === 'number' && typeof b.distanceFromStart === 'number' && fallbackTargetDist > b.distanceFromStart) {
          const remainingMeters = fallbackTargetDist - b.distanceFromStart
          const speed = (typeof b.speed === 'number' && b.speed >= 3 && b.speed <= 18) ? b.speed : 6.0
          etaSeconds = Math.max(30, Math.round(remainingMeters / speed + (stopsAway - 1) * 30))
        }
        else {
          etaSeconds = Math.max(60, stopsAway * 150)
        }
        const d = new Date(now + etaSeconds * 1000 + 8 * 3600 * 1000)
        time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
      }

      arrivals.push({
        time,
        etaSeconds,
        stopsAway,
        distanceMeters: b.distanceToWaitStn && b.distanceToWaitStn > 0 ? b.distanceToWaitStn : undefined,
        busId: b.id,
      })
    }

    arrivals.sort((a, b) => a.etaSeconds - b.etaSeconds)
    return { isExact: false, arrivals: arrivals.slice(0, count) }
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
    void this.getLiveStatus(lineId, direction, cityCode).then((status) => {
      if (status && ws.readyState === ws.OPEN) {
        const msg: WsServerMessage = {
          type: 'line_update',
          lineId,
          direction,
          status,
        }
        ws.send(JSON.stringify(msg))
      }
    })
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
