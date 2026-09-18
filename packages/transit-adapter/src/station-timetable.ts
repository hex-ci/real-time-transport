/**
 * Station-level precise timetable overlay ("增强层").
 *
 * The UniversalSubwayEngine simulates whole-line train positions from origin
 * departures + headway rules. For a handful of high-frequency commuter stations
 * we also hold the OFFICIAL minute-level timetable (e.g. Beijing Line 7 群芳站,
 * scraped from bjsubway.com). When a query targets such a station, we return the
 * exact departure minutes instead of the simulated estimate.
 *
 * Beijing Subway timetable selection rule (official practice):
 *   Mon-Fri -> workday table; Sat/Sun -> weekend table.
 *   A Saturday/Sunday that is a make-up workday STILL uses the weekend table
 *   (metro schedules follow weekend passenger flow), so selection is purely by
 *   day-of-week, NOT by statutory holiday status.
 */

export interface DayTimetable {
  /** first departure of the day, "H:MM" or "HH:MM" */
  first: string
  /** last departure of the day */
  last: string
  /** free-text caveat, e.g. "晚间两班半程至双合" */
  note: string
  /** { hour (0-23, string key): [minute, ...] } departure minutes at this station */
  departures: Record<string, number[]>
}

export interface DirectionTimetable {
  name: string
  workday: DayTimetable
  weekend: DayTimetable
}

export interface StationTimetable {
  lineId: string
  lineName: string
  cityCode: string
  stationName: string
  sourceNote: string
  /** keyed by direction string ("0" / "1") */
  directions: Record<string, DirectionTimetable>
}

export type DayType = 'workday' | 'weekend'

/** Pick the timetable table by day-of-week (Beijing rule: weekend = Sat/Sun only). */
export function dayTypeForDate(d: Date): DayType {
  // getDay(): 0=Sun ... 6=Sat. Beijing uses weekend table for Sat & Sun.
  const day = d.getUTCDay()
  return day === 0 || day === 6 ? 'weekend' : 'workday'
}

export interface StationArrival {
  /** departure time "HH:MM" (24h) */
  time: string
  /** seconds-of-day */
  secOfDay: number
  /** seconds from `nowSecOfDay` (may be negative if just passed) */
  etaSeconds: number
}

export interface StationArrivalsResult {
  lineId: string
  stationName: string
  direction: number
  dayType: DayType
  isExact: boolean
  first: string
  last: string
  note: string
  arrivals: StationArrival[]
}

/**
 * Query the next `count` exact departures at a station after `nowSecOfDay`.
 * Handles the after-midnight tail (hour 0 entries) by wrapping into the next day.
 */
export function queryStationArrivals(
  timetable: StationTimetable,
  direction: number,
  nowSecOfDay: number,
  opts: { count?: number, dayType?: DayType, now?: Date } = {},
): StationArrivalsResult | null {
  const count = opts.count ?? 6
  const dir = timetable.directions[String(direction)]
  if (!dir) return null

  const refDate = opts.now ? new Date(opts.now.getTime() + 8 * 3600 * 1000) : new Date(Date.now() + 8 * 3600 * 1000)
  const dayType = opts.dayType || dayTypeForDate(refDate)
  const day = dir[dayType]

  const flat: Array<{ hour: number, minute: number }> = []
  for (const [hStr, mins] of Object.entries(day.departures)) {
    const h = Number(hStr)
    for (const m of mins) {
      flat.push({ hour: h, minute: m })
    }
  }
  // sort by seconds-of-day; hour 0 entries are after-midnight (treat as +24h when wrapping)
  const toSec = (h: number, m: number) => h * 3600 + m * 60
  flat.sort((a, b) => toSec(a.hour, a.minute) - toSec(b.hour, b.minute))

  const arrivals: StationArrival[] = []
  // First pass: today's departures at/after now
  for (const d of flat) {
    const sec = toSec(d.hour, d.minute)
    if (sec >= nowSecOfDay - 30) {
      arrivals.push(fmt(d.hour, d.minute, sec, nowSecOfDay))
      if (arrivals.length >= count) break
    }
  }
  // Second pass: wrap into next day (after-midnight hour-0 entries + early morning)
  if (arrivals.length < count) {
    for (const d of flat) {
      const sec = toSec(d.hour, d.minute) + 24 * 3600
      arrivals.push(fmt(d.hour, d.minute, sec, nowSecOfDay))
      if (arrivals.length >= count) break
    }
  }

  return {
    lineId: timetable.lineId,
    stationName: timetable.stationName,
    direction,
    dayType,
    isExact: true,
    first: day.first,
    last: day.last,
    note: day.note,
    arrivals: arrivals.slice(0, count),
  }
}

function fmt(hour: number, minute: number, sec: number, nowSec: number): StationArrival {
  return {
    time: `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    secOfDay: sec % (24 * 3600),
    etaSeconds: Math.max(0, sec - nowSec),
  }
}

/** Convenience: seconds until the next exact departure, or null if none/unknown. */
export function nextDepartureEtaSeconds(result: StationArrivalsResult | null): number | null {
  if (!result || result.arrivals.length === 0) return null
  const a = result.arrivals.find(x => x.etaSeconds > 0)
  return a ? a.etaSeconds : null
}
