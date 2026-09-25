import type { CatchDecision } from './schemas/gis.js'

/**
 * F1's departure conclusion — 「打开即结论」.
 *
 * The reference row answers one question: the anchor the user is standing at is
 * a real walk from the platform, and the platform's buses are real minutes — so
 * does leaving now catch the next one, or how long can they wait?
 *
 *   walk = 锚点 → 站台真实步行耗时（服务端已缓存）
 *   T    = 站台等待容忍值（默认 3 分钟，同时是安全边际）
 *   eta₁ = 最近一班到站分钟
 *     eta₁ - walk ≤ T  → 现在就走
 *     否则             → (eta₁ - walk - T) 分钟后出门
 *     错过代价         = eta₂ - eta₁
 *
 * Pure, so the two boundaries that carry real risk — the tolerance itself and
 * the point where this bus stops being catchable — are decided here, once, and
 * covered by tests instead of by reading the UI. The server resolves the anchor
 * and prices the walk; the web app renders the verdict. Neither side computes
 * the conclusion on its own.
 *
 * Zero fabrication: every input is real upstream data or a named, documented
 * tolerance, and the conclusion is withheld (null) rather than guessed. There
 * is no walking speed, no assumed distance and no defaulted ETA anywhere in
 * this file.
 */

/**
 * T, the wait the user tolerates at the platform, in minutes.
 *
 * It is also the safety margin: leaving T minutes before the bus arrives absorbs
 * 「车早到」 and whatever happens on the way. A named default rather than a
 * settings column — F1 says it must be configurable, and it is (every entry
 * point takes the tolerance as an argument), but storing it needs a migration
 * this task deliberately does not write.
 */
export const DEFAULT_WAIT_TOLERANCE_MINUTES = 3

/**
 * How old a live reading may be and still support a conclusion, in seconds.
 *
 * The server polls at 18 s and the aggregator caches a reading for the same 18 s,
 * so a fresh answer is always under ~40 s old; 120 s is six missed polls, i.e.
 * an outage rather than jitter. Beyond it the reference row is withheld: saying
 * 「现在就走」 from a stale number is worse than saying nothing (F1 边界).
 */
export const STALE_ARRIVAL_SECONDS = 120

/**
 * The three verdicts F1 reuses from the catch-the-bus vocabulary — `CatchDecision`
 * minus its `unknown`, which is a statement about the data, not about the
 * departure. `comfortable` = there is time to spare, `hurry` = leave now or lose
 * it, `missed` = this one is gone.
 */
export type DepartureState = Exclude<CatchDecision, 'unknown'>

/**
 * How much the arrival numbers can be trusted.
 *
 * Only `ok` supports a conclusion: F1 withholds the verdict on stale or degraded
 * data, because a confident 「现在就走」 built on an old reading is exactly the
 * failure mode this row would introduce.
 */
export type DepartureTrust = 'ok' | 'stale' | 'degraded'

/** The two saved positions, as F2 names them. */
export type AnchorLeg = 'home' | 'work'

/** The stored commute windows that decide which anchor means 「where you are」. */
export interface CommuteHours {
  morningStart: string
  morningEnd: string
  eveningStart: string
  eveningEnd: string
}

export interface DepartureAdviceInput {
  /**
   * Real walking time anchor → platform, SECONDS, as the path service measured
   * it. `null` when no walking route was priced — there is then no conclusion,
   * because the walk IS the comparison.
   */
  walkSeconds: number | null
  /**
   * Seconds until the next vehicle reaches this platform; `0` means it is at the
   * platform now (which is a missed bus for anyone still at the anchor).
   * `null` when no vehicle is on its way.
   */
  nextArrivalSeconds: number | null
  /**
   * Seconds until the vehicle after that, for 错过代价. Optional: with no
   * second bus the verdict still stands, only the cost is unknown.
   */
  followingArrivalSeconds?: number | null
  /** T. Defaults to {@link DEFAULT_WAIT_TOLERANCE_MINUTES}. */
  waitToleranceMinutes?: number
  /** Freshness of the arrival numbers. Defaults to `ok`. */
  trust?: DepartureTrust
}

