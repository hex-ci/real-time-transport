import { describe, expect, it } from 'vitest'
import { GLIDE_CONVERGE_SEC, MAX_BUS_SPEED_MS, dwellTarget, glideStep } from '../../../views/line-detail/glide'

/**
 * 车来了对停在站台上的车仍报 5~11 m/s。上一版把图标"吸附"到站台，
 * 90 米的差距在 0.5 秒时间常数下被拉过去，实测读数冲到 1224 km/h。
 * 现在所有修正都走 glideStep：只能开到站台，不能闪过去。
 */

describe('glideStep', () => {
  it('walks to the target at the physical speed cap, never faster', () => {
    const dt = 1 / 60
    for (let i = 0; i < 60 * 20; i++) {
      const step = glideStep(0, 500, dt)
      expect(Math.abs(step) / dt).toBeLessThanOrEqual(MAX_BUS_SPEED_MS + 1e-9)
    }
  })

  it('covers a 90 m gap without ever exceeding the cap in a single frame', () => {
    const dt = 1 / 60
    let pos = 0
    let frames = 0
    while (pos < 90 - 1e-3 && frames < 60 * 60) {
      const step = glideStep(pos, 90, dt)
      expect(step / dt).toBeLessThanOrEqual(MAX_BUS_SPEED_MS + 1e-9)
      pos += step
      frames++
    }
    expect(pos).toBeCloseTo(90, 2)
    // 90 米至少要走 5.6 秒（16 m/s），不可能一帧到位
    expect(frames / 60).toBeGreaterThan(5)
  })

  it('eases out near the target instead of stopping dead', () => {
    const near = glideStep(89, 90, 1 / 60) / (1 / 60)
    const far = glideStep(0, 90, 1 / 60) / (1 / 60)
    expect(near).toBeLessThan(far)
    expect(near).toBeCloseTo(1 / GLIDE_CONVERGE_SEC, 5)
  })

  it('moves backwards when the target is behind (only used while stopped)', () => {
    expect(glideStep(100, 90, 1 / 60)).toBeLessThan(0)
  })

  it('snaps the last fraction of a metre instead of approaching forever', () => {
    expect(glideStep(0, 0.2, 10)).toBeCloseTo(0.2, 9)
  })

  it('does nothing without a time step', () => {
    expect(glideStep(0, 100, 0)).toBe(0)
  })
})

describe('dwellTarget', () => {
  it('draws a stopped vehicle on the platform when the source reports it nearby', () => {
    expect(dwellTarget(1055, 1000, 90)).toBe(1000)
    expect(dwellTarget(940, 1000, 90)).toBe(1000)
  })

  it('keeps the reported position when it is far from any platform', () => {
    expect(dwellTarget(1200, 1000, 90)).toBe(1200)
  })

  it('falls back to the reported position when the platform is unknown', () => {
    expect(dwellTarget(500, null, 90)).toBe(500)
    expect(dwellTarget(null, 1000, 90)).toBeNull()
  })
})
