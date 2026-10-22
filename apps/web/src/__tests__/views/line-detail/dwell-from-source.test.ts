import { describe, expect, it } from 'vitest'
import { LiveBusSchema } from '@real-time-transport/shared'

/**
 * 停靠判据：车来了对停在站台上的车仍会报 5~11 m/s 的瞬时速度。
 * 只按速度判停靠时，动画会拿那个速度外推——18 秒一轮就是 200 米，
 * 正好落在下一段路的中间，而弹窗同时还在说「车辆正在本站」。
 *
 * 上游自己用 `state: 1` 陈述「停在站台上」；provider 把它变成 `atStop`。
 * 有该字段时以它为准，没有时才退回低速判据。
 */

const AT_STOP_THRESHOLD_MS = 1.0

/** route-board 里 `syncVehicles` 的那条规则，原样抄一份用于钉住语义。 */
function dwellOf(bus: { atStop?: boolean, speed?: number }): boolean {
  const dwell = bus.atStop === true
    || (bus.atStop === undefined && bus.speed !== undefined && bus.speed < AT_STOP_THRESHOLD_MS)
  return dwell
}

const bus = (fields: Record<string, unknown>) => LiveBusSchema.parse({
  id: 'B1',
  order: 7,
  nextOrder: 8,
  congestion: 'unknown',
  updatedAt: 1,
  ...fields,
})

describe('dwell comes from the source statement, not from the reported speed', () => {
  it('treats an at-stop vehicle as dwelling even while it reports 11.1 m/s', () => {
    expect(dwellOf(bus({ atStop: true, speed: 11.1 }))).toBe(true)
  })

  it('lets an at-stop vehicle keep moving only when the source did not say so', () => {
    expect(dwellOf(bus({ speed: 11.1 }))).toBe(false)
  })

  it('still honours the low-speed fallback for sources without the field', () => {
    expect(dwellOf(bus({ speed: 0.3 }))).toBe(true)
  })

  it('does not invent a stop from the absence of the field', () => {
    // 地铁引擎与备用来源都没有这个字段：它们靠速度说自己在停靠。
    expect(dwellOf(bus({ speed: 6 }))).toBe(false)
  })

  it('keeps atStop out of the schema unless the source said it', () => {
    expect(bus({ atStop: true }).atStop).toBe(true)
    expect(bus({}).atStop).toBeUndefined()
  })
})