/**
 * What every verdict carries, whatever the departure answer is.
 */
export interface DepartureAdviceFields {
  /** The walking minutes the row shows (「步行 6 分」). */
  walkMinutes: number
  /** The next arrival in minutes, as the arrivals list shows it. */
  nextArrivalMinutes: number
  /** eta₂ - eta₁: what missing this vehicle costs, or `null` when eta₂ is unknown. */
  missCostMinutes: number | null
}

/**
 * The verdict, with the fields each one actually carries.
 *
 * `leaveInMinutes` is deliberately a per-verdict field rather than one nullable
 * number: `comfortable` always has a departure time and `missed` never does, so
 * a row cannot render 「null 分钟后出门」 — a missing value dressed as an answer,
 * which is the one thing this feature may not do.
 *
 * - `comfortable` — more slack than the user tolerates at the platform: they may wait.
 * - `hurry`       — the slack is inside the tolerance: leave now or lose it.
 * - `missed`      — the bus arrives before the walk is done; no departure to give.
 */
export type DepartureAdvice
  = | (DepartureAdviceFields & { state: 'comfortable', leaveInMinutes: number })
    | (DepartureAdviceFields & { state: 'hurry', leaveInMinutes: 0 })
    | (DepartureAdviceFields & { state: 'missed', leaveInMinutes: null })

/**
 * What the server resolved for one platform, or `null`.
 *
 * F1 gives no reference row for a platform whose walking time, arrivals or
 * anchor is missing, and three answers are deliberately NOT collapsed into one:
 *
 * - `advice`        — a real walk and a real bus: the verdict.
 * - `anchor-unset`  — this leg's anchor was never saved, so the row points at
 *                     the settings screen. Distinct from a missing walk: it is a
 *                     statement about the stored row, and claiming it when the
 *                     walk merely failed would be a lie about the user's data.
 * - `null`          — no anchor means 「where you are」 (outside both commute
 *                     windows), no walking route, no vehicle to walk to, or
 *                     stale/degraded arrivals. The row is absent, never dressed
 *                     up as 「不用着急」.
 */
export type DepartureReference
  = | { status: 'advice', anchor: AnchorLeg, advice: DepartureAdvice }
    | { status: 'anchor-unset', anchor: AnchorLeg }

/**
 * Whole minutes of walking, floored at 1.
 *
 * A 20-second walk is still a walk; rendering it as 「步行 0 分」 would read as
 * no walk at all, and the floor errs on the safe side of the comparison.
 */
export function walkingMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60))
}

/**
 * Whole minutes until a vehicle arrives — the same rule the arrival list uses,
 * so the verdict is drawn from the numbers the user actually reads. `0` means it
 * is pulling in now, and 30 s reads as 1 minute (never as 0).
 */
export function arrivalMinutes(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60))
}

/**
 * The minute one ARRIVAL ROW states, or `null` when the row states none.
 *
 * `ArrivalRowSchema` makes `etaSeconds` OPTIONAL, and that absence is data rather
 * than a gap to fill: a targeted reading that published no arrival time for a
 * vehicle yields a row with no minute, because this app no longer extrapolates one
 * from the vehicle's snapshot speed and a nominal per-stop dwell (see
 * `apps/server/src/services/transit.service.ts`). Every surface that lists
 * arrivals therefore has to render the absence for such a row, and this is the ONE
 * place that decides which of the two it is — `Math.round(undefined / 60)` painted
 * beside 「分」 is the same lie as the estimate that was removed, one layer out.
 *
 * `isAtStation` is answered FIRST and as `0`: the server prices that state with
 * `etaSeconds: 0` (upstream's own statement that the vehicle is here), and reading
 * it as 「no minute」 would hide a vehicle standing at the platform.
 *
 * A non-finite or negative duration is not a duration — it answers `null` rather
 * than becoming 「NaN分」 or 「-1分」, i.e. a number nobody stated.
 */
