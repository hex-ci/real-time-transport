import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema, LiveBusSchema } from '@real-time-transport/shared'
import { arrivalsAfterLivePass } from '../../../views/line-detail/live-arrivals'

/**
 * 弹窗答案比线路图旧一轮时，同一辆车会同时出现在两个位置。
 *
 * 上游把 `order` 报成车辆**正前往**的站，故 `nextOrder > 本站序` 就是
 * 它已经开过本站 —— 与服务端 `vehicleArrivals` 的过滤同一条判据。
 */

const row = (
  busId: string | undefined,
  isAtStation = true,
  provenance: 'live' | 'exact_timetable' | 'schedule_simulation' = 'live',
) => ArrivalRowSchema.parse({
  time: '正在进站',
  etaSeconds: 0,
  stopsAway: 0,
  ...(isAtStation ? { isAtStation: true } : {}),
  ...(busId ? { busId } : {}),
  provenance,
})

const bus = (id: string, order: number, nextOrder?: number) => LiveBusSchema.parse({
  id,
  order,
  ...(nextOrder === undefined ? {} : { nextOrder }),
  congestion: 'unknown',
  updatedAt: 1,
})

describe('the popover drops a vehicle the latest reading has already driven past', () => {
  it('drops the row once the vehicle is heading for a later stop', () => {
    const rows = arrivalsAfterLivePass([row('B1')], [bus('B1', 8, 9)], 8)
    expect(rows).toHaveLength(0)
  })

  it('keeps the row while the vehicle is still heading for this stop', () => {
    const rows = arrivalsAfterLivePass([row('B1')], [bus('B1', 7, 8)], 8)
    expect(rows).toHaveLength(1)
  })

  it('treats a vehicle whose last passed stop is this one as gone', () => {
    // 没有 nextOrder 时 `order` 是刚驶过的那一站：等于本站序说明它已在开往下一站。
    const rows = arrivalsAfterLivePass([row('B1')], [bus('B1', 8)], 8)
    expect(rows).toHaveLength(0)
  })

  it('keeps the row when the latest reading does not contain that vehicle', () => {
    // 这一轮没读到不等于开走了：删行会把「没读到」说成「已驶离」。
    const rows = arrivalsAfterLivePass([row('B1')], [bus('B2', 9, 10)], 8)
    expect(rows).toHaveLength(1)
  })

  it('keeps rows that name no vehicle', () => {
    // 精确时刻表的行没有车辆 id：它们的在场由时刻表决定，不由实时读数裁决。
    const rows = arrivalsAfterLivePass([row(undefined)], [bus('B1', 9, 10)], 8)
    expect(rows).toHaveLength(1)
  })

  it('never re-decides a timetable or simulated row by the live reading', () => {
    // 地铁的 `order` 是车所在的站、不是刚驶过的那一站，且在场由模型决定。
    const rows = arrivalsAfterLivePass(
      [row('train:1', true, 'exact_timetable'), row('sim_1', true, 'schedule_simulation')],
      [bus('train:1', 8, 9), bus('sim_1', 8, 9)],
      8,
    )
    expect(rows).toHaveLength(2)
  })

  it('keeps every row when there is no live reading at all', () => {
    const rows = arrivalsAfterLivePass([row('B1')], [], 8)
    expect(rows).toHaveLength(1)
  })

  it('filters row by row, leaving the later vehicles in place', () => {
    const rows = arrivalsAfterLivePass(
      [row('B1'), row('B2', false), row('B3', false)],
      [bus('B1', 8, 9), bus('B2', 6, 7), bus('B3', 5, 6)],
      8,
    )
    expect(rows.map(r => r.busId)).toEqual(['B2', 'B3'])
  })
})
