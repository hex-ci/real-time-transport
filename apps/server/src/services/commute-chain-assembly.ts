import type {
  ArrivalBasis,
  ChainLegLive,
  ChainLegVehicle,
  LiveLineStatus,
  OperatingStatus,
} from '@real-time-transport/shared'

/**
 * F10's server half, the pure part: two targeted readings turned into the ONE
 * reading the engine takes.
 *
 * The adapter answers for ONE requested target station per read — chelaile
 * matches a vehicle's `travels` by the order the request named — so one vehicle's
 * board minute and alight minute can only ever come from two reads, each returned
 * in its own arrival order. Everything that can go wrong between the two is
 * decided here, and it is decided by the provider's stable vehicle id
 * (`LiveBusSchema.id`) and by nothing else.
 *
 * Nothing in this file reads a clock, a socket or a distance: the two readings
 * and the matching are the whole input, which is what makes 「which vehicle did
 * this chain board, and how long is its ride」 testable without an upstream.
 */

/** One vehicle's arrival at ONE targeted station, as the live path priced it. */
export interface TargetedArrival {
  /** `LiveBusSchema.id` — the vehicle itself. */
  vehicleId: string
  /** Seconds until THIS vehicle reaches the station the read targeted. */
  etaSeconds: number
  /** How this minute was produced (F4's basis, before the mark is applied). */
  basis: ArrivalBasis
}

/**
 * A targeted row reaches this type only when it STATES a minute.
 *
 * `vehicleArrivals` serves a row with no `time`/`etaSeconds`/`basis` when the
 * targeted reading published no arrival time for that vehicle (this app no longer
 * extrapolates one), and such a row is filtered out before pairing rather than
 * carrying an absent minute through this contract: a ride duration needs BOTH ends'
 * minutes, so a half-priced pair would have to invent the missing one. It is the
 * caller (`readChainLeg`) that filters, and it still counts that vehicle as one on
 * the way.
 */

/**
 * Pair a leg's two targeted reads into the vehicles the deduction can use.
 *
 * The match is by vehicle id, NEVER by position: the two reads are ordered by
 * their own arrival minutes, so a board read's first row is routinely a different
 * vehicle than the alight read's first row, and pairing the nth with the nth would
 * put one vehicle's alight minute beside another vehicle's board minute — a ride
 * duration about no journey anyone takes.
 *
 * A vehicle only one read carries is dropped, and it must be: it has no pair, so
 * offering it would mean inventing the missing half. Within ONE snapshot of the
 * upstream that is always the vehicle only the ALIGHT read carries — one already
 * past the board station but not yet past the alight one, so it has no board
 * minute to give (upstream returns a vehicle for a requested order iff it has not
 * passed it, and that filter is monotone, which makes the board read's rows a
 * subset of the alight read's — FOR A LEG WHOSE ALIGHT STOP IS FURTHER ALONG IN THE
 * DIRECTION IT IS READ). A subway leg stored the other way round is read in the
 * opposite direction with both orders translated into its numbering
 * (`transit.service.ts`, `chainLegInput`), so it too arrives here with alight >
 * board in the numbering the two reads used. A board row the alight read lacks is
 * NOT something that upstream produces; the `continue` below is kept as a defence,
 * not as a case the caller is expected to hit.
 *
 * The nesting is a precondition, not a property of any input: a BUS leg whose
 * alight order is upstream of its board order INVERTS it (the alight read becomes
 * the subset), which is why the deduction refuses such a leg as
 * `leg-recorded-backwards` before the empty-pair check that consults this pairing,
 * and the schema rejects it on write. Nothing here may assume the relation
 * without it.
 */
