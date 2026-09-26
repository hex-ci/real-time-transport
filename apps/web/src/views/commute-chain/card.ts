import type { CommuteChainDeductionView } from '@real-time-transport/shared'
import { anchorForPurpose } from '@real-time-transport/shared'
import { chainConclusionOf } from './margin'
import { chainReadingOf } from './provenance'
import { anchorNameOf, refusalOf } from './refusal'
import type { ChainCardView } from './types'

/**
 * 一张链路的卡片视图：本页唯一的装配处。
 *
 * 起点由链路自己的通勤目的推出（上班从家出发、下班从公司出发，`anchorForPurpose`）——
 * 它不是端点送来的一个字段，故卡片上的起点文案与拒绝点名的那一行设置必然同源，不可能互相矛盾。
 * 被拒绝的链路不带任何种类的结论：拒绝是一个码而不是更小的答案。
 */
export function chainCardOf(chain: CommuteChainDeductionView): ChainCardView {
  const { deduction } = chain
  // 同一条链路的起点只有一个来源，故下面两处都不各自推导。
  const anchor = anchorForPurpose(chain.purpose)

  if (deduction.status === 'deduced') {
    return {
      chainId: chain.chainId,
      name: chain.name,
      originText: `从「${anchorNameOf(anchor)}」出发`,
      conclusion: chainConclusionOf(deduction),
      refusal: null,
      chainProvenance: deduction.provenance,
      reading: chainReadingOf({
        lastUpdatedAt: deduction.lastUpdatedAt,
        provenance: deduction.provenance,
      }),
      deduction,
    }
  }

  return {
    chainId: chain.chainId,
    name: chain.name,
    originText: `从「${anchorNameOf(anchor)}」出发`,
    conclusion: null,
    refusal: refusalOf({ deduction, anchor }),
    // 没有结论就没有归属某种来源的数字。
    chainProvenance: null,
    reading: chainReadingOf({ lastUpdatedAt: deduction.updatedAt ?? null, provenance: null }),
    deduction,
  }
}
