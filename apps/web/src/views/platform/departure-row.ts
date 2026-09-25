/**
 * One platform-board row, built from one targeted live reading.
 *
 * WHY THIS IS A MODULE. The board rendered 「无法估算 / 暂无到站耗时」 on every row at every
 * moment because the row builder read `travelTimeSec` off a reading that had asked for no
 * target stop — and upstream fills that field only when the request names the stop the
 * vehicle is travelling to. The builder sat inside the view, where nothing could state
 * what it had been handed, so the column's emptiness was only ever visible in a browser.
 * It lives here now for the same reason the other platform rules do (`landmark-distance`,
 * `congestion`): the answer for a given reading is a pure function with two outcomes that
 * a test can pin.
 *
 * THE MINUTE IS THE SOURCE'S OWN. This row states a minute only when the reading carries
 * one — `travelTimeSec`, which exists only on a targeted read. It deliberately does NOT
 * fall back to per-stop arithmetic the way the home card's arrival rows do: the board is a
 * departure board for a platform (「下一班还有几分钟」), and a row that computed its own
 * minute would be stating this app's estimate of the wait where the source stated none.
 * That is why 「无法估算 / 暂无到站耗时」 stays on the board: it is the honest answer for a
 * vehicle whose arrival time nobody published, and it is reachable — the row simply has no
 * minute. What was broken was the other half: with no target order the field was absent on
 * EVERY vehicle, so the known case could never be reached.
 *
 * THE ROW IS ABOUT THE VEHICLE STILL HEADING HERE. Membership is decided on the vehicle's
 * nose (`nextOrder`) and the source's own 「already past the requested stop」 sentinel
 * (`distanceToWaitStn === -1`), never on `order` alone — this is the same partition the
 * server applies before it prices an arrival row (`TransitService.vehicleArrivals`), so the
 * board and the home card cannot disagree about which vehicles have gone by.
 *
 * The kind of number a row carries is not decided here: `provenanceOf` answers that from
 * the source the response declared, so one board can hold rows of different kinds.
 */
import type { DataSourceType, LiveBus } from '@real-time-transport/shared'
import { platformRowProvenanceOf } from './provenance'
import type { DepartureItem, PlatformLineRule } from './types'

/** The live answer a row is built from: the source it declared, and its vehicles. */
export interface LiveAnswer {
  /**
   * The source the response declared. `null` when it declared none this build knows, in
   * which case the row keeps its minute and shows no mark — never the flattering one.
   */
  dataSource: DataSourceType | null
  buses: LiveBus[]
}

/**
 * The nearest vehicle still heading to this platform, or null when none is.
 *
 * `nextOrder` is the stop the vehicle's nose is heading to, so it is the thing that decides
 * whether this vehicle will still reach the platform being displayed; `order` (the stop it
 * last passed) is only the tiebreak for which of them is nearest.
 */
function vehicleHeadingTo(buses: LiveBus[], stationOrder: number): LiveBus | null {
  let nearest: LiveBus | null = null
  for (const bus of buses) {
    if (typeof bus.order !== 'number') continue
    // The source saying it outright: this vehicle is already past the requested stop.
    if (bus.distanceToWaitStn === -1) continue
    // No nose to read (a reading without ordinals) falls back to the tail, which is the
    // only position such a reading carries.
    const heading = bus.nextOrder ?? bus.order
    if (heading > stationOrder) continue
    if (!nearest || bus.order > (nearest.order ?? 0)) nearest = bus
  }
  return nearest
}

/**
 * The minute the source served for this platform, or null when it served none.
 *
 * `0` is upstream's own statement that the vehicle is STANDING at the platform, not a
 * missing value: it floors to 1 分钟, the app's word for 「马上」, and dropping it into the
 * unknown branch would hide a vehicle that is already there. A negative or non-finite value
 * is not a duration and is treated as no statement at all.
 */
function servedMinuteOf(bus: LiveBus): number | null {
  if (typeof bus.travelTimeSec !== 'number' || !Number.isFinite(bus.travelTimeSec)) return null
  if (bus.travelTimeSec < 0) return null
  return Math.max(1, Math.round(bus.travelTimeSec / 60))
}

/**
 * One row: the stated minute and stops from the answer, or the row's own reason for not
 * having one.
 *
 * `answer: null` is the request that failed and nothing else — a response that arrived
 * without a reading (a 404 for the line, a body with no vehicles) is an ANSWERED reading
 * with nothing in range, and the row states the line's service fact instead of a failure.
 */
export function departureRowOf(params: {
  /** The row's own id, built by the caller from the rule it came from. */
  id: string
  rule: PlatformLineRule
  /** The targeted live answer, or null when the request itself failed. */
  answer: LiveAnswer | null
}): DepartureItem {
  const { id, rule, answer } = params
  const base = { id, lineName: rule.lineName, terminal: rule.terminal }

  if (!answer) {
    // Nothing came back at all: neither a vehicle nor the service day is known here, so
    // no operating fact and no provenance is claimed either.
    return {
      ...base,
      etaMinutes: null,
      stopsAway: null,
      congestion: 'unknown',
      unavailable: true,
      operatingText: null,
      provenance: platformRowProvenanceOf({ dataSource: null, hasMinute: false }),
    }
  }

  const bus = vehicleHeadingTo(answer.buses, rule.stationOrder)
  if (!bus) {
    // No vehicle with a reading for this platform: state the line's own service fact
    // rather than a failure, because the request answered.
    return {
      ...base,
      etaMinutes: null,
      stopsAway: null,
      congestion: 'unknown',
      unavailable: false,
      operatingText: rule.operatingText,
      // A service fact is not a number, so there is nothing for a mark to qualify.
      provenance: platformRowProvenanceOf({ dataSource: answer.dataSource, hasMinute: false }),
    }
  }

  const etaMinutes = servedMinuteOf(bus)
  return {
    ...base,
    etaMinutes,
    // Hops from the nose to this platform, floored at 1 — the same arithmetic the server
    // prices an arrival row with, so the two surfaces cannot count differently.
    stopsAway: Math.max(1, rule.stationOrder - (bus.nextOrder ?? bus.order!)),
    // The crowding verdict is the vehicle's own and stands even with no minute.
    congestion: bus.congestion,
    unavailable: false,
    // A vehicle IS in range: this row's answer is a number, or the absence of one.
    operatingText: null,
    // A mark rides only on a minute that exists.
    provenance: platformRowProvenanceOf({ dataSource: answer.dataSource, hasMinute: etaMinutes !== null }),
  }
}
