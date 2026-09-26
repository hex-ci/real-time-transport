import type {
  Station,
} from '@real-time-transport/shared'
import { statedCoordinate, statedNumber, statedStopOrder } from '@real-time-transport/shared'

const AMAP_BASE = 'https://restapi.amap.com'

/**
 * 步行走廊 ETA 缓存的上限。条目按锚点坐标作键，移动中的定位每次
 * 轮询都会造出新键，没有上限时长跑进程会为见过的每个位置各留一条。
 */
export const WALK_ETA_MAX_ENTRIES = 500

/** 固定的（锚点, 站点）对几乎不动，所以已定价的步行腿每天重取一次。 */
const WALK_ETA_TTL_MS = 24 * 3600 * 1000

/** 瞬时失败后尽快重试，同时继续供上一条可用的腿。 */
const WALK_ETA_RETRY_MS = 30 * 1000

/**
 * 进入某段乘车段的接驳方式。方式决定定价走的**路线**（步行 v3、骑行 v4），
 * 因此也必须活在缓存键里 —— 否则先定价的一方会被当成另一方的答案供出去。
 */
export type ConnectionMode = 'walk' | 'cycle'

/**
 * 接驳走廊 ETA 的缓存键：方式在前，其余用原样发给上游的 GCJ-02 坐标构造，保留
 * 5 位小数（约 1 m），使同一个 ~1 m 格子内的锚点共用条目，坐标
 * 转换改动后也不会供出为别的坐标定价的腿。
 */
function connectionEtaCacheKey(mode: ConnectionMode, glng: number, glat: number, dlng: number, dlat: number): string {
  return `${mode}|${glng.toFixed(5)},${glat.toFixed(5)}|${dlng.toFixed(5)},${dlat.toFixed(5)}`
}

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
  /** POI 自身的 GCJ-02 位置；上游未给出位置时缺省。 */
  lat?: number
  lng?: number
  /**
   * 到 POI 的米数；上游未给出距离时缺省。
   *
   * 经 `statedNumber` 读取：写成 `0`（POI 就在测点上）是真实读数，
   * 只有未声明的距离才算缺省。
   */
  distanceMeters?: number
}

/**
 * 高德的「lng,lat」坐标对；上游未给出位置时为 undefined。
 *
 * 高德对放不下的站点或 POI 会省略 `location`；写出的坐标对也只取到
 * {@link statedCoordinate} 的程度 —— 一半为空、格式错、非有限或为 0
 * 都使整对缺省。0 不是装饰：本应用的 GCJ-02 基准上没有任何已放置的
 * 站点落在某个轴的 0 上，所以上游写 0 就是在说它放不下这个站点。
 * 两种写法都读：REST 载荷是字符串「lng,lat」，二元数组给同样两个数，
 * 顺序按上游自己的 —— 经度在前。
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
 * 高德 Web 服务 GIS 客户端。
 *
 * 坐标契约：每个接收坐标的公开方法接收的都是 **GCJ-02** —— 应用的
 * 归一化坐标系，也正是高德 REST API 使用的坐标系 —— 且不做任何转换。
 * 原始设备定位是 WGS-84，必须在 HTTP 边界用 `wgs84ToGcj02` 只转换
 * 一次，在它到达本服务之前：在这里再转一次会把起点挪偏；而在终点上
 * 转更糟，因为应用的每个站点坐标本已是 GCJ-02（`docs/PRD.md` 规定
 * 存储与传输坐标统一为 GCJ-02），那就会是第二次转换。
 */
export class AmapGisService {
  private readonly apiKey: string
  private readonly limiter = new AmapRateLimiter(220)
  private readonly lineCache = new Map<string, {
    data: AmapLineResult | null
    expiresAt: number
    fetchedAt: number
  }>()

  /**
   * 固定的（锚点, 站点）步行 ETA 很稳定，所以长期缓存；
   * 否则仅首页轮询就会超出高德月度配额。
   */
  private readonly walkEtaCache = new Map<string, { meters: number, seconds: number, expiresAt: number }>()

