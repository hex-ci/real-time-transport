import type { ArrivalRow, DataProvenance } from '@real-time-transport/shared'
import { listProvenanceOf } from '@real-time-transport/shared'

/**
 * F4 on an overview card's arrival feed.
 *
 * A card shows one feed per direction, and ONE feed can carry rows of different
 * kinds: the payload sent a real vehicle's own minute and this app computed the
 * next one. `listProvenanceOf` answers `null` for such a list — one word would be
 * false about part of it — so a card that rendered only the list mark would show
 * nothing at all, and a live minute would read exactly like a computed one
 * (Step 2: 同一列表里不同来源必须能区分).
 *
 * These two functions are the same fallback the station popover uses: the list
 * mark when every classified row agrees, otherwise each row's own. They return
 * KINDS; the wording stays in `@/provenance-copy`, so no second vocabulary for
 * provenance exists anywhere in the app.
 */

/**
 * The one kind this feed can state with a word, or `null` when it cannot — the
 * classified rows disagree, or none of them stated anything.
 */
export function cardListProvenanceOf(rows: readonly ArrivalRow[]): DataProvenance | null {
  return listProvenanceOf(rows)
}

/**
 * The kind one row of the list shows.
 *
 * When the whole feed agrees, that one word rides on the LEADING row (index 0),
 * where it is already stated once — repeating it down the 后续 sub-list would
 * crowd out the minutes it exists to explain. It rides there only when that row
 * stated its own kind AND stated a number: `listProvenanceOf` ignores an
 * unstated row when it decides, so without the first condition the word would be
 * lent to the one row that said nothing about its number, and without the second
 * it would be parked on an at-platform OBSERVATION (「正在进站」), which the card
 * renders no mark for — the word would then reach the screen nowhere while the
 * numbered rows below it went unexplained. Whenever the leading row cannot carry
 * it — it stated nothing, the feed mixes kinds, or it is an observation — every
 * row falls back to its own kind, and a row that stated none gets `null`, never
 * the flattering answer.
 */
export function cardRowProvenanceOf(
  rows: readonly ArrivalRow[],
  index: number,
): DataProvenance | null {
  const list = cardListProvenanceOf(rows)
  const lead = rows[0]
  if (list && lead?.provenance && !lead.isAtStation) return index === 0 ? list : null
  return rows[index]?.provenance ?? null
}
