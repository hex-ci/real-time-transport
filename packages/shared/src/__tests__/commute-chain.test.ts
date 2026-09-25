import { describe, expect, it } from 'vitest'

import {
  CHAIN_ERROR_MAGNITUDE_MINUTES,
  CHAIN_TIGHT_MARGIN_MINUTES,
  CONNECTION_REFUSAL_CODES,
  DEFAULT_CYCLE_EXTRA_MINUTES,
  chainMarginBandOf,
  deduceCommuteChain,
} from '../commute-chain.js'
import type {
  ChainConnectionUnpricedReason,
  ChainLegInput,
  ChainLegVehicle,
  ChainMarginBand,
  ChainNoConclusionReason,
  CommuteChainDeductionInput,
} from '../commute-chain.js'
import { DEFAULT_WAIT_TOLERANCE_MINUTES, STALE_ARRIVAL_SECONDS, arrivalMinutes } from '../departure.js'
import type { ArrivalBasis } from '../data-provenance.js'
import { CommuteChainLegSchema } from '../schemas/api.js'
import type { CommuteChainLeg } from '../schemas/api.js'
import type { DataSourceType, OperatingStatus } from '../schemas/transit.js'

/**
 * A line's own service hours, as F3 derives a state from them. Every leg in this
 * suite is 运营中 unless a test says otherwise: the clock is `NOW`, which is
 * 06:13:20 Beijing on the operating day the fixtures sit in.
 */
const OPERATING: OperatingStatus = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' }

/**
 * F10's chain deduction, at its boundaries.
 *
 * The engine is pure, so every number the row shows is decided here: the margin
 * (and therefore the band), which vehicle each leg boards, the F4 mark of each
 * minute, and every case where the honest answer is 「无法给出结论」. All station
 * and line values are synthetic placeholders — this suite never carries a real
 * commute of anyone's.
 *
 * Two sets of numbers matter. The first is the four bands, whose thresholds are
 * F1's own (`CHAIN_TIGHT_MARGIN_MINUTES` = T) plus the resolution of a
 * whole-minute margin (`CHAIN_ERROR_MAGNITUDE_MINUTES`). The second is the
 * binding leg: with more than one boarding, the conclusion belongs to the
 * tightest one, not to the first.
 */

/** A fixed clock: the engine reads the AGE of a reading, never the wall clock. */
const NOW = 1_700_000_000_000

const BOARD_STATION = { name: '甲乙路', order: 3 }
const ALIGHT_STATION = { name: '丙丁路', order: 8 }

/** Minutes on the wire, as a card displays them. */
function minutes(n: number): number {
  return n * 60
}

interface LegSpec {
  seq?: number
  lineId?: string
  /** `null` = never chosen. Absent = the default station pair. */
  board?: { name: string, order: number } | null
  alight?: { name: string, order: number } | null
  transferExtraMinutes?: number | null
  /** Seconds of the connection leading INTO this leg; `null` = unpriced. */
  connectionSeconds?: number | null
  /**
   * Why the connection has no priced duration, as the caller that tried to price
   * it knows the cause. Absent = the caller cannot name it.
   */
  connectionUnpricedReason?: ChainConnectionUnpricedReason
  connectionMode?: 'walk' | 'cycle'
  /** `null` = the line was never read; `[]` = read, nothing on its way. */
  vehicles?: readonly ChainLegVehicle[] | null
  /**
   * How many vehicles the BOARD read's own priced rows carried before pairing —
   * the rows still to reach the board order. Defaults to the paired count, which
   * is what a consistent (forward) reading has, since the paired rows are a
   * subset of the board read's own; a test that wants the two to disagree states
   * it explicitly.
   */
  boardVehiclesOnTheWay?: number
  dataSource?: DataSourceType | null
  updatedAt?: number
  isDegraded?: boolean
  /** The leg's F3 operating state, as the assembly derived it. Defaults to 运营中. */
  operatingStatus?: OperatingStatus
}

function storedLeg(spec: LegSpec, seq: number): CommuteChainLeg {
  const board = spec.board === undefined ? BOARD_STATION : spec.board
  const alight = spec.alight === undefined ? ALIGHT_STATION : spec.alight
  const lineId = spec.lineId ?? '101'
  return {
    seq,
    lineId,
    lineName: `${lineId}路`,
    cityCode: '027',
    boardStationName: board ? board.name : null,
    boardStationOrder: board ? board.order : null,
    alightStationName: alight ? alight.name : null,
    alightStationOrder: alight ? alight.order : null,
    transferExtraMinutes: spec.transferExtraMinutes ?? null,
  }
}

function chainInput(specs: LegSpec[], extra: Partial<CommuteChainDeductionInput> = {}): CommuteChainDeductionInput {
  return {
    now: NOW,
    ...extra,
    legs: specs.map((spec, seq): ChainLegInput => ({
      leg: storedLeg(spec, spec.seq ?? seq),
      connectionSeconds: spec.connectionSeconds === undefined ? minutes(5) : spec.connectionSeconds,
      // Only where the caller can name it: a leg with a priced connection, and a
      // caller that cannot say why one is unpriced, both state no reason.
      connectionUnpricedReason: spec.connectionSeconds === null ? spec.connectionUnpricedReason : undefined,
      connectionMode: spec.connectionMode ?? 'walk',
      live: spec.vehicles === null
        ? null
        : {
            dataSource: spec.dataSource === undefined ? 'chelaile' : spec.dataSource,
            updatedAt: spec.updatedAt ?? NOW,
            isDegraded: spec.isDegraded ?? false,
            vehicles: spec.vehicles ?? [],
            boardVehiclesOnTheWay: spec.boardVehiclesOnTheWay ?? spec.vehicles?.length ?? 0,
            operatingStatus: spec.operatingStatus ?? OPERATING,
          },
    })),
  }
}

/** One candidate vehicle: the same vehicle's ETA at the board and at the alight station. */
function vehicle(
  vehicleId: string,
  boardSeconds: number,
  alightSeconds: number,
  basis: ArrivalBasis = 'upstream',
): ChainLegVehicle {
  return { vehicleId, arrivalAtBoardSeconds: boardSeconds, arrivalAtAlightSeconds: alightSeconds, basis }
}

