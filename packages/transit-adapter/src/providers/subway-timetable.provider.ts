import type { Station } from '@real-time-transport/shared'
import { getCuratedCityName } from '@real-time-transport/shared'
import type { AmapGisService } from '../services/amap-gis.service.js'
import { normalizeStationName } from '../services/station-timetable.service.js'
import { dayTypeForDate, operatingDateOf } from '../station-timetable.js'
import type {
  SubwayTimetableCacheRow,
  SubwayTimetableStation,
} from '../subway-timetable-cache.js'
import { signSubwayTimestamp } from '../subway-sign.js'
import { cryptoSign } from './chelaile.js'

const WEB_BASE = 'https://web.chelaile.net.cn/api'
const API_BASE = 'https://api.chelaile.net.cn'
const TIMEOUT_MS = 8000
const DEFAULT_DELAY_MS = 200

const MINI_PARAMS: Record<string, string> = {
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

const MINI_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49',
  'Referer': 'https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html',
}

const APP_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chelaile/7.6.6',
}

const WEB_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Chelaile/7.6.6',
  'Referer': 'https://web.chelaile.net.cn/app-relate/subway_time/index.html',
}

export interface SubwayTimetableFetchInput {
  cityCode: string
  /** 应用侧 lineId，如 subway_027_7 */
  lineId: string
  /** 收藏里的线路名，如 地铁7号线 */
  lineName: string
}

export interface SubwayTimetableFetcherOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  /** 站间请求间隔；测试传 0。 */
  delayMs?: number
  /** 只用于把车来了方向对到应用方向；缺省时按「nSearch 方向 = 1」的 7 号线约定。 */
  amap?: Pick<AmapGisService, 'getLineByName'>
}

interface LineDetail {
  subLineId: number
  lineName: string
  startName: string
  endName: string
  oppositeSubLineId: number
  stations: Array<{ name: string, pStopId: number }>
}

interface DirectionSide {
  subLineId: number
  direction: number
  directionName: string
  stations: Array<{ name: string, pStopId: number }>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function unwrap(json: Record<string, unknown>): Record<string, unknown> {
  const data = asRecord(json.jsonr).data
  if (!data || typeof data !== 'object') {
    throw new Error('chelaile: response has no jsonr.data')
  }
  return data as Record<string, unknown>
}

function parseBody(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  let body = start >= 0 ? text.slice(start) : text
  if (body.endsWith('YGKJ##')) body = body.slice(0, -6)
  return JSON.parse(body) as Record<string, unknown>
}

/**
 * 抓取一条线的两个方向。只写「当前运营日型」的行：`preTimetable` 只按
 * 服务器当天给表，工作日/周末参数都切不动。
 */
export class SubwayTimetableFetcher {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly delayMs: number
  private readonly amap?: Pick<AmapGisService, 'getLineByName'>

  constructor(options: SubwayTimetableFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS
    this.amap = options.amap
  }

  async fetchLine(input: SubwayTimetableFetchInput): Promise<SubwayTimetableCacheRow[]> {
    const subLineId = await this.resolveSubLine(input)
    const detail = await this.fetchLineDetail(input.cityCode, subLineId)
    const firstStop = await this.amapFirstStop(input.cityCode, input.lineName)
    const sides = this.resolveDirectionSides(detail, firstStop)

    const now = this.now()
    const bjNow = new Date(now + 8 * 3600 * 1000)
    const operatingDate = operatingDateOf(bjNow)
    const serviceDate = operatingDate.toISOString().slice(0, 10)
    const dayType = dayTypeForDate(operatingDate)

    const rows: SubwayTimetableCacheRow[] = []
    for (const side of sides) {
      const stations: SubwayTimetableStation[] = []
      for (const station of side.stations) {
        const departures = await this.fetchTimetable(input.cityCode, side.subLineId, station.pStopId)
        stations.push({ name: station.name, pStopId: station.pStopId, departures })
        await this.sleep(this.delayMs)
      }
      rows.push({
        cityCode: input.cityCode,
        lineId: input.lineId,
        subLineId: side.subLineId,
        direction: side.direction,
        dayType,
        serviceDate,
        payload: {
          lineName: detail.lineName,
          directionName: side.directionName,
          stations,
        },
        fetchedAt: now,
      })
    }

    // 末班后到次日开服前，接口会按站返回 0 个时段；部分站收班早、部分晚，
    // 所以一张表可能「有些站有、有些站空」。空站的表不是完整的全天表，
    // 整行都不能落库 —— 否则该站会被当成「精确时刻表，只是今天没车」。
    for (const row of rows) {
      const empty = row.payload.stations.find(station =>
        Object.values(station.departures).every(minutes => minutes.length === 0),
      )
      if (empty) {
        throw new Error(`chelaile: incomplete timetable (${empty.name} has no departures)`)
      }
    }
    return rows
  }

