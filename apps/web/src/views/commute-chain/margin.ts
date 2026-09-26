import { chainMarginBandOf } from '@real-time-transport/shared'
import type { ChainBranch, ChainBranches, ChainDeduction, ChainLegDeduction, ChainMarginBand } from '@real-time-transport/shared'
import type { BranchView, ChainConclusionView, TransferRowView } from './types'

/**
 * 换乘行的措辞：每一段「能不能赶上换乘点那班车」。
 *
 * 档位与分钟是同一个数字的两个视角（`chainMarginBandOf`），两者都取自那个 `marginMinutes`，此处不重算。
 * 本文件不决定分钟、档位或判决——引擎已定——它唯一的判断是数字属于哪一班车，
 * 那是这一行自己可能弄错的唯一一件事。
 *
 * 余量的主人：`marginMinutes` 是相对使用者出门时此站台下一班车（`referenceVehicleId`）量的，
 * 而余量非负时那正是要上的那班；`insufficient` 时参照已走、计划变成下一班，
 * 那正是会在用户走向的车旁印「余量 -2 分」的一行，故参照已走时一个余量也不印，
 * 并说明所印的数字属于下一班。
 *
 * 负余量在任何地方都不印：段行不印，链路（取最紧的一段）也不印。
 * 车辆不用 id 命名：引擎的 `vehicleId` 是提供方的内部句柄，生成列车的是模型自己的名字，
 * 故本行用站台等待与下车分钟认车。
 */

/**
 * 档位的词。
 *
 * 紧 档含边界（引擎把紧划到容忍度为止且包含该边界），措辞不得声称比该档更窄的上限。
 * 第四档是余量落在误差量级内时的诚实降级：不挑一个读数，而是陈述两个。
 */
export const MARGIN_BAND_COPY: Record<ChainMarginBand, { label: string, verdict: string }> = {
  comfortable: { label: '充裕', verdict: '赶得上 · 就是这班' },
  tight: { label: '紧', verdict: '赶得上 · 就这几分钟' },
  uncertain: { label: '不确定', verdict: '赶不赶得上，看是不是正好这一班' },
  insufficient: { label: '不足', verdict: '赶不上出门时的那班 · 实际是下一班' },
}

export function transferRowOf(leg: ChainLegDeduction): TransferRowView {
  // 引擎自己的等价关系从两侧读：id 对说余量是相对哪班车量的，负余量说同一件事；其一成立就不印数字。
  const referenceGone = leg.referenceVehicleId !== leg.vehicleId || leg.marginMinutes < 0
  // 档位跟随这一行自己的车，不跟随原始数字：参照已走时档位就是不足，不论余量声称什么，
  // 否则会出现「充裕」与「改乘下一班」并列。
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
    // 上面这些数字所对照之物，两种情形都陈述：没有参照的余量是没有车的数字。
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
 * 一条推导出来的链路，如它的卡片所印。
 *
 * 链路自己的数字是它的绑定余量（引擎的最小值，档位由它读出），故词、芯片与分钟不会互相矛盾。
 */
export function chainConclusionOf(deduction: ChainDeduction): ChainConclusionView {
  const copy = MARGIN_BAND_COPY[deduction.band]
  const legs = deduction.legs.map(transferRowOf)
  const binding = legs.find(row => row.seq === deduction.bindingSeq)
  // 链路余量只在它所量的车仍在时印：档位是引擎自己的（绑定段），故载荷说「不足」而余量非负时两者不得并陈。
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
    // 两个读数只属于绑定段，且只在一个档位存在；可解析余量旁带着读数不陈述。
    branches: deduction.band === 'uncertain' && deduction.branches
      ? branchesOf(deduction.branches)
      : null,
    legs,
  }
}

/**
 * 不可解析余量的两个读数，各自的措辞。
 *
 * 读数里没有后续车辆、或没有它的分钟时陈述该缺失；编造一个「下一班」正是本情形要避免的虚假确定。
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