function deduced(input: CommuteChainDeductionInput) {
  const result = deduceCommuteChain(input)
  if (result.status !== 'deduced') throw new Error(`expected a deduction, got ${result.reason}`)
  return result
}

function refusal(input: CommuteChainDeductionInput): ChainNoConclusionReason {
  const result = deduceCommuteChain(input)
  if (result.status !== 'no-conclusion') throw new Error(`expected no conclusion, got ${result.band}`)
  return result.reason
}

describe('F10 deduction: the four bands, each from the same margin the row shows', () => {
  /**
   * The whole mapping, driven end to end through the public entry point. Both
   * columns must hold together: a band read from a quantity other than the
   * reported margin fails one of them.
   */
  const TABLE: readonly { name: string, connectionSeconds: number, boardSeconds: number, band: ChainMarginBand, marginMinutes: number }[] = [
    { name: '充裕: seven minutes of slack', connectionSeconds: minutes(5), boardSeconds: minutes(12), band: 'comfortable', marginMinutes: 7 },
    { name: '紧: three minutes — F1\'s tolerance itself', connectionSeconds: minutes(5), boardSeconds: minutes(8), band: 'tight', marginMinutes: 3 },
    { name: '紧: one or two minutes', connectionSeconds: minutes(5), boardSeconds: minutes(7), band: 'tight', marginMinutes: 2 },
    { name: '紧: one minute', connectionSeconds: minutes(5), boardSeconds: minutes(6), band: 'tight', marginMinutes: 1 },
    { name: '余量小于误差量级: zero', connectionSeconds: minutes(5), boardSeconds: minutes(5), band: 'uncertain', marginMinutes: 0 },
    { name: '不足: one minute short', connectionSeconds: minutes(5), boardSeconds: minutes(4), band: 'insufficient', marginMinutes: -1 },
    { name: '不足: two minutes gone', connectionSeconds: minutes(5), boardSeconds: minutes(3), band: 'insufficient', marginMinutes: -2 },
  ]

  for (const row of TABLE) {
    it(row.name, () => {
      const result = deduced(chainInput([{
        connectionSeconds: row.connectionSeconds,
        vehicles: [vehicle('A', row.boardSeconds, minutes(25)), vehicle('B', minutes(15), minutes(30))],
      }]))

      expect(result.marginMinutes).toBe(row.marginMinutes)
      expect(result.band).toBe(row.band)
      // The band is a function of the margin this result reports, and of nothing else.
      expect(result.band).toBe(chainMarginBandOf(result.marginMinutes, CHAIN_TIGHT_MARGIN_MINUTES))
    })
  }

  it('names a 充裕 chain above the tolerance, not at it', () => {
    const at = deduced(chainInput([{ vehicles: [vehicle('A', minutes(8), minutes(20))] }]))
    expect(at.band).toBe('tight')

    const above = deduced(chainInput([{ vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(above.band).toBe('comfortable')
    expect(above.marginMinutes).toBe(DEFAULT_WAIT_TOLERANCE_MINUTES + 1)
  })

  it('bands a one-leg chain the way F1 bands the same walk', () => {
    // F1: slack = eta - walk, hurry at slack <= T. Same numbers, same boundary,
    // because the chain's tolerance IS F1's.
    const walk = minutes(6)
    const result = deduced(chainInput([{ connectionSeconds: walk, vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(result.marginMinutes).toBe(3)
    expect(result.band).toBe('tight')
  })
})

describe('F10 deduction: 有余量就是这班, 不足就是下一班', () => {
  it('boards the vehicle the plan is timed against when the margin is positive', () => {
    const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(12), minutes(23))] }]))
    expect(result.band).toBe('comfortable')
    expect(result.legs[0]?.vehicleId).toBe('A')
    expect(result.legs[0]?.waitMinutes).toBe(7)
    expect(result.legs[0]?.alightMinutes).toBe(23)
    expect(result.legs[0]?.rideMinutes).toBe(11)
  })

  it('says 下一班 when the vehicle that was next cannot be reached', () => {
    const result = deduced(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(3), minutes(15)), vehicle('B', minutes(8), minutes(20))],
    }]))

    expect(result.band).toBe('insufficient')
    expect(result.marginMinutes).toBe(-2)
    // The vehicle the chain was timed against is gone; the plan is the next one.
    expect(result.legs[0]?.vehicleId).toBe('B')
    expect(result.legs[0]?.waitMinutes).toBe(3)
    expect(result.legs[0]?.marginMinutes).toBe(-2)
    expect(result.legs[0]?.alightMinutes).toBe(20)
  })

  it('puts no quantity beside a refusal — only the reason and which leg refused', () => {
    // A refusal carries no margin, no minute and no plan: a number beside a
    // refusal is exactly the guessed answer the refusal exists to avoid. WHICH
    // leg refused is not such a number (see `ChainNoConclusion`), so it travels.
    const result = deduceCommuteChain(chainInput([{ vehicles: null }]))
    expect(result.status).toBe('no-conclusion')
    expect(Object.keys(result).sort()).toEqual(['leg', 'reason', 'status'])
  })
})

describe('F10 deduction: the tightest boarding decides the chain', () => {
  it('takes the smallest margin, not the first leg\'s', () => {
    // Leg 0 has six minutes to spare (comfortable on its own); leg 1 has one.
    const result = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(11), minutes(25))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(31), minutes(40))] },
    ]))

    expect(result.legs[0]?.marginMinutes).toBe(6)
    expect(result.legs[1]?.marginMinutes).toBe(1)
    expect(result.marginMinutes).toBe(1)
    expect(result.band).toBe('tight')
    expect(result.bindingSeq).toBe(1)
  })

  it('keeps the earlier leg when two boardings are equally tight', () => {
    const result = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(8), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(28), minutes(40))] },
    ]))
    expect(result.legs[0]?.marginMinutes).toBe(3)
    expect(result.legs[1]?.marginMinutes).toBe(3)
    expect(result.bindingSeq).toBe(0)
  })

  it('chains leg 1\'s ready time off the vehicle leg 0 is boarded on', () => {
    // Leg 0 alights at 20 min; the transfer walk is 5 min, so the user is at the
    // second board station at 25 min. A vehicle arriving at 26 min is catchable
    // with one minute to spare, and one arriving at 22 min is not.
    const catchable = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', connectionSeconds: minutes(5), vehicles: [vehicle('C', minutes(26), minutes(40))] },
    ]))
    expect(catchable.legs[1]?.waitMinutes).toBe(1)
    expect(catchable.legs[1]?.marginMinutes).toBe(1)

    const missed = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      {
        lineId: '202',
        connectionSeconds: minutes(5),
        vehicles: [vehicle('C', minutes(22), minutes(40)), vehicle('D', minutes(32), minutes(50))],
      },
    ]))
    expect(missed.legs[1]?.vehicleId).toBe('D')
    expect(missed.legs[1]?.marginMinutes).toBe(-3)
  })

  it('handles a third ride leg, because the model is N legs', () => {
    const result = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(27), minutes(35))] },
      { seq: 2, lineId: '303', vehicles: [vehicle('E', minutes(48), minutes(60))] },
    ]))
    expect(result.legs).toHaveLength(3)
    expect(result.legs.map(l => l.seq)).toEqual([0, 1, 2])
    expect(result.legs[2]?.marginMinutes).toBeGreaterThanOrEqual(0)
  })
})

