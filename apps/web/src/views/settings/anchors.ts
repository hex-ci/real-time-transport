/**
 * 家 / 公司 as `GET /api/transit/settings` answers them.
 *
 * One reading of that row, in one place, because 设置 now has two screens that read it:
 * the 位置锚点 page (which shows and re-grabs them) and the INDEX row (which states
 * whether each one is set). A second parse of the same answer is a second chance to
 * disagree about what 「未设置」 means, and the index row is exactly where that would show
 * up as a lie about the stored row.
 *
 * The WRITE side is deliberately not here: the wire field names a PATCH carries stay in
 * `components/anchor-picker.vue` beside the `ANCHORS` table that builds the body.
 */

/** The four stored coordinates, exactly as `GET /settings` answers them. */
export interface StoredAnchors {
  homeLat: number | null
  homeLng: number | null
  workLat: number | null
  workLng: number | null
}

/** The anchors the app stores, as F1's reference line names them. */
export type AnchorId = 'home' | 'work'

/** A coordinate as the server holds it, or null. Never coerced to 0. */
export function coord(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The four anchors out of a `/settings` answer, with null for anything unset. */
export function pickAnchors(data: Record<string, unknown> | null | undefined): StoredAnchors {
  return {
    homeLat: coord(data?.homeLat),
    homeLng: coord(data?.homeLng),
    workLat: coord(data?.workLat),
    workLng: coord(data?.workLng),
  }
}

/** Whether an anchor has a stored position. Both axes, or it is not set. */
export function isAnchorSet(stored: StoredAnchors, id: AnchorId): boolean {
  return id === 'home'
    ? stored.homeLat !== null && stored.homeLng !== null
    : stored.workLat !== null && stored.workLng !== null
}
