import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  Station,
} from '@real-time-transport/shared'
import { getCuratedCityName, CITY_DICTIONARY, cumulativeDistances, statedCoordinate } from '@real-time-transport/shared'
import type { ITransitProvider } from '../types.js'
import type { AmapGisService } from '../services/amap-gis.service.js'
import type { StationTimetableService } from '../services/station-timetable.service.js'
import { dayTypeForDate, operatingDateOf, serviceWindowOf } from '../station-timetable.js'

/** 地铁发车间隔窗口（秒），按始发站发车时刻套用。 */
const HEADWAY_WINDOWS = [
  { from: 7 * 3600, to: 9.5 * 3600, headway: 210 },
  { from: 17 * 3600, to: 19.5 * 3600, headway: 210 },
  { from: 21.5 * 3600, to: 25 * 3600, headway: 480 },
] as const

const DEFAULT_HEADWAY = 360

/**
 * 仅用于枚举模拟发车的发车窗口：上游与线路自身的精确时刻表都
 * 没有真实服务时间时用它。
 *
 * 它是模拟参数，不是可上报的事实：`getLineDetail` 宁可让
 * `firstBusTime` / `lastBusTime` 留空，也不发布这个窗口。
 */
const SIMULATION_FIRST_SEC = 5 * 3600 + 30 * 60
const SIMULATION_LAST_SEC = 23 * 3600

const STATION_RUN_SEC = 135

/** 巡航速度，用于 LiveBus.speed（m/s），约 54 km/h。 */
const CRUISE_SPEED = 15

/**
 * 站点列表自身的坐标，形如 [lat, lng]；任一站点没有位置时返回 null。
 *
 * 累计剖面与站点列表按下标对齐，所以一个未放置的站点就让整个剖面
 * 无从表述：丢掉它会把后面的站点静默重编号，用替代点又会量出一条
 * 线路并不走的轨迹。任一轴为 0 同样是缺省（`statedCoordinate`）。
 */
function stopPositions(stops: readonly Station[]): Array<[number, number]> | null {
  const positions: Array<[number, number]> = []
  for (const stop of stops) {
    const lat = statedCoordinate(stop.lat)
    const lng = statedCoordinate(stop.lng)
    if (lat === undefined || lng === undefined) return null
    positions.push([lat, lng])
  }
  return positions
}

interface MetroStopNode {
  station: Station
  cumulativeSeconds: number
}

/**
 * 通用地铁排班推演引擎。
 *
 * lineId 约定：`subway_<cityCode>_<lineKeyword>`，例如
 * `subway_027_88`、`subway_amap_440100_3`。
 */
/**
 * 从持久存储（如服务端 DB 缓存）取线路静态详情，使 live 路径不必每次
 * 轮询都从高德重新推导站点几何 —— 否则一次 QPS 抖动就会把一条
 * 完全有效的线路变成 404。
 */
export type DetailResolver = (
  lineId: string,
  direction: number,
  cityCode?: string,
) => Promise<LineDetail | null>

export class UniversalSubwayEngine implements ITransitProvider {
  readonly name: DataSourceType = 'subway_schedule'

  constructor(
    private readonly amap: AmapGisService,
    private readonly timetables?: StationTimetableService,
    private readonly detailResolver?: DetailResolver,
  ) {}

  private async resolveDetail(
    lineId: string,
    direction: number,
    cityCode?: string,
  ): Promise<LineDetail | null> {
    if (!this.detailResolver) {
      return this.getLineDetail(lineId, direction, cityCode)
    }
    // resolver 拥有完整的兜底链，信任它的答案，不要再发一次高德调用
    // —— 那会在限流时把 QPS 用量翻倍。
    const resolved = await this.detailResolver(lineId, direction, cityCode).catch(() => null)
    return resolved && resolved.stops.length >= 2 ? resolved : null
  }

  async searchLines(_keyword: string, _cityCode: string = '027'): Promise<LineSummary[]> {
    return []
  }

