import { describe, expect, it } from 'vitest'
import type { ArrivalBasis, LiveLineStatus, OperatingStatus } from '@real-time-transport/shared'
import { legLiveReading, pairTargetedReads } from '../services/commute-chain-assembly.js'

/**
 * F10's server half, the pure part: two targeted readings turned into the ONE
 * reading the deduction takes.
 *
 * The adapter answers for ONE requested target station per read — chelaile's
 * `travels` are matched by the order the request named — so a vehicle's board
 * minute and alight minute can only ever come from two reads, and the two reads
 * are each answered in their own arrival order. Everything that can go wrong
 * between them is decided here, and it is decided by the provider's stable
 * vehicle id and by nothing else.
 *
 * 101 / 甲路 / 乙路 are placeholders: no real route, station or vehicle id
 * appears in this file.
 */

const NOW = 1_700_000_000_000

/** The leg's F3 service state, as the assembly derived it from the line's hours. */
const STATE: OperatingStatus = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' }

/** One vehicle's arrival at ONE targeted station, as the live path priced it. */
function arrival(vehicleId: string, etaSeconds: number, basis: ArrivalBasis = 'upstream') {
  return { vehicleId, etaSeconds, basis }
}

/** One leg's targeted reading: the line's status, with no vehicles of interest. */
function reading(over: Partial<LiveLineStatus> = {}): LiveLineStatus {
  return {
    lineId: '101',
    direction: 0,
    buses: [],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: NOW,
    ...over,
  }
}

describe('F10 assembly: the two targeted reads are matched by vehicle id', () => {
  it('pairs each vehicle\'s board minute with its own alight minute, never by position', () => {
    // The two reads are ordered by their OWN arrival minutes, so the second
    // read's first row is a different vehicle than the first read's. Pairing the
    // nth with the nth would put one vehicle's alight minute beside another
    // vehicle's board minute — a ride duration about no journey anyone takes.
    const vehicles = pairTargetedReads(
      [arrival('A', 180), arrival('B', 480)],
      [arrival('B', 1200), arrival('A', 1500)],
    )

    expect(vehicles).toEqual([
      { vehicleId: 'A', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 1500, basis: 'upstream' },
      { vehicleId: 'B', arrivalAtBoardSeconds: 480, arrivalAtAlightSeconds: 1200, basis: 'upstream' },
    ])
  })

  it('drops a vehicle only one of the two reads carries', () => {
    // A vehicle past the board station appears in the alight read alone, and one
    // this build dropped from the alight read has no alight minute at all.
    // Neither carries a pair, so neither may be offered to the deduction.
    const vehicles = pairTargetedReads(
      [arrival('A', 180), arrival('B', 480)],
      [arrival('C', 900), arrival('B', 1200)],
    )

    expect(vehicles.map(v => v.vehicleId)).toEqual(['B'])
    expect(vehicles[0]?.arrivalAtBoardSeconds).toBe(480)
    expect(vehicles[0]?.arrivalAtAlightSeconds).toBe(1200)
  })

  it('pairs the strict superset upstream actually sends, id by id', () => {
    // The real shape, and the reason position-pairing is wrong: upstream returns
    // a vehicle iff it has NOT passed the requested order, and that filter is
    // monotone in the order — so the board read's rows are a SUBSET of the alight
    // read's, the alight read's first row is routinely a vehicle the board read
    // does not carry, and the extra row is the one already past the board station.
    const vehicles = pairTargetedReads(
      [arrival('v1', 180), arrival('v2', 480)],
      // The alight read is ordered by ITS OWN arrival minutes, so its first row
      // is a different vehicle than the board read's first row.
      [arrival('v3', 900), arrival('v1', 1500), arrival('v2', 1200)],
    )

    // v3 is past the board station and has no board minute: dropped, not invented.
    expect(vehicles.map(v => v.vehicleId)).toEqual(['v1', 'v2'])
    // Each pair's ALIGHT minute is the one from the alight read — never the board
    // read's row sitting at the same position.
    expect(vehicles[0]).toEqual({
      vehicleId: 'v1', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 1500, basis: 'upstream',
    })
    expect(vehicles[1]).toEqual({
      vehicleId: 'v2', arrivalAtBoardSeconds: 480, arrivalAtAlightSeconds: 1200, basis: 'upstream',
    })
  })

  it('carries no vehicle at all when the two reads share none', () => {
    expect(pairTargetedReads([arrival('A', 180)], [arrival('B', 900)])).toEqual([])
    expect(pairTargetedReads([], [arrival('B', 900)])).toEqual([])
  })

  it('takes the basis of the ALIGHT minute, which is the minute the mark qualifies', () => {
    // The pair is one vehicle, but the mark the row shows qualifies the alight
    // minute (`ChainLegVehicle.basis`), so a board minute the payload carried
    // beside an alight minute this app computed is 位置推算, not 实时.
    const [vehicle] = pairTargetedReads(
      [arrival('A', 180, 'upstream')],
      [arrival('A', 900, 'our_estimate')],
    )

    expect(vehicle?.basis).toBe('our_estimate')
  })
})

