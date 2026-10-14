/**
 * 「屏幕上这个方向服务哪一腿通勤」的标识：措辞与色调都在这里给出一次。
 *
 * 判据只有一个 —— 使用者自己存下来的方向选择（详情页的 `activePurpose`）。未声明过时为 `null`，
 * 那时一个字都不显示，绝不退到「方向 0」：一个没人声明过的目的不得被说出来。
 *
 * 桌面与移动两处头部渲染同一句话、同一种色调，故同一个事实不会在两种屏幕上各说一套；
 * 每一处各写一份字面量就是漂移的机会。
 */
export interface PurposeBadge {
  /** 与另一处头部逐字相同的那句话。 */
  text: string
  /** 目的自己的色调，与线路类型的配色无关。 */
  tone: string
}

const BADGES: Record<'morning' | 'evening', PurposeBadge> = {
  morning: { text: '🏠 上班方向', tone: 'bg-emerald-500/10 text-emerald-400' },
  evening: { text: '🏢 下班方向', tone: 'bg-violet-500/10 text-violet-400' },
}

export function purposeBadgeOf(purpose: 'morning' | 'evening' | null): PurposeBadge | null {
  if (purpose === null) return null
  return BADGES[purpose]
}

/** 窄处的短说法（首页卡片的标签、电子站牌行里那三个字）：同一件事的字数不同，指的不是两件事。 */
const SHORT: Record<'morning' | 'evening', string> = {
  morning: '🏠 上班',
  evening: '🏢 下班',
}

export function shortPurposeTextOf(purpose: 'morning' | 'evening'): string {
  return SHORT[purpose]
}

/** 只有字的那种（电子站牌行里那句灰字）：比短说法更轻，因为它跟着终点站，不该抢戏。 */
const PLAIN: Record<'morning' | 'evening', string> = {
  morning: '上班',
  evening: '下班',
}

export function plainPurposeTextOf(purpose: 'morning' | 'evening'): string {
  return PLAIN[purpose]
}
