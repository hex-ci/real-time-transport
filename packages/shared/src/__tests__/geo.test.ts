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
    const sd = [0, 1000, 3000, 6000]

    expect(distanceToSegment(0, sd)).toEqual({ index: 0, progress: 0 })

    expect(distanceToSegment(2000, sd)).toEqual({ index: 1, progress: 0.5 })

    expect(distanceToSegment(99999, sd)).toEqual({ index: 2, progress: 1 })

    expect(distanceToSegment(-5, sd)).toEqual({ index: 0, progress: 0 })
  })

  it('distanceToSegment returns null for degenerate input', () => {
    expect(distanceToSegment(100, [])).toBeNull()
    expect(distanceToSegment(100, [0])).toBeNull()
    expect(distanceToSegment(100, [0, 0])).toBeNull()
  })

  it('stationProgressToDistance places a vehicle between order-1 and order (0-indexed)', () => {
    const sd = [0, 1000, 3000, 6000]
    expect(stationProgressToDistance(2, 0, sd)).toBe(1000)
    expect(stationProgressToDistance(2, 0.5, sd)).toBe(2000)
    expect(stationProgressToDistance(1, 0.5, sd)).toBe(500)
    expect(stationProgressToDistance(4, 0, sd)).toBe(3000)
  })
})

/**
 * 上游声明数字的规则，直接读取。
 * `statedNumber` 是「payload 声明了一个数字」的唯一居所；
 * 关键在 `statedCoordinate` 刻意反向回答的那一半：声明的 `0` 在这里是读数、在那里是哨兵，
 * 因为两个字段含义不同 —— 0 米是 POI 就在测点上，而本应用基准面上的 0 坐标是没人落点的站。
 */
describe('statedNumber answers the number a payload stated, or states none', () => {
  it('answers the number the payload stated, including zero', () => {
    expect(statedNumber(120)).toBe(120)
    expect(statedNumber(0)).toBe(0)
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
    // 两条规则不得合流：0 在 statedNumber 是读数，在 statedCoordinate 是缺省。
    expect(statedNumber(0)).toBe(0)
    expect(statedCoordinate(0)).toBeUndefined()
  })
})

/**
 * 坐标规则，直接读取。
 * `statedCoordinate` 是该规则的唯一居所；此处钉住规则本身，
 * 故某处不再应用它时，不会被误认为「从没有读取依赖过它」。两个方向都重要：
 * payload 声明的数就是那个数；而任何不是本应用基准面上位置的值（任一轴为 0、半个配对、
 * 空串、非数字）与 payload 直接缺字段是同一种「缺省」。
 */
describe('statedCoordinate answers the coordinate a payload stated, or states none', () => {
  it('answers the number the payload stated', () => {
    expect(statedCoordinate(39.9)).toBe(39.9)
    expect(statedCoordinate(116.4074)).toBe(116.4074)
    expect(statedCoordinate(-73.9857)).toBe(-73.9857)
  })

  it('reads a numeric string as the number it holds', () => {
    expect(statedCoordinate('116.4')).toBe(116.4)
    expect(statedCoordinate(' 39.9 ')).toBe(39.9)
  })

  it('answers no position for a zero on either axis', () => {
    expect(statedCoordinate(0)).toBeUndefined()
    expect(statedCoordinate(-0)).toBeUndefined()
    expect(statedCoordinate('0')).toBeUndefined()
  })

  it('answers no position for a missing half of the pair', () => {
    expect(statedCoordinate(undefined)).toBeUndefined()
    expect(statedCoordinate(null)).toBeUndefined()
  })

  it('answers no position for a non-numeric string', () => {
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
 * 站序规则，直接读取。
 * `order` 是已存路段据以定位的字段，故 payload 的编号与列表下标不一致时必须照 payload 出行；
 * 任何非正整数的值都回落到列表下标 —— 那里出现 NaN 或 0 会指到一个该线没有的站序。
 */
describe('statedStopOrder answers the ordinal a payload stated, or the list position', () => {
  it('answers the number the payload stated', () => {
    expect(statedStopOrder(3, 1)).toBe(3)
    expect(statedStopOrder('3', 1)).toBe(3)
    expect(statedStopOrder('3.0', 1)).toBe(3)
  })

  it('keeps the payload numbering even where it diverges from the list position', () => {
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
