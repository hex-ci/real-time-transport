import type { DataProvenance } from '@real-time-transport/shared'

/** A followed line/direction that passes the selected platform. */
export interface PlatformLineRule {
  lineId: string
  lineName: string
  direction: number
  terminal: string
  stationOrder: number
  /**
   * F3: the line's operating fact, derived from this line's own first/last
   * departure (carried by the detail row the rule was built from). Shown when
   * upstream reports no vehicle with an ETA, so 「已过末班」 is never answered
   * with the generic 「暂无来车」. The board's crowding chip is the verdict
   * chip, so this fact is stated where the numbers are, not repeated on it.
   */
  operatingText: string
}

/** One departure row on the platform board. */
export interface DepartureItem {
  id: string
  lineName: string
  terminal: string
  etaMinutes: number | null
  stopsAway: number | null
  congestion: string
  /**
   * The request behind this row failed: neither a vehicle nor the service day is
   * known. A named state rather than a display word, so the row's wording branches
   * on what is true rather than on a string meant for a human, and the chip can
   * never echo a failure the numbers column already states.
   */
  unavailable: boolean
  /** F3: what this row states when it has no arrival minutes to show. */
  operatingText: string | null
  /**
   * F4: the kind of number `etaMinutes` is, stated per row because one board mixes
   * lines and therefore sources. Null when the row has no minute, or when the
   * source behind it is one this build does not know — either way the row renders
   * no mark rather than the flattering one.
   */
  provenance: DataProvenance | null
}
