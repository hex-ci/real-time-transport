import { operatingTextOf } from '@/operating-copy'
import type { ChainNoConclusion, ChainNoConclusionReason, CommuteChainAnchor } from '@real-time-transport/shared'
import type { RefusalView } from './types'

/**
 * Every 「不给结论」 code, and the ONE sentence it gets.
 *
 * The engine answers with a code rather than a sentence, so the wording is this
 * side's — and it is the strictest copy in the feature. A code with no sentence is
 * a hole; a sentence that is true of only some of a code's causes is a lie for the
 * rest. The table below is therefore TOTAL over `ChainNoConclusionReason` (`Record`
 * rather than a chain of comparisons, the same shape as the engine's own
 * `CONNECTION_REFUSAL_CODES`), which makes a code added upstream a COMPILE error
 * rather than a row that quietly stops being true.
 *
 * Three of the codes need care and get it here:
 *
 *  - `anchor-unset` is the ONLY cause of an unpriced connection the user can act
 *    on, and it keeps F1's own sentence for the same settings row. Its action is
 *    the reason's own, never a field's: the engine settles the anchor BEFORE it
 *    reads a leg's line or locates a station, so a chain whose line is also
 *    unreadable arrives with this code — and the page must send the user to the one
 *    row they can repair rather than let a line problem speak for it.
 *  - `leg-recorded-backwards` covers TWO causes with no ordering in common: a bus
 *    leg whose alight station is not downstream, and any leg whose two ends are the
 *    SAME station. A sentence naming the order is therefore false for the second —
 *    there is no order to be wrong when both ends are one station — so the wording
 *    states only what is true of both: a leg filled in so it cannot be ridden.
 *  - `connection-unpriced` covers four causes with DIFFERENT permanence: a stop the
 *    stop list carries without a coordinate is a permanent upstream data gap, while
 *    a route the path service happened not to price is momentary. 「稍后重试」 would
 *    be true of the last and false of the first, on a row that cannot tell the page
 *    which one fired — so no sentence here promises a retry, and none offers an
 *    action, because for these causes there is none the user can take.
 *
 * A refusal is a CODE, not a smaller answer: a sentence about why states the fact
 * and stops. It never carries a minute, and no sentence names a data source,
 * describes how a number is computed, or tells the user what to do.
 */

/** One sentence per code. The parameter is the anchor, which only one code needs. */
export interface RefusalSentenceParams {
  /** The anchor this chain starts from — `CommuteChainDeductionView.originAnchor`. */
  anchor: CommuteChainAnchor
}

/** The anchor's own name, as F1's reference line states the same two settings rows. */
export function anchorNameOf(anchor: CommuteChainAnchor): string {
  return anchor === 'home' ? '家' : '公司'
}

/** F1's sentence for an anchor that was never saved, word for word. */
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
 * A code this build has never heard of — a newer server, an older page.
 *
 * It says what is certainly true (this chain has no conclusion) and nothing else:
 * no cause is invented, no action is offered, and the row is not dressed as one of
 * the codes above. The known set is total at compile time; this is the wire's
 * forward-compatibility, not a substitute for a missing entry.
 */
const UNKNOWN_CODE_SENTENCE = '这条链路无法给出结论'

/**
 * The codes whose empty answer is a question about the SERVICE DAY rather than
 * about this app's reading.
 *
 * For these, the refusing leg's F3 state rides BESIDE the sentence: 首班前 /
 * 运营中 / 已过末班 are three different facts, and 「暂时没有开往这一站的车」 must
 * never be answered as 「这条线停运」, nor a line that has ended as a bare 暂无来车.
 * The state is F3's own wording rather than a second one, so the chain page and a
 * platform board cannot state two different service states for one line.
 *
 * Everywhere else the state is deliberately NOT shown: beside 「数据太旧」 or
 * 「来源未知」 it would read as the cause of a refusal that is about our reading.
 */
const SERVICE_GOVERNED_REASONS: ReadonlySet<string> = new Set([
  'no-vehicle',
  'no-vehicle-after-connection',
  'no-vehicle-at-departure',
])

/**
 * A refusal, as its card renders it: the sentence for the code, which transfer it
 * is about, F3's service state where that is the question, and the one action the
 * cause leaves the user.
 *
 * Nothing beyond that: every field here is either rendered by the card or is the
 * engine's code itself (`reason`, which the page's own tests compare against).
 * The instant the reading was obtained is NOT a field of this model — the card
 * states it from the reading line it already renders (`ChainCardView.reading`), and
 * a second copy of one instant would be a field no view reads.
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
    // The action belongs to the CAUSE, not to a field: an anchor that was never
    // saved is repaired on 设置, and no other code has a screen to send anyone to.
    action: reason === 'anchor-unset' ? 'settings' : null,
  }
}