describe('F10 deduction: the band cannot drift from the numbers beside it', () => {
  it('decides on the rounded minutes the row shows, not on the raw seconds', () => {
    // Raw margin 185 s is over 3 minutes; the displayed minutes are 6 - 3 = 3,
    // which is inside the tolerance. A band computed from raw seconds would say
    // 充裕 beside a 「余量 3 分」 — two quantities disagreeing in one row.
    const result = deduced(chainInput([{
      connectionSeconds: 190,
      vehicles: [vehicle('A', 375, minutes(25))],
    }]))
    expect(result.legs[0]?.marginMinutes).toBe(3)
    expect(result.band).toBe('tight')
  })

  it('rounds each reading as the row shows it and then subtracts, like F1', () => {
    // 「3 分钟后到」 - 「车 6 分钟到」 = 余量 3 分. Rounding the difference instead
    // (121 s) would print 余量 2 分 beside the same two readings: a third number
    // that belongs to neither of them.
    const result = deduced(chainInput([{
      connectionSeconds: 209,
      vehicles: [vehicle('A', 330, minutes(25))],
    }]))
    expect(result.legs[0]?.marginMinutes).toBe(3)
    expect(result.band).toBe('tight')
  })

  it('moves the band and the minutes together', () => {
    const inputs = [
      chainInput([{ vehicles: [vehicle('A', minutes(6), minutes(20))] }]),
      chainInput([{ vehicles: [vehicle('A', minutes(7), minutes(20))] }]),
      chainInput([{ vehicles: [vehicle('A', minutes(9), minutes(20))] }]),
    ]
    const seen = inputs.map(i => deduced(i))
    expect(seen.map(r => [r.marginMinutes, r.band])).toEqual([
      [1, 'tight'],
      [2, 'tight'],
      [4, 'comfortable'],
    ])
    for (const result of seen) {
      expect(result.band).toBe(chainMarginBandOf(result.marginMinutes, CHAIN_TIGHT_MARGIN_MINUTES))
      // The displayed margin is the binding leg's own displayed margin.
      const binding = result.legs.find(l => l.seq === result.bindingSeq)
      expect(binding?.marginMinutes).toBe(result.marginMinutes)
    }
  })

  it('follows a configured tolerance instead of the default', () => {
    const input = chainInput([{ vehicles: [vehicle('A', minutes(8), minutes(20))] }])
    expect(deduced(input).band).toBe('tight')
    expect(deduced({ ...input, tightMarginMinutes: 1 }).band).toBe('comfortable')
  })

  it('exposes thresholds that are F1\'s tolerance and one whole minute', () => {
    expect(CHAIN_TIGHT_MARGIN_MINUTES).toBe(DEFAULT_WAIT_TOLERANCE_MINUTES)
    expect(CHAIN_ERROR_MAGNITUDE_MINUTES).toBe(1)
  })
})

describe('F10 deduction: a margin inside the error magnitude gets two branches', () => {
  it('gives both branches instead of one false answer at margin zero', () => {
    const result = deduced(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(5), minutes(20)), vehicle('B', minutes(11), minutes(26))],
    }]))

    expect(result.band).toBe('uncertain')
    expect(result.marginMinutes).toBe(0)
    // Branch A: the vehicle the chain is timed against is made.
    expect(result.branches?.asPlanned).toEqual({ vehicleId: 'A', alightMinutes: 20 })
    // Branch B: it is not, and the next vehicle is the one actually taken.
    expect(result.branches?.nextVehicle).toEqual({ vehicleId: 'B', alightMinutes: 26 })
  })

  it('names no vehicle in the second branch when nothing follows', () => {
    const result = deduced(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(5), minutes(20))],
    }]))
    expect(result.band).toBe('uncertain')
    expect(result.branches?.asPlanned).toEqual({ vehicleId: 'A', alightMinutes: 20 })
    expect(result.branches?.nextVehicle).toEqual({ vehicleId: null, alightMinutes: null })
  })

  it('offers branches only where the margin cannot be resolved', () => {
    for (const boardMinutes of [1, 2, 4, 9]) {
      const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(boardMinutes), minutes(20)), vehicle('B', minutes(boardMinutes + 5), minutes(30))] }]))
      expect(result.band).not.toBe('uncertain')
      expect(result.branches).toBeUndefined()
    }
  })

  it('keeps the branch readings to whole minutes, like every other number here', () => {
    const result = deduced(chainInput([{
      connectionSeconds: 300,
      vehicles: [vehicle('A', 297, 1180), vehicle('B', 640, 1500)],
    }]))
    expect(result.branches?.asPlanned.alightMinutes).toBe(arrivalMinutes(1180))
    expect(result.branches?.nextVehicle.alightMinutes).toBe(arrivalMinutes(1500))
  })

  it('reads the branches off the BINDING leg, whatever leg that is', () => {
    // Leg 0 is comfortable on its own (six minutes of slack). Leg 1 is the tight
    // one: leg 0 alights at 25, the transfer is 5, so the user is at leg 1's board
    // station at minute 30 — exactly when its reference vehicle arrives. The two
    // readings are therefore about leg 1's vehicles, and naming leg 0's would be
    // the wrong bus beside a margin that was never leg 0's.
    const result = deduced(chainInput([
      { connectionSeconds: minutes(5), vehicles: [vehicle('A', minutes(11), minutes(25))] },
      {
        lineId: '202',
        connectionSeconds: minutes(5),
        vehicles: [vehicle('C', minutes(30), minutes(40)), vehicle('D', minutes(36), minutes(46))],
      },
    ]))

    expect(result.legs[0]?.marginMinutes).toBe(6)
    expect(result.legs[1]?.marginMinutes).toBe(0)
    expect(result.marginMinutes).toBe(0)
    expect(result.bindingSeq).toBe(1)
    expect(result.band).toBe('uncertain')
    expect(result.branches?.asPlanned).toEqual({ vehicleId: 'C', alightMinutes: 40 })
    expect(result.branches?.nextVehicle).toEqual({ vehicleId: 'D', alightMinutes: 46 })
  })
})

