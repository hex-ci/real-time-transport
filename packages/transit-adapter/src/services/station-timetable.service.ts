import type { StationTimetable, DayType } from '../station-timetable.js'
import { queryStationArrivals, dayTypeForDate, type StationArrivalsResult } from '../station-timetable.js'
import { STATION_TIMETABLES } from '../data/subway-timetables.data.js'

/**
 * Normalize a station name so that "群芳站" (amap) matches "群芳" (official
 * timetable key). Strips a trailing 站 and any parenthetical suffix, then trims.
 */
export function normalizeStationName(name: string): string {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/站$/, '')
    .trim()
}

/**
 * Registry of precise, officially-published station timetables.
 *
 * Indexed by `lineId::stationName` for O(1) lookup. When a query hits a station
 * we hold an exact timetable for, callers get minute-accurate departures instead
 * of the whole-line headway simulation. Extendable: drop a new generated data
 * file into STATION_TIMETABLES to cover more stations/cities.
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

  /** Whether we hold an exact timetable for this line+station. */
  has(lineId: string, stationName: string): boolean {
    return this.index.has(this.key(lineId, stationName))
  }

  /** All station names we hold exact timetables for on a given line. */
  stationsForLine(lineId: string): string[] {
    const out: string[] = []
    for (const t of this.index.values()) {
      if (t.lineId === lineId) out.push(t.stationName)
    }
    return out
  }

  /**
   * Query exact upcoming departures at a station.
   * Returns null when no precise timetable is registered (caller should fall
   * back to the simulated engine).
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

  /**
   * All departures of the current "operating day" at a station, in seconds.
   * After-midnight tail entries (hour < 4) are shifted +24h so the timeline is
   * continuous for a 00:00~28:00 operating day. dayType is resolved from the
   * operating date (Beijing time minus 4h, so 0~4am belongs to the previous day).
   */
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
    const operatingDate = new Date(bjNow.getTime() - 4 * 3600 * 1000)
    const dayType = dayTypeForDate(operatingDate)
    const day = dir[dayType]

    const departures: number[] = []
    for (const [hStr, mins] of Object.entries(day.departures)) {
      const h = Number(hStr)
      for (const m of mins) {
        const sec = h * 3600 + m * 60
        departures.push(h < 4 ? sec + 24 * 3600 : sec)
      }
    }
    departures.sort((a, b) => a - b)
    return { dayType, departures }
  }

  getRaw(lineId: string, stationName: string): StationTimetable | undefined {
    return this.index.get(this.key(lineId, stationName))
  }
}
