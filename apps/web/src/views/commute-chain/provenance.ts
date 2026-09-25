import { provenanceLabelOf } from '@/provenance-copy'
import { refreshFreshnessOf } from '@/stores/transit.store'
import type { DataProvenance } from '@real-time-transport/shared'
import type { ChainReadingView } from './types'

/**
 * F4 on the chain page: one mark for the chain, or one per leg.
 *
 * A chain's answer is never one number from one source. Each leg's alight minute
 * belongs to its own vehicle, so a bus leg can be 实时 while a subway leg is
 * 排班推演 — and the engine already decided that per leg (`listProvenanceOf`), the
 * same way a card's arrival list does. Where the kinds agree the chain states that
 * ONE word and no leg repeats it; where they disagree the engine answers null for
 * the chain, because one word would then be false about part of it, and every leg
 * states its own.
 *
 * That fallback is the whole point: a leg's minute may never borrow the chain's
 * word for a number some other leg produced, and a kind nobody classified is
 * stated as no mark rather than rounded up to the flattering one. The KINDS come
 * from `@real-time-transport/shared`, the WORDS from `@/provenance-copy`, and the
 * instant from the store's own freshness line — so this page owns no second
 * provenance vocabulary and no second clock.
 */

/** The mark one leg's row states: its own kind, or nothing when the chain is
 * already saying the one word.
 *
 * It takes the KIND rather than the leg, because that is all the decision needs
 * and the row's own model already carries it — a leg's minute may no more borrow
 * the chain's word through this function than through the component that calls it.
 */
export function legMarkOf(
  provenance: DataProvenance,
  chainProvenance: DataProvenance | null,
): string | null {
  if (chainProvenance !== null) return null
  return provenanceLabelOf(provenance)
}

/**
 * The reading line: when the reading behind this answer was obtained, and the kind
 * of number the answer is.
 *
 * The instant is worded by F11's own freshness line (`refreshFreshnessOf`), so the
 * chain page and the refresh control cannot print one instant two ways. The KIND is
 * not that function's answer: it derives the kind from a line's `dataSource`, while
 * a chain's mark is the engine's own per-leg kinds. And a reading that was never
 * obtained has no line at all — the clock is not a reading, and stamping one would
 * dress an empty answer as a fresh one.
 */
export function chainReadingOf(params: {
  /** The engine's `lastUpdatedAt`, or a refusal's `updatedAt` when it was read. */
  lastUpdatedAt: number | null
  /** The engine's own chain-level provenance — null when the legs disagree. */
  provenance: DataProvenance | null | undefined
}): ChainReadingView | null {
  if (params.lastUpdatedAt === null) return null

  const freshness = refreshFreshnessOf({ at: params.lastUpdatedAt, dataSource: null, isDegraded: null })
  if (freshness.time === null) return null

  const mark = provenanceLabelOf(params.provenance)
  return {
    time: freshness.time,
    mark,
    text: `最后更新 ${freshness.time}${mark ? ` · ${mark}` : ''}`,
  }
}
