import type { CommuteChainAnchor, CommuteChainPurpose } from '@real-time-transport/shared'
import { anchorUnsetSentenceOf } from './refusal'
import type { ChainEmptyStateView } from './types'

/**
 * The page's empty state: this purpose has no chain recorded.
 *
 * An empty screen has to name a cause the USER can act on, and it may not let one
 * cause hide another. Here two facts can be true at once — nothing is recorded for
 * this window, and the anchor a chain would start from was never saved — and both of
 * them now have a screen behind them, so the anchor's fact is stated first, in F1's
 * own words for that settings row: a chain recorded without its start anchor has no
 * walking time, which is the repair that has to happen first.
 *
 * The third state is the one worth being careful about: an anchor state this page
 * could NOT read (the settings request failed) is neither saved nor missing.
 * Claiming it was never saved invents a fact about a row nobody read, and sending
 * the user to 设置 to repair something that may be in place is the same invention
 * with a link on it — so nothing is claimed about the anchor, and the empty state
 * offers the other cause's screen instead.
 *
 * The other guidance line names what a chain is made of AND, now that recording a
 * chain has a screen of its own, offers it: 「去设置里录入链路」 → 设置's 通勤链路 page.
 * It did not offer one before because this build had no such screen, and the app's
 * own rule is that no state promises a control that does not exist — the rule held,
 * the surface appeared, and the entry is added only because it exists.
 */

/** The anchor a chain of this purpose starts from, as F1 pairs them: 上班 from 家, 下班 from 公司. */
export function anchorForPurpose(purpose: CommuteChainPurpose): CommuteChainAnchor {
  return purpose === 'morning' ? 'home' : 'work'
}

/**
 * The empty state for a purpose with nothing recorded.
 *
 * `anchorSaved` is the anchor's own state as the settings row stated it: `false`
 * when it has no coordinate, `true` when it has one, and `null` when the page could
 * not read it at all.
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
    // The recording screen exists, so this cause gets a real affordance. It claims
    // nothing about the anchor row: an anchor that was read as saved, and one that could
    // not be read at all, both land here — and recording a chain is the same act either
    // way.
    action: 'chains',
  }
}
