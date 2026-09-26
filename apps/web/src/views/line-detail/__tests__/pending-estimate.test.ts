import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as pendingEstimate from '../pending-estimate'
import {
  ARRIVAL_ESTIMATE_FLOOR_SECONDS,
  estimateSubwayArrivalSeconds,
} from '../pending-estimate'

/**
 * F-E：页面自己的「等待窗口」估时必须是**服务端**的算术。
 *
 * 线路页面在到站应答落地前（以及永不到来时）为同一个车辆自己估价一个分钟。曾两侧各存在两套模型；
 * 其中位置/驻站估时（`remainingMeters / speed + (stopsAway - 1) * 30`）已从两侧移除，因为服务端
 * 不再陈述那个分钟。客户端复制一个服务端拒绝陈述的数字，比死代码更糟——它是与第一个表面矛盾的第二个表面。
 *
 * 剩下的是地铁模型，且被**完全**共享：两侧曾都有它，但客户端缺服务端的 `Math.max(30, …)` 下限，
 * 于是同一时刻同一车辆给出不同的数，只因取整到分钟才没暴露。故这里钉的是**秒**：
 * 5 秒的原始估时必须输出为下限，而不是 5。
 *
 * 此处断言的数字取自 `vehicleArrivals` 自身（135 s/站），故线上任一侧改动都会在此失败。
 */

describe('the estimated seconds are floored, as the server floors them', () => {
  it('floors the subway model instead of stating the raw 14 seconds', () => {
    // 距一站且已走 0.9 程：0.1 × 135 = 13.5 → 原始 14。
    expect(estimateSubwayArrivalSeconds(1, 0.9)).toBe(ARRIVAL_ESTIMATE_FLOOR_SECONDS)
    expect(estimateSubwayArrivalSeconds(1, 0.9)).not.toBe(14)
  })

  it('states the model\'s own seconds above the floor, unchanged', () => {
    // 三整程：405 s——服务端的数字，原样通过。
    expect(estimateSubwayArrivalSeconds(3, 0)).toBe(405)
  })
})

/**
 * 以及接线：页面必须经由本模块**计算**，而不是内联保留第二份算术
 * （副本正是下限丢失的原因，也是纯逻辑测试看不到的一半）。
 */
describe('the line page prices only the model the server still states', () => {
  const view = readFileSync(fileURLToPath(new URL('../index.vue', import.meta.url)), 'utf8')

  it('imports the subway estimate from the module instead of inlining the arithmetic', () => {
    expect(view).toContain('estimateSubwayArrivalSeconds')
    // 回归：曾缺少下限的内联副本。
    expect(view).not.toContain('(stops - progress) * 135')
  })

  it('exports no position/dwell estimate at all', () => {
    // 本页曾自己估价的车辆分钟是服务端自己的外推，而服务端现在无处陈述它。
    expect(Object.keys(pendingEstimate)).not.toContain('estimatePositionArrivalSeconds')
  })
})
