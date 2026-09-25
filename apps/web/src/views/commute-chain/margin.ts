import { chainMarginBandOf } from '@real-time-transport/shared'
import type { ChainBranch, ChainBranches, ChainDeduction, ChainLegDeduction, ChainMarginBand } from '@real-time-transport/shared'
import type { BranchView, ChainConclusionView, TransferRowView } from './types'

/**
 * F10's core, as the row states it: 「能不能赶上换乘点那班车」, per transfer.
 *
 * The band and the minute are two views of ONE number (`chainMarginBandOf`), and
 * this module is where that contract becomes words: a row cannot say 充裕 beside
 * 「余量 1 分」, because both come from the same `marginMinutes` and neither is
 * recomputed here. Nothing in this file decides a minute, a band or a verdict —
 * the engine decided all three — and the only judgement it makes is WHICH vehicle
 * a number belongs to, which is the one thing a row can get wrong by itself.
 *
 * THE MARGIN'S OWNER. `marginMinutes` is measured against the vehicle that was
 * next at this platform when the user set off (`referenceVehicleId`), which is the
 * vehicle being boarded exactly while that margin is zero or more. In the
 * `insufficient` case the reference has already gone and the plan below it is the
 * next vehicle — and that row is precisely the one that would otherwise print
 * 「余量 -2 分」 beside the bus the user is walking to. So a gone reference prints
 * NO margin at all, and the row says of the numbers it does print that they are the
 * next vehicle's. The withheld number is not information lost: the band (不足) and
 * the two branch readings state the outcome, and a negative minute attributed to
 * the wrong bus is worse than no minute.
 *
 * A NEGATIVE MARGIN IS NEVER PRINTED, anywhere: not on a leg row and not on the
 * chain, whose `marginMinutes` is its tightest leg's. The engine's own tie is read
 * from both sides (`referenceVehicleId` differing from `vehicleId`, or the margin
 * being negative), so a payload that contradicted itself would withhold the number
 * rather than print one that belongs to a bus it does not name.
 *
 * The vehicle is NOT named by its id: the engine's `vehicleId` is the provider's
 * handle, and a generated train's is the model's own name
 * (`train_<lineId>_d<direction>_dep<i>`) — no screen in this app prints one, so a
 * row identifies its vehicle by the platform wait and the alight minute, which is
 * how the other screens state a vehicle too.
 */

/**
 * The band, in the words the product uses for it.
 *
 * The three resolvable bands are the PRD's own — 充裕 → 就是这班, 紧 → 就这几分钟,
 * 不足 → 实际是下一班 — with the 紧 wording covering the band the ENGINE actually
 * has: `chainMarginBandOf` bands 紧 up to `CHAIN_TIGHT_MARGIN_MINUTES`
 * (= F1's tolerance, 3 by default) with that boundary included, so the band is
 * margins 1–3 minutes and its words must not claim a narrower ceiling (「一两分钟」
 * was the old wording, and it was false for the 3-minute case the band includes).
 * The fourth is the honest-degradation case the PRD asks for: a margin inside the
 * error magnitude has no single answer, so its words state the two readings
 * instead of picking one.
 */
export const MARGIN_BAND_COPY: Record<ChainMarginBand, { label: string, verdict: string }> = {
  comfortable: { label: '充裕', verdict: '赶得上 · 就是这班' },
  tight: { label: '紧', verdict: '赶得上 · 就这几分钟' },
  uncertain: { label: '不确定', verdict: '赶不赶得上，看是不是正好这一班' },
  insufficient: { label: '不足', verdict: '赶不上出门时的那班 · 实际是下一班' },
}

