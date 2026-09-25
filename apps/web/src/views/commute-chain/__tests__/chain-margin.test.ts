import { describe, expect, it } from 'vitest'
import type { ChainMarginBand } from '@real-time-transport/shared'
import { CHAIN_TIGHT_MARGIN_MINUTES, chainMarginBandOf } from '@real-time-transport/shared'
import { MARGIN_BAND_COPY, chainConclusionOf, transferRowOf } from '../margin'
import { conclusion, leg } from './chain-fixtures'

/**
 * F10's core, per transfer: 「能不能赶上换乘点那班车」.
 *
 * Three things are load-bearing here and none of them is a rendering detail:
 *
 *  1. the band and the minute are two views of ONE number, so a row cannot say
 *     充裕 beside a margin of 2;
 *  2. the margin is always stated WITH what it was measured against — the vehicle
 *     that was next at this platform when the user set off — because a margin
 *     with no reference is a number about no bus;
 *  3. when that reference has already gone the row prints NO margin, and says the
 *     numbers it does print belong to the NEXT vehicle. Printing 「余量 -2 分」
 *     beside the bus the user is about to board is the one failure this feature
 *     exists to avoid: it reads as that bus's own margin.
 */

/** Everything one row prints, as the user reads it — the surface these rules are about. */
function printedOf(row: ReturnType<typeof transferRowOf>): string {
  return [
    row.positionText,
    row.lineName,
    row.bandLabel,
    row.verdict,
    row.vehicleText,
    row.waitText,
    row.marginText,
    row.basisText,
    row.rideText,
    row.alightText,
  ].filter((text): text is string => text !== null).join(' ')
}

describe('the band and the minute are two views of one number', () => {
  /** The bands as the PRD names them, written out here so a relabelled band fails. */
  const LABELS: Record<ChainMarginBand, string> = {
    comfortable: '充裕',
    tight: '紧',
    uncertain: '不确定',
    insufficient: '不足',
  }

  it('bands a leg by the very margin it prints', () => {
    for (const marginMinutes of [9, 4, 3, 2, 1, 0, -1, -6]) {
      const row = transferRowOf(leg({ marginMinutes }))
      const band = chainMarginBandOf(marginMinutes)
      expect(row.band, `margin ${marginMinutes}`).toBe(band)
      expect(row.bandLabel, `margin ${marginMinutes}`).toBe(LABELS[band])
    }
  })

  it('has no band whose label is missing', () => {
    for (const band of ['comfortable', 'tight', 'uncertain', 'insufficient'] as const) {
      expect(MARGIN_BAND_COPY[band].label).toBe(LABELS[band])
      expect(MARGIN_BAND_COPY[band].verdict.length).toBeGreaterThan(0)
    }
  })
})

/**
 * F-F: the band's WORDS must cover the band the engine has.
 *
 * `chainMarginBandOf` bands 紧 up to the tolerance with that boundary INCLUDED, so
 * the band is margins 1–3 minutes (verified against live readings: a margin of 4
 * bands 充裕, a margin of 3 bands 紧). The copy read 「就这一两分钟」, which is false
 * about the very case the boundary exists for — a row printing 「余量 3 分」 beside a
 * sentence claiming two. The engine is not the thing to fix here: the sentence is.
 */
describe('the 紧 wording covers the band the engine actually bands', () => {
  it('is 紧 at the tolerance itself, and 充裕 one minute beyond it', () => {
    expect(CHAIN_TIGHT_MARGIN_MINUTES).toBe(3)
    expect(chainMarginBandOf(CHAIN_TIGHT_MARGIN_MINUTES)).toBe('tight')
    expect(chainMarginBandOf(CHAIN_TIGHT_MARGIN_MINUTES + 1)).toBe('comfortable')
  })

  it('does not word that band as a two-minute ceiling', () => {
    const verdict = MARGIN_BAND_COPY.tight.verdict
    expect(verdict).not.toContain('一两分')
    expect(verdict).not.toMatch(/[12]\s*分/)
  })

  it('prints the tolerance-margin row with the 紧 verdict and its own number', () => {
    const row = transferRowOf(leg({ marginMinutes: CHAIN_TIGHT_MARGIN_MINUTES, waitMinutes: 3 }))
    expect(row.band).toBe('tight')
    expect(row.verdict).toBe(MARGIN_BAND_COPY.tight.verdict)
    expect(row.marginText).toBe('余量 3 分')
    expect(printedOf(row)).toContain('3 分')
  })
})

