import crypto from 'node:crypto'
import type {
  CongestionLevel,
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  NearbyStop,
  Station,
  StationBoardArrival,
  StationBoardLine,
} from '@real-time-transport/shared'
import { cumulativeDistances, statedCoordinate, statedStopOrder } from '@real-time-transport/shared'
import type { ITransitProvider } from '../types.js'

const BASE_URL = 'https://web.chelaile.net.cn/api'
const DEFAULT_SIGN_SALT = 'qwihrnbtmj'
const DEFAULT_AES_KEY = 'FF32AE65FBFD19414EAAFF6291A54B42'

function getSignSalt(): string {
  return process.env.CHELAILE_SIGN_SALT || DEFAULT_SIGN_SALT
}

function getAesKey(): Buffer {
  const raw = process.env.CHELAILE_AES_KEY || DEFAULT_AES_KEY
  return Buffer.from(raw, 'utf8')
}

/**
 * 某条上游方向记录的终点牌文案（「开往 X」）。
 *
 * 这条规则只能有一处实现：搜索与详情都由此推导，字段链的接受顺序
 * 也必须一致 —— 各写一份副本会让同一个方向在搜索行与选择器里叫
 * 不同的名字。
 */
function destinationLabel(raw: { endSn?: unknown, endStn?: unknown, destinationName?: unknown }): string {
  const terminal = raw.endSn || raw.endStn || raw.destinationName || '终点站'
  return `开往 ${String(terminal)}`
}

const DEFAULT_PARAMS: Record<string, string> = {
  s: 'h5',
  wxs: 'wx_app',
  sign: '1',
  h5RealData: '1',
  v: '3.11.28',
  src: 'weixinapp_cx',
  ctm_mp: 'mp_wx',
  vc: '2',
  favoriteGray: '1',
  gpstype: 'wgs',
  geo_type: 'wgs',
  scene: '1256',
}

const HEADERS: Record<string, string> = {
  'Host': 'web.chelaile.net.cn',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254160a) XWEB/18055',
  'Referer': 'https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html',
}