/** One transfer, as the row prints it. */
export function transferRowOf(leg: ChainLegDeduction): TransferRowView {
  // Both sides of the engine's own tie (see the file header): the id pair says
  // which vehicle the margin was measured against, and a negative margin says the
  // same. Either one on its own withholds the number.
  const referenceGone = leg.referenceVehicleId !== leg.vehicleId || leg.marginMinutes < 0
  // THE BAND FOLLOWS THE ROW'S OWN VEHICLE, not the raw number. The engine's
  // `referenceVehicleId === vehicleId ⟺ margin >= 0` is what makes the two the same
  // question, and a payload that broke it (ids differing while the margin is not
  // negative — unreachable through the engine, since a user's negative extra time is
  // clamped there) must not produce a row that says 充裕 beside 「改乘下一班」: the
  // band, the verdict and the vehicle all describe the boarded bus, and this row
  // just withheld the only number they could have been read from. So when the
  // reference has gone the band is 不足, whatever the margin claims.
  const band: ChainMarginBand = referenceGone ? 'insufficient' : chainMarginBandOf(leg.marginMinutes)
  const copy = MARGIN_BAND_COPY[band]
  const marginMinutes = referenceGone ? null : leg.marginMinutes

  return {
    seq: leg.seq,
    positionText: `第 ${leg.seq + 1} 段`,
    lineName: leg.lineName,
    band,
    bandLabel: copy.label,
    verdict: copy.verdict,
    vehicleText: referenceGone ? '改乘下一班' : '乘这一班',
    waitMinutes: leg.waitMinutes,
    waitText: `站台等待 ${leg.waitMinutes} 分`,
    marginMinutes,
    marginText: marginMinutes === null ? null : `余量 ${marginMinutes} 分`,
    // What the numbers above are measured against, in both cases — the fact the
    // row may never leave to the reader: a margin with no reference is a number
    // about no bus, and a row whose reference has gone is a row about the NEXT one.
    basisText: referenceGone
      ? '出门时最近的一班已经走了，这一行的等待与到站时间都是下一班的'
      : '余量按出门时最近的一班算 · 就是这一班',
    referenceGone,
    rideText: `车程约 ${leg.rideMinutes} 分`,
    alightText: `${leg.alightMinutes} 分钟后到下车站`,
    provenance: leg.provenance,
  }
}

/**
 * A deduced chain, as its card prints it.
 *
 * The chain's own number is its BINDING margin — the engine's smallest, the one
 * the band was read from — so the word, the chip and the minute cannot disagree.
 * The chain ends at its last leg's alight station: nothing here sums the legs, and
 * no total arrival minute is computed, because the chain records a start and no
 * destination.
 */
export function chainConclusionOf(deduction: ChainDeduction): ChainConclusionView {
  const copy = MARGIN_BAND_COPY[deduction.band]
  const legs = deduction.legs.map(transferRowOf)
  const binding = legs.find(row => row.seq === deduction.bindingSeq)
  // The chain's margin is a signed quantity and is printed only while the vehicle
  // it measures is still there — the same rule the leg rows follow, for the same
  // reason: the bus being walked to must not be given the missed one's minute. The
  // band is the engine's own (the chain's binding leg), so a payload whose band says
  // the reference has gone while its margin is not negative cannot state the two
  // together: 不足 beside 「余量 2 分」 is the contradiction this page must not print.
  const marginMinutes = deduction.band === 'insufficient' || deduction.marginMinutes < 0
    ? null
    : deduction.marginMinutes

  return {
    band: deduction.band,
    bandLabel: copy.label,
    verdict: copy.verdict,
    marginMinutes,
    marginText: marginMinutes === null ? null : `余量 ${marginMinutes} 分`,
    bindingSeq: deduction.bindingSeq,
    bindingText: binding
      ? `最紧的是第 ${deduction.bindingSeq + 1} 段 · ${binding.lineName}`
      : `最紧的是第 ${deduction.bindingSeq + 1} 段`,
    // The two readings belong to the binding leg and exist for exactly one band.
    // A payload that carried them beside a resolvable margin is not stated: the
    // band is then a single answer, and two readings would contradict it.
    branches: deduction.band === 'uncertain' && deduction.branches
      ? branchesOf(deduction.branches)
      : null,
    legs,
  }
}

/**
 * The two readings of an unresolvable margin, worded.
 *
 * A branch whose reading carries no following vehicle, or no minute for it, states
 * that absence — 「后续班次未读到」 / 「到站时间未读到」. An invented 「下一班」 would
 * be exactly the false certainty this case exists to avoid.
 */
export function branchesOf(branches: ChainBranches): BranchView[] {
  return [
    branchOf(branches.asPlanned, '赶得上就是这一班'),
    branchOf(branches.nextVehicle, '赶不上就是下一班'),
  ]
}

function branchOf(branch: ChainBranch, outcomeText: string): BranchView {
  if (branch.vehicleId === null) return { outcomeText, detailText: '后续班次未读到' }
  if (branch.alightMinutes === null) return { outcomeText, detailText: '到站时间未读到' }
  return { outcomeText, detailText: `${branch.alightMinutes} 分钟后到下车站` }
}
