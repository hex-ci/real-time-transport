import type { OperatingState, OperatingStatus } from './schemas/transit.js'

/**
 * F3: 「今天还有没有车」, as a state rather than a sentence.
 *
 * A board that says 「暂无来车」 at 01:00 has told the user nothing they can act
 * on: no vehicle is coming because the day's service has ended, and that answer
 * is available from the line's own last departure. The three facts this module
 * separates — 首班前 / 运营中 / 已过末班 — are decided from the line's REAL
 * first and last departure times, and from nothing else:
 *
 * - Never from a clock assumption. There is no built-in 05:30 or 23:00 anywhere
 *   in this file: a line whose hours are unknown reports `unknown`, and the
 *   caller renders that state rather than 运营中 with a caveat.
 * - Never from a guess at the other end. Half a service window (one time known)
 *   is still `unknown`: 12:00 could be mid-service or hours after the last
 *   train, and the one absent time is never filled in with a default.
 *
 * The day model is the one the station timetable already uses
 * (`operatingDateOf(bjNow) = bjNow - 4h` in the adapter): an operating day runs
 * from its first morning departure through the after-midnight tail, so 00:00–03:59
 * still belongs to the PREVIOUS operating day and its timeline runs 00:00–28:00.
 * {@link operatingDaySecondsOf} is the seconds form of that same boundary, and
 * the two must agree — 04:00 is where a new operating day starts.
 */

/** The operating day's boundary in Beijing: 04:00, the same -4h of `operatingDateOf`. */
const OPERATING_DAY_START_SEC = 4 * 3600

const DAY_SEC = 24 * 3600

/**
 * Seconds into the Beijing operating day (00:00–28:00) for an instant.
 *
 * The instant may come from any device timezone: it is read in Beijing time, so
 * the boundary is the network's, not the phone's. 00:00–03:59 is shifted +24h,
 * making the after-midnight tail continuous with the evening it belongs to.
 */
export function operatingDaySecondsOf(now: Date = new Date()): number {
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000)
  const secOfDay = beijing.getUTCHours() * 3600 + beijing.getUTCMinutes() * 60 + beijing.getUTCSeconds()
  return secOfDay < OPERATING_DAY_START_SEC ? secOfDay + DAY_SEC : secOfDay
}

/**
 * An upstream 「HH:MM」 departure as both its operating-day seconds and the
 * normalized label the API carries. `null` for anything that is not a time —
 * an unparseable value is unknown, not a partial parse.
 */
function parseDeparture(time: string | null | undefined): { seconds: number, label: string } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  // 「24:00」 is the end of the operating day, not a malformed 25th hour: a feed
  // that runs past midnight prints it as the last departure. Accepted only as
  // exactly 24:00 — 24:30 is a time this model cannot place, so it stays malformed.
  const isDayEnd = hours === 24 && minutes === 0
  if ((hours > 23 && !isDayEnd) || minutes > 59) return null

  const seconds = hours * 3600 + minutes * 60
  return {
    // After-midnight departures belong to this operating day's tail.
    seconds: seconds < OPERATING_DAY_START_SEC ? seconds + DAY_SEC : seconds,
    label: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  }
}

export interface OperatingStatusInput {
  /** The line's (or platform's) first departure, 「HH:MM」; '' / null when unknown. */
  firstDeparture?: string | null
  /** The line's last departure, 「HH:MM」 — possibly after midnight. */
  lastDeparture?: string | null
  /** Now, in operating-day seconds, from {@link operatingDaySecondsOf}. */
  nowSecOfDay: number
}

/**
 * The operating state, with the times it was derived from.
 *
 * Boundaries are inclusive at both ends: at exactly the first departure the
 * service is running (that train is leaving now), and so is it at exactly the
 * last one. Both `firstDeparture` and `lastDeparture` are reported whenever they
 * are known — including in the `unknown` state, where one of them may be known —
 * and are null when they are not.
 */
export function operatingStatusOf(input: OperatingStatusInput): OperatingStatus {
  const first = parseDeparture(input.firstDeparture)
  const last = parseDeparture(input.lastDeparture)

  // A single known end says nothing: the service window is the pair. Report what
  // is held (so a known 首班 can still be shown) and refuse to state a state.
  if (!first || !last) {
    return {
      state: 'unknown',
      firstDeparture: first?.label ?? null,
      lastDeparture: last?.label ?? null,
    }
  }

  // A window that ends before it starts is contradictory data, not a service
  // day. 运营中 would be a claim about hours that cannot both be true.
  if (first.seconds >= last.seconds) {
    return { state: 'unknown', firstDeparture: first.label, lastDeparture: last.label }
  }

  const state: OperatingState = input.nowSecOfDay < first.seconds
    ? 'before_first'
    : input.nowSecOfDay > last.seconds ? 'after_last' : 'operating'

  return { state, firstDeparture: first.label, lastDeparture: last.label }
}
