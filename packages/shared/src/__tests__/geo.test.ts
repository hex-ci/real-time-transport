import { describe, expect, it } from 'vitest'
import {
  cumulativeDistances,
  distanceToSegment,
  haversineMeters,
  polylineLengthMeters,
  statedCoordinate,
  statedNumber,
  statedStopOrder,
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

/**
 * The stated-number rule, read directly.
 *
 * `statedNumber` is the ONE place 「the payload stated a number」 lives, and the
 * reads that price a value with it are pinned by their own files: the Amap
 * walking leg's two axes and the nearby radar's per-POI distance. What matters
 * here is the half `statedCoordinate` deliberately answers the OTHER way: a
 * stated `0` is a reading here and a sentinel there, because the two fields mean
 * different things. A distance of 0 metres is a POI on the measured point; a
 * coordinate of 0 on this app's GCJ-02 datum is a stop nobody placed.
 */
describe('statedNumber answers the number a payload stated, or states none', () => {
  it('answers the number the payload stated, including zero', () => {
    expect(statedNumber(120)).toBe(120)
    expect(statedNumber(0)).toBe(0)
    // Amap spells these as strings, and a spelled zero is the same stated zero.
    expect(statedNumber('0')).toBe(0)
    expect(statedNumber(' 120 ')).toBe(120)
  })

  it('answers no number for a field the payload left out or did not spell as one', () => {
    for (const absent of [undefined, null, '', '   ', 'abc', '116.4,39.9', false, {}, []]) {
      expect(statedNumber(absent), String(absent)).toBeUndefined()
    }
    expect(statedNumber(Number.NaN)).toBeUndefined()
    expect(statedNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(statedNumber(Number.NEGATIVE_INFINITY)).toBeUndefined()
  })

  it('keeps a stated zero apart from the absence a coordinate reads the same value as', () => {
    // The two rules must never collapse into one: this is exactly the pair of
    // readings that made `Number(poi.distance || 0)` a defect upstream and a
    // correct guard in `nearestStopOnLine`.
    expect(statedNumber(0)).toBe(0)
    expect(statedCoordinate(0)).toBeUndefined()
  })
})

/**
 * The coordinate rule, read directly.
 *
 * `statedCoordinate` is the ONE place the rule lives, and the providers pin the
 * reads that apply it; these cases pin the rule itself, so a rule that stops
 * being applied here cannot be mistaken for one no read ever depended on. Both
 * halves of the answer matter: the number a payload stated IS the number, and
 * everything that is not a position on this app's datum — either axis at 0, half
 * a pair, an empty string, a non-numeric one — is the SAME absence as a field
 * the payload omitted.
 */
describe('statedCoordinate answers the coordinate a payload stated, or states none', () => {
  it('answers the number the payload stated', () => {
    expect(statedCoordinate(39.9)).toBe(39.9)
    expect(statedCoordinate(116.4074)).toBe(116.4074)
    expect(statedCoordinate(-73.9857)).toBe(-73.9857)
  })

  it('reads a numeric string as the number it holds', () => {
    // A payload may spell a number either way, and both spellings are the same
    // fact about the same stop.
    expect(statedCoordinate('116.4')).toBe(116.4)
    expect(statedCoordinate(' 39.9 ')).toBe(39.9)
  })

  it('answers no position for a zero on either axis', () => {
    // No placed stop on this app's GCJ-02 datum sits at 0, so a zero is the
    // absence of a coordinate and not a coordinate whose value is zero.
    expect(statedCoordinate(0)).toBeUndefined()
    expect(statedCoordinate(-0)).toBeUndefined()
    expect(statedCoordinate('0')).toBeUndefined()
  })

  it('answers no position for a missing half of the pair', () => {
    expect(statedCoordinate(undefined)).toBeUndefined()
    expect(statedCoordinate(null)).toBeUndefined()
  })

  it('answers no position for a non-numeric string', () => {
    // A pair sent as one string is not a coordinate on either half of it.
    expect(statedCoordinate('abc')).toBeUndefined()
    expect(statedCoordinate('116.4,39.9')).toBeUndefined()
  })

  it('answers no position for an empty string', () => {
    expect(statedCoordinate('')).toBeUndefined()
    expect(statedCoordinate('   ')).toBeUndefined()
  })

  it('answers no position for a non-finite number or a non-number', () => {
    expect(statedCoordinate(Number.NaN)).toBeUndefined()
    expect(statedCoordinate(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(statedCoordinate(false)).toBeUndefined()
    expect(statedCoordinate({})).toBeUndefined()
    expect(statedCoordinate([])).toBeUndefined()
  })
})

/**
 * The stop-ordinal rule, read directly.
 *
 * `order` is what a stored leg is located BY, so a payload numbering that
 * diverges from a stop's position in the list must travel as the payload stated
 * it, and anything that is not a positive whole number must fall back to the list
 * position — a NaN or a 0 there would name an order no stop of the line occupies.
 */
describe('statedStopOrder answers the ordinal a payload stated, or the list position', () => {
  it('answers the number the payload stated', () => {
    expect(statedStopOrder(3, 1)).toBe(3)
    expect(statedStopOrder('3', 1)).toBe(3)
    expect(statedStopOrder('3.0', 1)).toBe(3)
  })

  it('keeps the payload numbering even where it diverges from the list position', () => {
    // The list IS the sequence by construction, but upstream's own numbering is
    // the authority when it states one: this platform is the payload's stop 5
    // even though it is the first element, and the list position would name a
    // different stop of the line.
    expect(statedStopOrder(5, 1)).toBe(5)
    expect(statedStopOrder(1, 9)).toBe(1)
  })

  it('falls back to the list position for an order that is not a positive whole number', () => {
    expect(statedStopOrder(undefined, 2)).toBe(2)
    expect(statedStopOrder(null, 2)).toBe(2)
    expect(statedStopOrder(0, 2)).toBe(2)
    expect(statedStopOrder('0', 2)).toBe(2)
    expect(statedStopOrder(-1, 2)).toBe(2)
    expect(statedStopOrder(1.5, 2)).toBe(2)
    expect(statedStopOrder('7.5', 2)).toBe(2)
    expect(statedStopOrder('', 2)).toBe(2)
    expect(statedStopOrder('x', 2)).toBe(2)
    expect(statedStopOrder(Number.NaN, 2)).toBe(2)
    expect(statedStopOrder(Number.POSITIVE_INFINITY, 2)).toBe(2)
  })
})