describe('F10 deduction: every leg\'s minute carries its F4 mark', () => {
  it('marks a real vehicle\'s own arrival minute 实时', () => {
    const result = deduced(chainInput([{
      vehicles: [vehicle('A', minutes(6), minutes(20), 'upstream')],
    }]))
    expect(result.legs[0]?.provenance).toBe('live')
    expect(result.provenance).toBe('live')
  })

  it('marks this app\'s own arithmetic 位置推算, never 实时', () => {
    const result = deduced(chainInput([{
      vehicles: [vehicle('A', minutes(6), minutes(20), 'our_estimate')],
    }]))
    expect(result.legs[0]?.provenance).toBe('position_estimate')
    expect(result.provenance).toBe('position_estimate')
  })

  it('marks an observation of the vehicle at the platform 实时', () => {
    // The vehicle is at the platform as the user arrives (no walk between them).
    const result = deduced(chainInput([{
      connectionSeconds: 0,
      vehicles: [vehicle('A', 0, minutes(20), 'at_platform')],
    }]))
    expect(result.legs[0]?.provenance).toBe('live')
  })

  it('marks a subway leg 排班推演 however its minute was produced', () => {
    for (const basis of ['upstream', 'our_estimate', 'at_platform'] as const) {
      const result = deduced(chainInput([{
        dataSource: 'subway_schedule',
        vehicles: [vehicle('train_1', minutes(6), minutes(20), basis)],
      }]))
      expect(result.legs[0]?.provenance).toBe('schedule_simulation')
      expect(result.provenance).toBe('schedule_simulation')
    }
  })

  it('never lets a generated vehicle read as 实时', () => {
    const result = deduced(chainInput([{
      dataSource: 'subway_schedule',
      vehicles: [vehicle('train_1', minutes(6), minutes(20), 'upstream')],
    }]))
    expect(result.legs[0]?.provenance).not.toBe('live')
  })

  it('states no single chain mark when the legs disagree', () => {
    const result = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20), 'upstream')] },
      { lineId: '202', dataSource: 'subway_schedule', vehicles: [vehicle('train_1', minutes(30), minutes(40), 'upstream')] },
    ]))
    expect(result.legs.map(l => l.provenance)).toEqual(['live', 'schedule_simulation'])
    // One word would be false about part of the chain, so the chain states none.
    expect(result.provenance).toBeNull()
  })
})