  constructor(apiKey?: string) {
    // 显式实参（即使是 ''）优先；未传（undefined）才回落到环境变量
    this.apiKey = apiKey !== undefined ? apiKey : (process.env.AMAP_MAPS_API_KEY || '')
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  /**
   * 带明确失败分类的高德请求。
   *
   * `transient` 把可重试的情形（无 key、网络错误、超时、HTTP 5xx、
   * 高德 QPS/配额类 infocode）与真正的「响应合法但没有匹配数据」
   * 区分开；调用方据此决定是否适合供出陈旧缓存 —— 一次瞬时抖动
   * 绝不能污染好数据。
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
        return { json: null, transient: res.status >= 500 }
      }
      const json = await res.json() as any
      if (json.status !== '1' || json.infocode !== '10000') {
        return { json: null, transient: TRANSIENT_AMAP_INFOCODES.has(String(json?.infocode)) }
      }
      return { json, transient: false }
    }
    catch {
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
      // 瞬时失败（QPS/配额/网络）：绝不能污染好的缓存数据。
      // 站点序列极其稳定，所以供出此前取到的数据，永远优于
      // 为一条真实存在的线路返回 404。
      if (transient) {
        if (cached?.data) {
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
      // 真正的未命中（响应合法，确无此线路）：短负缓存，使一次
      // 打错字的搜索不至于反复捶上游，同时恢复仍然很快。
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
   * 清掉已过期的步行 ETA 并返回清掉的条数：长跑进程每次定位都
   * 带来新锚点，所以缓存边写边剪枝，而不是任其增长。
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
   * 一直淘汰最早持有的条目，直到腾出一个位置，使漂移的定位不会把
   * 缓存推过 WALK_ETA_MAX_ENTRIES。Map 的迭代遵循插入顺序，所以
   * 淘汰的是最早的锚点，而不是刚定价的那一个。
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
   * 真实道路步行路线规划（v3/direction/walking），用于「要不要跑去赶车」。
   *
   * 两端都是 GCJ-02，原样发给上游：起点是应用归一化坐标系里的位置，
   * 终点是已存储的站点坐标，本来就在该坐标系内。见类上的契约。
   */
  async getWalkingEta(originLng: number, originLat: number, destLng: number, destLat: number): Promise<WalkEtaResult | null> {
    return this.getConnectionEta('walk', originLng, originLat, destLng, destLat)
  }

  /**
   * 进入某段乘车段的接驳定价，按该段自己的方式择路线：步行走 v3、骑行走 v4。
   *
   * 两端都是 GCJ-02，原样发给上游（契约见类上）。缓存、TTL、容量、串行限流
   * 与瞬时降级是两条路线**同一份** —— 唯一按方式分开的是上游端点与缓存键：
   * 两个端点的答案不同（同一对端点上骑行更快、且信封不同），共享键会让
   * 先定价的一方冒充另一方。
   *
   * v4 的成功信封没有 v3 的那对成功码：HTTP 200 + `data.paths[]` 即成功，
   * 失败以 `errcode`/`errmsg` 陈述（无 key 为 `errcode: 10001`）。`requestDetailed`
   * 的成功判据是 v3 形状，故 v4 在这里直接以 `fetch` 发出，走同一个限流器。
   * 载荷的两个数是数字（v3 是字符串），经 `statedNumber` 走同一条「只读声明的数」的规则。
   */
  async getConnectionEta(mode: ConnectionMode, originLng: number, originLat: number, destLng: number, destLat: number): Promise<WalkEtaResult | null> {
    const cacheKey = connectionEtaCacheKey(mode, originLng, originLat, destLng, destLat)

    const cached = this.walkEtaCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { distanceMeters: cached.meters, durationSeconds: cached.seconds }
    }

    let path: any
    if (mode === 'cycle') {
      if (!this.apiKey) return null
      await this.limiter.throttle()
      const url = `${AMAP_BASE}/v4/direction/bicycling?${new URLSearchParams({
        key: this.apiKey,
        origin: `${originLng.toFixed(6)},${originLat.toFixed(6)}`,
        destination: `${destLng.toFixed(6)},${destLat.toFixed(6)}`,
      }).toString()}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      let json: any = null
      let transient: boolean
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) {
          transient = res.status >= 500
        }
        else {
          json = await res.json() as any
          // v4 以 `errcode` 陈述失败，且配额/QPS 族与 v3 的 infocode 是同一批号。
          transient = json?.errcode !== undefined && json.errcode !== 0
            ? TRANSIENT_AMAP_INFOCODES.has(String(json.errcode))
            : false
        }
      }
      catch {
        transient = true
      }
      finally {
        clearTimeout(timer)
      }
      path = json?.data?.paths?.[0]
      // 瞬时失败（QPS/配额/网络）：绝不能污染好数据，规则与步行一致。
      if (!path) {
        if (transient && cached) {
          this.walkEtaCache.set(cacheKey, { ...cached, expiresAt: Date.now() + WALK_ETA_RETRY_MS })
          return { distanceMeters: cached.meters, durationSeconds: cached.seconds }
        }
        return null
      }
    }
    else {
      const { json, transient } = await this.requestDetailed('/v3/direction/walking', {
        origin: `${originLng.toFixed(6)},${originLat.toFixed(6)}`,
        destination: `${destLng.toFixed(6)},${destLat.toFixed(6)}`,
      })
      path = json?.route?.paths?.[0]
      if (!path) {
        // 瞬时失败：供出此前定价的这条腿并标成尽早重试，而不是报告此站不可达。
        if (transient && cached) {
          this.walkEtaCache.set(cacheKey, { ...cached, expiresAt: Date.now() + WALK_ETA_RETRY_MS })
          return { distanceMeters: cached.meters, durationSeconds: cached.seconds }
        }
        return null
      }
    }

    // 路径存在但没有为两端都定价，与空的 `paths` 是同一类答案 ——
    // 上游自己的「这对端点无路线」—— 所以不用陈旧条目顶替：当下的事实
    // 就是这对端点没有价格。载荷写出的两个数原样采用，写出的 `0` 保留
    // （0 米腿合法），否则视为无价格并返回 null。
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
   * 附近公交/地铁站雷达（v3/place/around），
   * type: 150700 = 公交车站, 150500 = 地铁站。
   *
   * `lng`/`lat` 是 GCJ-02，原样发给上游，返回结果同样是 GCJ-02。
   * 见类上的契约。
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
        // 高德放不下 —— 或用 0 标记 —— 的 POI 保持没有位置，但它仍是
        // 一个带已声明距离的站名，而这个雷达要读的正是后者。
        lat: location?.lat,
        lng: location?.lng,
        // 载荷「声明」的距离，未声明时缺省。刻意不按坐标读：写出的 0 是
        // 到测点上那个 POI 的真实距离，而坐标为 0 是没人放置过的站；
        // 未测量就必须缺省，不能给出看着真实的「0m」。
        distanceMeters: statedNumber(poi.distance),
      }
    })
  }

  /** 逆地理编码（v3/geocode/regeo）：GCJ-02 点 -> 可读地标描述。
   *  `lng`/`lat` 原样发给上游 —— 见类上的契约。 */
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
