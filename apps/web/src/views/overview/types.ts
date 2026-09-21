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
  isExact: boolean
  arrivals: Array<{
    time: string
    etaSeconds: number
    stopsAway?: number
    distanceMeters?: number
    isAtStation?: boolean
  }>
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
  /** Subway routes get the amber accent, buses cyan — same rule as KioskView. */
  isSubway: boolean
  /** Commute modes carry exactly one row; nearby carries one per available direction. */
  rows: CardRow[]
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
