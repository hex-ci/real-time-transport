import type { DepartureAdvice, DepartureReference } from '@real-time-transport/shared/departure'

/**
 * F1's reference line, as text.
 *
 * Kept out of the card component so the wording is a tested fact rather than a
 * template that only a browser can check: this app has no DOM test harness, and
 * the one thing F1 is strict about here is that different states never read
 * alike — 「暂无数据」 is not 「不用着急」, and a missing value is never dressed up
 * as an answer.
 */

export interface ReferenceLine {
  /** 「步行 6 分」, or null when there is no walk to name. */
  walk: string | null
  /** The conclusion, in the user's own terms. */
  conclusion: string
}

/**
 * The conclusion for one verdict.
 *
 * The row states a fact and leaves the decision where F1 puts it — with the
 * user, reading the arrival minutes beside it.
 */
export function conclusionOf(advice: DepartureAdvice): string {
  if (advice.state === 'comfortable') {
    return `${advice.leaveInMinutes} 分钟后出门`
  }
  if (advice.state === 'hurry') {
    // The PRD's own wording: being in time is a fact, not an instruction.
    return '现在走还来得及'
  }
  // This bus is gone. With no second bus priced there is no cost to state, and
  // an invented one would be the failure mode this whole row guards against.
  return advice.missCostMinutes === null
    ? '赶不上这班'
    : `赶不上这班 · 下一班多等 ${advice.missCostMinutes} 分`
}

/**
 * The line to render, or null for no line at all.
 *
 * `null` covers every case where the server drew no conclusion — outside both
 * commute windows, no walking route, no vehicle, stale or degraded arrivals —
 * and the row is then simply absent. The one non-conclusion with content of its
 * own is an anchor that was never saved: that points at 设置, because otherwise
 * the feature looks broken exactly when the user has never set it up.
 */
export function referenceLineOf(reference: DepartureReference | null | undefined): ReferenceLine | null {
  if (!reference) return null
  if (reference.status === 'anchor-unset') {
    return {
      walk: null,
      conclusion: `未设置「${reference.anchor === 'home' ? '家' : '公司'}」位置 · 在「设置」中设置`,
    }
  }
  return {
    walk: `步行 ${reference.advice.walkMinutes} 分`,
    conclusion: conclusionOf(reference.advice),
  }
}
