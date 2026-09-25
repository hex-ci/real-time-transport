import type { ArrivalRow, DepartureReference, OperatingStatus } from '@real-time-transport/shared'
import type { CommuteLegState } from './commute-leg'

/** One direction row on an overview card: its own lineId, direction, and stop order. */
export interface CardRow {
  lineId: string
  direction: 0 | 1
  /** This direction's order for the displayed stop; null when it has no such stop. */
  stopOrder: number | null
  /** Destination-board label (「开往 X」), so the row is identifiable and a11y-named. */
  directionName: string
}

/** Arrival feed shape returned by the station-arrivals endpoint. */
export interface ArrivalsFeed {
  /**
   * The arrivals, each carrying its own F4 provenance. The card's mark is derived
   * from these rows (`listProvenanceOf`), never from a response-level flag: a
   * response can mix a vehicle whose minute the payload carried with one this app
   * computed.
   */
  arrivals: ArrivalRow[]
  /**
   * F3: whether the line is running right now.
   *
   * Decided server-side from the line's own first/last departure, so the card
   * does not read a clock of its own. An empty `arrivals` array is NOT this
   * fact: 首班前, 已过末班 and 运营中-but-nothing-in-range are different answers,
   * and the card renders this one whenever it has no minutes to show.
   */
  operatingStatus: OperatingStatus
  /**
   * F1's reference row for this platform: the walking time from the anchor the
   * user is at, and the departure conclusion drawn from the SAME arrivals above.
   *
   * Resolved server-side (the anchor never travels through the browser, where a
   * second coordinate conversion would move it ~520 m) and null whenever no
   * honest conclusion exists.
   */
  reference: DepartureReference | null
  /**
   * F-C: the registered timetable's own caveat for this platform, verbatim (e.g.
   * a last departure that only runs half the route), or null when the answering
   * path holds none. Carried for the surfaces that show this platform's
   * departures; this card shows the next few minutes and renders nothing of it.
   */
  note?: string | null
}

/**
 * One direction row as the card receives it: the base row plus its arrivals,
 * merged in by the card grid from the arrivals map.
 */
export interface CardRowWithArrivals extends CardRow {
  arrivals: ArrivalsFeed | null
}

/** Everything one followed line needs to render as an overview card. */
export interface MiniCardConfig {
  lineName: string
  /** Label of the direction the card leads with, from the loaded detail. */
  directionName: string
  /** The stop the card reports on: a board stop (commute) or the located platform. */
  stopName: string | null
  /** GPS distance to that stop, metres — nearby mode only. */
  stopDistanceMeters: number | null
  detailLoaded: boolean
  /** Subway routes get the amber accent, buses cyan — the shared route-type rule. */
  isSubway: boolean
  /**
   * This route is the pinned one. The pin is a state overlaid on the list order,
   * so the overview marks the card instead of lifting it out of the list.
   */
  isPinned: boolean
  /** Commute modes carry exactly one row; nearby carries one per available direction. */
  rows: CardRow[]
  /**
   * What the card may say about this commute leg, established by the caller from
   * the favourite's own fields — its board stop and the direction the user chose
   * — or null for the nearby view, which has no commute leg, and while the chosen
   * direction's stop list has not loaded.
   *
   * Established here rather than in the card: every unreadable leg carries no row
   * either, so the card may not read a state off the absence of a row.
   */
  legState: CommuteLegState | null
  /** Which direction leads on a two-row card; null lets the card fall back to dir0. */
  primaryDirection: 0 | 1 | null
  /**
   * Where tapping the card goes: a route is viewable regardless of whether the
   * user has configured a commute leg for it, so this is resolved from the
   * favourite and never from `rows` (which is legitimately empty while a
   * direction is unchosen or its detail has not loaded).
   */
  detailLineId: string
  detailDirection: 0 | 1
  /** Favourite this card belongs to, so a direction pick can be stored against it. */
  favoriteId: string | null
}

/** What the overview is currently showing, driven by commute hours or a manual pick. */
export type OverviewMode = 'morning' | 'evening' | 'nearby'
