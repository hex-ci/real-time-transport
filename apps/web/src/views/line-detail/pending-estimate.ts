/**
 * 到站答案在途时本页自己估的秒数——服务端自己的地铁模型，不是第二个意见。
 *
 * 位置/驻站估时（真实位置、真实速度、每站名义停站）已从服务端移除，此处也必须一并删：一个给公交
 * 分钟估价的待定答案会陈述到站答案不再陈述的数字，两个屏幕会为同一辆车在同一时刻互相矛盾。
 * 没有分钟可陈述时，页面陈述与行相同的缺失。
 *
 * 剩下的是两侧仍共享的唯一模型，且被完全共享：客户端曾缺服务端的下限，两侧于是对同一辆车给出不同
 * 的数，只被取整到分钟掩盖。此处不读时钟：进度与剩余站数都来自 live 板。
 */

/** 任何估时之下的下限：用服务端自己的，绝不用更小的。 */
export const ARRIVAL_ESTIMATE_FLOOR_SECONDS = 30

/** 地铁模型假设的每站运行秒数（服务端自己的 135 s）。 */
export const SUBWAY_STATION_RUN_SECONDS = 135

/** 地铁模型的估时：剩余整程，减去本程已走的进度。 */
export function estimateSubwayArrivalSeconds(stopsAway: number, progress: number): number {
  return Math.max(
    ARRIVAL_ESTIMATE_FLOOR_SECONDS,
    Math.round((stopsAway - progress) * SUBWAY_STATION_RUN_SECONDS),
  )
}