describe('a margin is always stated with what it was measured against', () => {
  it('prints the number, and names the vehicle it belongs to, when that vehicle is being boarded', () => {
    const row = transferRowOf(leg({ marginMinutes: 4, waitMinutes: 4 }))
    expect(row.referenceGone).toBe(false)
    expect(row.marginMinutes).toBe(4)
    expect(row.marginText).toBe('余量 4 分')
    expect(row.waitText).toBe('站台等待 4 分')
    expect(row.vehicleText).toBe('乘这一班')
    // What the number measures, in the row's own words: the bus that was next at
    // this platform when the user set off — which here is the one being boarded.
    expect(row.basisText).toContain('出门时最近的一班')
    expect(row.basisText).toContain('就是这一班')
  })

  it('keeps the platform wait the boarded vehicle\'s, and never negative', () => {
    expect(transferRowOf(leg({ marginMinutes: 4, waitMinutes: 4 })).waitMinutes).toBe(4)
    const late = transferRowOf(leg({
      marginMinutes: -2,
      waitMinutes: 6,
      vehicleId: 'provider-vehicle-next',
      referenceVehicleId: 'provider-vehicle-gone',
    }))
    expect(late.waitMinutes).toBe(6)
    expect(late.waitText).toBe('站台等待 6 分')
  })
})

describe('a missed vehicle is never printed as this bus\'s margin', () => {
  /** The case the engine calls `insufficient`: the reference has gone, the plan is the next bus. */
  const missed = leg({
    marginMinutes: -2,
    waitMinutes: 6,
    vehicleId: 'provider-vehicle-next',
    referenceVehicleId: 'provider-vehicle-gone',
  })

  it('prints no margin number at all when the vehicle it measures has gone', () => {
    const row = transferRowOf(missed)
    expect(row.referenceGone).toBe(true)
    expect(row.marginMinutes).toBeNull()
    expect(row.marginText).toBeNull()
    // Not anywhere else either: no negative minute may reach the screen beside the
    // vehicle the user is about to board.
    expect(printedOf(row)).not.toMatch(/-\d/)
    expect(printedOf(row)).not.toContain('余量 -')
  })

  it('says the numbers it does print belong to the next vehicle', () => {
    const row = transferRowOf(missed)
    expect(row.vehicleText).toBe('改乘下一班')
    expect(row.basisText).toContain('出门时最近的一班已经走了')
    expect(row.basisText).toContain('下一班')
    // …and it is still that next vehicle's numbers the row carries.
    expect(row.waitText).toBe('站台等待 6 分')
  })

  it('states the band as insufficient, which is where the missed vehicle is reported', () => {
    const row = transferRowOf(missed)
    expect(row.band).toBe('insufficient')
    expect(row.bandLabel).toBe('不足')
  })

  it('withholds the number when the two signals contradict each other', () => {
    // A payload whose id pair says "another vehicle" while the margin says zero is
    // not a margin this page can attribute to a bus. Both signals are read, and
    // the safe side of a contradiction is to print no number rather than a wrong one.
    const contradicted = transferRowOf(leg({
      marginMinutes: 0,
      vehicleId: 'provider-vehicle-next',
      referenceVehicleId: 'provider-vehicle-gone',
    }))
    expect(contradicted.marginMinutes).toBeNull()
    expect(contradicted.referenceGone).toBe(true)
  })

  it('makes the row coherent when the payload contradicts itself: the band agrees with the withheld number', () => {
    // The ids say "another vehicle" while the margin says zero or better. Both
    // signals are read, so the number is withheld — and the band, the verdict and
    // the vehicle all describe the bus being boarded, so none of them may be read
    // from a number the row just refused to print. 「充裕」 beside 「改乘下一班」 is
    // the contradiction this rule exists to make impossible.
    const contradicted = transferRowOf(leg({
      marginMinutes: 0,
      waitMinutes: 6,
      vehicleId: 'provider-vehicle-next',
      referenceVehicleId: 'provider-vehicle-gone',
    }))
    expect(contradicted.marginMinutes).toBeNull()
    expect(contradicted.referenceGone).toBe(true)
    expect(contradicted.band).toBe('insufficient')
    expect(contradicted.bandLabel).toBe('不足')
    expect(contradicted.verdict).toBe(MARGIN_BAND_COPY.insufficient.verdict)
    expect(contradicted.vehicleText).toBe('改乘下一班')
  })

  it('never states a resolvable band beside 「改乘下一班」, whatever the margin claims', () => {
    for (const marginMinutes of [9, 4, 3, 2, 1, 0, -1, -6]) {
      const row = transferRowOf(leg({
        marginMinutes,
        vehicleId: 'provider-vehicle-next',
        referenceVehicleId: 'provider-vehicle-gone',
      }))
      expect(row.referenceGone, `margin ${marginMinutes}`).toBe(true)
      expect(row.marginMinutes, `margin ${marginMinutes}`).toBeNull()
      expect(row.band, `margin ${marginMinutes}`).toBe('insufficient')
      expect(row.vehicleText, `margin ${marginMinutes}`).toBe('改乘下一班')
      expect(MARGIN_BAND_COPY[row.band].verdict, `margin ${marginMinutes}`)
        .toBe(MARGIN_BAND_COPY.insufficient.verdict)
      expect(printedOf(row), `margin ${marginMinutes}`).not.toContain('余量')
    }
  })

  it('withholds the number from a negative margin even when the ids agree', () => {
    // The engine states the two are equivalent; a payload that broke that would
    // otherwise print a negative margin beside the boarded vehicle.
    const broken = transferRowOf(leg({ marginMinutes: -3 }))
    expect(broken.marginMinutes).toBeNull()
    expect(printedOf(broken)).not.toMatch(/-\d/)
  })
})