export function statedArrivalMinutes(
  row: { etaSeconds?: number | null, isAtStation?: boolean },
): number | null {
  if (row.isAtStation) return 0
  if (typeof row.etaSeconds !== 'number' || !Number.isFinite(row.etaSeconds) || row.etaSeconds < 0) {
    return null
  }
  return arrivalMinutes(row.etaSeconds)
}

/**
 * The departure conclusion, or `null` when the data cannot honestly support one.
 *
 * The comparison runs on the ROUNDED minutes the row shows, so the verdict and
 * the numbers beside it can never disagree (a raw-seconds comparison against
 * displayed minutes is a one-minute lie waiting to happen at the tolerance).
 */
export function departureAdvice(input: DepartureAdviceInput): DepartureAdvice | null {
  if ((input.trust ?? 'ok') !== 'ok') return null
  if (input.walkSeconds === null || input.nextArrivalSeconds === null) return null

  const walkMinutes = walkingMinutes(input.walkSeconds)
  const nextArrivalMinutes = arrivalMinutes(input.nextArrivalSeconds)
  const tolerance = input.waitToleranceMinutes ?? DEFAULT_WAIT_TOLERANCE_MINUTES

  const following = input.followingArrivalSeconds
  const missCostMinutes = typeof following === 'number'
    ? arrivalMinutes(following) - nextArrivalMinutes
    : null

  const slack = nextArrivalMinutes - walkMinutes

  // The bus arrives before the walk is done: this one is gone.
  if (slack < 0) {
    return { state: 'missed', walkMinutes, nextArrivalMinutes, leaveInMinutes: null, missCostMinutes }
  }
  // eta₁ - walk ≤ T: leave now. The boundary is inclusive — at exactly T the
  // user is still inside their own tolerance, so 现在就走 is the truthful answer.
  if (slack <= tolerance) {
    return { state: 'hurry', walkMinutes, nextArrivalMinutes, leaveInMinutes: 0, missCostMinutes }
  }
  // More slack than the user tolerates at the platform: they may wait.
  return {
    state: 'comfortable',
    walkMinutes,
    nextArrivalMinutes,
    leaveInMinutes: slack - tolerance,
    missCostMinutes,
  }
}

/**
 * Which saved anchor means 「where you are」 at `hhmm` (local `HH:MM`).
 *
 * Morning → the user leaves 家; evening → 公司. Outside both windows there is no
 * anchor that means the user's position, and F1's answer is to draw no
 * conclusion rather than pick one: a reference row built from a guess about
 * where the user is would be worse than an absent one.
 *
 * Endpoints are inclusive, matching the window rule the commute profile already
 * applies, so the mode the card shows and the anchor this row prices cannot
 * disagree at 06:30 or 11:30.
 */
export function anchorLegAt(hhmm: string, hours: CommuteHours): AnchorLeg | null {
  if (hhmm >= hours.morningStart && hhmm <= hours.morningEnd) return 'home'
  if (hhmm >= hours.eveningStart && hhmm <= hours.eveningEnd) return 'work'
  return null
}

/**
 * Trust of an arrival reading, from how it was produced and how old it is.
 *
 * `isDegraded` is the aggregator's mark that a fallback source answered; both it
 * and an over-age reading suppress the conclusion. Pure so the rule itself is
 * covered by tests, not only by the branch that happens to call it.
 */
export function arrivalTrust(params: {
  isDegraded?: boolean
  updatedAt: number
  /** Injectable clock, so the age boundary is testable. */
  now?: number
}): DepartureTrust {
  if (params.isDegraded) return 'degraded'
  const ageMs = (params.now ?? Date.now()) - params.updatedAt
  return ageMs > STALE_ARRIVAL_SECONDS * 1000 ? 'stale' : 'ok'
}