describe('F10 deduction: 无法给出结论 rather than a guessed number', () => {
  it('refuses when a leg never had its stations chosen', () => {
    expect(refusal(chainInput([{ board: null }]))).toBe('station-unset')
    expect(refusal(chainInput([{ alight: null }]))).toBe('station-unset')
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', alight: null, vehicles: [vehicle('C', minutes(30), minutes(40))] },
    ]))).toBe('station-unset')
  })

  it('refuses when a connection was never priced', () => {
    expect(refusal(chainInput([{ connectionSeconds: null }]))).toBe('connection-unpriced')
  })

  it('names the chain\'s own unsaved origin as its own cause, because that is the one the user can act on', () => {
    // A chain records an origin and never a destination, so a chain whose anchor
    // was never saved has no origin to walk from at all — and that is a fact
    // about the stored settings rather than about the service or about our
    // reading of it. It travels under its own code, and under the SAME word F1's
    // empty state already uses for it (`anchor-unset`), so the row can point at
    // 设置 instead of printing a sentence about a connection nobody could price.
    const result = deduceCommuteChain(chainInput([{
      connectionSeconds: null,
      connectionUnpricedReason: 'anchor-unset',
      vehicles: null,
    }]))

    if (result.status !== 'no-conclusion') throw new Error(`expected a refusal, got ${result.band}`)
    expect(result.reason).toBe('anchor-unset')
    expect(result.reason).not.toBe('connection-unpriced')
    // Which leg it is about is stated as for every other refusal: the first leg
    // is the one whose connection starts at the anchor.
    expect(result.leg).toEqual({ seq: 0, lineId: '101', lineName: '101路' })
  })

  it('keeps every cause the user cannot act on in ONE code, whichever one the caller names', () => {
    // The cause set is DERIVED from the engine's own table and never written down
    // here: `CONNECTION_REFUSAL_CODES` is a total `Record` over
    // `ChainConnectionUnpricedReason`, so its keys ARE the whole vocabulary — the
    // engine cannot compile while any cause lacks a code. A hand-written set
    // cannot be exact, because the only moment it could go stale is the moment
    // nobody looks: a cause added to the vocabulary would simply be missing from
    // it, and the loop below would have one fewer iteration to be wrong about, so
    // the guard would pass while covering less. Deriving the set instead means a
    // cause added upstream appears here automatically, and a cause MOVED into
    // another code fails below rather than dropping out of a loop.
    const CAUSES = Object.keys(CONNECTION_REFUSAL_CODES) as ChainConnectionUnpricedReason[]

    // The chain's own origin anchor is the ONE cause the user can act on (the test
    // above is what makes it actionable), so it is the only cause that travels
    // under its own code. Asserting the partition — and not merely that the
    // expected causes reach the generic code — is what fails when some OTHER cause
    // is mapped to `anchor-unset`.
    expect(CAUSES.filter(cause => CONNECTION_REFUSAL_CODES[cause] === 'anchor-unset'))
      .toEqual(['anchor-unset'])

    // Every other cause — the line's detail could not be read, the stored station
    // is not in the direction's stop list, the stop list carries it but states no
    // coordinate, or the path service priced no route — shares ONE code. None of
    // them leaves the user an action and none is a fact about the answer, so each
    // is disclosed by a code the page can answer with one honest sentence:
    // `connection-unpriced`. That sentence promises no retryability, because these
    // causes do not share a permanence (see `ChainNoConclusionReason`).
    const unactable = CAUSES.filter(cause => cause !== 'anchor-unset')
    expect(unactable.length).toBeGreaterThan(0)
    for (const cause of unactable) {
      expect(CONNECTION_REFUSAL_CODES[cause], cause).toBe('connection-unpriced')
      expect(refusal(chainInput([{ connectionSeconds: null, connectionUnpricedReason: cause }])), cause)
        .toBe('connection-unpriced')
    }

    // A caller that cannot name the cause states none and reaches the same code —
    // the only way into it that carries no cause of its own.
    expect(refusal(chainInput([{ connectionSeconds: null }]))).toBe('connection-unpriced')
  })

  it('refuses when a line was never read, and when no vehicle is on its way', () => {
    expect(refusal(chainInput([{ vehicles: null }]))).toBe('no-live')
    expect(refusal(chainInput([{ vehicles: [] }]))).toBe('no-vehicle')
  })

  it('separates nothing on the way from a reading that shares no vehicle', () => {
    // (1) the board read itself carried nothing: nothing is on its way to this
    // board station. A fact about the service.
    expect(refusal(chainInput([{ vehicles: [], boardVehiclesOnTheWay: 0 }]))).toBe('no-vehicle')
    // (2) the board read carried vehicles, but the two targeted reads share none
    // of their ids. That is a fact about OUR OWN reading — the same empty pair —
    // and calling it 「没有可乘的车」 would describe the service when the truth is
    // about the two snapshots we compared.
    expect(refusal(chainInput([{ vehicles: [], boardVehiclesOnTheWay: 3 }]))).toBe('no-shared-vehicle')
  })

  it('refuses when nothing on the way is still catchable', () => {
    // Everything has already passed, or arrives before the walk is done and
    // nothing follows it: there is no plan to deduce from.
    expect(refusal(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(1), minutes(10))],
    }]))).toBe('no-vehicle-after-connection')
  })

  it('separates the vehicle that left during the walk from one that left before it began', () => {
    // (3) the user sets off, and a vehicle is still to come — but it reaches the
    // board station before the 5-minute connection is walked: it left while the
    // user was on their way. 「连走过去的那趟都赶不上」.
    expect(refusal(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(1), minutes(10))],
    }]))).toBe('no-vehicle-after-connection')

    // (4) by the time the user can set off toward this board station, every
    // vehicle has already been there: there is nothing even to be short of. Only
    // a later leg can be in this state, because leg 0 sets off at minute 0.
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(10), minutes(15))] },
    ]))).toBe('no-vehicle-at-departure')
  })

  it('refuses on data that is past its freshness limit', () => {
    expect(refusal(chainInput([{ updatedAt: NOW - (STALE_ARRIVAL_SECONDS + 1) * 1000 }]))).toBe('stale')
  })

  it('uses the freshness limit itself, not one second past it', () => {
    const at = deduced(chainInput([{
      updatedAt: NOW - STALE_ARRIVAL_SECONDS * 1000,
      vehicles: [vehicle('A', minutes(6), minutes(20))],
    }]))
    expect(at.status).toBe('deduced')
    expect(refusal(chainInput([{
      updatedAt: NOW - STALE_ARRIVAL_SECONDS * 1000 - 1000,
      vehicles: [vehicle('A', minutes(6), minutes(20))],
    }]))).toBe('stale')
  })

  it('refuses on an answer a fallback source served', () => {
    expect(refusal(chainInput([{ isDegraded: true }]))).toBe('degraded')
  })

  it('refuses when the reading declares no source this build knows', () => {
    expect(refusal(chainInput([{ dataSource: null }]))).toBe('provenance-unknown')
  })

  it('refuses a reading whose alight time precedes its board time', () => {
    // A downstream minute that is not downstream of anything: the two numbers do
    // not describe one journey, so no leg can be priced from them.
    expect(refusal(chainInput([{ vehicles: [vehicle('A', minutes(20), minutes(6))] }]))).toBe('inconsistent-live')
  })

  it('refuses a chain with no ride leg at all', () => {
    expect(refusal({ now: NOW, legs: [] })).toBe('no-legs')
  })

  it('refuses when no vehicle can still reach a leg\'s board station by the time the user sets off', () => {
    // Leg 0 alights at minute 20. Every vehicle on leg 1's line reaches ITS board
    // station at minute 10 — gone by the time the user can be there, so the
    // vehicle the chain would be timed against does not exist at all. That is
    // 「没有可乘的车」 because it has all gone, not a negative margin: there is
    // nothing to be short of.
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(10), minutes(15))] },
    ]))).toBe('no-vehicle-at-departure')
  })

  it('refuses on the first leg that cannot be deduced from, in leg order', () => {
    // Leg 0 is fine; leg 1 is stale. The reason reported is leg 1's.
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', updatedAt: NOW - 10 * 60 * 1000, vehicles: [vehicle('C', minutes(30), minutes(40))] },
    ]))).toBe('stale')
  })
})