describe('the vehicle is named the way this app names vehicles', () => {
  it('never prints the reading\'s own vehicle id', () => {
    // `LiveBusSchema.id` is the provider's internal handle, and a generated train's
    // is the model's own name (`train_<lineId>_d<direction>_dep<i>`). No screen in
    // this app prints one, and this page must not start.
    const row = transferRowOf(leg({
      vehicleId: 'train_subway_027_88_d0_dep3',
      referenceVehicleId: 'train_subway_027_88_d0_dep8',
      marginMinutes: -1,
    }))
    const printed = printedOf(row)
    expect(printed).not.toContain('train_')
    expect(printed).not.toContain('dep3')
    expect(printed).not.toContain('subway_027_88')
  })
})

describe('the chain states its tightest margin, and which transfer it belongs to', () => {
  it('reads the chain band from the binding leg, not from the first one', () => {
    const chain = conclusion([
      leg({ seq: 0, marginMinutes: 9, alightMinutes: 12 }),
      leg({ seq: 1, lineName: '地铁 88 号线', marginMinutes: 2, alightMinutes: 20, provenance: 'schedule_simulation' }),
    ])
    const view = chainConclusionOf(chain)
    expect(view.band).toBe('tight')
    expect(view.bandLabel).toBe('紧')
    expect(view.marginMinutes).toBe(2)
    expect(view.marginText).toBe('余量 2 分')
    expect(view.bindingSeq).toBe(1)
    expect(view.bindingText).toBe('最紧的是第 2 段 · 地铁 88 号线')
  })

  it('states a gone reference in words rather than printing its negative margin', () => {
    const chain = conclusion([
      leg({ seq: 0, marginMinutes: 9 }),
      leg({ seq: 1, marginMinutes: -2, vehicleId: 'provider-vehicle-next', referenceVehicleId: 'provider-vehicle-gone' }),
    ])
    const view = chainConclusionOf(chain)
    expect(view.band).toBe('insufficient')
    expect(view.marginMinutes).toBeNull()
    expect(view.marginText).toBeNull()
    expect(view.verdict).toBe('赶不上出门时的那班 · 实际是下一班')
    expect(`${view.marginText ?? ''} ${view.bindingText}`).not.toMatch(/-\d/)
  })

  it('withholds the chain margin whenever the chain\'s own band says the reference has gone', () => {
    // The chain's band is the engine's own, read from the binding margin — so a
    // payload whose band says 不足 while its margin is not negative contradicts
    // itself, and 不足 beside 「余量 4 分」 is exactly the pair this page may not
    // print. (Unreachable through the engine, which derives the band from the same
    // number; this is the page not printing a contradiction it was handed.)
    const view = chainConclusionOf(conclusion(
      [leg({ seq: 0, marginMinutes: 4 })],
      { band: 'insufficient', marginMinutes: 4 },
    ))
    expect(view.band).toBe('insufficient')
    expect(view.marginMinutes).toBeNull()
    expect(view.marginText).toBeNull()
    expect(view.verdict).toBe(MARGIN_BAND_COPY.insufficient.verdict)
    expect(`${view.marginText ?? ''} ${view.bindingText}`).not.toContain('余量')
  })

  it('never adds the legs up into a total', () => {
    // The chain ends at its last leg's alight station: there is no destination and
    // no total arrival minute, and none may be computed here.
    const view = chainConclusionOf(conclusion([
      leg({ seq: 0, alightMinutes: 12, rideMinutes: 8 }),
      leg({ seq: 1, alightMinutes: 20, rideMinutes: 10, marginMinutes: 2 }),
    ]))
    expect(view.legs.map(item => item.alightText)).toEqual(['12 分钟后到下车站', '20 分钟后到下车站'])
    const printed = view.legs.map(printedOf).join(' ')
    // 12 + 20 = 32 is the number a tail total would print, and it must appear nowhere.
    expect(printed).not.toContain('32')
  })
})

