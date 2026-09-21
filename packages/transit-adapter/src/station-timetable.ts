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
 * The operating date a Beijing timestamp belongs to: a metro operating day runs
 * from its first morning departure through the after-midnight tail, so 00:00-04:00
 * still belongs to the previous day and selects that day's table.
 */
export function operatingDateOf(bjNow: Date): Date {
  return new Date(bjNow.getTime() - 4 * 3600 * 1000)
}

/**
 * Sorted seconds-of-day for one table. Entries before 04:00 are the previous
 * operating day's tail, shifted +24h so the timeline is continuous.
 */
export function operatingDaySeconds(day: DayTimetable): number[] {
  const out: number[] = []
  for (const [hStr, mins] of Object.entries(day.departures)) {
    const h = Number(hStr)
    for (const m of mins) {
      out.push(h < 4 ? h * 3600 + m * 60 + 24 * 3600 : h * 3600 + m * 60)
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * First departure of the service day, in seconds of day. After-midnight tail
 * entries (hour < 4) are excluded: they belong to the PREVIOUS operating day,
 * so the day's own service starts at its first morning train.
 */
function serviceStartSeconds(day: DayTimetable): number {
  let min = Infinity
  for (const [hStr, mins] of Object.entries(day.departures)) {
    const h = Number(hStr)
    if (h < 4) continue
    for (const m of mins) min = Math.min(min, h * 3600 + m * 60)
  }
  return min
}

/**
 * Query the next `count` exact departures at a station at/after `nowSecOfDay`.
 *
 * Only the current operating day is considered, and only while it is actually
 * running. Once the last departure has gone — or before the first one — the
 * result is empty: the next train is on another operating day, and reporting it
 * as a few hundred minutes away reads as a live train when nothing is running.
 * The simulated engine already reports nothing outside its service window, so
 * both paths agree.
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
  const dayType = opts.dayType || dayTypeForDate(operatingDateOf(refDate))
  const day = dir[dayType]

  const arrivals: StationArrival[] = []
  if (nowSecOfDay >= serviceStartSeconds(day)) {
    for (const sec of operatingDaySeconds(day)) {
      // 30s grace keeps a departure that has just left the platform in the list.
      if (sec < nowSecOfDay - 30) continue
      arrivals.push(fmtSec(sec, nowSecOfDay))
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
    arrivals,
  }
}

function fmtSec(sec: number, nowSec: number): StationArrival {
  const daySec = sec % (24 * 3600)
  return {
    time: `${String(Math.floor(daySec / 3600)).padStart(2, '0')}:${String(Math.floor((daySec % 3600) / 60)).padStart(2, '0')}`,
    secOfDay: daySec,
    etaSeconds: Math.max(0, sec - nowSec),
  }
}

/** Convenience: seconds until the next exact departure, or null if none/unknown. */
export function nextDepartureEtaSeconds(result: StationArrivalsResult | null): number | null {
  if (!result || result.arrivals.length === 0) return null
  const a = result.arrivals.find(x => x.etaSeconds > 0)
  return a ? a.etaSeconds : null
}
