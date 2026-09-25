import type { ArrivalRow, DataProvenance } from '@real-time-transport/shared'
import { listProvenanceOf } from '@real-time-transport/shared'

/**
 * F4 in the station panel's arrival list.
 *
 * A single arrivals answer can carry rows of different kinds: the payload sent a
 * real vehicle's own minute and this app computed the next. `listProvenanceOf`
 * answers `null` for such a list — one word would then be false about part of it
 * — so the list states nothing and every row states its own kind instead. When
 * the classified rows DO agree, the list states that one word once (beside 后续
 * 进站计划) and no row repeats it.
 *
 * These two functions are the same fallback the overview card uses, kept here so
 * this view's version is exercised by its own test rather than only read. They
 * return KINDS; the wording stays in `@/provenance-copy`, so no second provenance
 * vocabulary exists anywhere in the app.
 */

/**
 * The one kind this list can state with a word, or `null` when it cannot — the
 * classified rows disagree, or none of them stated anything.
 */
export function arrivalListProvenanceOf(rows: readonly ArrivalRow[]): DataProvenance | null {
  return listProvenanceOf(rows)
}

/**
 * The kind one row of the list shows.
 *
 * `null` when the list already speaks for its classified rows (the word is shown
 * once at the list level) — and `null` when the row itself stated nothing, since
 * a value nobody classified must never borrow the flattering answer.
 */
export function arrivalRowProvenanceOf(
  rows: readonly ArrivalRow[],
  index: number,
): DataProvenance | null {
  if (arrivalListProvenanceOf(rows) !== null) return null
  return rows[index]?.provenance ?? null
}
