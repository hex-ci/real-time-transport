/**
 * F-E: the seconds this page estimates for itself while the arrivals answer is
 * in flight — the SERVER's own subway model, not a second opinion.
 *
 * `TransitService.vehicleArrivals` prices a targeted row from the payload's own
 * `travelTimeSec` when it carries one, from the subway engine's 135 s/station
 * model for a subway line, and otherwise states NO minute at all. The
 * position/dwell estimate that used to live on BOTH sides (a real position, a
 * real speed, a nominal per-stop dwell) is gone from the server — its error had
 * no fixed sign, ~12 minutes mean and 28 minutes worst — and the copy here had to
 * go with it: a pending answer that priced a bus minute would state exactly the
 * number the arrivals answer no longer states, and the two surfaces would
 * contradict each other for the same vehicle in the same instant. With no minute
 * to state, the page states the same absence the row does (`@/arrival-copy`).
 *
 * What remains is the ONE model both sides still share, and it is shared exactly:
 * a subway minute is the engine's arithmetic on this side too. The minutes
 * happened to round the same, which is precisely how a divergence survives review —
 * the client once lacked the server's `Math.max(30, …)` floor under the estimated
 * seconds, so the two stated different numbers for the same vehicle and only the
 * rounding hid it. One formula, floored, and the page keeps the server's own
 * 1-minute display minimum on top.
 *
 * Nothing here reads a clock: `progress` and `stopsAway` come from the live
 * board, so the two sides cannot drift on where the vehicle is either.
 */

/** The floor under any estimated arrival: the server's own, never a smaller one. */
export const ARRIVAL_ESTIMATE_FLOOR_SECONDS = 30

/** Seconds the subway model assumes per inter-station run (the server's 135 s). */
export const SUBWAY_STATION_RUN_SECONDS = 135

/** The subway model's estimate: full hops remaining, less the progress made on this one. */
export function estimateSubwayArrivalSeconds(stopsAway: number, progress: number): number {
  return Math.max(
    ARRIVAL_ESTIMATE_FLOOR_SECONDS,
    Math.round((stopsAway - progress) * SUBWAY_STATION_RUN_SECONDS),
  )
}