describe('F10 assembly: one leg has one reading, and it states what it knows', () => {
  const vehicles = [{ vehicleId: 'A', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 900, basis: 'upstream' as const }]

  it('states no reading when either of the two reads did not answer', () => {
    // Half a pair is not a reading: the board minute without the alight minute
    // cannot price a ride, and reporting the half that answered would claim a
    // reading the leg does not have.
    expect(legLiveReading({ board: null, alight: reading(), vehicles, boardVehiclesOnTheWay: 1, operatingStatus: STATE })).toBeNull()
    expect(legLiveReading({ board: reading(), alight: null, vehicles, boardVehiclesOnTheWay: 1, operatingStatus: STATE })).toBeNull()
  })

  it('states no source when the two reads were answered by different ones', () => {
    // A board minute from one source and an alight minute from another are not
    // one reading. Naming either would claim a provenance the pair does not
    // have; the engine then reports `provenance-unknown`, which is the honest
    // answer for a pair nothing vouches for.
    const split = legLiveReading({
      board: reading({ dataSource: 'chelaile' }),
      alight: reading({ dataSource: 'subway_schedule' }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })
    expect(split?.dataSource).toBeNull()

    const same = legLiveReading({
      board: reading({ dataSource: 'apizero' }),
      alight: reading({ dataSource: 'apizero' }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })
    expect(same?.dataSource).toBe('apizero')
  })

  it('judges the leg by its OLDER read, and a fallback on either side is a fallback', () => {
    // Freshness is judged once per leg, so the leg's instant must be the older
    // of the two: the newer one would flatter the pair with an age half of it
    // does not have, and the deduction would then conclude on a stale reading
    // that happened to sit beside a fresh one.
    const live = legLiveReading({
      board: reading({ updatedAt: NOW - 5_000, isDegraded: false }),
      alight: reading({ updatedAt: NOW - 60_000, isDegraded: true }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })

    expect(live?.updatedAt).toBe(NOW - 60_000)
    expect(live?.isDegraded).toBe(true)
    expect(live?.vehicles).toEqual(vehicles)
  })

  it('carries the matched vehicles through untouched', () => {
    expect(legLiveReading({ board: reading(), alight: reading(), vehicles: [], boardVehiclesOnTheWay: 0, operatingStatus: STATE })?.vehicles)
      .toEqual([])
  })

  it('carries the count the board read carried, so an empty pair can say WHY', () => {
    // The board read carried three, the match kept none: the leg's reading states
    // the board read's own size, which is what lets the engine tell 「一趟车都没有」
    // from 「两个读数没有对上的车」 — the same empty `vehicles`, two facts.
    const live = legLiveReading({ board: reading(), alight: reading(), vehicles: [], boardVehiclesOnTheWay: 3, operatingStatus: STATE })
    expect(live?.boardVehiclesOnTheWay).toBe(3)
    expect(live?.vehicles).toEqual([])
  })

  it('carries the leg\'s service state, so an empty answer can be governed by it', () => {
    // The reading is the only place the state can come from: it is derived from
    // the line the SAME leg read answered about, so a page with 「没有可乘的车」
    // can tell 首班前 / 已过末班 from a gap in a running service.
    const live = legLiveReading({
      board: reading(),
      alight: reading(),
      vehicles: [],
      boardVehiclesOnTheWay: 0,
      operatingStatus: { state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' },
    })
    expect(live?.operatingStatus).toEqual({ state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' })
  })
})
