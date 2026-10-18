import type { LiveBus } from '@real-time-transport/shared'

/**
 * 精确时刻表的动画位置：站间按时间线性插值距离，进站由 arrivalAt 决定，
 * 停站到 departureAt 再发车。屏幕上是匀速的，因为它只沿两站的布局距离走，
 * 不依赖真实速度或米数。
 */
export function scheduleDistanceAt(
  schedule: LiveBus['schedule'],
  nowMs: number,
  stationDistances: number[],
): number | null {
  if (!schedule || schedule.length === 0 || stationDistances.length < 2) return null
  for (let i = 0; i < schedule.length - 1; i++) {
    const cur = schedule[i]!
    const next = schedule[i + 1]!
    const from = stationDistances[cur.order - 1]
    const to = stationDistances[next.order - 1]
    if (from === undefined || to === undefined) return null
    if (nowMs < cur.arrivalAt) return from
    if (nowMs < cur.departureAt) return from
    if (nowMs < next.arrivalAt) {
      const duration = Math.max(1, next.arrivalAt - cur.departureAt)
      const p = Math.min(Math.max((nowMs - cur.departureAt) / duration, 0), 1)
      return from + (to - from) * p
    }
  }
  const last = schedule[schedule.length - 1]!
  return stationDistances[last.order - 1] ?? null
}
