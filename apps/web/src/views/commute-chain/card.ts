import type { CommuteChainDeductionView } from '@real-time-transport/shared'
import { chainConclusionOf } from './margin'
import { chainReadingOf } from './provenance'
import { anchorNameOf, refusalOf } from './refusal'
import type { ChainCardView } from './types'

/**
 * One chain's answer, as its card renders it — the page's only assembly.
 *
 * Two facts have to be taken from the right place here, and both would be plausible
 * from the wrong one:
 *
 *  - a refusal's anchor is the CHAIN's own stored `originAnchor`, never the
 *    purpose's: an 上班 chain recorded from 公司 is repaired on the 公司 row, and
 *    naming 家 would send the user to change a setting that is not involved.
 *  - a refused chain carries a conclusion of NO kind. A refusal is a code, not a
 *    smaller answer, so the card holds no margin, no minute and no vehicle for it —
 *    there is nothing to print beside it that the engine did not refuse to give.
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
    // Nothing was concluded, so there is no number of ours for a kind to qualify —
    // a mark here would describe a value the answer does not have.
    chainProvenance: null,
    reading: chainReadingOf({ lastUpdatedAt: deduction.updatedAt ?? null, provenance: null }),
    deduction,
  }
}
