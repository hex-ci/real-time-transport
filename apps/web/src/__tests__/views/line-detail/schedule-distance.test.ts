import { describe, expect, it } from 'vitest'
import { scheduleDistanceAt } from '@/views/line-detail/components/schedule-distance'

const schedule = [
  { order: 1, arrivalAt: 1_000, departureAt: 1_300 },
  { order: 2, arrivalAt: 2_000, departureAt: 2_300 },
]

describe('scheduleDistanceAt: 按时刻表匀速走两站之间', () => {
  it('到站前停在当前站，停站期间不动', () => {
    expect(scheduleDistanceAt(schedule, 900, [0, 1_000, 2_000])).toBe(0)
    expect(scheduleDistanceAt(schedule, 1_100, [0, 1_000, 2_000])).toBe(0)
  })

  it('发车后到下一站之间按时间线性插值，到站时正好在下一站', () => {
    expect(scheduleDistanceAt(schedule, 1_500, [0, 1_000, 2_000])).toBeCloseTo((2_000 / 7))
    expect(scheduleDistanceAt(schedule, 2_000, [0, 1_000, 2_000])).toBe(1_000)
  })

  it('没有时间线或站距时不做调度插值', () => {
    expect(scheduleDistanceAt(undefined, 1_500, [0, 1_000])).toBeNull()
    expect(scheduleDistanceAt(schedule, 1_500, [])).toBeNull()
  })
})
