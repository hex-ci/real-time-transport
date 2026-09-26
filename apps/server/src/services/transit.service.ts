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
 * 当前本地 `HH:MM` —— 存储的通勤时段使用的形式（本地时钟，与通勤档案读的钟一致）。
 */
function localHHMM(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * 本引擎用来决定「未配置的用户被问到哪个锚点」的跨度：它自己的参数，不是用户的设置；
 * 它只决定句子说的是哪个锚点，绝不作为一行用户设置交给调用方。
 */
const UNCONFIGURED_COMMUTE_WINDOW = {
  ...DEFAULT_COMMUTE_HOURS,
  homeLat: null,
  homeLng: null,
  workLat: null,
  workLng: null,
} satisfies StoredUserSettings

/**
 * 用户没有说时段时，本引擎用来判定 `hhmm` 的跨度：他从未选择的每个端点都回落到本引擎自己的
 * 参数，已存的端点照旧用他的；该值从不作为用户时段交出去。
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
 * F11 的冷却，按 (user, 数据类)：故意取实时缓存自己的 TTL，令两者不可能各自漂移。
 */
const REFRESH_COOLDOWN_MS = LIVE_CACHE_TTL_MS

/**
 * 距下次允许刷新还有多少秒：每个分支都从 `nextAllowedAt` 推出来，它是唯一真源。
 */
function secondsUntil(nextAllowedAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
}

/**
 * 一个站点自己的点，没有位置时为 null；任一轴为 0 也算没有位置（与 `statedCoordinate` 同一条规则）。
 */
function stationPoint(station: Station | null | undefined): { lng: number, lat: number } | null {
  if (!station) return null
  const lat = statedCoordinate(station.lat)
  const lng = statedCoordinate(station.lng)
  return lat === undefined || lng === undefined ? null : { lng, lat }
}

/**
 * 一辆车到达某一个目标站的读数：带车辆 id（两次定向读取据此配对）与定价用的 basis，
 * F4 的 mark 由调用方施加。
 */
interface VehicleArrival {
  /**
   * 该行声明的时刻，没有声明分钟时缺席 —— 与 `etaSeconds` 同行。
   */
  time?: string
  /**
   * 到这辆车到达目标站的秒数，该行未声明分钟时缺席 —— 缺席是一种结果，
   * 不用本应用自己的算术填补。
   */
  etaSeconds?: number
  stopsAway: number
  distanceMeters?: number
  isAtStation?: boolean
  vehicleId: string
  /**
   * `etaSeconds` 由哪种算术产生；该行不声明分钟时正好缺席。
   */
  basis?: ArrivalBasis
}

export class TransitService {
  private aggregator: TransitAggregator
  private amap: AmapGisService
  private chelaile: ChelaileProvider
  private timetables: StationTimetableService
  /**
   * 按 `${lineId}_${direction}` 作键，不能只按 lineId：地铁一条线两个方向共用一个 lineId。
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
   * 每个 (user, 数据类) 一个窗口：键里带上数据类，虽然今天只有实时这一类。
   */
  private readonly refreshWindows = new Map<string, {
    /**
     * 本用户最近一次取到读数的时刻，从未取到时为 null；窗口关闭期间报告它。
     */
    lastObtainedAt: number | null
    nextAllowedAt: number
  }>()

  /**
   * 保留多少窗口：键带调用方给的 user id 且端点人人可达，映射必须有界；最久未刷新的窗口价值最低。
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
    // 把地铁引擎接到本服务带缓存的 getLineDetail 上：直播轮询路径复用 DB 里的静态几何，
    // 不再每 18s 重问 Amap。
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
   * 城市字典：把 chelaile 自动生成的城市字典与它未覆盖的人工维护的轨道交通城市合并。
   */
  getCities(): TransitCity[] {
    const dictByCode = new Map(CITY_DICTIONARY.map(c => [c.code, c]))
    const mergedCodes = new Set<string>()
    const merged: TransitCity[] = []

    // 人工维护的热门城市排在最前（按 HOT_CITY_META 顺序），hasMetro 全为 true：
    // 它们都有轨道交通，通用地铁引擎经 Amap 模拟它们，与 chelaile 覆盖无关。
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

    for (const c of CITY_DICTIONARY) {
      if (mergedCodes.has(c.code)) continue
      merged.push(c)
      mergedCodes.add(c.code)
    }

    const hotCount = HOT_CITY_META.length
    const rest = merged.slice(hotCount).sort((a, b) => a.code.localeCompare(b.code))
    return [...merged.slice(0, hotCount), ...rest]
  }

  async searchLines(keyword: string, cityCode: string = DEFAULT_CITY_CODE): Promise<LineSummary[]> {
    return this.aggregator.searchLines(keyword, cityCode)
  }

  /**
   * 记录几何回填尝试：每个冷却窗口最多回填一次，否则每个请求都会重问上游。
   */
  private readonly geomBackfillAt = new Map<string, number>()
  private static readonly GEOM_BACKFILL_COOLDOWN_MS = 6 * 3600 * 1000

  /**
   * 带静态仓储缓存的线路详情：DB 命中即返回（零上游配额），未命中则取回并落库；
   * 缓存行缺几何时每个冷却窗口最多回填一次，否则按原样提供。
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
      // 缓存行缺几何：每个冷却窗口只重试上游一次，之后继续提供已有的
      // （客户端降级为均匀间隔）。
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
    // 上游失败但有更早的缓存行：提供它（无几何的回退仍能渲染，
    // 车辆降级为均匀间隔）。
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
   * 为一个屏幕正在看的线路重读实时数据，每个用户每个冷却窗口一次。
   *
   * 结果是三种不可互换的事实：`throttled` 什么都没读；`unavailable` 读了而都没答；
   * `ok` 至少一个答了。只有 `ok` 可带新时刻，失败的尝试保留原有时刻。只覆盖实时类，
   * 长 TTL 线路数据保持缓存原样。
   */
  async refreshLive(params: RefreshLiveRequest): Promise<{
    outcome: 'ok' | 'throttled' | 'unavailable'
    result: RefreshLiveResult
  }> {
    const attemptedAt = Date.now()
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
          // 没有读任何线路，就没有按线路的结果可报：用 null 读数列出它们
          // 等于说相反的话（读了而没答）。
          lines: [],
        },
      }
    }

    // 窗口在尝试时开，而不是在结果时开：失败的刷新已经花掉了
    // 上游调用，不能变成重试循环。
    const nextAllowedAt = attemptedAt + REFRESH_COOLDOWN_MS

    const lines: RefreshLiveLineResult[] = []
    let newestObtainedAt: number | null = null

    // 同一条线出现两次是一次读数：请求命名的是线路，
    // 重复的不得把上游读取翻倍。
    const targets = new Map(params.lines.map(target => [
      `${target.lineId}_${target.direction}`,
      target,
    ]))

    for (const target of targets.values()) {
      // 丢掉缓存读数，让这次调用是真的读；与轮询循环重叠时仍可能为这个
      // 键花掉两次上游读取（聚合器没有 single-flight）。
      this.aggregator.invalidateLive(target.lineId, target.direction)
      const status = await this.getLiveStatus(target.lineId, target.direction, target.cityCode)
      // 取得读数的时刻，按产生它的来源所盖，绝不是本方法作答的时刻。
      const obtainedAt = status ? status.updatedAt : null

      lines.push({
        lineId: target.lineId,
        direction: target.direction,
        lastUpdatedAt: obtainedAt,
        // 读数的 provenance，随产生它的状态一路带来；没有任何读数时为 null。
        // 生成的读数与别的读数一样盖当前时间，只看时刻无法知道手里是什么值。
        dataSource: status?.dataSource ?? null,
        isDegraded: status?.isDegraded ?? null,
      })
      if (obtainedAt !== null && (newestObtainedAt === null || obtainedAt > newestObtainedAt)) {
        newestObtainedAt = obtainedAt
      }
    }

    // 什么都没取到的刷新保留本用户曾取到的最新时刻：读数仍是那时的，
    // 而时钟不是读数。
    const lastObtainedAt = newestObtainedAt ?? held?.lastObtainedAt ?? null
    this.rememberRefreshWindow(key, { lastObtainedAt, nextAllowedAt })

    return {
      outcome: newestObtainedAt === null ? 'unavailable' : 'ok',
      result: {
        dataClass: 'live',
        throttled: false,
        lastUpdatedAt: lastObtainedAt,
        nextAllowedAt,
        // 这次尝试无论是否取到东西都花掉了窗口，因此等待时间是整个节拍。
        retryAfterSeconds: secondsUntil(nextAllowedAt, attemptedAt),
        lines,
      },
    }
  }

  /**
   * 记录窗口并让映射有界：重新插入而不是覆盖，迭代顺序即最近使用顺序，
   * 第一个键就是最久未刷新的窗口。
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
   * 环境强制生成车辆而非上游实时数据时为 true；暴露给 web 端以便明确标注模拟数据。
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
   * 为「线路作为整体（两个方向）被关注之前存下的收藏」回填 `reverseLineId`：
   * 地铁两个方向共用一个上游 lineId（反向就是同一个 id），公交每个方向一个 lineId
   * （取 provider 的 `otherDirectionLineId`）。解析不出来的行保持原样，界面因此不为它提供方向切换。
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
      }
      resolved.push(fav)
    }

    return resolved
  }

  /**
   * 一个 GCJ-02 点对的步行 ETA：起点已在 HTTP 边界换算，终点是存储的站点坐标（已是 GCJ-02）；
   * Amap 客户端只接 GCJ-02、不做换算。
   */
  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number) {
    return this.amap.getWalkingEta(originLng, originLat, destLng, destLat)
  }

  /**
   * 赶公交决策：把真实道路步行 ETA 与某条线某站最近车辆的剩余行程时间相比。
   * `origin*` 是 GCJ-02，站点坐标来自缓存的线路详情（Amap 返回的 GCJ-02），步行段两端同一系统。
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
    // 线路详情无法定位的站台定不出步行价：没有终点可规划，
    // 从替代点算出的路线回答的是没人命名的地点。
    const destination = stationPoint(station)
    if (!destination) return null

    const walk = await this.amap.getWalkingEta(params.originLng, params.originLat, destination.lng, destination.lat)
    if (!walk) return null

    const arrivalsResult = await this.getStationArrivals(params.lineId, params.stationName, params.direction, 1, params.cityCode)
    const nextArrival = arrivalsResult?.arrivals?.[0]
    let vehicleEtaSeconds: number | null = null
    if (nextArrival) {
      // `statedArrivalMinutes` 是「有分钟或没有」的唯一规则：到站态答 0，
      // 声明分钟的行答它，读数没发布分钟的行留空 —— 绝不与没人说过的数字做步行比较。
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
   * F1 针对一个站台的参考行：从用户所在锚点出发的真实步行时间，以及由此得出的出门结论。
   *
   * 锚点在服务端按存储行读（GCJ-02），原样交给 Amap；HTTP GIS 路由的 `originLng/originLat`
   * 按契约是原始 WGS-84 设备定位、入口即换算，把存储锚点推过去会换算第二次。
   *
   * 答案会是猜测时返回 null：没有锚点、没有可走到的车、没定出步行路线、到站数字过期或降级。
   * 它唯一报告的非结论是从未保存的锚点。
   */
  private async departureReference(params: {
    /**
     * 站台坐标（按线路详情所持），该站没有坐标时为 null —— 定价意义上同样是缺席。
     */
    station: { lng: number, lat: number } | null
    arrivals: readonly ArrivalRow[]
    trust: DepartureTrust
  }): Promise<DepartureReference | null> {
    if (!params.station) return null

    const stored = await this.db.getUserSettings(DEFAULT_USER_ID)
    // 「你在哪」指哪个锚点由通勤时段决定；没有选中时段的用户没有属于他的窗口
    // （没有行，或一行四个时刻为 NULL），两者到这里是同一件事：他从未选择的端点。
    // 下面的跨度是本引擎自己的参数，他选过的端点按他的用；该跨度从不作为用户时段报出，
    // 它只决定这一行问的是哪个锚点。
    const hours = commuteWindowFor(stored)
    const leg = anchorLegAt(localHHMM(), hours)
    if (!leg) return null

    // 锚点只从存储行读：上面的跨度不带锚点，而没有行的库里也没存锚点，
    // 因此这里 `stored` 为 null 与它的锚点列为 null 是同一件事。
    const lng = leg === 'home' ? stored?.homeLng ?? null : stored?.workLng ?? null
    const lat = leg === 'home' ? stored?.homeLat ?? null : stored?.workLat ?? null
    // 未设置就报未设置：修它在设置页，这一行要说出来，
    // 而不是回退到用户从未保存的坐标。
    if (lng === null || lat === null) return { status: 'anchor-unset', anchor: leg }

    // 没有可据以结论的东西，也没有理由为它花一次步行请求：
    // 「现在就走」建在过期或降级的读数上是这一行绝不能说的话。
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

  /** 一个 GCJ-02 点周边的站点（该点已在 HTTP 边界换算）。 */
  async getNearbyStations(lng: number, lat: number, radius: number = 800) {
    return this.amap.getNearbyStations(lng, lat, radius)
  }

  /** 一个 GCJ-02 点的地标（该点已在 HTTP 边界换算）。 */
  async reverseGeocode(lng: number, lat: number) {
    return this.amap.reverseGeocode(lng, lat)
  }

  /**
   * 站点到站，带精度意识：平台注册了分钟级时刻表则给官方发车，否则给实时读数
   * （或地铁引擎的列车），`isExact: false`。
   *
   * 每一行自带 F4 provenance：上游 `travelTimeSec` 是实时，地铁引擎的 135 s/站是排班推演，
   * 没有分钟则没有 mark。生成车辆优先于前两者（地铁行会带上引擎编的 `travelTimeSec`）。
   *
   * 答案还带该站台的 F1 `reference` 行，用的是调用方显示的同一批到站分钟。
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
     * F3：服务是否在运营，由线路自己的首末班推导 —— 空 `arrivals` 单独分不出首班前 /
     * 已过末班 / 运营中但没有车。
     */
    operatingStatus: OperatingStatus
    /**
     * F-C：该站台精确时刻表自己的注意事项，原样携带，没有时为 null；
     * 只有注册时刻表有它，实时与模拟路径以 null 说明没有。
     */
    note: string | null
    reference: DepartureReference | null
  } | null> {
    const now = Date.now()
    // 北京运营日内的秒数（00:00~28:00）：00:00-03:59 属前一天的尾巴，
    // 因此在这里移位而不读日历日期。
    const nowSecOfDay = operatingDaySecondsOf(new Date(now))

    const detail = await this.getLineDetail(lineId, direction, cityCode)
    const station = detail
      ? ((typeof targetOrderParam === 'number' && targetOrderParam > 0)
          ? detail.stops.find(s => s.order === targetOrderParam)
          : (detail.stops.find(s => s.name === stationName) || detail.stops.find(s => s.name.includes(stationName))))
      : undefined

    const exact = this.timetables.query(lineId, stationName, direction, nowSecOfDay, { count })
    if (exact) {
      const arrivals: ArrivalRow[] = exact.arrivals.map(a => ({
        time: a.time,
        etaSeconds: a.etaSeconds,
        provenance: 'exact_timetable',
      }))
      return {
        isExact: true,
        arrivals,
        // 这里由该站自己的首末班决定状态，而不是线路的：与上面的发车列表同源，
        // 因此状态与旁边的发车不能对「这个站台的运营是否已结束」各说各话。
        operatingStatus: operatingStatusOf({
          firstDeparture: exact.first,
          lastDeparture: exact.last,
          nowSecOfDay,
        }),
        // F-C：时刻表自己的注意事项随它所限定的发车一起走；
        // 空串不是注意事项 —— 没有可说时该字段是 null，渲染方的 v-if 于是陈述事实而不是测空白。
        note: exact.note.trim() ? exact.note : null,
        // 注册时刻表是时钟的函数而非缓存观测，因此永不陈旧：步行决策可以用它。
        reference: await this.departureReference({ station: stationPoint(station), arrivals, trust: 'ok' }),
      }
    }

    if (!detail || !station) return null
    const targetOrder = station.order

    // F3：线路自己的服务时段，按静态详情所持；缺失的时段保持缺失 ——
    // 状态这时报 未知，而不是假定一个窗口。
    const operatingStatus = operatingStatusOf({
      firstDeparture: detail.firstBusTime,
      lastDeparture: detail.lastBusTime,
      nowSecOfDay,
    })

    const live = await this.getLiveStatus(lineId, direction, cityCode, false, { targetOrder })
    // 缺读数对任何由它推导的答案都是降级：它支撑不了结论，说出来比假装便宜。
    const trust: DepartureTrust = live
      ? arrivalTrust({ isDegraded: live.isDegraded, updatedAt: live.updatedAt })
      : 'degraded'
    if (!live || !live.buses || live.buses.length === 0) {
      // 没有车可走。参考行仍会报从未保存的锚点 —— 那是设置行的事实，不是这个站台的事实。
      return {
        isExact: false,
        arrivals: [],
        operatingStatus,
        // 这里没有注册时刻表作答，因此这条路径没有自己的注意事项要声明，
        // 也不得借用时刻表的。
        note: null,
        reference: await this.departureReference({ station: stationPoint(station), arrivals: [], trust }),
      }
    }

    /**
     * F4：这些行说的是什么车，按作答的来源；本构建不认识该来源时为 null，
     * 此时其行不分类，而不是一律归到 实时。
     */
    const vehicle = vehicleProvenanceOf(live.dataSource)

    const arrivals: ArrivalRow[] = this.vehicleArrivals({ detail, live, targetOrder, now })
      .slice(0, count)
      .map(row => ({
        // 一行给出自己的分钟或不给，二者同行：没有 `etaSeconds` 的行既没有 `time`
        // 也没有 mark，因为 mark 限定的是一个数字。车辆仍被命名（`busId`），
        // 并带上观测到的东西（`stopsAway`、`distanceMeters`）。
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
      // 实时/模拟路径没有时刻表注意事项：null，绝不借用不覆盖该站台的时刻表的注意事项。
      note: null,
      reference: await this.departureReference({ station: stationPoint(station), arrivals, trust }),
    }
  }

  /**
   * 把一次读数带的每辆车在同一个目标站定价。
   *
   * 抽出来是为让站牌与 F10 的链路扣减对一辆车的分钟定价一次且完全一致。每个可用行都返回
   * （按到站排序），由调用方决定保留几条；F4 不在这里施加，每行带定价用的 basis。
   */
  private vehicleArrivals(params: {
    detail: LineDetail | null
    live: LiveLineStatus
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

      // 上游 -1 哨兵（chelaile）：这辆车已过目标站。
      if (b.distanceToWaitStn === -1) continue

      // 车头朝 nextOrder 走，已过了 order：只有 nextOrder === targetOrder 时
      // 这辆车才服务目标站。
      //
      // 这个过滤对 `targetOrder` 单调，F10 依赖它：没过更靠后的 order 的车也没过更靠前的
      // order，因此上车 order 的行是同一方向更靠后的下车 order 的行的子集 —— `readChainLeg`
      // 的整个配对都建在这一点上。该关系只在腿沿其被读取的方向向前时成立；反向存储的公交腿与
      // 「站到自身」的腿会把它反转，因此 schema 在写入时拒绝，扣减把它们判为
      // `leg-recorded-backwards`。id 配对是规则（绝不按位置）。
      if (b.nextOrder !== undefined && b.nextOrder > targetOrder) continue
      if (b.nextOrder === undefined && b.order >= targetOrder) continue

      // 此刻正停在该站台（或来源直接这么说）：定向读取中，chelaile 对站在请求站点上的车
      // 会给 `travelTime 0`（观测到 `distanceToWaitStn 0`、`speed` ~0），那个 0 说的是车在哪
      // （在站台），不是时长。先读它，让来源自己的事实占先。
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
          // 这是对车辆的观测 —— 真实车辆的观测，因此由 basis 而不是分支决定答案。
          basis: 'at_platform',
        })
        continue
      }

      // 车正在接近：stopsAway 是从 nextOrder 到 target 的完整跳数。
      const stopsAway = Math.max(1, targetOrder - (b.nextOrder ?? b.order))
      const distanceMeters = b.distanceToWaitStn && b.distanceToWaitStn > 0 ? b.distanceToWaitStn : undefined

      /**
       * 这一行声明的分钟，没有任何来源发布或建模时为 `null`：只剩两个来源 ——
       * payload 自己的到站时间与地铁引擎声明的模型。
       */
      let minute: { etaSeconds: number, basis: ArrivalBasis } | null = null

      if (typeof b.travelTimeSec === 'number' && b.travelTimeSec > 0) {
        // 数据源自己给出的这辆车的到站时间。
        minute = { etaSeconds: b.travelTimeSec, basis: 'upstream' }
      }
      else if (isSubway) {
        // 135 s/站是假设而不是读数，且它是地铁引擎声明的模型（`dataSource: 'subway_schedule'`，
        // 由 `arrivalProvenanceOf` 标为 排班推演），不是本应用对公交的猜测。
        const progress = typeof b.progress === 'number' ? b.progress : 0
        minute = { etaSeconds: Math.max(30, Math.round((stopsAway - progress) * 135)), basis: 'our_estimate' }
      }

      if (!minute) {
        // 没有分钟被声明：定向读数没有为这辆车发布到站时间，而以前用来填空的算术是外推的
        // 快照速度与标称停站时间，已不再声明。行仍然提供 —— 车确实在途，观测到的东西随行带上
        // （剩余站数、距离）；`time`、`etaSeconds`、`basis` 全部缺席，provenance 为 null：
        // mark 限定的是一个数字，这一行没有数字。
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

    // 声明分钟的行在前（按分钟排序）；不声明分钟的行无法排进时间序，跟在后面，
    // 彼此按它们唯一描述的次序（剩余站数）排列 —— 放在最后不对它们何时到达作任何声明，
    // 交错进来则等于说它们在上面的车之后到。
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
   * F10 的服务端一半：某一个通勤目的下已录的链路，各自对着实时读数走一遍。
   *
   * 这里只把存储的链路转成纯引擎的输入；余量、区间与每个「不给结论」的理由都归
   * `deduceCommuteChain`，缺失的事实以 `null` 传递而不是传一个替代值。
   *
   * 每段乘车腿的衔接按前一段腿被留下的点定价（第一段用链路存的锚点，两端都是 GCJ-02、原样发出）；
   * 腿的线路读两次（分别定向到上车站与下车站），按车辆 id 配对。链路止于最后一段乘车腿的下车站，
   * 之后不定价、不给总到达时间。
   *
   * 只在可能改变答案的地方花读取：站点未设置、衔接定不出价、或记录本身判为反向的腿，在引擎看读数
   * 之前就被拒，因此不读；引擎对某段给出拒绝后，之后的腿一概不读。
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
      // 下一段衔接的起点：第一段用链路自己的锚点，之后用前一段腿被留下的点。
      // 只有锚点可能解析不出来，且只对第一段：下车站定位不了的腿被引擎拒，链路到此为止，
      // 因此不会有后面的腿从没解析出来的点组装。
      let from = this.anchorPoint(chain.originAnchor, settings)
      const legs: ChainLegInput[] = []

      // 引擎对目前已组装腿的答案：每段之后问它一次，正是让短路保持为引擎的规则
      // 而不是这里的副本（引擎按腿序走，拒了前缀就在同一段拒绝整条链路）。
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
   * 链路起点的存储锚点，按设置行所持（GCJ-02）；从未保存时为 null。
   * 未设置就保持 null：回退到一个坐标会把衔接起点放到用户从未保存的地方。
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
   * 存储腿的某个站，在线路站序中定位；定位不到为 null。
   *
   * 存储的是 (name, order) 对，定位按 ORDER，但名字要与该 order 上的站核对 —— 两者是用户一起
   * 选下的一个值。不一致时（记录来自另一份站序，或地铁两个方向对同一站编号不同）按「未定位」
   * 处理：不为该腿定价也不读。
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
   * 引擎需要的一条存储腿，加上该腿被留下的点。
   *
   * 方向由存储的 order 推导，绝不猜：两站先在方向 0 的站序里定位，alight order > board order 时
   * 按方向 0 读；地铁 alight < board 时读方向 1，并把两个 order 都换算进它的编号；公交
   * alight < board 是记录错误，两站相同同样被拒。按哪个方向读就用那个方向的几何定价。
   * 记录本身判为反向的腿完全不读。衔接定不出价时，原因按引擎输入所需的方式写明。
   */
  private async chainLegInput(params: {
    leg: StoredCommuteChainLeg
    /**
     * 进入这条腿的衔接从哪开始；链路起点锚点从未保存时为 null。
     * 第一段之后的腿起点是前一段被留下的站，到组装后续腿时必定已解析
     * （未解析是引擎对前缀作答的拒绝，链路到此结束）。
     */
    from: { lng: number, lat: number } | null
    now: number
  }): Promise<{ input: ChainLegInput, alight: { lng: number, lat: number } | null }> {
    const { leg, from } = params
    const boardOrder = leg.boardStationOrder
    const alightOrder = leg.alightStationOrder

    // 站点从未被选择的腿没有可定位、可定价、可读的东西：引擎不看读数就答
    // `station-unset`，因此这里也不花读取。
    if (boardOrder === null || alightOrder === null) {
      return {
        input: { leg, connectionSeconds: null, connectionMode: 'walk', live: null },
        alight: null,
      }
    }

    // 链路起点锚点最先确定，先于任何读取：它是用户唯一能对之采取行动的
    // 「衔接定不出价」原因，而一条衔接的原因不得取决于上游读取的结果。
    //
    // 只有第一段会遇到：后面每段都在前一段有结论时才组装，
    // 返回未解析的起点是引擎对前缀作答的拒绝，链路到此结束。
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

    // 两站都要，或都不要：上车站不是用户存的那个就不是这条腿，关于它的一切都不定价也不读；
    // 之后引擎因衔接没有时长而拒绝，不会印出一个关于错误站台的数字。哪一类事实导致未定位会写明。
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

    // 定位到的站还必须可放置：衔接是到上车站自己坐标的步行路线，腿被留下的点是下车站的，
    // 因此方向站序里没有坐标的站让两者都答不出来。不请求路线也不读站台 ——
    // 定价到替代点的步行是到没人命名的地方的真实路线。
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

    // 衔接时长，从解析出的点到解析出的站台。缺时长不做替代；六种定不出价的原因各自在
    // 获知该事实的分支决定：锚点从未保存（`anchor-unset`）、本构建读不了该腿的线路
    // （`line-unavailable`）、存储的站不在此方向站序里（`station-unlocated`）、站序里有该站
    // 但没有坐标（`station-without-coordinate`）、路径服务在两个都已解析的端点间没定出路线
    // （`route-unpriced`），以及站点从未被选择（引擎自己的 `station-unset`）。
    const connectionSeconds = (await this.getWalkingEta(from.lng, from.lat, boardPoint.lng, boardPoint.lat))?.durationSeconds ?? null
    const connectionUnpricedReason: ChainConnectionUnpricedReason | undefined = connectionSeconds === null
      ? 'route-unpriced'
      : undefined

    // 乘车方向只由存储的 order 决定。地铁判据是本项目的约定：
    // 地铁 id 带 `subway_` 前缀（路由到地铁引擎的依据）。
    const forward = alightOrder > boardOrder
    const subway = leg.lineId.startsWith('subway_')
    // 反向的地铁乘车是真实的；反向存储的公交腿与「站到自身」的腿由记录本身判定
    // （引擎命名为 `leg-recorded-backwards`，不看读数），因此两次定向读取被跳过。
    const settledBackwards = !forward && !(subway && alightOrder < boardOrder)

    let live: ChainLegLive | null = null
    if (connectionSeconds !== null && !settledBackwards) {
      // 实际乘坐的方向与它自己的站序：方向 1 的目标 order 必须用方向 1 的编号，
      // 几何也必须是方向 1 的。
      const readDetail = forward ? detail : await this.getLineDetail(leg.lineId, 1, leg.cityCode)
      // 该方向没有站序：没有可定位的编号，也没有可定价的几何；读方向 0 会给出这次乘车
      // 不会经过的站的分钟。不花读取，引擎答 `no-live`。
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
   * 一条腿的实时读数，由对该线路的两次定向读取组成。
   *
   * 每次定向读取只回答一个目标站，因此同一辆车的上车与下车分钟不可能来自一次读取。
   * 两次读取按 provider 稳定的 vehicle id 配对，绝不按位置：每次读取按自己的到站分钟排序，
   * 只被一次读取带的车辆没有可用配对而被丢弃。`boardVehiclesOnTheWay` 随腿一起走，
   * 让空配对能说出是服务空还是读数空。
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

    // 各定价一次并整体保留：上车读取自己的行正是 `boardVehiclesOnTheWay` 数的东西，
    // 其全集才是参与配对的东西。
    const boardArrivals = board
      ? this.vehicleArrivals({ detail: params.detail, live: board, targetOrder: params.boardOrder, now: params.now })
      : []
    const alightArrivals = alight
      ? this.vehicleArrivals({ detail: params.detail, live: alight, targetOrder: params.alightOrder, now: params.now })
      : []

    /**
     * 能参与配对的行：声明了分钟的那些。行程时长是 `alight - board`，
     * 两端都没定价的车没有配对可给，在这里丢掉而不是传一个替代值。
     */
    const priced = (rows: VehicleArrival[]): TargetedArrival[] =>
      rows.filter((row): row is VehicleArrival & { etaSeconds: number, basis: ArrivalBasis } =>
        row.etaSeconds !== undefined && row.basis !== undefined)

    // 这条腿所属线路的 F3 服务状态，来自本路径为定位两站已解析的详情，
    // 用的也是判读读数所用的同一个 `now` —— 与站牌同一套推导，两个屏幕不会对一条线各说各话。
    // 空链路行需要它来分辨 首班前 / 已过末班 与服务运行中的空档。
    const operatingStatus = operatingStatusOf({
      firstDeparture: params.detail?.firstBusTime,
      lastDeparture: params.detail?.lastBusTime,
      nowSecOfDay: operatingDaySecondsOf(new Date(params.now)),
    })

    return legLiveReading({
      board,
      alight,
      vehicles: pairTargetedReads(priced(boardArrivals), priced(alightArrivals)),
      // 上车读取带的所有行，有分钟与否都算：定不出价的车仍在往这里来，
      // 只数已定价的行会把空配对报成空服务（`no-vehicle`）。
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
      // 让 city 与这条线+方向的最新订阅者保持同步。
      sub.cityCode = cityCode
    }
    sub.clients.add(ws)

    // 立即推送当前状态
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
   * 把一个客户端从一次订阅中移除；`direction` 必须有：地铁一条线在同一个 lineId 下
   * 有两个独立订阅，移除一个不得拆掉另一个。
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
    // 旧形式：把这个客户端从该线路的每个方向都移除。
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
