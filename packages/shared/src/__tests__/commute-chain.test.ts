import { describe, expect, it } from 'vitest'

import {
  CHAIN_ERROR_MAGNITUDE_MINUTES,
  CHAIN_TIGHT_MARGIN_MINUTES,
  CONNECTION_REFUSAL_CODES,
  DEFAULT_CYCLE_EXTRA_MINUTES,
  anchorForPurpose,
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
import { CommuteChainAnchorSchema, CommuteChainLegSchema } from '../schemas/api.js'
import type { CommuteChainLeg, CommuteChainPurpose } from '../schemas/api.js'
import type { DataSourceType, OperatingStatus } from '../schemas/transit.js'

/**
 * 线路自己的服务时刻，F3 据此导出状态。
 * 除注明外，本套件每段都是 运营中：时钟是 `NOW`，即各 fixture 所属运营日的北京时间 06:13:20。
 */
const OPERATING: OperatingStatus = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' }

/**
 * F10 的链路推演，在其边界上。
 *
 * 引擎是纯的，故行展示的每个数字都在此决定：余量（进而带位）、每段上哪辆车、
 * 每个分钟的 F4 标记，以及诚实答案是「无法给出结论」的每一种情形。
 * 所有站与线的取值都是合成的占位符 —— 本套件从不携带任何人的真实通勤。
 *
 * 两组数字重要。一是四个带位，其阈值就是 F1 的（`CHAIN_TIGHT_MARGIN_MINUTES` = T）
 * 加上整分余量的分辨率（`CHAIN_ERROR_MAGNITUDE_MINUTES`）；
 * 二是决定性路段：有多次上车时，结论属于最紧的那次，而不是第一次。
 */

/** 固定时钟：引擎读的是读数的**年龄**，绝不是墙上时钟。 */
const NOW = 1_700_000_000_000

const BOARD_STATION = { name: '甲乙路', order: 3 }
const ALIGHT_STATION = { name: '丙丁路', order: 8 }

/** 线上分钟数，按卡片展示口径。 */
function minutes(n: number): number {
  return n * 60
}

interface LegSpec {
  seq?: number
  lineId?: string
  /** `null` = 从未选择。缺省 = 默认的站点配对。 */
  board?: { name: string, order: number } | null
  alight?: { name: string, order: number } | null
  transferExtraMinutes?: number | null
  /** 进入本路段的接驳秒数；`null` = 未计价。 */
  connectionSeconds?: number | null
  /**
   * 接驳为什么没有计价时长，由尝试计价的调用方给出原因。缺省 = 调用方说不清。
   */
  connectionUnpricedReason?: ChainConnectionUnpricedReason
  connectionMode?: 'walk' | 'cycle'
  /** `null` = 线路从未读取；`[]` = 读过，没有车在途。 */
  vehicles?: readonly ChainLegVehicle[] | null
  /**
   * **看板**读数自己的已计价行在配对**之前**携带了多少辆车 —— 仍要抵达看板站序的行。
   * 默认为配对后的计数，即一致（正向）读数的取值，因为配对行是看板读数自身行的子集；
   * 想让两者不一致的用例需显式说明。
   */
  boardVehiclesOnTheWay?: number
  dataSource?: DataSourceType | null
  updatedAt?: number
  isDegraded?: boolean
  /** 该路段的 F3 运营状态，按装配层的推导。默认 运营中。 */
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
    // 已存的那一列：没给就是「没选过」（NULL），绝不默认成步行 —— 默认值会把
    // 「没人选过」与「选了步行」变成同一个值，而引擎问的正是这个区别。
    connectionMode: spec.connectionMode ?? null,
  }
}

