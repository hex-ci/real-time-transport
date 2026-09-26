import { operatingTextOf } from '@/operating-copy'
import type { ChainNoConclusion, ChainNoConclusionReason, CommuteChainAnchor } from '@real-time-transport/shared'
import type { RefusalView } from './types'

/**
 * 每个「不给结论」的码，以及它唯一的那句话。
 *
 * 引擎用码而不是句子作答，措辞是本侧的事，且是这里最严的文案：码没有句子是一个洞，
 * 只对一部分成因成立的句子对其余是假话。下表对 `ChainNoConclusionReason` 是 TOTAL 的
 * （`Record` 而非一串比较），故上游新增一个码是编译错误，而不是一行悄悄失效。
 *
 * 三个码需要小心：`anchor-unset` 是唯一用户可行动的成因，且动作取该成因自己的；
 * `leg-recorded-backwards` 覆盖两类无共同顺序的成因，故措辞不能提顺序；
 * `connection-unpriced` 的成因永久性不同，故不承诺重试、也不给动作。
 *
 * 拒绝是一个码，不是更小的答案：它不带分钟，也不描述数字是怎么算出来的。
 */

/** 一个码一句话；参数是锚点，只有一个码需要它。 */
export interface RefusalSentenceParams {
  /** 这条链路起步的锚点，即 `CommuteChainDeductionView.originAnchor`。 */
  anchor: CommuteChainAnchor
}

export function anchorNameOf(anchor: CommuteChainAnchor): string {
  return anchor === 'home' ? '家' : '公司'
}

/** 锚点从未保存时的句子，与 F1 对同一设置行的措辞逐字相同。 */
export function anchorUnsetSentenceOf(anchor: CommuteChainAnchor): string {
  return `未设置「${anchorNameOf(anchor)}」位置 · 在「设置」中设置`
}

export const REFUSAL_SENTENCE: Record<ChainNoConclusionReason, (params: RefusalSentenceParams) => string> = {
  'no-legs': () => '这条链路还没有乘车段',
  'station-unset': () => '这条链路有乘车段的上车站或下车站还没选',
  'leg-recorded-backwards': () => '这条链路有乘车段的上车站与下车站填得走不通',
  'anchor-unset': ({ anchor }) => anchorUnsetSentenceOf(anchor),
  'connection-unpriced': () => '这一段接驳的时长取不到，无法判断余量',
  'no-live': () => '这一段线路没有读到车况数据',
  'no-vehicle': () => '暂时没有开往这一站的车',
  'no-shared-vehicle': () => '这一段暂时无法确认可乘的班车',
  'no-vehicle-after-connection': () => '走到这一站时，原来在途的车已经走了',
  'no-vehicle-at-departure': () => '还没出发去这一站，车就已经全部走了',
  'stale': () => '这一段的车况数据太旧，无法判断',
  'degraded': () => '这一段的数据来自备用来源，仅供参考',
  'provenance-unknown': () => '这一段的车况数据来源未知，无法判断',
  'inconsistent-live': () => '这一段的车况数据前后不一致，无法判断',
}

/**
 * 本构建从未听过的码（更新的服务端、更旧的页面）。
 *
 * 只说必然为真的事（这条链路没有结论）：不编造成因、不给动作、不扮成上面的码。
 */
const UNKNOWN_CODE_SENTENCE = '这条链路无法给出结论'

/**
 * 空答案是营运日的问题（而非本应用读取的问题）的那些码。
 *
 * 对这些码，拒绝段的 F3 状态与句子并列。其余各处刻意不显示该状态：
 * 在「数据太旧」「来源未知」旁它会被读成拒绝的成因。
 */
const SERVICE_GOVERNED_REASONS: ReadonlySet<string> = new Set([
  'no-vehicle',
  'no-vehicle-after-connection',
  'no-vehicle-at-departure',
])

/**
 * 一条拒绝，如它的卡片所渲染：码的句子、它关于哪一段、该有营运日状态时的 F3 状态，以及成因留下的动作。
 *
 * 此外别无所有。读取时刻不是本模型的字段：卡片从它已渲染的读取行陈述它。
 */
export function refusalOf(params: {
  deduction: ChainNoConclusion
  anchor: CommuteChainAnchor
}): RefusalView {
  const { deduction } = params
  const reason: string = deduction.reason
  const copy = REFUSAL_SENTENCE[deduction.reason]

  return {
    reason,
    sentence: copy ? copy({ anchor: params.anchor }) : UNKNOWN_CODE_SENTENCE,
    legText: deduction.leg ? `第 ${deduction.leg.seq + 1} 段 · ${deduction.leg.lineName}` : null,
    serviceText: SERVICE_GOVERNED_REASONS.has(reason) && deduction.operatingStatus
      ? operatingTextOf(deduction.operatingStatus)
      : null,
    // 动作属于成因，不属于某个字段：只有从未保存的锚点在设置里有可修的行。
    action: reason === 'anchor-unset' ? 'settings' : null,
  }
}
