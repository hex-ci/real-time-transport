import type {
  DataProvenance,
  DataSourceType,
  VehicleProvenance,
} from './schemas/transit.js'

/**
 * F4: which KIND of number a value is, decided where the value is produced.
 *
 * The product rule this file exists to enforce: 「没有来源」 and 「实时」 are
 * different facts, and the difference is invisible to the user unless the data
 * layer says it. Every function here therefore has a way to answer 「I do not
 * know」 — `null` — and no input can round an unknown up to `live`.
 *
 * The measurement that makes the distinction load-bearing: `travelTimeSec` is
 * filled only when the request named a target order — the upstream then returns
 * that stop's own travel time and the adapter copies it onto the vehicle — so an
 * arrivals response CAN carry the minute, and the same response can carry it for
 * one vehicle and not the next. With no target (the bare live board) the field is
 * absent on every in-transit vehicle, so no arrival minute there comes from the
 * payload: a subway row is the engine's 135 s/station model
 * (`schedule_simulation`), and a bus row whose reading published no arrival time
 * states NO MINUTE AT ALL — this app used to price one from the vehicle's position
 * and speed (`position_estimate`), and that arithmetic was removed because its
 * error had no fixed sign. A response that simply says "live source answered"
 * would label every one of them 实时, which is the one lie F4 exists to prevent.
 *
 * Nothing in this file reads a clock, a route type, or a view's position. A
 * component that decides a provenance for itself is wrong the first time the
 * aggregator fails over to a source that answers with a different kind of reading.
 */

/**
 * Which kind of vehicle reading a payload's declared `dataSource` produces.
 *
 * `null` — no statement — for a missing source and for a source this build does
 * not know, so a new provider cannot inherit `live` by default.
 */
export function vehicleProvenanceOf(
  dataSource: DataSourceType | null | undefined,
): VehicleProvenance | null {
  switch (dataSource) {
    // Real vehicles, observed by the operator and served live.
    case 'chelaile':
    case 'apizero':
      return 'live'
    // The engine's trains are generated from the timetable, whatever their
    // positions look like.
    case 'subway_schedule':
      return 'schedule_simulation'
    default:
      return null
  }
}

/**
 * How one arrival minute came to exist.
 *
 * - `upstream`      the minute was in the payload — the source's own arrival time
 * - `at_platform`   the vehicle was observed at this platform (`isAtStation`)
 * - `our_estimate`  this app computed the minute from its own model of the vehicle
 *
 * `our_estimate` is the SUBWAY model's basis. It used to cover a bus too (a real
 * position, a real speed, a nominal dwell per remaining stop); that arithmetic no
 * longer produces a minute at all, so a bus row reaches this type as `upstream`
 * or `at_platform` or — when the targeted reading published nothing for it — with
 * NO basis, because it states no minute for a basis to describe.
 */
export type ArrivalBasis = 'upstream' | 'at_platform' | 'our_estimate'

/**
 * The provenance of one arrival minute, from the vehicle behind it and the way the
 * minute was produced.
 *
 * The order of the two questions matters. A generated vehicle makes the whole row a
 * model output however its minute was produced — the subway engine puts a
 * `travelTimeSec` on each of its trains, so such a row reaches the "upstream sent
 * the minute" branch while the train itself does not exist.
 */
export function arrivalProvenanceOf(params: {
  vehicle: VehicleProvenance | null | undefined
  basis: ArrivalBasis
}): DataProvenance | null {
  const vehicle = params.vehicle ?? null
  if (!vehicle) return null
  if (vehicle === 'schedule_simulation') return 'schedule_simulation'
  // A real vehicle, read from upstream data: 实时 for a value upstream sent or an
  // observation of the vehicle itself, and this app's own arithmetic otherwise.
  return params.basis === 'our_estimate' ? 'position_estimate' : 'live'
}

/**
 * The one provenance all of a list's classified rows share, or `null`.
 *
 * `null` covers both 「nothing is classified」 and 「the rows disagree」: one word
 * would then be false about part of the list, and the caller states each row's own
 * provenance instead. Rows that stated nothing are ignored rather than treated as a
 * second opinion — an unclassified row must not silence a list whose classified
 * rows all agree.
 */
export function listProvenanceOf(
  rows: readonly { provenance?: DataProvenance | null }[],
): DataProvenance | null {
  const known = new Set<DataProvenance>()
  for (const row of rows) {
    if (row.provenance) known.add(row.provenance)
  }
  return known.size === 1 ? [...known][0]! : null
}
