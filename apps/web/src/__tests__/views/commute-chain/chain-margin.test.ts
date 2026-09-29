import { describe, expect, it } from 'vitest'
import type { ChainMarginBand } from '@real-time-transport/shared'
import { CHAIN_TIGHT_MARGIN_MINUTES, chainMarginBandOf } from '@real-time-transport/shared'
import { MARGIN_BAND_COPY, chainConclusionOf, transferRowOf } from '../margin'
import { conclusion, leg } from './chain-fixtures'

/**
 * F10 的核心，按换乘计：「能不能赶上换乘点那班车」。
 *
 * 三点承重，且都不是渲染细节：
 *
 *  1. 档位与分钟是同一个数字的两个视角，故一行不能在余量为 2 时还说「充裕」；
 *  2. 余量总是**连同**它所对照之物一起陈述——用户出发时在此站台下一班的车——因为没有参照的
 *     余量是一个关于无车的数字；
 *  3. 该参照已走时，该行不印余量，并声明它所印的数字属于**下一班**车。在用户即将上的车旁印
 *     「余量 -2 分」正是本特性要避免的失败：它会被读成那班车自己的余量。
 */

/** 一行所印的全部，如用户读到——这些规则所关于的表面。 */
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
  /** PRD 命名的档位，写在此处，使改名的档位会失败。 */
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
 * F-F：档位的**措辞**必须覆盖引擎实际划分的档位。
 *
 * `chainMarginBandOf` 把「紧」划到容忍度为止且**包含**该边界，故该档是 1–3 分钟。文案曾写
 * 「就这一两分钟」，与它存在所针对的情形不符——一行印「余量 3 分」而句子里说两分钟。
 * 此处要改的不是引擎，是那句话。
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
    // 该数字所测为何，用该行自己的话：用户出发时此站台下一班的车——此处即正要上的那班。
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
  /** 引擎称为 `insufficient` 的情形：参照已走，计划是下一班。 */
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
    // 别处也不行：不得有负分钟到达用户即将上车的车辆旁。
    expect(printedOf(row)).not.toMatch(/-\d/)
    expect(printedOf(row)).not.toContain('余量 -')
  })

  it('says the numbers it does print belong to the next vehicle', () => {
    const row = transferRowOf(missed)
    expect(row.vehicleText).toBe('改乘下一班')
    expect(row.basisText).toContain('出门时最近的一班已经走了')
    expect(row.basisText).toContain('下一班')
    // ……而该行携带的仍是那下一班车的数字。
    expect(row.waitText).toBe('站台等待 6 分')
  })

  it('states the band as insufficient, which is where the missed vehicle is reported', () => {
    const row = transferRowOf(missed)
    expect(row.band).toBe('insufficient')
    expect(row.bandLabel).toBe('不足')
  })

  it('withholds the number when the two signals contradict each other', () => {
    // 载荷的 id 对说「别的车」而余量说零，这不是本页能归给某班车的余量。两个信号都被读取，
    // 矛盾的稳妥一侧是不印数字而非印错的数字。
    const contradicted = transferRowOf(leg({
      marginMinutes: 0,
      vehicleId: 'provider-vehicle-next',
      referenceVehicleId: 'provider-vehicle-gone',
    }))
    expect(contradicted.marginMinutes).toBeNull()
    expect(contradicted.referenceGone).toBe(true)
  })

  it('makes the row coherent when the payload contradicts itself: the band agrees with the withheld number', () => {
    // id 说「别的车」而余量为零或更好。两个信号都被读取，故不印该数字——且档位、判决与车辆
    // 都描述正在上的那班车，故它们都不得取自该行刚拒绝印的数字。在「改乘下一班」旁写「充裕」
    // 正是本规则要使之不可能的矛盾。
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
    // 引擎陈述两者等价；破坏该关系的载荷否则会在已上车车辆旁印出负余量。
    const broken = transferRowOf(leg({ marginMinutes: -3 }))
    expect(broken.marginMinutes).toBeNull()
    expect(printedOf(broken)).not.toMatch(/-\d/)
  })
})

describe('the vehicle is named the way this app names vehicles', () => {
  it('never prints the reading\'s own vehicle id', () => {
    // `LiveBusSchema.id` 是提供方的内部句柄，生成列车的则是模型自己的名字
    // （`train_<lineId>_d<direction>_dep<i>`）。本应用没有屏幕印它，本页也绝不能开始印。
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
    // 链路的档位是引擎自己的，从约束余量读出——故载荷说「不足」而其余量非负即自相矛盾，
    // 而「不足」与「余量 4 分」并列正是本页不得印的一对。（经由引擎不可达，它从同一个数字推出档位；
    // 这里是页面不印别人递给它的矛盾。）
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
    // 链路止于其最后一段的下车站：没有目的地、没有总到站分钟，此处也不得计算。
    const view = chainConclusionOf(conclusion([
      leg({ seq: 0, alightMinutes: 12, rideMinutes: 8 }),
      leg({ seq: 1, alightMinutes: 20, rideMinutes: 10, marginMinutes: 2 }),
    ]))
    expect(view.legs.map(item => item.alightText)).toEqual(['12 分钟后到下车站', '20 分钟后到下车站'])
    const printed = view.legs.map(printedOf).join(' ')
    // 12 + 20 = 32 是尾部合计会印的数字，它必须不出现于任何地方。
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
      // 载荷在可解析余量旁携带分支：档位是唯一答案，两个读数会与之矛盾，故不陈述。
      branches: {
        asPlanned: { vehicleId: 'provider-vehicle-1', alightMinutes: 14 },
        nextVehicle: { vehicleId: 'provider-vehicle-2', alightMinutes: 26 },
      },
    })
    expect(chainConclusionOf(chain).branches).toBeNull()
  })
})
