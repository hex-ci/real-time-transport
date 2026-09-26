import type { StationTimetable, DayType } from '../station-timetable.js'
import {
  queryStationArrivals,
  dayTypeForDate,
  operatingDateOf,
  operatingDaySeconds,
  type StationArrivalsResult,
} from '../station-timetable.js'
import { STATION_TIMETABLES } from '../data/subway-timetables.data.js'

/**
 * 规范化站名，使 "甲站站"（高德）与 "甲站"（官方时刻表键）能对上：
 * 去掉结尾的「站」与任意括号后缀，再 trim。
 */
export function normalizeStationName(name: string): string {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/站$/, '')
    .trim()
}

/**
 * 官方发布的站点精确时刻表注册表。
 *
 * 可扩展：把新的生成数据文件放进 STATION_TIMETABLES 即可覆盖更多站点/城市。
 */
export class StationTimetableService {
  private readonly index = new Map<string, StationTimetable>()

  constructor(timetables: StationTimetable[] = STATION_TIMETABLES) {
    for (const t of timetables) {
      this.index.set(this.key(t.lineId, t.stationName), t)
    }
  }

  private key(lineId: string, stationName: string): string {
    return `${lineId}::${normalizeStationName(stationName)}`
  }

  has(lineId: string, stationName: string): boolean {
    return this.index.has(this.key(lineId, stationName))
  }

  stationsForLine(lineId: string): string[] {
    const out: string[] = []
    for (const t of this.index.values()) {
      if (t.lineId === lineId) out.push(t.stationName)
    }
    return out
  }

  /**
   * 查询某站接下来的精确发车；未登记精确时刻表时返回 null
   * （调用方应回落到推演引擎）。
   */
  query(
    lineId: string,
    stationName: string,
    direction: number,
    nowSecOfDay: number,
    opts: { count?: number, dayType?: 'workday' | 'weekend', now?: Date } = {},
  ): StationArrivalsResult | null {
    const t = this.index.get(this.key(lineId, stationName))
    if (!t) return null
    return queryStationArrivals(t, direction, nowSecOfDay, opts)
  }

  /** 某站当前「运营日」的全部发车，按秒。跨 0 点的尾班统一 +24h，
   *  使 00:00~28:00 的运营日时间轴连续。 */
  allDeparturesToday(
    lineId: string,
    stationName: string,
    direction: number,
    now?: Date,
  ): { dayType: DayType, departures: number[] } | null {
    const t = this.index.get(this.key(lineId, stationName))
    if (!t) return null
    const dir = t.directions[String(direction)]
    if (!dir) return null

    const bjNow = new Date((now ? now.getTime() : Date.now()) + 8 * 3600 * 1000)
    const dayType = dayTypeForDate(operatingDateOf(bjNow))
    return { dayType, departures: operatingDaySeconds(dir[dayType]) }
  }

  getRaw(lineId: string, stationName: string): StationTimetable | undefined {
    return this.index.get(this.key(lineId, stationName))
  }
}
