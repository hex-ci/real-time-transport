import type { CommuteChainAnchor, CommuteChainPurpose } from '@real-time-transport/shared'
import { anchorUnsetSentenceOf } from './refusal'
import type { ChainEmptyStateView } from './types'

/**
 * 页面的空态：这个时段没有任何记录。
 *
 * 空屏要点名使用者可行动的成因，且一个成因不得掩盖另一个。此处两个事实可以同时为真——
 * 这个时段没有记录，以及链路将要起步的锚点从未保存——故锚点的事实先陈述。
 * 第三种状态是读取失败：一个读不到的锚点既非已保存也非缺失，对它不作任何断言。
 */

export function anchorForPurpose(purpose: CommuteChainPurpose): CommuteChainAnchor {
  return purpose === 'morning' ? 'home' : 'work'
}

/**
 * 无记录时段的空态。
 *
 * `anchorSaved` 取自设置行自己的说法：无坐标为 false，有坐标为 true，完全读不到为 null。
 */
export function emptyStateOf(params: {
  purpose: CommuteChainPurpose
  anchorSaved: boolean | null
}): ChainEmptyStateView {
  if (params.anchorSaved === false) {
    return {
      headline: '这个时段还没有换乘链',
      detail: anchorUnsetSentenceOf(anchorForPurpose(params.purpose)),
      action: 'settings',
    }
  }
  return {
    headline: '这个时段还没有换乘链',
    detail: '换乘链由使用者逐段录入：线路 + 上车站 + 下车站',
    // 录制页存在，故这个成因有真实可供性；它对锚点行不作断言：已保存与不可读都落到这里。
    action: 'chains',
  }
}