function chainInput(specs: LegSpec[], extra: Partial<CommuteChainDeductionInput> = {}): CommuteChainDeductionInput {
  return {
    now: NOW,
    ...extra,
    legs: specs.map((spec, seq): ChainLegInput => ({
      leg: storedLeg(spec, spec.seq ?? seq),
      connectionSeconds: spec.connectionSeconds === undefined ? minutes(5) : spec.connectionSeconds,
      // 只在调用方能说出原因时才带原因：接驳已计价的路段，以及说不清某段为何未计价的调用方，都不给原因。
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

/** 一辆候选车辆：同一辆车在上车站与下车站的 ETA。 */
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
   * 整张映射，经由公开入口端到端驱动。两列必须互相印证：
   * 从「非所报余量」读出的带位会使其一失败。
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
      // 带位是本结果所报余量的函数，而不是别的任何东西的函数。
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
    // F1：slack = eta - walk，slack <= T 时为 hurry。同样的数字、同样的边界，
    // 因为链的容忍值就是 F1 的。
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
    // 链所对的那辆车已经走了；方案是下一辆。
    expect(result.legs[0]?.vehicleId).toBe('B')
    expect(result.legs[0]?.waitMinutes).toBe(3)
    expect(result.legs[0]?.marginMinutes).toBe(-2)
    expect(result.legs[0]?.alightMinutes).toBe(20)
  })

  it('puts no quantity beside a refusal — only the reason and which leg refused', () => {
    // 一次拒绝不携带余量、分钟与方案：拒绝旁边的数字正是该拒绝存在的意义所要避免的猜测答案。
    // 而「哪一段拒绝」不是这样的数字（见 `ChainNoConclusion`），故它可以随行。
    const result = deduceCommuteChain(chainInput([{ vehicles: null }]))
    expect(result.status).toBe('no-conclusion')
    expect(Object.keys(result).sort()).toEqual(['leg', 'reason', 'status'])
  })
})

describe('F10 deduction: the tightest boarding decides the chain', () => {
  it('takes the smallest margin, not the first leg\'s', () => {
    // 第 0 段有 6 分钟富余（单独看是充裕）；第 1 段只有 1 分钟。
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
    // 第 0 段在 20 分钟到达；换乘步行 5 分钟，故用户 25 分钟到第二段的上车站。
    // 26 分钟到的车赶得上、富余 1 分钟；22 分钟到的赶不上。
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
    // 原始余量 185 秒超过 3 分钟；展示分钟是 6 - 3 = 3，在容忍值之内。
    // 用原始秒算出的带位会在「余量 3 分」旁边说 充裕 —— 同一行里两个量互相矛盾。
    const result = deduced(chainInput([{
      connectionSeconds: 190,
      vehicles: [vehicle('A', 375, minutes(25))],
    }]))
    expect(result.legs[0]?.marginMinutes).toBe(3)
    expect(result.band).toBe('tight')
  })

  it('rounds each reading as the row shows it and then subtracts, like F1', () => {
    // 「3 分钟后到」-「车 6 分钟到」= 余量 3 分。改去取整那个差值（121 秒）会在同样两个读数旁印出 余量 2 分：
    // 第三个既不属于前者也不属于后者的数字。
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
      // 展示的余量就是决定性路段自己展示的余量。
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
    // 分支 A：链所对的那辆车赶上了。
    expect(result.branches?.asPlanned).toEqual({ vehicleId: 'A', alightMinutes: 20 })
    // 分支 B：没赶上，实际乘的是下一辆。
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
    // 第 0 段单独看很充裕（6 分钟富余）。紧的是第 1 段：第 0 段 25 分钟到达、换乘 5 分钟，
    // 故用户在第 1 段上车站的 30 分钟处 —— 恰是其参考车抵达的时刻。
    // 故两个读数都是关于第 1 段的车的，点名第 0 段的车就是在从不属于第 0 段的余量旁边放错公交。
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

  it('states 实时 for a real vehicle\'s minute however that minute was produced', () => {
    // 词汇表不再有「本应用自算」那一档，故真实车辆的非缺席分钟一律读作 实时。
    const result = deduced(chainInput([{
      vehicles: [vehicle('A', minutes(6), minutes(20), 'our_estimate')],
    }]))
    expect(result.legs[0]?.provenance).toBe('live')
    expect(result.provenance).toBe('live')
  })

  it('marks an observation of the vehicle at the platform 实时', () => {
    // 用户抵达时车已在站台（两者之间没有步行）。
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
    // 一个词会对链的一部分说谎，故链什么都不陈述。
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
    // 链记录起点而从不记录目的地，故锚点从未保存的链根本没有可出发的起点 ——
    // 而那是关于已存设置的事实，不是关于服务、也不是关于我们对它读数的事实。
    // 它走自己的码，且用 F1 的空状态对同一事实所用的同一个词（`anchor-unset`），
    // 故该行可以指向设置，而不是印一句关于没人能计价的接驳的话。
    const result = deduceCommuteChain(chainInput([{
      connectionSeconds: null,
      connectionUnpricedReason: 'anchor-unset',
      vehicles: null,
    }]))

    if (result.status !== 'no-conclusion') throw new Error(`expected a refusal, got ${result.band}`)
    expect(result.reason).toBe('anchor-unset')
    expect(result.reason).not.toBe('connection-unpriced')
    // 关于哪一段与其它拒绝一样陈述：接驳始于锚点的那一段就是第一段。
    expect(result.leg).toEqual({ seq: 0, lineId: '101', lineName: '101路' })
  })

  it('keeps every cause the user cannot act on in ONE code, whichever one the caller names', () => {
    // 原因集**推导**自引擎自己的表，绝不在此手写：`CONNECTION_REFUSAL_CODES` 是
    // `ChainConnectionUnpricedReason` 上的全量 `Record`，故它的键**就是**整套词汇 ——
    // 任何原因缺码时引擎都编译不过。手写的集合不可能精确，因为它唯一会变旧的时刻正是没人看的时刻：
    // 往词汇里加了原因，它只是少一项，下面的循环就少一次可以出错的机会，于是守卫在覆盖更少的情况下通过。
    // 改为推导则：上游加了一个原因，它会自动出现在此处；而被**移到**别个码的原因会在下面失败，而不是掉出循环。
    const CAUSES = Object.keys(CONNECTION_REFUSAL_CODES) as ChainConnectionUnpricedReason[]

    // 链自身的起点锚点是用户唯一可行动的原因（上面那个用例正是让它可行动的原因），
    // 故只有它走自己的码。断言这个划分 —— 而不只是断言预期的原因落到通用码 ——
    // 才在某个**别的**原因被映射到 `anchor-unset` 时失败。
    expect(CAUSES.filter(cause => CONNECTION_REFUSAL_CODES[cause] === 'anchor-unset'))
      .toEqual(['anchor-unset'])

    // 其余每个原因 —— 线路详情读不到、已存车站不在该方向的停靠列表里、列表有该站但没给坐标、
    // 或路径服务没计价出路线 —— 共用一个码。它们都不给用户任何动作，也不是关于答案的事实，
    // 故各自由一个页面能用一句诚实的话作答的码披露：`connection-unpriced`。
    // 那句话不承诺可重试，因为这些原因的持久性不同（见 `ChainNoConclusionReason`）。
    const unactable = CAUSES.filter(cause => cause !== 'anchor-unset')
    expect(unactable.length).toBeGreaterThan(0)
    for (const cause of unactable) {
      expect(CONNECTION_REFUSAL_CODES[cause], cause).toBe('connection-unpriced')
      expect(refusal(chainInput([{ connectionSeconds: null, connectionUnpricedReason: cause }])), cause)
        .toBe('connection-unpriced')
    }

    // 说不清原因的调用方就什么都不给，落到同一个码 —— 那是进入该码唯一不自带原因的途径。
    expect(refusal(chainInput([{ connectionSeconds: null }]))).toBe('connection-unpriced')
  })

  it('refuses when a line was never read, and when no vehicle is on its way', () => {
    expect(refusal(chainInput([{ vehicles: null }]))).toBe('no-live')
    expect(refusal(chainInput([{ vehicles: [] }]))).toBe('no-vehicle')
  })

  it('separates nothing on the way from a reading that shares no vehicle', () => {
    // (1) 看板读数本身什么都没带：没有车在开往这个上车站。这是关于服务的事实。
    expect(refusal(chainInput([{ vehicles: [], boardVehiclesOnTheWay: 0 }]))).toBe('no-vehicle')
    // (2) 看板读数带了车，但两份定向读数没有共同 id。
    // 那是关于**我们自己读数**的事实 —— 同样是空配对 ——
    // 而把它叫做「没有可乘的车」会描述服务，实情却是关于我们比较的那两份快照。
    expect(refusal(chainInput([{ vehicles: [], boardVehiclesOnTheWay: 3 }]))).toBe('no-shared-vehicle')
  })

  it('refuses when nothing on the way is still catchable', () => {
    // 全都已经过站，或在步行走完前就到、其后也没有车：没有可供推演的方案。
    expect(refusal(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(1), minutes(10))],
    }]))).toBe('no-vehicle-after-connection')
  })

  it('separates the vehicle that left during the walk from one that left before it began', () => {
    // (3) 用户出发时还有车要来 —— 但它在 5 分钟接驳走完前就抵达上车站：
    // 它在用户还在路上时就走了。「连走过去的那趟都赶不上」。
    expect(refusal(chainInput([{
      connectionSeconds: minutes(5),
      vehicles: [vehicle('A', minutes(1), minutes(10))],
    }]))).toBe('no-vehicle-after-connection')

    // (4) 到用户来得及出发去这个上车站时，每辆车都已到过那里：连「差一点」都谈不上。
    // 只有更靠后的路段会是这种状态，因为第 0 段在 0 分钟出发。
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
    // 一个不在任何东西下游的下车分钟：这两个数不描述同一趟行程，无法从它们为任何路段定价。
    expect(refusal(chainInput([{ vehicles: [vehicle('A', minutes(20), minutes(6))] }]))).toBe('inconsistent-live')
  })

  it('refuses a chain with no ride leg at all', () => {
    expect(refusal({ now: NOW, legs: [] })).toBe('no-legs')
  })

  it('refuses when no vehicle can still reach a leg\'s board station by the time the user sets off', () => {
    // 第 0 段在 20 分钟到达。第 1 段线路上的每辆车都在 10 分钟抵达它自己的上车站 ——
    // 到用户能到那里时已经走了，故链所对的那辆车根本不存在。那是「没有可乘的车」（都走光了），
    // 不是负余量：连「差一点」都谈不上。
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', vehicles: [vehicle('C', minutes(10), minutes(15))] },
    ]))).toBe('no-vehicle-at-departure')
  })

  it('refuses on the first leg that cannot be deduced from, in leg order', () => {
    // 第 0 段没问题，第 1 段过期。所报原因是第 1 段的。
    expect(refusal(chainInput([
      { vehicles: [vehicle('A', minutes(6), minutes(20))] },
      { lineId: '202', updatedAt: NOW - 10 * 60 * 1000, vehicles: [vehicle('C', minutes(30), minutes(40))] },
    ]))).toBe('stale')
  })
})