  private async resolveSubLine(input: SubwayTimetableFetchInput): Promise<number> {
    const params: Record<string, string> = {
      ...MINI_PARAMS,
      cityId: input.cityCode,
      localCityId: input.cityCode,
      key: input.lineName,
      supportPhyStn: 'true',
    }
    params.cryptoSign = cryptoSign(params)

    const data = unwrap(await this.getJson(
      `${WEB_BASE}/bus/query!nSearch.action?${new URLSearchParams(params).toString()}`,
      MINI_HEADERS,
    ))
    const result = asRecord(data.result)
    const lines = Array.isArray(result['lines']) ? result['lines'] : []
    const candidates = lines
      .map(line => asRecord(line))
      .filter(line => line.subwayV2 === 1 && Number(line.subLineId) > 0)
    const exact = candidates.find(line => line.name === input.lineName) ?? candidates[0]
    if (!exact) {
      throw new Error(`chelaile: subway line not found for ${input.cityCode}/${input.lineName}`)
    }
    return Number(exact.subLineId)
  }

  private async fetchLineDetail(cityCode: string, subLineId: number): Promise<LineDetail> {
    const params = new URLSearchParams({
      subLineId: String(subLineId),
      cityId: cityCode,
      s: 'IOS',
      v: '7.6.6',
      sign: signSubwayTimestamp(this.now()),
    })
    const data = unwrap(await this.getJson(
      `${API_BASE}/bus/subway_v2/lineDetail?${params.toString()}`,
      APP_HEADERS,
    ))
    const line = asRecord(data.line)
    const subLine = asRecord(data.subLine)
    const startName = String(subLine.startName ?? '')
    const endName = String(subLine.endName ?? '')
    const oppositeSubLineId = Number(subLine.oppositeSubLineId)
    const stations = (Array.isArray(data.stations) ? data.stations : [])
      .map(item => asRecord(item))
      .map(item => ({ name: String(item.sname ?? ''), pStopId: Number(item.pStopId) }))
      .filter(station => station.name.length > 0 && Number.isInteger(station.pStopId) && station.pStopId > 0)

    if (!startName || !endName || !Number.isInteger(oppositeSubLineId) || stations.length === 0) {
      throw new Error(`chelaile: incomplete lineDetail for subLineId ${subLineId}`)
    }
    return {
      subLineId,
      lineName: String(line.lineName ?? ''),
      startName,
      endName,
      oppositeSubLineId,
      stations,
    }
  }

  private async amapFirstStop(cityCode: string, lineName: string): Promise<string | null> {
    if (!this.amap) return null
    const cityName = getCuratedCityName(cityCode)
    if (!cityName) return null
    try {
      const line = await this.amap.getLineByName(cityName, lineName)
      const first: Station | undefined = line?.stations?.[0]
      return first?.name ?? null
    }
    catch {
      return null
    }
  }

  /**
   * 应用方向 0 = 高德站序。nSearch 返回的 subLineId 是「startName → endName」；
   * 若高德首站等于 startName，它就是方向 0，否则方向 0 是对向。
   * 高德不可用时退回 7 号线实测约定：subLineId = 1，对向 = 0。
   */
  private resolveDirectionSides(detail: LineDetail, firstStop: string | null): DirectionSide[] {
    const subLineIsZero = firstStop !== null
      && normalizeStationName(firstStop) === normalizeStationName(detail.startName)

    return [
      {
        subLineId: detail.subLineId,
        direction: subLineIsZero ? 0 : 1,
        directionName: `开往 ${detail.endName}`,
        stations: detail.stations,
      },
      {
        subLineId: detail.oppositeSubLineId,
        direction: subLineIsZero ? 1 : 0,
        directionName: `开往 ${detail.startName}`,
        stations: [...detail.stations].reverse(),
      },
    ]
  }

  private async fetchTimetable(
    cityCode: string,
    subLineId: number,
    stopId: number,
  ): Promise<Record<string, number[]>> {
    const params = new URLSearchParams({
      stopId: String(stopId),
      subLineId: String(subLineId),
      sCode: String(stopId),
      cityId: cityCode,
      s: 'IOS',
      v: '7.6.6',
      sign: signSubwayTimestamp(this.now()),
    })
    const data = unwrap(await this.getJson(
      `${WEB_BASE}/bus/subway_v2/preTimetable?${params.toString()}`,
      WEB_HEADERS,
    ))
    return parseDepartures(data)
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      // 错误信息不带查询串：preTimetable 的 sign 是可重放的请求凭据，
      // 不该因为一次 5xx 被写进日志。
      const path = (() => {
        try {
          return new URL(url).pathname
        }
        catch {
          return 'upstream'
        }
      })()
      throw new Error(`chelaile: HTTP ${res.status} for ${path}`)
    }
    return parseBody(await res.text())
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return
    await new Promise<void>(resolve => setTimeout(resolve, ms))
  }
}

export function parseDepartures(data: Record<string, unknown>): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  const bands = Array.isArray(data.timetable) ? data.timetable : []
  for (const band of bands) {
    const times = Array.isArray(asRecord(band).times) ? asRecord(band).times as unknown[] : []
    for (const time of times) {
      const ms = Number(asRecord(time).arrivalTime)
      if (!Number.isFinite(ms) || ms <= 0) continue
      const bj = new Date(ms + 8 * 3600 * 1000)
      const hour = String(bj.getUTCHours())
      const minute = bj.getUTCMinutes()
      ;(out[hour] ??= []).push(minute)
    }
  }
  for (const hour of Object.keys(out)) {
    out[hour] = out[hour]!.sort((a, b) => a - b)
  }
  return out
}
