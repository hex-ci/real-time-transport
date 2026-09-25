import type { DataProvenance, DataSourceType } from '@real-time-transport/shared'
import { arrivalProvenanceOf, vehicleProvenanceOf } from '@real-time-transport/shared'

/**
 * F4: what kind of number one platform row carries.
 *
 * The board is a row per followed line/direction, so one glance can hold rows of
 * different kinds at once and every row states its own — a list-level word would
 * be describing several different answers. The KIND comes from
 * `@real-time-transport/shared` and the WORDS from `provenance-copy.ts`; this
 * function only says which of the shared answers applies to a row.
 *
 * A mark exists only where a minute does. The board's rows are built by
 * `departure-row.ts` from a per-station targeted reading (`/lines/:id/live?order=N`), and
 * upstream fills a real vehicle's `travelTimeSec` only when the request names that stop —
 * so a bus row with an approaching vehicle can carry the source's own minute, and the
 * `basis: 'upstream'` below is the basis such a number was priced with. A same reading can
 * carry the minute for one vehicle and not the next, and a vehicle the source priced
 * nothing for yields no minute at all: that row renders 无法估算, with nothing for a mark to
 * qualify (see `departure-row.ts`). The timetable engine's generated trains reach this
 * function with a minute too — their declared source reads as `schedule_simulation`, and
 * `arrivalProvenanceOf` answers 排班推演 from that vehicle before it consults the basis.
 *
 * Two inputs answer `null`, and both are meant to: a row that states no minute has
 * no number for a kind to belong to (it reports a service fact instead), and a
 * source this build does not know classifies nothing. The row then renders no
 * mark, which is the whole point — 「没有来源」 must never read as 实时.
 */
export function platformRowProvenanceOf(params: {
  /** The `dataSource` the response this row came from declared. */
  dataSource: DataSourceType | null | undefined
  /** Whether the row states an arrival minute at all. */
  hasMinute: boolean
}): DataProvenance | null {
  if (!params.hasMinute) return null
  return arrivalProvenanceOf({
    vehicle: vehicleProvenanceOf(params.dataSource),
    basis: 'upstream',
  })
}
