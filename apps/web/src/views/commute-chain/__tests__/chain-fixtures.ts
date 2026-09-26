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
 * F10 页面测试所依据的夹具。
 *
 * 此处每个数字都是**引擎**产出的：档位绝不手写（它是紧邻余量的 `chainMarginBandOf`），
 * 链路的来源是其各段的 `listProvenanceOf`，故夹具无法陈述契约不成立的关系。
 */

/** 夹具报告为读取自身时刻的瞬间。 */
export const READ_AT = 1_700_000_000_000

/** F3 的运营状态，如运行中的线路所陈述。 */
export const OPERATING = { state: 'operating', firstDeparture: '05:30', lastDeparture: '23:00' } as const

/** 推断链路的一段。默认余量宽裕为正。 */
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

/** 一条推断链路，档位、余量与约束段由其各段推出。 */
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

/** 链路的答案可以是的拒绝，而非推断。 */
export function refusal(
  reason: ChainNoConclusionReason,
  overrides: Partial<ChainNoConclusion> = {},
): ChainNoConclusion {
  return { status: 'no-conclusion', reason, ...overrides }
}

/** 一条链路，如端点所发送。 */
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
 * 刷新端点的答案，如它所发送的一条。
 *
 * 读取的时刻是引擎自己的（`lastUpdatedAt`），各线路携带各自取得读取的时刻与种类——store 由这些
 * 派生新鲜度行，绝不取自时钟，故把答案盖成 `Date.now()` 的夹具无法证明页面印了什么。
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
