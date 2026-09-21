/** A followed line/direction that passes the selected platform. */
export interface PlatformLineRule {
  lineId: string
  lineName: string
  direction: number
  terminal: string
  stationOrder: number
}

/** One departure row on the platform board. */
export interface DepartureItem {
  id: string
  lineName: string
  terminal: string
  etaMinutes: number | null
  stopsAway: number | null
  congestion: string
  statusText: string
}