export function pairTargetedReads(
  board: readonly TargetedArrival[],
  alight: readonly TargetedArrival[],
): ChainLegVehicle[] {
  const alightById = new Map(alight.map(row => [row.vehicleId, row]))

  const vehicles: ChainLegVehicle[] = []
  for (const row of board) {
    const other = alightById.get(row.vehicleId)
    if (!other) continue
    vehicles.push({
      vehicleId: row.vehicleId,
      arrivalAtBoardSeconds: row.etaSeconds,
      arrivalAtAlightSeconds: other.etaSeconds,
      // The pair is one vehicle, but the mark the row shows qualifies the ALIGHT
      // minute (`ChainLegVehicle.basis`), so it is that read's basis which
      // travels: a board minute the payload carried beside an alight minute this
      // app computed is 位置推算, not 实时.
      basis: other.basis,
    })
  }
  return vehicles
}

/**
 * The leg's reading, from the two reads that produced it — or nothing.
 *
 * One leg has ONE reading, so it declares one source, one instant, one degraded
 * mark and one service state. Each of the first three is derived so that it
 * cannot flatter the pair:
 *
 *  - a source only when BOTH reads named the same one. A board minute from one
 *    source beside an alight minute from another is not one reading, and naming
 *    either would claim a provenance the pair does not have; the engine then
 *    reports `provenance-unknown`, which is the honest answer for a pair nothing
 *    vouches for.
 *  - the OLDER instant of the two, because freshness is judged once for the leg
 *    and the newer instant would state an age that half the pair does not have.
 *  - degraded when EITHER read fell back, because the reading is only as good as
 *    its weaker half.
 *
 * `operatingStatus` is not derived from either read: it is F3's state for the
 * line the leg is about, which the caller derives once from the line detail it
 * already resolved (`operatingStatusOf`) and passes in. The DERIVATION is shared
 * with the station board — one function, one vocabulary — but the INPUTS are NOT,
 * and the two can therefore disagree about one line:
 *
 *  - this leg's state is the LINE's own service hours, the `firstBusTime` /
 *    `lastBusTime` carried by the line detail (`transit.service.ts`,
 *    `readChainLeg`);
 *  - the board's exact-timetable branch states the STATION's own official table,
 *    the `exact.first` / `exact.last` of the platform the request named
 *    (`transit.service.ts`, `getStationArrivals`), because that is the table its
 *    departures are listed from.
 *
 * For the one station this repo ships a published table for, the two
 * values differ, so there is a real window in which the chain and the board state
 * two different service states for one line. The chain states the LINE's hours
 * rather than a station's; it is not a second status model and must not be read as
 * one. It belongs to the leg's one reading because that is where every other fact
 * about this leg travels, and an empty answer needs it: 首班前 / 已过末班 and
 * 运营中·暂无来车 are not one sentence.
 */
export function legLiveReading(params: {
  board: LiveLineStatus | null
  alight: LiveLineStatus | null
  vehicles: readonly ChainLegVehicle[]
  /**
   * How many vehicles the BOARD read carried, before the id match — every row
   * still to reach the board order, whether or not the reading published an
   * arrival time for it, and NOT the alight read's rows. A fact of the reading,
   * not of the pair: it is what lets the engine answer `no-shared-vehicle` (the
   * read carried vehicles, the match kept none) instead of `no-vehicle` (the read
   * carried nothing at all). A vehicle we could not price counts, because it IS on
   * its way — claiming an empty service for it would be a different lie.
   */
  boardVehiclesOnTheWay: number
  /** F3's state for the leg's line, derived by the caller from the leg's own line. */
  operatingStatus: OperatingStatus
}): ChainLegLive | null {
  const { board, alight } = params
  // Half a pair is not a reading: with either read missing there is no board
  // minute and no alight minute to compare, and reporting the half that answered
  // would claim a reading the leg does not have.
  if (!board || !alight) return null

  return {
    dataSource: board.dataSource === alight.dataSource ? board.dataSource : null,
    updatedAt: Math.min(board.updatedAt, alight.updatedAt),
    isDegraded: board.isDegraded || alight.isDegraded,
    vehicles: params.vehicles,
    boardVehiclesOnTheWay: params.boardVehiclesOnTheWay,
    operatingStatus: params.operatingStatus,
  }
}
