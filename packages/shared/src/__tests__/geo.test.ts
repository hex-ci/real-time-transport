import { describe, expect, it } from 'vitest'
import {
  cumulativeDistances,
  distanceToSegment,
  haversineMeters,
  polylineLengthMeters,
  stationProgressToDistance,
} from '../geo.js'

describe('geo helpers', () => {
  it('haversineMeters computes a known distance', () => {
    // Beijing (116.4074, 39.9042) -> a point ~1.11 km due north (+0.01 deg lat)
    const d = haversineMeters(39.9042, 116.4074, 39.9142, 116.4074)
    expect(d).toBeGreaterThan(1100)
    expect(d).toBeLessThan(1120)
  })

  it('cumulativeDistances is monotonic and starts at 0', () => {
    const pts: Array<[number, number]> = [
      [39.9042, 116.4074],
      [39.9142, 116.4074],
      [39.9242, 116.4074],
    ]
    const cum = cumulativeDistances(pts)
    expect(cum).toHaveLength(3)
    expect(cum[0]).toBe(0)
    expect(cum[1]).toBeGreaterThan(0)
    expect(cum[2]).toBeGreaterThan(cum[1]!)
    expect(polylineLengthMeters(pts)).toBeCloseTo(cum[2]!, 3)
  })

  it('distanceToSegment maps distance onto 0-indexed leaving station + progress', () => {
    // 4 stations at 0, 1000, 3000, 6000 meters
    const sd = [0, 1000, 3000, 6000]

    // At the origin: leaving station idx 0, progress 0
    expect(distanceToSegment(0, sd)).toEqual({ index: 0, progress: 0 })

    // Halfway between station idx 1 and 2 (1000..3000 -> 2000)
    expect(distanceToSegment(2000, sd)).toEqual({ index: 1, progress: 0.5 })

    // Past the terminal clamps to the last segment at progress 1
    expect(distanceToSegment(99999, sd)).toEqual({ index: 2, progress: 1 })

    // Negative clamps to the start
    expect(distanceToSegment(-5, sd)).toEqual({ index: 0, progress: 0 })
  })

  it('distanceToSegment returns null for degenerate input', () => {
    expect(distanceToSegment(100, [])).toBeNull()
    expect(distanceToSegment(100, [0])).toBeNull()
    expect(distanceToSegment(100, [0, 0])).toBeNull()
  })

  it('stationProgressToDistance places a vehicle between order-1 and order (0-indexed)', () => {
    const sd = [0, 1000, 3000, 6000]
    // order=2 (1-indexed station being left) => leaving idx 1 (1000m), heading to idx 2 (3000m)
    expect(stationProgressToDistance(2, 0, sd)).toBe(1000)
    expect(stationProgressToDistance(2, 0.5, sd)).toBe(2000)
    // order=1 => leaving idx 0
    expect(stationProgressToDistance(1, 0.5, sd)).toBe(500)
    // order clamps into the last real segment
    expect(stationProgressToDistance(4, 0, sd)).toBe(3000)
  })
})