describe('F10 deduction: a refusal names the leg, its age and its service state', () => {
  it('names the leg that refused, so a page can point at the transfer point and its line', () => {
    // Leg 1 is the one that cannot be deduced from: 「都走了」 is leg 1's fact, and
    // without its sequence a page with a two-leg chain can neither say WHICH
    // transfer point refused nor name the line that refused there.
    const result = deduceCommuteChain(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(10), minutes(15))] },
    ]))
    expect(result.status).toBe('no-conclusion')
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('no-vehicle-at-departure')
    expect(result.leg).toEqual({ seq: 1, lineId: '202', lineName: '202路' })
  })

  it('names no leg for a chain that carries none', () => {
    // `no-legs` is a fact about the chain itself: there is no leg to point at.
    expect(deduceCommuteChain({ now: NOW, legs: [] })).toEqual({ status: 'no-conclusion', reason: 'no-legs' })
  })

  it('carries the refusing leg\'s reading age, so F11 can sit beside it', () => {
    const result = deduceCommuteChain(chainInput([{ updatedAt: NOW - 4_000, vehicles: [] }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.updatedAt).toBe(NOW - 4_000)
  })

  it('carries the refusing leg\'s service state, so an empty answer is governed by it', () => {
    // 「暂无来车」 at 06:00 and 「暂无来车」 at 01:00 are not the same fact: the first
    // is a gap in service, the second is a service day that has ended — and only
    // the state distinguishes them.
    const result = deduceCommuteChain(chainInput([{
      vehicles: [],
      operatingStatus: { state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' },
    }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('no-vehicle')
    expect(result.operatingStatus).toEqual({ state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' })
  })

  it('carries no age and no state when the leg was never read', () => {
    // `no-live` means no reading exists: there is no obtained-at to state and no
    // source that declared a service state, so neither is invented for the row.
    const result = deduceCommuteChain(chainInput([{ vehicles: null }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('no-live')
    expect('updatedAt' in result).toBe(false)
    expect('operatingStatus' in result).toBe(false)
  })

  it('names a later refusing leg under the seq the chain stores it at', () => {
    const late = deduceCommuteChain(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(27), minutes(35))] },
      { seq: 2, lineId: '303', updatedAt: NOW - 600_000, vehicles: [vehicle('E', minutes(48), minutes(60))] },
    ]))
    if (late.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(late.reason).toBe('stale')
    expect(late.leg).toEqual({ seq: 2, lineId: '303', lineName: '303路' })
  })
})

describe('F10 deduction: every leg states its service state', () => {
  it('carries each leg\'s F3 state beside its answer', () => {
    const result = deduced(chainInput([
      {
        operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
        vehicles: [vehicle('A', minutes(6), minutes(20))],
      },
      {
        lineId: '202',
        operatingStatus: { state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' },
        vehicles: [vehicle('C', minutes(30), minutes(40))],
      },
    ]))
    expect(result.legs.map(l => l.operatingStatus.state)).toEqual(['operating', 'after_last'])
    expect(result.legs[0]?.operatingStatus.firstDeparture).toBe('05:00')
  })
})

describe('F10 deduction: a leg recorded the wrong way round is its own answer', () => {
  it('names the record, not our reading, when the alight station is upstream of the board one', () => {
    // The user recorded alight order 3 and board order 8 — the leg runs backwards.
    // The two targeted reads cannot then share a vehicle, but that is a fact about
    // the RECORD, and 「两个读数没有对上的车」 would blame this app's reading while
    // quoting the user no fix at all. The honest answer is that the chain is
    // recorded the wrong way round, which the user can correct.
    const result = deduceCommuteChain(chainInput([{
      board: { name: '丁丁路', order: 8 },
      alight: { name: '甲甲路', order: 3 },
      vehicles: [],
      boardVehiclesOnTheWay: 3,
    }]))
    expect(result.status).toBe('no-conclusion')
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('leg-recorded-backwards')
    expect(result.reason).not.toBe('no-shared-vehicle')
    expect(result.leg).toEqual({ seq: 0, lineId: '101', lineName: '101路' })
  })

  it('refuses a leg that alights where it boards, because that is not a ride either', () => {
    // Equality is not "downstream of", and a boarding station that is also the
    // alighting one prices no ride: the same code covers it, which is why the
    // recording rule is 「站序更大」 rather than 「不同」.
    const result = deduceCommuteChain(chainInput([{
      board: { name: '甲甲路', order: 3 },
      alight: { name: '甲甲路', order: 3 },
      vehicles: [vehicle('A', minutes(6), minutes(20))],
    }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('leg-recorded-backwards')
  })

  it('lets a SUBWAY leg run the other way round, because one subway lineId carries both directions', () => {
    // On a bus the two directions are two lineIds, so a stored `lineId` names one
    // of them and alight < board is a recording error. On a subway one lineId
    // serves both ways and numbers the same station oppositely, so the very same
    // pair of stored orders is a ride the OTHER way — the assembly reads the
    // opposite direction for it (translating both orders), and there is nothing
    // for the engine to refuse. The leg is timed against the reading the assembly
    // produced, which is the only reading this leg has.
    const result = deduced(chainInput([{
      lineId: 'subway_101',
      board: { name: '丁丁路', order: 8 },
      alight: { name: '甲甲路', order: 3 },
      dataSource: 'subway_schedule',
      vehicles: [vehicle('train_1', minutes(6), minutes(20))],
    }]))

    expect(result.band).toBe('tight')
    expect(result.legs[0]?.vehicleId).toBe('train_1')
    expect(result.legs[0]?.marginMinutes).toBe(1)
    expect(result.legs[0]?.provenance).toBe('schedule_simulation')
  })

  it('still refuses a station-to-itself leg on a subway, because that is not a ride either', () => {
    // The subway allowance covers the OTHER way round and nothing else: boarding
    // and alighting at one station is not a shorter ride on any line, so equality
    // keeps the same code it has on a bus.
    const result = deduceCommuteChain(chainInput([{
      lineId: 'subway_101',
      board: { name: '甲甲路', order: 3 },
      alight: { name: '甲甲路', order: 3 },
      dataSource: 'subway_schedule',
      vehicles: [vehicle('train_1', minutes(6), minutes(20))],
    }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('leg-recorded-backwards')
  })

  it('keeps connection-unpriced AHEAD of the backwards rule, so a leg that did not locate keeps its honest diagnosis', () => {
    // A leg can trip both rules at once: its stored ends run backwards AND its
    // connection was never priced. The ORDER between the two checks is a product
    // decision, not an accident. The connection necessarily comes first — a
    // connection is priced only once both stored stations located in THIS
    // direction's stop list, so 「站序反了」 without a price would be a diagnosis
    // of a record this path could not even read, and flipping the two ends would
    // not be the fix. (Swapping the two checks leaves every other test in this
    // suite green; this fixture is the one that pins the order.)
    expect(refusal(chainInput([{
      board: { name: '丁丁路', order: 8 },
      alight: { name: '甲甲路', order: 3 },
      connectionSeconds: null,
      vehicles: null,
    }]))).toBe('connection-unpriced')
  })

  it('keeps the connection ahead of the backwards rule for each cause the caller can name', () => {
    // The same leg that trips both rules at once, with the caller's reason
    // stated. The ORDER must not depend on WHICH cause it is: a priced
    // connection is what proves both stored stations located in the direction
    // the leg runs, so 「站序反了」 without a price would diagnose a record this
    // path could not even read. That includes the one cause the user can act on
    // — a chain whose origin was never saved must not be told its ends are
    // recorded the wrong way round.
    const backwardsAndUnpriced = {
      board: { name: '丁丁路', order: 8 },
      alight: { name: '甲甲路', order: 3 },
      connectionSeconds: null,
      vehicles: null,
    } as const

    expect(refusal(chainInput([
      { ...backwardsAndUnpriced, connectionUnpricedReason: 'anchor-unset' },
    ]))).toBe('anchor-unset')

    expect(refusal(chainInput([
      { ...backwardsAndUnpriced, connectionUnpricedReason: 'station-unlocated' },
    ]))).toBe('connection-unpriced')
  })
})

describe('F10 schema: a leg must run downstream, and the order is checked on write', () => {
  const LEG = {
    lineId: '101',
    lineName: '101路',
    cityCode: '027',
    boardStationName: '甲甲路',
    boardStationOrder: 3,
    alightStationName: '丁丁路',
    alightStationOrder: 8,
    transferExtraMinutes: null,
  }

  it('rejects a leg whose alight order is not downstream of its board order', () => {
    // The same spirit as the name/order refinements beside it: the pair is one
    // value, so a leg that runs backwards is rejected at the boundary rather than
    // stored and later explained away as a fact about our reading.
    const parsed = CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: '乙乙路', alightStationOrder: 2 })
    expect(parsed.success).toBe(false)
    // The rejection says what to fix, in the same register as the pair refinements.
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain('站序')
  })

  it('rejects a leg that alights where it boards', () => {
    expect(CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: '甲甲路', alightStationOrder: 3 }).success).toBe(false)
  })

  it('accepts a leg that runs downstream, and one whose station is not chosen yet', () => {
    expect(CommuteChainLegSchema.safeParse(LEG).success).toBe(true)
    // An unchosen station has no order to compare, so the ordering rule must not
    // double-refuse the leg the pair refinement already governs.
    expect(CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: null, alightStationOrder: null }).success).toBe(true)
    expect(CommuteChainLegSchema.safeParse({ ...LEG, boardStationName: null, boardStationOrder: null }).success).toBe(true)
  })

  it('accepts a SUBWAY leg recorded the other way round, while a bus one stays an error', () => {
    // The ordering rule is about the DIRECTION a leg runs, and only the lineId
    // says which way is downstream. A bus lineId names one of its two directions,
    // so alight < board there is the user's entry the wrong way round. A subway
    // lineId carries BOTH directions and numbers the same station oppositely, so
    // the same stored pair is a real ride the other way — the assembly reads the
    // opposite direction for it — and rejecting it would make a legitimate
    // reverse subway chain unrecordable.
    const reverse = { ...LEG, lineId: 'subway_027_88', alightStationName: '乙乙路', alightStationOrder: 2 }
    expect(CommuteChainLegSchema.safeParse(reverse).success).toBe(true)

    // The same pair on a bus is still refused, and its message still says what to
    // fix.
    const busReverse = CommuteChainLegSchema.safeParse({ ...reverse, lineId: '101' })
    expect(busReverse.success).toBe(false)
    expect(busReverse.success ? '' : busReverse.error.issues[0]?.message).toContain('站序')

    // And a subway cannot be ridden from a station to itself any more than a bus
    // can: the allowance is for the other way round, not for a shorter ride.
    expect(CommuteChainLegSchema.safeParse({ ...LEG, lineId: 'subway_027_88', alightStationName: '甲甲路', alightStationOrder: 3 }).success).toBe(false)
  })
})

describe('F10 deduction: connections are priced by the path service, never by a guess', () => {
  it('adds the user\'s cycling extra to a cycling connection', () => {
    // 5 min of riding + the default finding/parking time: the vehicle that is
    // 9 minutes away is no longer comfortable.
    const walking = deduced(chainInput([{ connectionMode: 'walk', vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(walking.band).toBe('comfortable')

    const cycling = deduced(chainInput([{ connectionMode: 'cycle', vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(cycling.band).toBe('tight')

    expect(DEFAULT_CYCLE_EXTRA_MINUTES).toBeGreaterThan(0)
  })

  it('lets a leg\'s own extra override the default, and zero mean no extra at all', () => {
    const none = deduced(chainInput([{
      connectionMode: 'cycle',
      transferExtraMinutes: 0,
      vehicles: [vehicle('A', minutes(9), minutes(20))],
    }]))
    expect(none.band).toBe('comfortable')

    const extra = deduced(chainInput([{
      connectionMode: 'cycle',
      transferExtraMinutes: 5,
      vehicles: [vehicle('A', minutes(11), minutes(20))],
    }]))
    expect(extra.band).toBe('tight')
    expect(extra.marginMinutes).toBe(1)
  })

  it('adds nothing to a walking connection the user left unconfigured', () => {
    const result = deduced(chainInput([{
      connectionMode: 'walk',
      transferExtraMinutes: null,
      vehicles: [vehicle('A', minutes(9), minutes(20))],
    }]))
    expect(result.marginMinutes).toBe(4)
  })

  it('applies a leg\'s own extra to a WALKING connection too, because the field names no mode', () => {
    // The stored field is the leg's own extra on the connection into it, and the
    // chain stores no mode — so a configured 4 minutes is honoured for a walking
    // connection as well (7 minutes of slack becomes 3). Intended, not an
    // accident: dropping a number the user typed because the mode that motivated
    // it is not stored would be this app deciding the user meant nothing.
    const withoutExtra = deduced(chainInput([{
      connectionMode: 'walk',
      transferExtraMinutes: null,
      vehicles: [vehicle('A', minutes(12), minutes(25))],
    }]))
    expect(withoutExtra.marginMinutes).toBe(7)
    expect(withoutExtra.legs[0]?.waitMinutes).toBe(7)
    expect(withoutExtra.band).toBe('comfortable')

    const withExtra = deduced(chainInput([{
      connectionMode: 'walk',
      transferExtraMinutes: 4,
      vehicles: [vehicle('A', minutes(12), minutes(25))],
    }]))
    expect(withExtra.marginMinutes).toBe(3)
    // The extra moves the platform wait with it: leg 0 boards the same vehicle,
    // but the user is at the board station four minutes later.
    expect(withExtra.legs[0]?.waitMinutes).toBe(3)
    expect(withExtra.band).toBe('tight')
  })

  it('lets the engine\'s own default be configured', () => {
    // 5 min of riding + the 2-minute default extra leaves 3 minutes on a vehicle
    // 10 minutes away; with no extra at all it is 5.
    const input = chainInput([{ connectionMode: 'cycle', vehicles: [vehicle('A', minutes(10), minutes(20))] }])
    expect(deduced(input).band).toBe('tight')
    expect(deduced(input).marginMinutes).toBe(3)
    expect(deduced({ ...input, cycleExtraMinutes: 0 }).band).toBe('comfortable')
  })
})

describe('F10 deduction: the numbers the row shows', () => {
  it('prices nothing past the last leg: no destination, no total arrival', () => {
    // The product need is the per-transfer margin — 「我能不能赶上这个换乘点的车」
    // — and nothing more. The chain ends at its last ride leg's alight station:
    // there is no destination to walk to, so neither the engine's input carries a
    // tail connection nor its output a total arrival minute. Both are GONE, not
    // nulled: a field that always reads null is a promise the feature does not make.
    const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(6), minutes(20))] }]))
    expect('arriveInMinutes' in result).toBe(false)
    expect('tailConnectionSeconds' in chainInput([{}])).toBe(false)
    // The whole shape, so a total arrival minute cannot be added back quietly.
    // `branches` is the only optional key and is `undefined` outside `uncertain`.
    expect(Object.keys(result).sort()).toEqual([
      'band', 'bindingSeq', 'branches', 'lastUpdatedAt', 'legs', 'marginMinutes', 'provenance', 'status',
    ])
  })

  it('reports the oldest reading it used', () => {
    const result = deduced(chainInput([
      { updatedAt: NOW - 60_000, vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', updatedAt: NOW - 30_000, vehicles: [vehicle('C', minutes(30), minutes(40))] },
    ]))
    expect(result.lastUpdatedAt).toBe(NOW - 60_000)
  })

  it('does not depend on the order the candidates arrive in', () => {
    const ordered = deduced(chainInput([{
      vehicles: [vehicle('A', minutes(6), minutes(20)), vehicle('B', minutes(12), minutes(30))],
    }]))
    const shuffled = deduced(chainInput([{
      vehicles: [vehicle('B', minutes(12), minutes(30)), vehicle('A', minutes(6), minutes(20))],
    }]))
    expect(shuffled).toEqual(ordered)
  })
})

describe('F10 deduction: 余量 belongs to the vehicle it measures', () => {
  it('ties a non-negative margin to the vehicle the leg boards', () => {
    // With a margin of zero or more the reference and the boarded vehicle are
    // the same one, so the margin and 「哪班车」 agree by construction.
    const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(12), minutes(23))] }]))
    expect(result.legs[0]?.vehicleId).toBe('A')
    expect(result.legs[0]?.marginMinutes).toBe(7)
    expect(result.legs[0]?.referenceVehicleId).toBe('A')
  })

  it('ties a negative margin to the vehicle that has gone, NOT to the one boarded', () => {
    // The 「余量 -2 分」 case: A was next when the user set off and is gone, and
    // the plan is B. A page that put the −2 beside `vehicleId` alone would print
    // 「余量 -2 分」 next to the bus the user will actually board — so the margin
    // states WHICH vehicle it is about.
    const result = deduced(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(3), minutes(15)), vehicle('B', minutes(8), minutes(20))],
    }]))

    expect(result.band).toBe('insufficient')
    expect(result.legs[0]?.vehicleId).toBe('B')
    expect(result.legs[0]?.marginMinutes).toBe(-2)
    expect(result.legs[0]?.referenceVehicleId).toBe('A')
    expect(result.legs[0]?.referenceVehicleId).not.toBe(result.legs[0]?.vehicleId)
  })

  it('names the reference even when a later leg is the binding one', () => {
    const result = deduced(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      {
        lineId: '202',
        connectionSeconds: minutes(5),
        vehicles: [vehicle('C', minutes(22), minutes(40)), vehicle('D', minutes(32), minutes(50))],
      },
    ]))
    expect(result.bindingSeq).toBe(1)
    expect(result.legs[1]?.vehicleId).toBe('D')
    expect(result.legs[1]?.marginMinutes).toBe(-3)
    expect(result.legs[1]?.referenceVehicleId).toBe('C')
  })

  it('keeps the tie between margin and vehicle when the leg\'s own extra is negative', () => {
    // The tie 「equal exactly when the margin is zero or more」 needs the ready
    // moment to be no EARLIER than the set-off moment — a non-negative leg extra.
    // `transferExtraMinutes` is guarded by the schema (`min(0)`), but
    // `cycleExtraMinutes` and direct calls are not: a negative extra puts the user
    // at the platform before they set off, makes a vehicle that left before the
    // set-off moment look catchable, and then measures the margin against a LATER
    // vehicle than the one it says is boarded — the review's margin +6 with
    // mismatched ids. Clamping the effective extra at zero is what makes the tie
    // true for every caller rather than only for the ones the schema happened to
    // guard, and it cannot widen a margin (the clamp only ever delays the ready
    // moment), so no existing answer moves.
    const result = deduced(chainInput(
      [
        { connectionSeconds: 0, vehicles: [vehicle('A', minutes(3), minutes(30))] },
        {
          lineId: '202',
          connectionSeconds: minutes(5),
          connectionMode: 'cycle',
          // The board station is 29 minutes out; the reference is 35 minutes out.
          vehicles: [vehicle('V1', minutes(29), minutes(40)), vehicle('V2', minutes(35), minutes(50))],
        },
      ],
      { cycleExtraMinutes: -6 },
    ))

    const leg = result.legs[1]
    // The extra is zero, so the user is at the platform at minute 35 and the only
    // vehicle they can still board is V2 — the reference and the boarded vehicle
    // are the same one, exactly as the margin of zero requires.
    expect(leg?.marginMinutes).toBe(0)
    expect(leg?.vehicleId).toBe('V2')
    expect(leg?.referenceVehicleId).toBe('V2')
  })
})