describe('F10 deduction: a refusal names the leg, its age and its service state', () => {
  it('names the leg that refused, so a page can point at the transfer point and its line', () => {
    // 无法据以推演的是第 1 段：「都走了」是第 1 段的事实，
    // 而没有它的序号，两段链的页面既说不出是**哪个**换乘点拒绝，也点不出在那里拒绝的线路。
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
    // `no-legs` 是关于链自身的事实：没有路段可点。
    expect(deduceCommuteChain({ now: NOW, legs: [] })).toEqual({ status: 'no-conclusion', reason: 'no-legs' })
  })

  it('carries the refusing leg\'s reading age, so F11 can sit beside it', () => {
    const result = deduceCommuteChain(chainInput([{ updatedAt: NOW - 4_000, vehicles: [] }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.updatedAt).toBe(NOW - 4_000)
  })

  it('carries the refusing leg\'s service state, so an empty answer is governed by it', () => {
    // 06:00 的「暂无来车」与 01:00 的「暂无来车」不是同一个事实：
    // 前者是服务中的间隙，后者是一个已经结束的服务日 —— 只有状态能分辨它们。
    const result = deduceCommuteChain(chainInput([{
      vehicles: [],
      operatingStatus: { state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' },
    }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('no-vehicle')
    expect(result.operatingStatus).toEqual({ state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' })
  })

  it('carries no age and no state when the leg was never read', () => {
    // `no-live` 表示读数不存在：没有取得时刻可陈述，也没有声明服务状态的来源，故两者都不为该行编造。
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
    // 用户记录的下车站序是 3、上车站序是 8 —— 路段反向运行。两份定向读数随后无法共享车辆，
    // 但那是关于**记录**的事实，把它叫做「两个读数没有对上的车」是用本应用的读数背锅，
    // 且完全不给用户修法。诚实的答案是这条链录反了，用户可以改。
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
    // 相等不是「在下游」，既是上车站又是下车站的站不做任何乘车计价：同一个码覆盖它，
    // 故记录规则是「站序更大」而不是「不同」。
    const result = deduceCommuteChain(chainInput([{
      board: { name: '甲甲路', order: 3 },
      alight: { name: '甲甲路', order: 3 },
      vehicles: [vehicle('A', minutes(6), minutes(20))],
    }]))
    if (result.status !== 'no-conclusion') throw new Error('expected a refusal')
    expect(result.reason).toBe('leg-recorded-backwards')
  })

  it('lets a SUBWAY leg run the other way round, because one subway lineId carries both directions', () => {
    // 公交两个方向是两个 lineId，故已存的 `lineId` 已指明其一，`alight < board` 是录入错误。
    // 地铁一条 lineId 服务两个方向并对同一站反向编号，故同一对已存站序是沿**另一**方向的真实乘车 ——
    // 装配层为它读取相反方向（两个站序都翻译进去），引擎没有什么可拒绝的。
    // 该路段对装配层产出的读数计时，那是这段唯一的读数。
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
    // 地铁的宽容只覆盖**另一**方向，别无其他：任何线路上在同一站上下车都不是更短的乘车，
    // 故相等保留它在公交上的同一个码。
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
    // 一条路段可以同时触发两条规则：已存两端反向**且**它的接驳从未计价。
    // 两个检查之间的**顺序**是产品决定而非偶然。接驳必然在前 —— 只有两个已存车站都定位到了
    // **本**方向的停靠列表里，接驳才会被计价，故没有价格就说「站序反了」，
    // 是在诊断一份这条路径根本读不了的记录，而对调两端不会是修法。
    // （把两个检查对调，本套件其余用例仍然全绿；钉住顺序的就是这个 fixture。）
    expect(refusal(chainInput([{
      board: { name: '丁丁路', order: 8 },
      alight: { name: '甲甲路', order: 3 },
      connectionSeconds: null,
      vehicles: null,
    }]))).toBe('connection-unpriced')
  })

  it('keeps the connection ahead of the backwards rule for each cause the caller can name', () => {
    // 同一条同时触发两条规则的路段，且调用方陈述了原因。顺序不得取决于**哪个**原因：
    // 已计价的接驳正是两个已存车站都定位在路段所行方向的证明，故没有价格就说「站序反了」
    // 是在诊断一份这条路径根本读不了的记录。这包括用户唯一可行动的那个原因 ——
    // 起点从未保存的链不得被告知它两端录反了。
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
    connectionMode: null,
  }

  it('rejects a leg whose alight order is not downstream of its board order', () => {
    // 与旁边的站名 / 站序 refine 同一精神：配对是一个值，
    // 故反向运行的路段在边界上被拒绝，而不是存下来再解释成关于我们读数的事实。
    const parsed = CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: '乙乙路', alightStationOrder: 2 })
    expect(parsed.success).toBe(false)
    // 拒绝信息说明该修什么，与配对 refine 同一语气。
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain('站序')
  })

  it('rejects a leg that alights where it boards', () => {
    expect(CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: '甲甲路', alightStationOrder: 3 }).success).toBe(false)
  })

  it('accepts a leg that runs downstream, and one whose station is not chosen yet', () => {
    expect(CommuteChainLegSchema.safeParse(LEG).success).toBe(true)
    // 未选择的站没有站序可比，故排序规则不得对配对 refine 已经管辖的路段再拒一次。
    expect(CommuteChainLegSchema.safeParse({ ...LEG, alightStationName: null, alightStationOrder: null }).success).toBe(true)
    expect(CommuteChainLegSchema.safeParse({ ...LEG, boardStationName: null, boardStationOrder: null }).success).toBe(true)
  })

  it('accepts a SUBWAY leg recorded the other way round, while a bus one stays an error', () => {
    // 排序规则关乎路段运行的**方向**，而只有 lineId 说明哪个方向是下游。
    // 公交 lineId 指明其两个方向之一，故那里的 `alight < board` 是用户录入反了。
    // 地铁 lineId 承载**两个**方向并对同一站反向编号，故同一对已存站序是沿另一方向的真实乘车 ——
    // 装配层为它读相反方向 —— 拒绝它会让一条合法的反向地铁链无法记录。
    const reverse = { ...LEG, lineId: 'subway_027_88', alightStationName: '乙乙路', alightStationOrder: 2 }
    expect(CommuteChainLegSchema.safeParse(reverse).success).toBe(true)

    // 同一对在公交上仍被拒绝，且其信息仍说明该修什么。
    const busReverse = CommuteChainLegSchema.safeParse({ ...reverse, lineId: '101' })
    expect(busReverse.success).toBe(false)
    expect(busReverse.success ? '' : busReverse.error.issues[0]?.message).toContain('站序')

    // 地铁也无法从一站乘到它自己，与公交一样：那项宽容是为另一方向准备的，不是为更短的乘车。
    expect(CommuteChainLegSchema.safeParse({ ...LEG, lineId: 'subway_027_88', alightStationName: '甲甲路', alightStationOrder: 3 }).success).toBe(false)
  })
})

describe('F10 deduction: connections are priced by the path service, never by a guess', () => {
  it('adds the user\'s cycling extra to a cycling connection', () => {
    // 5 分钟乘车 + 默认的找车 / 停车时间：9 分钟远的车不再充裕。
    const walking = deduced(chainInput([{ connectionMode: 'walk', vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(walking.band).toBe('comfortable')

    const cycling = deduced(chainInput([{ connectionMode: 'cycle', vehicles: [vehicle('A', minutes(9), minutes(20))] }]))
    expect(cycling.band).toBe('tight')

    expect(DEFAULT_CYCLE_EXTRA_MINUTES).toBeGreaterThan(0)
  })

  it('makes a riding connection exactly the default extra tighter than the same walking one', () => {
    // 同一条链、同一批读数，只改方式：两个答案的差**就是**找车与停车那一段。
    // 「充裕 / 紧」这种分档不够：附加时间写成别的分钟数、甚至写成 0，也可能落进同一个分档，
    // 而那个数字正是用户会拿来做决定的东西。
    const same = { vehicles: [vehicle('A', minutes(12), minutes(30))] }
    const walking = deduced(chainInput([{ ...same, connectionMode: 'walk' }]))
    const cycling = deduced(chainInput([{ ...same, connectionMode: 'cycle' }]))

    // 骑行更紧，绝不更松：附加时间是成本，只会把到达站台的时刻推后。
    expect(walking.marginMinutes - cycling.marginMinutes).toBe(DEFAULT_CYCLE_EXTRA_MINUTES)
    expect(walking.legs[0]!.waitMinutes - cycling.legs[0]!.waitMinutes).toBe(DEFAULT_CYCLE_EXTRA_MINUTES)
  })

  it('prices a connection whose mode was never chosen as walking', () => {
    // 「没选过」在已存的链路上是 NULL，在引擎的输入里则是**不带**这个键。两种写法都不是骑行，
    // 故与显式 'walk' 得到逐字相同的答案；把任一处默认成骑行会在这里分叉。
    const withMode = chainInput([{ connectionMode: 'walk', vehicles: [vehicle('A', minutes(12), minutes(30))] }])
    const withoutMode = {
      ...withMode,
      legs: withMode.legs.map((leg) => {
        const { connectionMode: omitted, ...rest } = leg
        expect(omitted).toBe('walk')
        return rest
      }),
    }

    expect(deduced(withoutMode)).toEqual(deduced(withMode))
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
    // 已存字段是该路段「进入它的接驳」上的自己的附加时间，而链不存方式 ——
    // 故配置的 4 分钟对步行接驳同样生效（7 分钟富余变成 3）。这是刻意的，不是偶然：
    // 因为促使用户键入那个数字的方式没有存储就把它丢掉，等于本应用替用户决定他什么都没说。
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
    // 附加时间把站台等待一起推后：第 0 段上同一辆车，但用户晚四分钟到上车站。
    expect(withExtra.legs[0]?.waitMinutes).toBe(3)
    expect(withExtra.band).toBe('tight')
  })

  it('lets the engine\'s own default be configured', () => {
    // 5 分钟乘车 + 默认的 2 分钟附加，对 10 分钟远的车只剩 3 分钟；完全没有附加则是 5。
    const input = chainInput([{ connectionMode: 'cycle', vehicles: [vehicle('A', minutes(10), minutes(20))] }])
    expect(deduced(input).band).toBe('tight')
    expect(deduced(input).marginMinutes).toBe(3)
    expect(deduced({ ...input, cycleExtraMinutes: 0 }).band).toBe('comfortable')
  })
})

describe('F10 deduction: the numbers the row shows', () => {
  it('prices nothing past the last leg: no destination, no total arrival', () => {
    // 产品需要的是每个换乘点的余量 ——「我能不能赶上这个换乘点的车」—— 别无其他。
    // 链终止于最后一个乘车路段的到达站：没有目的地可走，故引擎的输入既不带尾接驳，
    // 输出也没有总到达时刻。两者是**删掉**而不是置 null：一个永远读作 null 的字段是功能不作的承诺。
    const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(6), minutes(20))] }]))
    expect('arriveInMinutes' in result).toBe(false)
    expect('tailConnectionSeconds' in chainInput([{}])).toBe(false)
    // 整个形状，使总到达时刻不可能被悄悄加回来。`branches` 是唯一的可选键，
    // 且在 `uncertain` 之外为 `undefined`。
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
    // 余量为零或正时，参考车与被上的车是同一辆，故余量与「哪班车」按构造一致。
    const result = deduced(chainInput([{ vehicles: [vehicle('A', minutes(12), minutes(23))] }]))
    expect(result.legs[0]?.vehicleId).toBe('A')
    expect(result.legs[0]?.marginMinutes).toBe(7)
    expect(result.legs[0]?.referenceVehicleId).toBe('A')
  })

  it('ties a negative margin to the vehicle that has gone, NOT to the one boarded', () => {
    // 「余量 -2 分」的情形：用户出发时下一个到的是 A 且已走，方案是 B。
    // 只把 −2 放在 `vehicleId` 旁边的页面会印出「余量 -2 分」紧挨用户实际要上的那辆车 ——
    // 故余量说明它关于**哪辆**车。
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
    // 「余量为零或正时两者相等」这个等价需要就绪时刻不**早于**出发时刻 —— 即路段附加时间非负。
    // `transferExtraMinutes` 由 schema（`min(0)`）守住，但 `cycleExtraMinutes` 与直接调用没有：
    // 负的附加时间会把用户放到他们出发之前的站台，让出发时刻之前已走的车看起来赶得上，
    // 随后把余量衡量到比它声称所上的车更晚的一辆上。
    // 把有效附加时间钳到零，才使该等价对每个调用方为真，而不只对 schema 恰好守住的那些；
    // 它也不会放大余量（钳制只会推后就绪时刻），故没有任何既有答案会改变。
    const result = deduced(chainInput(
      [
        { connectionSeconds: 0, vehicles: [vehicle('A', minutes(3), minutes(30))] },
        {
          lineId: '202',
          connectionSeconds: minutes(5),
          connectionMode: 'cycle',
          // 上车站还有 29 分钟，参考车还有 35 分钟。附加时间为零，故用户在第 35 分钟到站台，
          // 唯一还能上的是 V2 —— 参考车与被上的车是同一辆，与余量为零所要求的完全一致。
          vehicles: [vehicle('V1', minutes(29), minutes(40)), vehicle('V2', minutes(35), minutes(50))],
        },
      ],
      { cycleExtraMinutes: -6 },
    ))

    const leg = result.legs[1]
    expect(leg?.marginMinutes).toBe(0)
    expect(leg?.vehicleId).toBe('V2')
    expect(leg?.referenceVehicleId).toBe('V2')
  })
})

/**
 * F10：起点由通勤目的决定 —— 上班从家出发、下班从公司出发。
 *
 * 这是「一条链路从哪里起步」在本仓的**唯一**推导处：服务端按它取衔接的第一个点，
 * web 的空态与拒绝按它点名要修的那一行设置。起点因此不再是链路上的一列，
 * 也就不存在一条「上班·从公司出发」的矛盾链 —— 引擎与页面读同一个函数，
 * 故两侧不可能对同一条链路得出两个起点。
 */
describe('F10: the purpose decides where a chain starts', () => {
  /** 本仓的通勤目的全集；起点推导对它必须是全量的。 */
  const PURPOSES: CommuteChainPurpose[] = ['morning', 'evening']

  it('starts a morning chain from home and an evening one from work', () => {
    expect(anchorForPurpose('morning')).toBe('home')
    expect(anchorForPurpose('evening')).toBe('work')
  })

  it('answers a value the anchor contract knows, and one anchor per purpose', () => {
    for (const purpose of PURPOSES) {
      expect(CommuteChainAnchorSchema.safeParse(anchorForPurpose(purpose)).success).toBe(true)
    }
    // 两个目的各有一条真正的路：把它们映到同一个锚点，会让另一半的通勤从错的地方起步。
    expect(anchorForPurpose('morning')).not.toBe(anchorForPurpose('evening'))
  })
})
