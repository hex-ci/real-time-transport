import type { OperatingStatus } from '@real-time-transport/shared'

/**
 * F3: the operating fact, as the line a board shows.
 *
 * A board that has no vehicle to show has exactly one of four things to say, and
 * they are not interchangeable: service has not started yet, service has ended,
 * the line is running and nothing is in range, or the line's hours are unknown.
 * The server decides which one applies (from the line's own first/last departure
 * times); this module is where that state becomes the user's words, so the
 * wording is a tested fact rather than a template only a browser can check.
 *
 * The copy states the fact and stops. It names no data source, carries no
 * marketing register, and tells the user nothing to do.
 *
 * 「暂无来车」 survives only for the case it is literally the whole truth: no
 * status at all (the feed has not arrived), when nothing about the service day
 * is known. Everywhere the state is known, the state is what is shown.
 */

/**
 * The state alone, for a badge: the short word a compact control has room for,
 * without the time it refers to. Same four states, same one-word-per-state rule,
 * so a badge and a full line can never disagree about which state this is.
 */
export function operatingLabelOf(status: OperatingStatus | null | undefined): string {
  if (!status) return '暂无来车'
  if (status.state === 'before_first') return '未到首班'
  if (status.state === 'after_last') return '已过末班'
  if (status.state === 'operating') return '运营中'
  return '运营时间未知'
}

/**
 * The live screen's badge, where a vehicle actually on the line can outrank the
 * schedule — but ONLY a real one.
 *
 * `hasRealVehicle` is the payload's own declared source classified by
 * `vehicleProvenanceOf`, never a vehicle COUNT. A count cannot make that
 * distinction: the subway engine places its trains inside an internal simulation
 * window, so a line whose hours are unknown can have movement in the list while
 * the state answer on the same screen says 运营时间未知, and generated data must
 * never outrank a known unknown. With no real vehicle the badge is the state,
 * word for word.
 */
export function operatingBadgeOf(
  hasRealVehicle: boolean,
  status: OperatingStatus | null | undefined,
): string {
  return hasRealVehicle ? '有车在途' : operatingLabelOf(status)
}

/** The fact as text, with the time it refers to when that time is known. */
export function operatingTextOf(status: OperatingStatus | null | undefined): string {
  if (!status) return '暂无来车'

  if (status.state === 'before_first') {
    return status.firstDeparture ? `未到首班 · 首班 ${status.firstDeparture}` : '未到首班'
  }
  if (status.state === 'after_last') {
    return status.lastDeparture ? `已过末班 · 末班 ${status.lastDeparture}` : '已过末班'
  }
  if (status.state === 'operating') {
    // Running, but no vehicle in range: the two halves are both facts, and the
    // second is the one that used to be reported as if it were the whole story.
    return '运营中 · 暂无来车'
  }
  return '运营时间未知 · 暂无来车'
}