  /**
   * 用高德静态站点序列构造模拟线路详情。
   * cityCode 只是提示，lineId 里内嵌的编码永远优先（WS 订阅与缓存只
   * 以 lineId 为键，因此必须如此）。
   */
  async getLineDetail(lineId: string, direction: number = 0, cityCode?: string): Promise<LineDetail | null> {
    if (!this.amap?.isAvailable()) {
      return null
    }
    if (!lineId.startsWith('subway_')) {
      return null
    }

    // 本引擎能作用的方向 —— 见 `statedDirection`。
    const dir = statedDirection(direction)

    const resolvedCity = resolveCityFromLineId(lineId) || cityCode || '027'
    const keyword = extractLineKeyword(lineId)
    if (!keyword) {
      return null
    }

    const cityName = getCuratedCityName(resolvedCity)
      || CITY_DICTIONARY.find(c => c.code === resolvedCity)?.name
      || resolvedCity
    const result = await this.amap.getLineByName(cityName, `地铁${keyword}`)
    if (!result || result.stations.length < 2) {
      return null
    }

    const orderedStops = dir === 1 ? [...result.stations].reverse() : [...result.stations]
    const stops: Station[] = orderedStops.map((s, idx) => ({
      ...s,
      order: idx + 1,
    }))

    const terminalName = stops[stops.length - 1]?.name || '终点站'
    const cleanName = result.lineName.replace(/\(.*?\)/g, '').trim()

    // 用高德站点坐标算真实站间几何（GCJ-02，同一基准下的距离自洽），
    // 使客户端得到米级精度的连续轨迹。
    //
    // 剖面与 `stops` 按下标对齐，所以一个没有坐标的站点就让整条线路的
    // 几何无从表述：穿过替代点量出的距离谈的是一条线路并不走的轨迹，
    // 而更短的数组会把缺口之后的每个站点静默重编号。
    const positions = stopPositions(stops)
    const stationDistances = positions ? cumulativeDistances(positions) : undefined
    const routeLengthMeters = stationDistances?.[stationDistances.length - 1]
    const hasGeometry = typeof routeLengthMeters === 'number' && routeLengthMeters > 0

    const serviceHours = this.realServiceHours(lineId, dir, stops)

    return {
      lineId,
      lineName: cleanName || `地铁${keyword}`,
      direction: dir,
      directionName: `开往 ${terminalName}`,
      // 上报的时间是关于线路的事实：上游给了就用上游的，否则用线路
      // 自己发布的时刻表；两者都没有时字段留空 —— 模拟窗口永远不会
      // 被当作服务时间发布（见 `SIMULATION_FIRST_SEC`）。
      firstBusTime: result.firstTime || serviceHours?.first || '',
      lastBusTime: result.lastTime || serviceHours?.last || '',
      cityCode: resolvedCity,
      type: 'subway',
      stops,
      routeLengthMeters: hasGeometry ? routeLengthMeters : undefined,
      stationDistances: hasGeometry ? stationDistances : undefined,
      otherDirectionLineId: lineId, // 同一个 lineId，方向由查询参数区分
    }
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    if (!lineId.startsWith('subway_')) {
      return null
    }

    // 方向只读一次，与站点顺序同理：调用方可能给出根本不是方向的
    // 东西（见 `statedDirection`），下面每一处用法 —— 车次 id、站点顺序、
    // 发车、回显的方向 —— 都必须是同一个值。
    const dir = statedDirection(direction)

    // 接好持久缓存时从中取静态几何。live 路径绝不能每次轮询都重新
    // 问高德：一次 QPS 限流就会让一条数据本已知良好的线路变成 404。
    const detail = await this.resolveDetail(lineId, dir, cityCode)
    if (!detail || detail.stops.length < 2) {
      return null
    }

    const stops = detail.stops
    const totalStops = stops.length
    const now = Date.now()

    const bjDate = new Date(now + 8 * 3600 * 1000)
    const hours = bjDate.getUTCHours()
    const minutes = bjDate.getUTCMinutes()
    const seconds = bjDate.getUTCSeconds()
    let currentSecOfDay = hours * 3600 + minutes * 60 + seconds
    if (hours < 4) {
      currentSecOfDay += 24 * 3600
    }

    // 发车窗口，按当日秒数。兜底值是模拟窗口：模型需要一个跨度来
    // 枚举发车，但这个跨度永远不会被当作线路的服务时间上报。跨 0 点
    // 的末班属于本运营日的尾巴 —— 见 `serviceWindowSeconds`。
    const { first: firstSec, last: lastSec } = serviceWindowSeconds(
      detail.firstBusTime,
      detail.lastBusTime,
    )

    const nodes: MetroStopNode[] = stops.map((station, idx) => ({
      station,
      cumulativeSeconds: idx * STATION_RUN_SEC,
    }))

    const totalTripSec = nodes[nodes.length - 1]!.cumulativeSeconds + STATION_RUN_SEC

    const buses: LiveBus[] = []

    if (currentSecOfDay >= firstSec && currentSecOfDay <= lastSec + totalTripSec) {
      const departures = this.resolveDepartures(lineId, dir, stops, firstSec, lastSec)

      for (let i = 0; i < departures.length; i++) {
        const depTime = departures[i]!
        const elapsedSinceDep = currentSecOfDay - depTime

        if (elapsedSinceDep < 0 || elapsedSinceDep >= totalTripSec) {
          continue
        }

        let segmentIdx = 0
        for (let n = 0; n < nodes.length; n++) {
          if (elapsedSinceDep >= nodes[n]!.cumulativeSeconds) {
            segmentIdx = n
          }
          else {
            break
          }
        }

        if (segmentIdx >= totalStops - 1) {
          continue
        }

        const segmentStart = nodes[segmentIdx]!.cumulativeSeconds
        const segmentEnd = segmentIdx < nodes.length - 1
          ? nodes[segmentIdx + 1]!.cumulativeSeconds
          : totalTripSec

        const segDuration = Math.max(segmentEnd - segmentStart, 30)
        const segElapsed = elapsedSinceDep - segmentStart
        const progress = Math.min(Math.max(segElapsed / segDuration, 0), 0.99)

        const order = segmentIdx + 1
        const remainingStopsToTerminal = totalStops - 1 - segmentIdx

        const sd = detail.stationDistances
        let distanceFromStart: number | undefined
        if (sd && sd.length === totalStops) {
          const segStartM = sd[segmentIdx]!
          const segEndM = sd[Math.min(segmentIdx + 1, totalStops - 1)]!
          distanceFromStart = segStartM + (segEndM - segStartM) * progress
        }
        const routeLen = detail.routeLengthMeters

        let distanceToWaitStn: number | undefined
        let travelTimeSec: number | undefined

        if (options?.targetOrder) {
          if (order < options.targetOrder) {
            const stopsToTarget = options.targetOrder - order - progress
            travelTimeSec = Math.max(30, Math.round(stopsToTarget * STATION_RUN_SEC))
            if (sd && typeof distanceFromStart === 'number' && sd[options.targetOrder - 1]) {
              distanceToWaitStn = Math.max(0, sd[options.targetOrder - 1]! - distanceFromStart)
            }
            else {
              distanceToWaitStn = Math.max(0, Math.round(stopsToTarget * 1200))
            }
          }
        }
        else {
          distanceToWaitStn = (typeof routeLen === 'number' && distanceFromStart !== undefined)
            ? Math.max(0, routeLen - distanceFromStart)
            : remainingStopsToTerminal * 1200
          travelTimeSec = Math.max(60, remainingStopsToTerminal * STATION_RUN_SEC)
        }

        buses.push({
          id: simulatedTrainId(lineId, dir, i),
          order,
          nextOrder: order + 1,
          progress: Number(progress.toFixed(3)),
          // 列车所在（或刚离开）那一站的位置，且只有该站声明了位置时
          // 才有：未放置站点旁的列车同样没有位置，列表标 0 的站点也是
          // 未放置（`statedCoordinate`）。
          lat: statedCoordinate(stops[segmentIdx]?.lat),
          lng: statedCoordinate(stops[segmentIdx]?.lng),
          speed: CRUISE_SPEED,
          // 位置由时刻表推导，完全没有拥挤度数据 —— 拥挤度绝不能
          // 由时钟推断。
          congestion: 'unknown',
          distanceToWaitStn,
          distanceFromStart,
          travelTimeSec,
          updatedAt: now,
        })
      }
    }

    return {
      lineId,
      direction: dir,
      buses,
      dataSource: 'subway_schedule',
      isDegraded: false,
      updatedAt: now,
    }
  }

