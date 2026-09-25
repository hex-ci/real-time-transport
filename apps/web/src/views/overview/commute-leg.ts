import { stopServedByDirection } from '@real-time-transport/shared/line-group'

/**
 * Which commute leg a board stop and a direction belong to.
 *
 * The two legs are stored independently: `morning` is the AM departure and
 * `evening` the PM one.
 */
export type CommutePurpose = 'morning' | 'evening'

/**
 * The facts one commute leg is read from, all of them the favourite's own.
 *
 * None of the three may be replaced by "no row came back": an absent row is what
 * every state below looks like from the card.
 */
export interface CommuteLegFacts {
  /**
   * The direction this leg rides, from `morningDirection` / `eveningDirection` —
   * via `effectiveCommuteDirection`, which resolves a route that has only one
   * direction. Null while the user has never chosen one.
   */
  direction: 0 | 1 | null
  /** The leg's boarding stop, from `morningStopName` / `eveningStopName`. */
  stopName: string | null
  /**
   * The chosen direction's own stop list, or undefined while that direction's
   * detail has not loaded. An EMPTY list is a third fact, not the same as an
   * absent stop: the direction answered with no stops at all, so nothing about
   * that stop can be read here.
   */
  stops: Array<{ name: string }> | undefined
}

/**
 * The states a commute leg can be in, as the home card has to state them.
 *
 * Every one is a fact about what the user configured, and each has a different
 * thing to say — which is why the words live with the state rather than with the
 * card's row count.
 */
export type CommuteLegState
  /** Neither the direction nor the board stop has been chosen for this leg. */
  = | 'leg-unset'
  /** A board stop is set for this leg, but no direction — so no stop can be read. */
    | 'direction-unset'
  /** The direction is chosen, but the leg has no board stop. */
    | 'stop-unset'
  /** Direction and stop are both set, and that direction calls at no stop at all. */
    | 'stops-unavailable'
  /** Direction and stop are both set, and that direction does not call at the stop. */
    | 'stop-unserved'
  /** Both are set and the stop is on this direction: the leg can be read. */
    | 'ready'

/**
 * Which state this leg is in, or null while it cannot be established — the
 * direction's stop list has not loaded, so neither the stop nor the direction can
 * be judged against it.
 *
 * The order is the settings screen's own: a direction is chosen before a stop
 * (a stop's number, and whether the direction even calls there, depends on the
 * direction), so a leg missing both reports the direction as the thing to pick.
 */
export function commuteLegStateOf(facts: CommuteLegFacts): CommuteLegState | null {
  if (facts.direction === null) {
    return facts.stopName ? 'direction-unset' : 'leg-unset'
  }
  if (!facts.stopName) return 'stop-unset'
  // Not loaded: the card is still loading, and a mismatch cannot be claimed from
  // a list nobody has read.
  if (!facts.stops) return null
  if (facts.stops.length === 0) return 'stops-unavailable'
  return stopServedByDirection({ stops: facts.stops }, facts.stopName) ? 'ready' : 'stop-unserved'
}

/**
 * The state, as the line the card shows — or null when there is nothing to say.
 *
 * `「设置」` is named because that screen owns both of these fields; no state
 * promises a control the app does not have. The one notice without it is a
 * direction with no stop data at all, which no setting on any screen supplies.
 */
export function commuteLegNoticeOf(
  state: CommuteLegState | null,
  purpose: CommutePurpose,
): string | null {
  if (state === null || state === 'ready') return null

  const leg = purpose === 'morning' ? '上班' : '下班'
  if (state === 'leg-unset') return `未设置${leg}方向和上车点 · 在「设置」中设置`
  if (state === 'direction-unset') return `未设置${leg}方向 · 在「设置」中设置`
  if (state === 'stop-unset') return `未设置${leg}上车点 · 在「设置」中设置`
  if (state === 'stops-unavailable') return '本方向暂无站点数据，无法显示到站时间'
  return `${leg}上车点不在本方向停靠 · 在「设置」中重选`
}
