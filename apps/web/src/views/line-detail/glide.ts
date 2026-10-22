/**
 * 车辆图标的位移约束。
 *
 * 上游对停在站台上的车仍会报 5~11 m/s，任何"按速度直接写位置"的做法
 * （含把图标吸附到站台）都能在一帧里画出上百公里的读数：90 米差距的
 * 指数吸附实测冲到过 1224 km/h。这里把**所有**修正都压到同一个物理上限下，
 * 车只能"开过去"，不能"闪过去"。
 */

/** 城市公交的物理速度上限 57.6 km/h。 */
export const MAX_BUS_SPEED_MS = 16.0

/** 位置修正的收敛时间：差距越大走得越快，但不超过物理上限。 */
export const GLIDE_CONVERGE_SEC = 3.5

/**
 * 一帧允许的位移（米，带符号）。
 *
 * 上限 = min(物理速度, 差距 / 收敛时间)，再乘以帧时长；
 * 差距很小时直接取剩余距离，避免永远差一点点。
 */
export function glideStep(from: number, to: number, dt: number): number {
  if (dt <= 0) return 0
  const gap = to - from
  if (gap === 0) return 0
  const limit = Math.min(MAX_BUS_SPEED_MS, Math.abs(gap) / GLIDE_CONVERGE_SEC)
  return Math.sign(gap) * Math.min(Math.abs(gap), limit * dt)
}

/**
 * 停站时图标该去哪：上游把车报在站台附近时画在站台上，否则就画在它报的位置。
 * 上游的里程有取整/标定误差，实测停站车落在站台 −50…+73 米内。
 */
export function dwellTarget(
  fixDist: number | null,
  platformDist: number | null,
  toleranceM: number,
): number | null {
  if (fixDist === null) return null
  if (platformDist !== null && Math.abs(fixDist - platformDist) <= toleranceM) return platformDist
  return fixDist
}