  /**
   * 线路所在车站若持有官方精确时刻表，从中取真实服务时间；没有则 null。
   *
   * 这些是已发布的时间，所以优先于空值与模拟窗口，但低于上游自己给的
   * 时间（调用方优先用后者）。运营日的取法与时刻表叠加层一致，时刻本身
   * 来自站台发车所蕴含的同一个 {@link serviceWindowOf}，所以线路上报的
   * 服务时间与它自己的站点列表不可能互相矛盾。
   */
  private realServiceHours(
    lineId: string,
    direction: number,
    stops: Station[],
  ): { first: string, last: string } | null {
    if (!this.timetables) {
      return null
    }
    const bjNow = new Date(Date.now() + 8 * 3600 * 1000)
    const dayType = dayTypeForDate(operatingDateOf(bjNow))

    for (const st of stops) {
      const day = this.timetables.getRaw(lineId, st.name)?.directions[String(direction)]?.[dayType]
      if (!day) continue
      const window = serviceWindowOf(day)
      const first = padClockTime(window.first)
      const last = padClockTime(window.last)
      if (first || last) {
        return { first, last }
      }
    }
    return null
  }

  /**
   * 按当前运营日解析始发站发车秒数：该线路某站持有官方分钟级时刻表时，
   * 把该站的发车按它的累计运行偏移推回始发站，使整条推演线路与真实
   * 时刻表锁相，而不是走通用的发车间隔网格；否则按间隔规则枚举始发
   * 站发车。
   */
  private resolveDepartures(
    lineId: string,
    direction: number,
    stops: Station[],
    firstSec: number,
    lastSec: number,
  ): number[] {
    if (this.timetables) {
      for (const st of stops) {
        const idx = st.order - 1
        if (idx < 0 || idx >= stops.length) continue
        if (!this.timetables.has(lineId, st.name)) continue

        const all = this.timetables.allDeparturesToday(lineId, st.name, direction)
        if (!all || all.departures.length === 0) continue

        const offset = idx * STATION_RUN_SEC
        const origin = all.departures
          .map(sec => sec - offset)
          .filter(sec => sec >= firstSec - 3600 && sec <= lastSec + 3600)

        if (origin.length > 0) {
          return origin
        }
      }
    }

    const departures: number[] = []
    let t = firstSec
    while (t <= lastSec) {
      departures.push(t)
      t += getHeadwayForTime(t)
    }
    return departures
  }

