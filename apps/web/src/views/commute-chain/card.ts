import type { CommuteChainDeductionView } from '@real-time-transport/shared'
import { chainConclusionOf } from './margin'
import { chainReadingOf } from './provenance'
import { anchorNameOf, refusalOf } from './refusal'
import type { ChainCardView } from './types'

/**
 * 一张链路的卡片视图：本页唯一的装配处。
 *
 * 拒绝链路的锚点取自链路自己存的 `originAnchor`，不是目的的——上班链路从公司记录，就在公司那一行修。
 * 被拒绝的链路不带任何种类的结论：拒绝是一个码而不是更小的答案。
 */
export function chainCardOf(chain: CommuteChainDeductionView): ChainCardView {
  const { deduction } = chain

  if (deduction.status === 'deduced') {
    return {
      chainId: chain.chainId,
      name: chain.name,
      originText: `从「${anchorNameOf(chain.originAnchor)}」出发`,
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
    originText: `从「${anchorNameOf(chain.originAnchor)}」出发`,
    conclusion: null,
    refusal: refusalOf({ deduction, anchor: chain.originAnchor }),
    // 没有结论就没有归属某种来源的数字。
    chainProvenance: null,
    reading: chainReadingOf({ lastUpdatedAt: deduction.updatedAt ?? null, provenance: null }),
    deduction,
  }
}
