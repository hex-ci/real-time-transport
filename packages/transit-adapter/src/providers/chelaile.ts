import crypto from 'node:crypto'
import type {
  CongestionLevel,
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  Station,
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

function cryptoSign(params: Record<string, string>): string {
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

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    if (lineId.startsWith('subway_')) {
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
      const data = await this.request('/bus/line!encryptedLineDetail.action', extraParams)

      const rawBuses = data.buses || []
      const rawStations = data.stations || []
      const totalStations = rawStations.length || 1

      // 上游没答出这条线路：载荷里没有身份（见 `holdsLineRecord`），也没有
      // 车辆。这里没有一样是读数，而据此回 `{buses: []}` 会让「这条线路
      // 不存在」与「此刻没车」字节相同。带着车辆的载荷即使没有名字也照收：
      // 车辆就是上游认识这条线路的证据。
      if (!holdsLineRecord(data) && rawBuses.length === 0) {
        return null
      }

      // jxPath 的路长把 distanceToWaitStn（到终点站的距离）换算成
      // distanceFromStart（权威的连续位置）。首次调用后即缓存，后续轮询免费。
      const geom = await this.fetchRouteGeometry(cityId, lineId, totalStations, data)
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
        const nextOrder = hasOrder ? Math.min(totalStations, orderNum) : undefined

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
