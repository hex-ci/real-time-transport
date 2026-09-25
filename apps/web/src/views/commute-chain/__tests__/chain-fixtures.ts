import type {
  ChainDeduction,
  ChainLegDeduction,
  ChainNoConclusion,
  ChainNoConclusionReason,
  CommuteChainDeductionView,
  RefreshLiveResult,
} from '@real-time-transport/shared'
import { chainMarginBandOf, listProvenanceOf } from '@real-time-transport/shared'

/**
 * The fixtures F10's page tests are written against.
 *
 * Every number here is one the ENGINE produces: a band is never written by hand
 * (it is `chainMarginBandOf` of the very margin beside it) and a chain's
 * provenance is `listProvenanceOf` of its own legs, so a fixture cannot state a
 * relationship the contract does not.
 */

/** The instant the fixtures report as a reading's own. */
export const READ_AT = 1_700_000_000_000

/** F3's operating state, as a running line states it. */
export const OPERATING = { state: 'operating', firstDeparture: '05:30', lastDeparture: '23:00' } as const

/** One leg of a deduced chain. Defaults to a leg whose margin is comfortably positive. */
export function leg(overrides: Partial<ChainLegDeduction> = {}): ChainLegDeduction {
  return {
    seq: 0,
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    vehicleId: 'provider-vehicle-1',
    referenceVehicleId: 'provider-vehicle-1',
    provenance: 'live',
    operatingStatus: OPERATING,
    waitMinutes: 4,
    alightMinutes: 12,
    rideMinutes: 8,
    marginMinutes: 4,
    ...overrides,
  }
}

/** A deduced chain, with the band, the margin and the binding leg derived from its own legs. */
export function conclusion(
  legs: ChainLegDeduction[],
  overrides: Partial<ChainDeduction> = {},
): ChainDeduction {
  const binding = legs.reduce(
    (tightest, item) => (item.marginMinutes < tightest.marginMinutes ? item : tightest),
    legs[0]!,
  )
  return {
    status: 'deduced',
    band: chainMarginBandOf(binding.marginMinutes),
    marginMinutes: binding.marginMinutes,
    bindingSeq: binding.seq,
    legs,
    provenance: listProvenanceOf(legs),
    lastUpdatedAt: READ_AT,
    ...overrides,
  }
}

/** The refusal a chain's answer can be instead of a deduction. */
export function refusal(
  reason: ChainNoConclusionReason,
  overrides: Partial<ChainNoConclusion> = {},
): ChainNoConclusion {
  return { status: 'no-conclusion', reason, ...overrides }
}

/** One chain as the endpoint sends it. */
export function chainView(
  deduction: CommuteChainDeductionView['deduction'],
  overrides: Partial<CommuteChainDeductionView> = {},
): CommuteChainDeductionView {
  return {
    chainId: 'chain-1',
    name: '上班 · 一路换乘',
    originAnchor: 'home',
    purpose: 'morning',
    deduction,
    ...overrides,
  }
}

/**
 * The refresh endpoint's answer, as it sends one.
 *
 * The reading's instant is the engine's own (`lastUpdatedAt`) and the lines carry
 * the instant and the kind of the reading each one obtained — the store derives the
 * freshness line from those, never from the clock, so a fixture that stamped the
 * answer with `Date.now()` would prove nothing about what the page prints.
 */
export function refreshAnswer(overrides: Partial<RefreshLiveResult> = {}): RefreshLiveResult {
  return {
    dataClass: 'live',
    throttled: false,
    lastUpdatedAt: READ_AT,
    nextAllowedAt: READ_AT + 30_000,
    retryAfterSeconds: 30,
    lines: [{
      lineId: 'bus_027_1',
      direction: 0,
      lastUpdatedAt: READ_AT,
      dataSource: 'chelaile',
      isDegraded: false,
    }],
    ...overrides,
  }
}