  async isAvailable(): Promise<boolean> {
    return this.amap?.isAvailable() || false
  }
}

/** 从 `subway_<cityCode>_<keyword>` 中取出内嵌的城市码（支持 `amap_<adcode>` 形式）。 */
export function resolveCityFromLineId(lineId: string): string | null {
  const m = /^subway_(amap_\d+|\d+)_/.exec(lineId)
  return m ? m[1]! : null
}

/** 从 subway lineId 中取出线路关键字（如 '88'，或具名线自己的关键字）。 */
export function extractLineKeyword(lineId: string): string {
  const parts = lineId.split('_')
  // subway_<code>_<keyword...>，其中 <code> 本身可能是 amap_<adcode>
  const codeStartIdx = parts[1] === 'amap' ? 3 : 2
  return parts.slice(codeStartIdx).join('_')
}

/**
 * 本引擎能作用的方向：0（站点列表原样）或 1（倒序）。
 *
 * 调用方可能两者都不是：`?direction=abc` 到达引擎时是 `Number('abc')`
 * = NaN，不归一化就会被回显成方向的 null，并写进每个生成车次的 id。
 * 归一化后，车次 id、回显方向、站点顺序与发车用的是同一个值。
 */
export function statedDirection(direction: number | undefined | null): 0 | 1 {
  return direction === 1 ? 1 : 0
}

/**
 * 生成车次在应用词汇里的名字：`train_<lineId>_d<direction>_dep<i>`。
 *
 * 在此命名而不内联，是为了让关键的那一条性质只有一个归属：名字里的
 * 方向是「已声明的」方向（`statedDirection`），绝不是原始实参。
 */
export function simulatedTrainId(lineId: string, direction: number | undefined | null, index: number): string {
  return `train_${lineId}_d${statedDirection(direction)}_dep${index}`
}

export function parseHm(timeStr: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim())
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null
  return hh * 3600 + mm * 60
}

const CALENDAR_DAY_SECONDS = 24 * 3600

/**
 * 线路自身的服务窗口，按运营日秒数，来自它的「H:MM」首末班字符串；
 * 时间未知时回落到模拟参数（{@link SIMULATION_FIRST_SEC}）。
 *
 * `parseHm` 给的是日历日秒数，而与之比较的时钟不跑 00:00–24:00：
 * `getLiveStatus` 里的 `currentSecOfDay` 把 00:00–03:59 平移 +24h，使
 * 跨 0 点的尾班与它所属的当晚连续，与 `@real-time-transport/shared`
 * 的 `operatingDaySecondsOf` 画的同一条 04:00 边界一致。直接读时钟
 * 的末班因此落在自己首班之前，整个窗口就匹配不上任何小时。
 *
 * 末班早于首班即表示跨 0 点的尾班，按「下一个日历日」理解。只有末端
 * 会平移，且只在它早于首班时：05:16–23:06 的窗口原样返回，首班永不
 * 平移，因为服务日在 0 点之后开始不是这批数据会出现的形状。
 */
export function serviceWindowSeconds(
  firstBusTime: string,
  lastBusTime: string,
): { first: number, last: number } {
  const first = parseHm(firstBusTime) ?? SIMULATION_FIRST_SEC
  let last = parseHm(lastBusTime) ?? SIMULATION_LAST_SEC
  if (last < first) last += CALENDAR_DAY_SECONDS
  return { first, last }
}

/**
 * 把官方时刻表的「H:MM」补零成线路契约携带的「HH:MM」。不是时钟
 * 时间的值原样通过：时刻表是真实数据，永远不会被改写成别的值。
 */
function padClockTime(raw: string): string {
  const s = String(raw ?? '').trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : s
}

export function getHeadwayForTime(secOfDay: number): number {
  for (const w of HEADWAY_WINDOWS) {
    if (secOfDay >= w.from && secOfDay <= w.to) {
      return w.headway
    }
  }
  return DEFAULT_HEADWAY
}
