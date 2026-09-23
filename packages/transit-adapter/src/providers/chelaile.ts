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
import { cumulativeDistances } from '@real-time-transport/shared'
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
 * Destination-board label (「开往 X」) for one upstream direction record.
 *
 * Single source for the rule: search and detail both derive the label, so they
 * must accept the same field chain in the same order. Duplicating the chain
 * let them drift (one accepted `endStn`, the other did not), which showed up as
 * the same direction being named differently in the search row and the selector.
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

function parseCongestion(tags?: Array<{ title?: string }>): CongestionLevel {
  if (!tags || tags.length === 0) return 'unknown'
  const text = tags.map(t => t.title || '').join(' ')
  if (text.includes('严重拥堵') || text.includes('拥挤')) return 'high'
  if (text.includes('缓行') || text.includes('适中')) return 'medium'
  if (text.includes('畅通') || text.includes('不拥挤')) return 'low'
  return 'unknown'
}

export class ChelaileProvider implements ITransitProvider {
  readonly name: DataSourceType = 'chelaile'

  /**
   * Per-line route geometry cache. jxPath is a static road polyline that never
   * changes for a given (cityId, lineId), so we resolve it once and keep the
   * total length + per-station cumulative road distances in memory.
   */
  private routeGeomCache = new Map<string, {
    routeLengthMeters: number
    stationDistances: number[]
  } | null>()

  /**
   * Resolve the real road polyline for a line via the jxPath trajectory URL.
   *
   * The `tra` point string is `lng,lat[,tag];...`. Points carrying a numeric
   * `tag` (1..N-1) mark each STATION's position along the road, so their
   * cumulative arc-length gives meter-accurate per-station distances. We
   * therefore build stationDistances directly from the tagged markers rather
   * than projecting the (GCJ-02, off-road) station coordinates.
   *
   * Returns null on any failure so callers degrade to even-spacing gracefully.
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
      // jxPath URL is exposed on the (already-signed) line detail response.
      const detail = preloadedDetail ?? await this.request('/bus/line!encryptedLineDetail.action', {
        cityId,
        lineId,
      })
      const jxPath: string | undefined = detail.jxPath || detail.line?.jxPath
      if (!jxPath) {
        // Line genuinely has no trajectory: negative-cache is fine.
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

      // Parse "lng,lat[,tag]" points into [lat, lng] plus cumulative arc-length.
      const parsed = tra.split(';').map((seg) => {
        const f = seg.split(',').map(Number)
        return { lng: f[0]!, lat: f[1]!, tag: f.length >= 3 ? f[2] : undefined }
      })
      const lats: Array<[number, number]> = parsed.map(p => [p.lat, p.lng])
      const cum = cumulativeDistances(lats)
      const routeLengthMeters = cum[cum.length - 1] ?? 0
      if (!(routeLengthMeters > 0)) {
        this.routeGeomCache.set(key, null)
        return null
      }

      // Tagged markers: tag=1 is the origin station (cum 0), tag=k is station
      // k-1 (0-indexed). The final station has no tag -> append routeLength.
      const tagged: number[] = []
      for (let i = 0; i < parsed.length; i++) {
        if (parsed[i]!.tag !== undefined) tagged.push(cum[i]!)
      }
      let stationDistances: number[]
      if (tagged.length >= 2 && tagged.length >= stationCount - 1) {
        // Use the authoritative road markers; clamp to monotonic and cap at L.
        stationDistances = [...tagged]
        for (let i = 1; i < stationDistances.length; i++) {
          if (stationDistances[i]! < stationDistances[i - 1]!) {
            stationDistances[i] = stationDistances[i - 1]!
          }
        }
        stationDistances.push(routeLengthMeters)
      }
      else {
        // No usable markers: fall back to even spacing across stationCount.
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
      // Transient failure: do NOT negative-cache so the next poll retries.
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
        // Chelaile subway entries often lack station sequences (empty stops).
        // Drop them: UniversalSubwayEngine provides complete subway results.
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

      if (!rawLine.name && !rawLine.lineName && rawStations.length === 0) {
        return null
      }

      const stops: Station[] = rawStations.map((s: any, idx: number) => {
        const metros = Array.isArray(s.metros) ? s.metros.map((m: any) => String(m.fullName || m.lineNo || '')) : []
        return {
          id: String(s.sId || `stop_${idx + 1}`),
          name: String(s.sn || `站点 ${idx + 1}`),
          order: Number(s.order || idx + 1),
          lat: Number(s.lat || 0),
          lng: Number(s.lng || 0),
          interchanges: metros,
        }
      })

      const otherlines = data.otherlines || []
      const otherDirectionLineId = otherlines[0]?.lineId ? String(otherlines[0].lineId) : undefined

      // Resolve the real road polyline (jxPath) for meter-accurate positioning.
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

      // Route length from jxPath lets us turn distanceToWaitStn (distance to
      // the TERMINAL) into distanceFromStart (authoritative continuous
      // position). Cached after the first call, so this is free per poll.
      const geom = await this.fetchRouteGeometry(cityId, lineId, totalStations, data)
      const routeLen = geom?.routeLengthMeters
      const sd = geom?.stationDistances

      const buses: LiveBus[] = rawBuses.map((b: any, idx: number) => {
        // Pass through only what the upstream actually reports; missing fields
        // stay undefined instead of being fabricated (0.5 progress, fake coords).
        const orderNum = Number(b.order)
        const speedNum = Number(b.speed)
        const distNum = Number(b.distanceToWaitStn)
        const latNum = Number(b.lat)
        const lngNum = Number(b.lng)

        const hasOrder = Number.isFinite(orderNum) && b.order !== undefined && orderNum > 0
        // In chelaile's wire protocol, b.order is the UPCOMING station the vehicle is heading towards.
        // Therefore, the station the vehicle last passed is orderNum - 1.
        const order = hasOrder ? Math.max(1, orderNum - 1) : undefined
        const nextOrder = hasOrder ? Math.min(totalStations, orderNum) : undefined

        const hasDist = Number.isFinite(distNum) && distNum >= 0
        // -1 is chelaile's sentinel for "already past the requested targetOrder";
        // pass it through so the arrivals endpoint can exclude such buses.
        const hasDistRaw = Number.isFinite(distNum)
        const mileageNum = Number(b.mileage)
        const hasMileage = Number.isFinite(mileageNum) && mileageNum > 0

        // When targetOrder is requested, chelaile provides target-specific travel time & distance.
        const travel = options?.targetOrder && Array.isArray(b.travels)
          ? b.travels.find((t: any) => Number(t.order) === options.targetOrder)
          : undefined
        const targetTravelTimeSec = travel && travel.travelTime > 0 ? Number(travel.travelTime) : undefined

        // Authoritative continuous distanceFromStart:
        // 1) Prefer raw b.mileage (vehicle odometer from start in meters, provided by chelaile)
        // 2) Fallback to targetStationDist - distNum or routeLen - distNum
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

  /**
   * Full realtime city dictionary.
   * Response envelope: { data: { allRealtimeCity: [{ cityName, cityId, pinyin, supportSubway }] } }
   */
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