export function cryptoSign(params: Record<string, string>): string {
  const salt = getSignSalt()
  const s = Object.entries(params).map(([k, v]) => `"${k}"="${v}"`).join('&') + salt
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

function aesDecrypt(ciphertextB64: string): string {
  const key = getAesKey()
  if (key.length !== 32) {
    throw new Error('CHELAILE_AES_KEY must be a 32-byte key')
  }
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
  const buf = Buffer.from(ciphertextB64, 'base64')
  return decipher.update(buf, undefined, 'utf8') + decipher.final('utf8')
}

/**
 * 上游拥挤度标签。一辆车恰好带一个拥挤度标签，级别写在 `title` 里：
 * 对象上其它字段都不是证据 —— 键里的数字不是级别，`sort` / `dispatch`
 * 的含义未经确认。
 */
export interface ChelaileBusTag {
  imageUrlKey?: string
  title?: string
  sort?: number
  dispatch?: boolean
}

/**
 * 上游对拥挤级别给出的「原文单词」，按精确相等匹配。
 *
 * 查表用标签而不是键：键的枚举按构造就不可能完整（没采样到的键会被
 * 静默降级），而只有标签能承载一个我们从未见过的级别。
 *
 * 否定形式是它自己的精确字符串：`不拥挤` 按自身匹配，绝不当成其中
 * 含有的「拥挤」。
 */
const CONGESTION_BY_TAG_TITLE: Record<string, CongestionLevel> = {
  不拥挤: 'low',
  拥挤: 'high',
}

export function parseCongestion(tags?: ChelaileBusTag[]): CongestionLevel {
  if (!tags || tags.length === 0) return 'unknown'
  for (const tag of tags) {
    // 按「标题已知」选中，绝不按位置：第一个标签是非拥挤的 无障碍 标签时
    // 仍要取它后面的拥挤读数；标题未被测量过的标签则跳过。
    // `Object.hasOwn` 挡住 「constructor」 这类原型成员；标题缺失或未测量
    // 时保持 `unknown` —— 对一个没人测量过的词，这才是诚实的答案。
    const title = tag?.title
    const level = typeof title === 'string' && Object.hasOwn(CONGESTION_BY_TAG_TITLE, title)
      ? CONGESTION_BY_TAG_TITLE[title]
      : undefined
    if (level) return level
  }
  return 'unknown'
}

/**
 * 站台载荷 → 站台上每一条线路/方向一行。
 *
 * 上游的应答里 `stationList` 是**若干组站台**：只有被查的那一组带着线路的完整身份与在途车
 * （其余几组只有站名与线路名）。故这里的判据是「这一组里有没有带 lineId 的线路」而不是位置 ——
 * 位置是它今天碰巧的排布方式，身份才是它说的话。
 *
 * `readAt` 是这次读取从源取得数据的瞬间：每辆车的 `remainSeconds` 由它算出（读数是活的，
 * 而调用方不该拿自己的钟去减上游的钟）。一辆车**至少带一份读数**才成行：到站时刻，或「还有
 * 几站」—— 远车没有时刻预测，但站数照给，那份读数不该丢。两样都没有的车不成行，也绝不
 * 补一个 0 当「现在就到」。
 */
/**
 * 站点详情要一个**非空**的 `lineId` 才返回「全站视图」：同名站牌两侧的并集，
 * 一条线路的两个方向各占一条（`lineId` 也各不同）。
 *
 * 值本身不参与取数 —— 实测给一条**不经过本站**的 id、甚至给 `x` 都一样解锁；
 * 给空串或空格则退回「只有本侧平台」的那个视图（每线只剩一个方向）。
 * 故这里用一个明确的「不针对某条线路」的占位值，而不是随手拿一条真实线路的 id。
 *
 * 2026-10-13 实测（万盛南街西口 010-20607）：不带 → 5 条线路、T12 只有 dir0；
 * 带上 → 13 条线路，T12 的 dir0 与 dir1 都在（各自有自己的到站车数）。
 */
export const WHOLE_STATION_VIEW_LINE_ID = '0'

export function stationBoardLinesOf(payload: any, readAt: number): StationBoardLine[] {
  const groups: any[] = Array.isArray(payload?.stationList) ? payload.stationList : []
  const hydrated = groups.find(group => Array.isArray(group?.lines) && group.lines.some((line: any) => line?.line?.lineId))
  const rawLines: any[] = Array.isArray(hydrated?.lines) ? hydrated.lines : []

  const lines: StationBoardLine[] = []
  for (const raw of rawLines) {
    const rawLine = raw?.line ?? {}
    const lineId = typeof rawLine.lineId === 'string' ? rawLine.lineId : ''
    // 只报了站名与线路名的组：它没有身份，不是一条可读的线路。
    if (!lineId) continue

    const arrivals: StationBoardArrival[] = []
    for (const st of (Array.isArray(raw?.stnStates) ? raw.stnStates : [])) {
      const arriveAt = typeof st?.arrivalTime === 'number' && st.arrivalTime > 0 ? st.arrivalTime : null
      // 上游的「还有几站」：目标站序 − 车头站序（`value`）—— 与车来了自己的计数同值。
      // -1 是未给的哨兵；它与到站时刻是两种读数：远车没有时刻预测，这个数照给。
      const stopsAway = typeof st?.value === 'number' && Number.isInteger(st.value) && st.value >= 0
        ? st.value
        : null
      // 两份读数都没有的车不成行：它没有说过任何关于自己的话。
      if (arriveAt === null && stopsAway === null) continue
      // 已经过去的那一班：上游在应答里留着它（travelTime 为 -1、距离是几公里外的旧读数）。
      // 它的剩余秒数是负的，按 `arrivalMinutes` 会落在 0 上被读成「正进站」—— 一辆不在那儿的车。
      // 留 30 秒余量：上游算这批时刻先于我们的读时刻，一辆真的正进站的车按我们的钟看可能刚过去几秒。
      if (arriveAt !== null && arriveAt < readAt - 30_000) continue
      const tags: string[] = (Array.isArray(st?.busTagList) ? st.busTagList : [])
        .map((tag: any) => (typeof tag?.title === 'string' ? tag.title : ''))
        // 拥挤度那几个词由芯片单独陈述：同一行里同一个事实说两遍，读者会以为那是两件事。
        .filter((title: string) => title !== '' && !Object.hasOwn(CONGESTION_BY_TAG_TITLE, title))
      arrivals.push({
        busId: String(st?.busId ?? ''),
        arriveAt,
        remainSeconds: arriveAt !== null ? Math.round((arriveAt - readAt) / 1000) : null,
        stopsAway,
        // 上游按被查的目标作答：查站台时这个距离就是这辆车到本站还有多少米。
        distanceToStationMeters: measuredDistance(st?.distanceToDest),
        congestion: parseCongestion(st?.busTagList),
        tags,
      })
    }
    // 有时刻的按到站先后升序在前；没有时刻的跟在后面，按站数升序 —— 站数小者先到。
    arrivals.sort((a, b) => {
      if (a.arriveAt !== null && b.arriveAt !== null) return a.arriveAt - b.arriveAt
      if (a.arriveAt !== null) return -1
      if (b.arriveAt !== null) return 1
      // 走到这一支的两辆车都带着站数（上面已保证至少一份读数）。
      return (a.stopsAway ?? 0) - (b.stopsAway ?? 0)
    })

    lines.push({
      lineId,
      lineName: String(rawLine.name || rawLine.lineNo || ''),
      direction: rawLine.direction === 1 ? 1 : 0,
      destination: String(rawLine.endSn || rawLine.destinationName || ''),
      firstBusTime: typeof rawLine.firstTime === 'string' && rawLine.firstTime ? rawLine.firstTime : null,
      lastBusTime: typeof rawLine.lastTime === 'string' && rawLine.lastTime ? rawLine.lastTime : null,
      isSubway: rawLine.isSubway === 1 || rawLine.isSubway === true,
      arrivals,
      // 上游给的就是这个窗口原文，照它传：它与到站时刻是两种东西，本层不做任何换算或取舍。
      intervalForecast: typeof raw?.preArrivalTime === 'string' && raw.preArrivalTime ? raw.preArrivalTime : null,
    })
  }
  return lines
}

/**
 * 附近站台载荷 → 我附近的站台（按站 id 去重，按上游给的距离升序）。
 *
 * 上游把**同一个站的不同物理站台各给一条**（同 `sId`、不同 `physicalStId` 与坐标），
 * 故这里按 `sId` 去重、保留最近的那一条 —— 站的身份是 id，一个站只该占一行。
 *
 * 不带距离：距离由调用方用项目里那一条直线距离量（数据源自己那个数只决定谁算附近，
 * 它的窗口约 1 公里）。缺 id 或缺站名的条目不成行；坐标缺失的条目留下但坐标为 null。
 */
export function nearbyStopsOf(payload: any): NearbyStop[] {
  const raw: any[] = Array.isArray(payload?.nearStations) ? payload.nearStations : []
  const byId = new Map<string, { station: NearbyStop, sourceDistance: number }>()

  for (const entry of raw) {
    const stationId = typeof entry?.sId === 'string' ? entry.sId : ''
    const name = typeof entry?.sn === 'string' ? entry.sn : ''
    if (!stationId || !name) continue
    const sourceDistance = typeof entry?.distance === 'number' && entry.distance >= 0
      ? entry.distance
      : Number.POSITIVE_INFINITY
    const existing = byId.get(stationId)
    if (existing && existing.sourceDistance <= sourceDistance) continue
    byId.set(stationId, {
      sourceDistance,
      station: {
        stationId,
        name,
        lat: statedCoordinate(entry?.lat) ?? null,
        lng: statedCoordinate(entry?.lng) ?? null,
      },
    })
  }

  return [...byId.values()]
    .sort((a, b) => a.sourceDistance - b.sourceDistance)
    .map(entry => entry.station)
}

/** 上游的距离：非负数才算量到过；-1 是它自己的缺省哨兵，不是 0 米。 */
function measuredDistance(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? value : null
}

/**
 * line-detail 载荷里到底有没有这条线路的记录。
 *
 * 接口对从未听说过的 id 也回 200 和一个格式完整的信封：`jsonr.data`
 * 既没有 `line` 对象也没有站点列表。那是未命中，不是读数 —— 同一个
 * 接口的两次读取必须在这一致。线路名与站点表是它的身份：两者都是
 * 静态的，存在的线路无论有没有车都会给出它们。车辆刻意不参与这个
 * 判据（无车的线路是真实且常见的读数），所以 live 读取另行加一条：
 * 载荷里有车就说明上游知道这条线路。
 */
function holdsLineRecord(data: any): boolean {
  const rawLine = data?.line ?? {}
  const stations = Array.isArray(data?.stations) ? data.stations : []
  return Boolean(rawLine.name || rawLine.lineName) || stations.length > 0
}

/**
 * 车来了上游认不认这个城市码：cityId 是纯数字串（如北京 '027'）。
 * `amap_` 前缀的码是给高德系引擎（地铁）用的占位码，车来了不认 ——
 * 这类城市（如天津/广州/深圳/厦门/兰州）上游 497 城表里就没有，
 * 调用前直接返回空，不浪费一次上游调用，也不让无效 cityId 透传。
 */
function isChelaileCity(cityCode?: string): boolean {
  return !cityCode || !cityCode.startsWith('amap_')
}

export class ChelaileProvider implements ITransitProvider {
  readonly name: DataSourceType = 'chelaile'

  /**
   * 逐线路的道路几何缓存。jxPath 对给定的 (cityId, lineId) 是不变的
   * 静态道路折线，所以只解析一次，把总长度与逐站累计距离留在内存里。
   */
  private routeGeomCache = new Map<string, {
    routeLengthMeters: number
    stationDistances: number[]
  } | null>()

  /**
   * 逐线路的站点数缓存。轻量刷新接口（encryptedBusDetail）不带站表，
   * getLiveStatus 钳制 nextOrder 需要总站数时从这里取。与 routeGeomCache
   * 用同样的 key（`${cityId}_${lineId}`），由 getLineDetail 解析站表时写入。
   */
  private stationCountCache = new Map<string, number>()

  /**
   * 通过 jxPath 轨迹 URL 取这条线路的真实道路折线。
   *
   * `tra` 点串形如 `lng,lat[,tag];...`。带数字 `tag`（1..N-1）的点标出
   * 每个车站在道路上的位置，因此它们的累计弧长给出米级精度的逐站
   * 距离；站点距离直接由这些标记点算出，而不是把（GCJ-02、离路）的
   * 站点坐标投影上去。每个顶点都走与其他读取同一条规则
   * （`statedCoordinate`）：任一轴为 0、或坐标对有一半未写出，都是上游
   * 从未放置的顶点，一个这样的顶点就让整条折线无从表述 —— 答案为 null。
   *
   * 任何失败都返回 null，调用方即可优雅降级为等距。
   */
  private async fetchRouteGeometry(
    cityId: string,
    lineId: string,
    stationCount: number,
    preloadedDetail?: any,
  ): Promise<{ routeLengthMeters: number, stationDistances: number[] } | null> {
    const key = `${cityId}_${lineId}`
    if (this.routeGeomCache.has(key)) {
      return this.routeGeomCache.get(key) ?? null
    }

    try {
      const detail = preloadedDetail ?? await this.request('/bus/line!encryptedLineDetail.action', {
        cityId,
        lineId,
      })
      const jxPath: string | undefined = detail.jxPath || detail.line?.jxPath
      if (!jxPath) {
        // 线路确实没有轨迹：写负缓存是合适的。
        this.routeGeomCache.set(key, null)
        return null
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      let raw: string
      try {
        const res = await fetch(jxPath, { signal: controller.signal })
        if (!res.ok) throw new Error(`jxPath HTTP ${res.status}`)
        raw = await res.text()
      }
      finally {
        clearTimeout(timer)
      }
      if (raw.startsWith('**YGKJ')) raw = raw.slice(6)
      if (raw.endsWith('YGKJ##')) raw = raw.slice(0, -6)

      const tra: string | undefined = JSON.parse(raw).jsonr?.data?.tra
      if (!tra) {
        this.routeGeomCache.set(key, null)
        return null
      }

      // 把 "lng,lat[,tag]" 点解析成 [lat, lng] 与累计弧长。任一点
      // 无法放置就让整条道路无从表述，与完全没有轨迹同样处理（负缓存）。
      const points: Array<[number, number]> = []
      const tags: Array<number | undefined> = []
      for (const seg of tra.split(';')) {
        const f = seg.split(',').map(Number)
        const lng = statedCoordinate(f[0])
        const lat = statedCoordinate(f[1])
        if (lng === undefined || lat === undefined) {
          this.routeGeomCache.set(key, null)
          return null
        }
        points.push([lat, lng])
        tags.push(f.length >= 3 ? f[2] : undefined)
      }
      const cum = cumulativeDistances(points)
      const routeLengthMeters = cum[cum.length - 1] ?? 0
      if (!(routeLengthMeters > 0)) {
        this.routeGeomCache.set(key, null)
        return null
      }

      // 标记点：tag=1 是始发站（累计 0），tag=k 是第 k-1 站（从 0 数）。
      // 终点站没有 tag —— 补上 routeLength。
      const tagged: number[] = []
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] !== undefined) tagged.push(cum[i]!)
      }
      let stationDistances: number[]
      if (tagged.length >= 2 && tagged.length >= stationCount - 1) {
        // 采用权威的道路标记点，并夹成单调不减。
        stationDistances = [...tagged]
        for (let i = 1; i < stationDistances.length; i++) {
          if (stationDistances[i]! < stationDistances[i - 1]!) {
            stationDistances[i] = stationDistances[i - 1]!
          }
        }
        stationDistances.push(routeLengthMeters)
      }
      else {
        stationDistances = Array.from(
          { length: stationCount },
          (_, i) => (routeLengthMeters * i) / Math.max(1, stationCount - 1),
        )
      }

      const geom = { routeLengthMeters, stationDistances }
      this.routeGeomCache.set(key, geom)
      return geom
    }
    catch {
      // 瞬时失败：不写负缓存，使下一次轮询重试。
      return null
    }
  }

  private async request(endpoint: string, extraParams: Record<string, string>): Promise<any> {
    const params: Record<string, string> = {
      ...DEFAULT_PARAMS,
      ...extraParams,
    }
    params.cryptoSign = cryptoSign(params)
    const qs = new URLSearchParams(params).toString()
    const url = `${BASE_URL}${endpoint}?${qs}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)

    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal })
      if (!res.ok) {
        throw new Error(`Chelaile HTTP error: ${res.status}`)
      }
      let raw = await res.text()
      if (raw.startsWith('**YGKJ')) raw = raw.slice(6)
      if (raw.endsWith('YGKJ##')) raw = raw.slice(0, -6)

      const envelope = JSON.parse(raw)
      const data = envelope.jsonr?.data
      if (!data) {
        throw new Error('Missing jsonr.data from Chelaile response')
      }

      if (data.encryptResult) {
        return JSON.parse(aesDecrypt(data.encryptResult))
      }
      return data
    }
    finally {
      clearTimeout(timer)
    }
  }

  async searchLines(keyword: string, cityCode: string = '027'): Promise<LineSummary[]> {
    // 非车来了覆盖城市（如 amap_ 占位码）：上游不认，直接返回空。
    if (!isChelaileCity(cityCode)) return []
    try {
      const data = await this.request('/bus/query!nSearch.action', {
        cityId: cityCode,
        localCityId: cityCode,
        key: keyword,
        supportPhyStn: 'true',
      })

      const lines = data.result?.lines || data.lines || []
      return lines.map((item: any) => ({
        lineId: String(item.lineId || item.id || ''),
        lineName: String(item.name || item.lineName || item.lineNo || keyword),
        direction: Number(item.direction || 0),
        startStop: String(item.startSn || item.startStn || ''),
        endStop: String(item.endSn || item.endStn || ''),
        directionName: destinationLabel(item),
        cityCode,
      })).filter((l: LineSummary) => {
        if (!l.lineId) return false
        // 车来了的地铁条目常常没有站点序列（stops 为空），直接丢掉：
        // 地铁结果由 UniversalSubwayEngine 完整提供。
        if (l.lineName.includes('地铁') && !l.startStop && !l.endStop) return false
        return true
      })
    }
    catch {
      return []
    }
  }

  async getLineDetail(lineId: string, _direction?: number, cityCode?: string): Promise<LineDetail | null> {
    if (lineId.startsWith('subway_')) {
      return null
    }
    // 非车来了覆盖城市：上游不认，直接返回空。
    if (!isChelaileCity(cityCode)) {
      return null
    }

    const cityId = cityCode || '027'
    try {
      const data = await this.request('/bus/line!encryptedLineDetail.action', {
        cityId,
        lineId,
      })

      const rawLine = data.line || {}
      const rawStations = data.stations || []

      // 上游根本没答出这条线路 —— 见 `holdsLineRecord`：未命中不能
      // 作为一条「格式完整但为空」的线路继续往下走。
      if (!holdsLineRecord(data)) {
        return null
      }

      const stops: Station[] = rawStations.map((s: any, idx: number) => {
        const metros = Array.isArray(s.metros) ? s.metros.map((m: any) => String(m.fullName || m.lineNo || '')) : []
        return {
          id: String(s.sId || `stop_${idx + 1}`),
          name: String(s.sn || `站点 ${idx + 1}`),
          // 站序取载荷给出的那个，读不出来时退回列表自身的位置：
          // F10 按站序定位已存站点，NaN 或 0 指不出任何站（`statedStopOrder`）。
          order: statedStopOrder(s.order, idx + 1),
          // 站点自身的位置，且只有载荷声明了才有：上游没有放置的站点
          // 保持未放置，而不是钉在 (0, 0)（`statedCoordinate`）。
          lat: statedCoordinate(s.lat),
          lng: statedCoordinate(s.lng),
          interchanges: metros,
        }
      })

      const otherlines = data.otherlines || []
      const otherDirectionLineId = otherlines[0]?.lineId ? String(otherlines[0].lineId) : undefined

      // 站点数写入缓存：轻量刷新接口不带站表，getLiveStatus 靠它钳制 nextOrder。
      this.stationCountCache.set(`${cityId}_${lineId}`, stops.length)

      const geom = await this.fetchRouteGeometry(cityId, lineId, stops.length, data)

      return {
        lineId,
        lineName: String(rawLine.name || rawLine.lineName || ''),
        direction: Number(rawLine.direction || 0),
        directionName: destinationLabel(rawLine),
        firstBusTime: String(rawLine.firstTime || ''),
        lastBusTime: String(rawLine.lastTime || ''),
        cityCode: cityId,
        type: 'bus',
        stops,
        routeLengthMeters: geom?.routeLengthMeters,
        stationDistances: geom?.stationDistances,
        otherDirectionLineId,
      }
    }
    catch {
      return null
    }
  }

  /**
   * 实时车辆读取：轻量接口优先，全量接口回退。
   *
   * 官方小程序也是这个双接口结构：首屏用 `encryptedLineDetail` 拿全量
   * （线路+站点+车辆），30 秒轮询用 `encryptedBusDetail` 只拿车辆明细。
   * 实测轻量接口的 `buses[]` 字段与全量一致（order/speed/
   * distanceToWaitStn/lat/lng/mileage/travels/busTagList/licence），
   * 体积小约 65%，但不带 `stations` 站表。
   *
   * 回退条件：轻量接口抛错，或返回的载荷里没有车辆数组（形态不对）。
   * 回退保证上游接口变化时可用性不降级 —— 最坏情况就是回到改动前。
   */
  private async requestLiveDetail(
    extraParams: Record<string, string>,
  ): Promise<any> {
    try {
      const light = await this.request('/bus/line!encryptedBusDetail.action', {
        ...extraParams,
        cshow: 'busDetail',
      })
      if (light && Array.isArray(light.buses)) {
        return light
      }
    }
    catch {
      // 回退全量接口
    }
    return this.request('/bus/line!encryptedLineDetail.action', extraParams)
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    if (lineId.startsWith('subway_')) {
      return null
    }
    // 非车来了覆盖城市：上游不认，直接返回空。
    if (!isChelaileCity(cityCode)) {
      return null
    }

    const cityId = cityCode || '027'
    try {
      const extraParams: Record<string, string> = {
        cityId,
        lineId,
      }
      if (options?.targetOrder) {
        extraParams.targetOrder = String(options.targetOrder)
      }
      const data = await this.requestLiveDetail(extraParams)

      const rawBuses = data.buses || []
      const rawStations = data.stations || []
      // 轻量接口不带站表：总站数按「响应自带 → getLineDetail 缓存」取，**取不到时不封顶**。
      //
      // 封顶只防上游报出越过终点的站序，故它需要一个真的总站数；兜底成 1 不是「保守」而是
      // 编造：它把 `nextOrder` 压成 1，于是定向读数（`targetOrder`）里每辆车都变成
      // 「距目标站 = 目标站序 − 1」（实测：目标 13 站时三辆车全报 12 站，而它们分别距
      // 141 m / 1.4 km / 3.8 km），并且 `nextOrder > targetOrder` 这个「已过站」判据永不成立。
      // 定向读数的上游响应正是不带站表的那种，而静态详情常由库缓存作答、走不到这里的
      // `getLineDetail`，所以这条路径上总站数经常是取不到的。
      const knownStations = rawStations.length || this.stationCountCache.get(`${cityId}_${lineId}`)

      // 上游没答出这条线路：载荷里没有身份（见 `holdsLineRecord`），也没有
      // 车辆。这里没有一样是读数，而据此回 `{buses: []}` 会让「这条线路
      // 不存在」与「此刻没车」字节相同。带着车辆的载荷即使没有名字也照收：
      // 车辆就是上游认识这条线路的证据。
      if (!holdsLineRecord(data) && rawBuses.length === 0) {
        return null
      }

      // jxPath 的路长把 distanceToWaitStn（到终点站的距离）换算成
      // distanceFromStart（权威的连续位置）。首次调用后即缓存，后续轮询免费。
      // 轻量接口不带 jxPath：只有全量载荷才配做 preloadedDetail。
      // 轻量载荷传 undefined，让 fetchRouteGeometry 按缓存未命中走全量获取，
      // 否则会被误判为"线路无轨迹"而写负缓存，永久关掉这条线的道路几何。
      const fullDetail = data.jxPath || data.line?.jxPath ? data : undefined
      // 几何那边只用它当长度阈值（判断标记点是否覆盖全程），未知时按 1 传与从前一致。
      const geom = await this.fetchRouteGeometry(cityId, lineId, knownStations ?? 1, fullDetail)
      const routeLen = geom?.routeLengthMeters
      const sd = geom?.stationDistances

      const buses: LiveBus[] = rawBuses.map((b: any, idx: number) => {
        // 只透传上游真正报出的字段；缺失的保持 undefined，不伪造
        // （比如 0.5 的 progress 或编造的坐标）。
        const orderNum = Number(b.order)
        const speedNum = Number(b.speed)
        const distNum = Number(b.distanceToWaitStn)
        const latNum = Number(b.lat)
        const lngNum = Number(b.lng)

        const hasOrder = Number.isFinite(orderNum) && b.order !== undefined && orderNum > 0
        // 按车来了的线上协议，b.order 是车辆正前往的下一站，所以它刚
        // 经过的那一站是 orderNum - 1。
        const order = hasOrder ? Math.max(1, orderNum - 1) : undefined
        const nextOrder = hasOrder && knownStations ? Math.min(knownStations, orderNum) : (hasOrder ? orderNum : undefined)

        const hasDist = Number.isFinite(distNum) && distNum >= 0
        // -1 是车来了「已过目标站」的哨兵值，原样透传，使到达接口
        // 能排除这类车。
        const hasDistRaw = Number.isFinite(distNum)
        const mileageNum = Number(b.mileage)
        const hasMileage = Number.isFinite(mileageNum) && mileageNum > 0

        const travel = options?.targetOrder && Array.isArray(b.travels)
          ? b.travels.find((t: any) => Number(t.order) === options.targetOrder)
          : undefined
        // 0 是上游自己的事实，不是缺值：车辆正停在请求的站上时，源自己
        // 给出 travelTime 0。只保留 > 0 会丢掉它，把这一行推给本应用的
        // 位置/停站估计；负值（-1）是「已过目标站」的哨兵，不是时长。
        const targetTravelTime = travel ? Number(travel.travelTime) : undefined
        const targetTravelTimeSec = targetTravelTime !== undefined
          && Number.isFinite(targetTravelTime)
          && targetTravelTime >= 0
          ? targetTravelTime
          : undefined

        let distanceFromStart: number | undefined
        if (hasMileage) {
          distanceFromStart = mileageNum
        }
        else if (options?.targetOrder && sd && sd[options.targetOrder - 1] && hasDist && distNum > 0) {
          const targetStationDist = sd[options.targetOrder - 1]!
          distanceFromStart = Math.max(0, targetStationDist - distNum)
        }
        else if (hasDist && typeof routeLen === 'number' && routeLen > 0) {
          distanceFromStart = Math.max(0, Math.min(routeLen - distNum, routeLen))
        }

        return {
          id: String(b.busId || `bus_${idx + 1}`),
          order,
          nextOrder,
          progress: undefined,
          lat: Number.isFinite(latNum) && b.lat !== undefined && latNum !== 0 ? latNum : undefined,
          lng: Number.isFinite(lngNum) && b.lng !== undefined && lngNum !== 0 ? lngNum : undefined,
          speed: Number.isFinite(speedNum) && b.speed !== undefined && speedNum >= 0 ? speedNum : undefined,
          congestion: parseCongestion(b.busTagList),
          distanceToWaitStn: hasDistRaw && distNum > 0
            ? distNum
            : (hasDistRaw && distNum === -1 ? -1 : undefined),
          distanceFromStart,
          travelTimeSec: targetTravelTimeSec,
          // `state` 是上游对「车停在站台上」的陈述（实测 1 ↔ travelTime 0）。
          // 它比速度可靠：停站时上游仍会报 5~11 m/s，按那个速度外推会跑出站。
          // 只在来源真的给了 1 时说；其他取值不推断成「不在站」。
          ...(Number(b.state) === 1 ? { atStop: true } : {}),
          license: b.licence ? String(b.licence) : undefined,
          updatedAt: Date.now(),
        }
      })

      return {
        lineId,
        direction,
        buses,
        dataSource: 'chelaile',
        isDegraded: false,
        updatedAt: Date.now(),
      }
    }
    catch {
      return null
    }
  }

  /**
   * 我附近的站台：坐标 + 城市 → 站 id 与站名（**站的身份**那条桥）。
   *
   * 上游没有半径参数（传什么都会忽略），窗口由它自己定：实测约 1 公里。不给城市码时它答空列表，
   * 故这里先按城市挡一次，不浪费调用；读不到时返回 null（与「附近确实没有站台」分开）。
   */
  async getNearbyStops(cityCode: string, lng: number, lat: number): Promise<NearbyStop[] | null> {
    if (!isChelaileCity(cityCode)) return null
    try {
      const data = await this.request('/bus/stop!encryptedNearPhysicalStns.action', {
        cityId: cityCode,
        lng: String(lng),
        lat: String(lat),
      })
      return nearbyStopsOf(data)
    }
    catch {
      return null
    }
  }

  /**
   * 按站台读取到站：一次调用就拿到该站**全部经过线路**的到站时刻（未关注的也在内）。
   *
   * 上游不认这个城市码时直接返回 null，不浪费一次调用；上游答了但没有可读的线路时返回
   * 空数组（「读到了、这站没有线路可报」与「读不到」是两件事）。
   */
  async getStationBoard(stationId: string, cityCode?: string): Promise<StationBoardLine[] | null> {
    if (!isChelaileCity(cityCode)) return null
    try {
      const data = await this.request('/bus/stop!encryptedPhyStnDetail.action', {
        stationId,
        cityId: cityCode ?? '027',
        // 见 `WHOLE_STATION_VIEW_LINE_ID`：不带它只拿到本侧平台那几条线（一条线路一个方向）。
        lineId: WHOLE_STATION_VIEW_LINE_ID,
      })
      // 读取时刻取自这次应答落地的那一刻：每辆车的剩余秒数由它算出，故它必须与数据同源。
      return stationBoardLinesOf(data, Date.now())
    }
    catch {
      return null
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!getSignSalt() || getAesKey().length !== 32) {
      return false
    }
    try {
      const res = await this.request('/cdatasource/citylist', {
        type: 'gpsRealtimeCity',
        lat: '39.9042',
        lng: '116.4074',
        gpstype: 'wgs',
      })
      return Boolean(res)
    }
    catch {
      return false
    }
  }

  async getCityList(): Promise<Array<{ code: string, name: string, pinyin: string, hasMetro: boolean }>> {
    try {
      const res = await fetch('https://web.chelaile.net.cn/cdatasource/citylist?type=allCities', {
        headers: HEADERS,
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) return []
      const json: any = await res.json()
      const cities = json?.data?.allRealtimeCity
      if (!Array.isArray(cities)) return []
      return cities
        .filter((c: any) => c && c.cityId && c.cityName)
        .map((c: any) => ({
          code: String(c.cityId),
          name: String(c.cityName),
          pinyin: String(c.pinyin || ''),
          hasMetro: Number(c.supportSubway) === 1,
        }))
    }
    catch {
      return []
    }
  }
}
