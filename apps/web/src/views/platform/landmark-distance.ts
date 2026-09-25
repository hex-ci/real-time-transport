/**
 * The distance the GPS radar stated to a platform, as the landmark hint renders it.
 *
 * Amap states this in metres for a POI it measured, and leaves the field out for
 * one it did not — the reading rule itself lives once, in `statedNumber`
 * (`@real-time-transport/shared/geo`). What is decided HERE is only how the one
 * surface that prints the number words each of the two answers: a stated distance
 * as itself, and an absent one as nothing at all.
 */
export function statedDistanceSuffix(meters: number | undefined): string {
  // Absence renders as nothing: `Math.round(undefined)` is NaN, and a substituted
  // 0 would claim the user is standing on the platform. A non-finite value is the
  // same absence — it measures nothing — while a stated 0 IS a measurement.
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return ''
  return `（${Math.round(meters)}m）`
}