describe('a margin too small to resolve gets two readings, and invents neither', () => {
  it('names both branches when the reading carries a following vehicle', () => {
    const chain = conclusion([leg({ marginMinutes: 0, waitMinutes: 3, alightMinutes: 14 })], {
      branches: {
        asPlanned: { vehicleId: 'provider-vehicle-1', alightMinutes: 14 },
        nextVehicle: { vehicleId: 'provider-vehicle-2', alightMinutes: 26 },
      },
    })
    const view = chainConclusionOf(chain)
    expect(view.band).toBe('uncertain')
    expect(view.branches).toEqual([
      { outcomeText: '赶得上就是这一班', detailText: '14 分钟后到下车站' },
      { outcomeText: '赶不上就是下一班', detailText: '26 分钟后到下车站' },
    ])
  })

  it('states that no following vehicle was read, rather than naming a minute for one', () => {
    const chain = conclusion([leg({ marginMinutes: 0 })], {
      branches: {
        asPlanned: { vehicleId: 'provider-vehicle-1', alightMinutes: 14 },
        nextVehicle: { vehicleId: null, alightMinutes: null },
      },
    })
    const view = chainConclusionOf(chain)
    expect(view.branches?.[1]).toEqual({ outcomeText: '赶不上就是下一班', detailText: '后续班次未读到' })
    expect(view.branches?.[1].detailText).not.toMatch(/\d/)
  })

  it('states a missing minute as missing when the vehicle itself is known', () => {
    const chain = conclusion([leg({ marginMinutes: 0 })], {
      branches: {
        asPlanned: { vehicleId: 'provider-vehicle-1', alightMinutes: null },
        nextVehicle: { vehicleId: 'provider-vehicle-2', alightMinutes: null },
      },
    })
    const view = chainConclusionOf(chain)
    expect(view.branches?.map(branch => branch.detailText))
      .toEqual(['到站时间未读到', '到站时间未读到'])
    expect(JSON.stringify(view.branches)).not.toContain('0 分钟')
  })

  it('states no branch when the margin is resolvable', () => {
    const chain = conclusion([leg({ marginMinutes: 4 })], {
      // A payload that carried branches beside a resolvable margin: the band is the
      // single answer and the two readings would contradict it, so they are not stated.
      branches: {
        asPlanned: { vehicleId: 'provider-vehicle-1', alightMinutes: 14 },
        nextVehicle: { vehicleId: 'provider-vehicle-2', alightMinutes: 26 },
      },
    })
    expect(chainConclusionOf(chain).branches).toBeNull()
  })
})
