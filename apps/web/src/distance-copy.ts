/**
 * 距离的措辞：一处定义，站台报站屏与电子站牌页共用。
 *
 * 米与公里两种写法按同一条界线分（1000 米），且**缺失就什么都不说** ——
 * 补一个 0 会被读成「就在你脚下」。
 */
export function distanceTextOf(meters: number | null | undefined): string | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return null
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} 公里`
  return `${Math.round(meters)} 米`
}

/** 带「距」字的那一种：站台行里与站数并排陈述（如「距 1.2 公里 · 2 站」）。 */
export function distancePrefixOf(meters: number | null | undefined): string | null {
  const text = distanceTextOf(meters)
  return text === null ? null : `距 ${text}`
}
