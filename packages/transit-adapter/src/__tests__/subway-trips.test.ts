import { describe, expect, it } from 'vitest'
import {
  buildSubwayTrips,
  matchSegment,
  segmentWindow,
  tripArrivalFor,
  tripPositionAt,
} from '../subway-trips.js'

const MIN = 60

describe('subway trips: 还原时刻表里的列车', () => {
  it('每站都有同一组车时，还原成一一对应的列车', () => {
    const trips = buildSubwayTrips([
      [0, 2 * MIN, 4 * MIN],
      [2 * MIN, 4 * MIN, 6 * MIN],
      [4 * MIN, 6 * MIN, 8 * MIN],
    ])
    expect(trips).toHaveLength(3)
    for (const trip of trips) {
      expect(trip.times.filter(t => t !== null)).toHaveLength(3)
      expect(trip.times[1]! - trip.times[0]!).toBe(2 * MIN)
      expect(trip.times[2]! - trip.times[1]!).toBe(2 * MIN)
    }
  })

  it('发车间隔短于区间耗时时，仍按保序匹配，不按第 k 个对第 k 个', () => {
    const trips = buildSubwayTrips([
      [0, 2 * MIN, 4 * MIN, 6 * MIN],
      [3 * MIN, 5 * MIN, 7 * MIN, 9 * MIN],
    ])
    expect(trips).toHaveLength(4)
    for (const trip of trips) {
      expect(trip.times[1]! - trip.times[0]!).toBe(3 * MIN)
    }
  })

  it('短线车在中途结束、后面有个别时刻没人接，就开一趟新车', () => {
    const trips = buildSubwayTrips([
      [0, 2 * MIN, 4 * MIN],
      [2 * MIN, 4 * MIN, 6 * MIN],
      [4 * MIN, 6 * MIN],
    ])
    expect(trips.length).toBeGreaterThanOrEqual(3)
    // 每个站点的每个时刻都只属于一趟车
    for (let station = 0; station < 3; station++) {
      const seen = trips
        .map(trip => trip.times[station])
        .filter((t): t is number => t !== null)
      expect(new Set(seen).size).toBe(seen.length)
    }
  })

  it('区间窗口用中位数，缺数据时有兜底', () => {
    expect(segmentWindow([0, 120], [150, 270])).toEqual({ lo: 60, hi: 270, med: 150 })
    expect(segmentWindow([0], [])).toEqual({ lo: 60, hi: 300, med: 120 })
  })

  it('保序匹配不会让两趟车交叉', () => {
    const pairs = matchSegment([0, 120], [150, 270], { lo: 60, hi: 300, med: 150 })
    expect(pairs).toEqual([[0, 0], [1, 1]])
  })
})

describe('subway trips: 当前位置与剩余站数', () => {
  const trip = buildSubwayTrips([
    [0],
    [2 * MIN],
    [4 * MIN],
  ])[0]!
  const distances = [0, 1000, 2000]

  it('按当前时间落在哪一段算进度与距离', () => {
    const pos = tripPositionAt(trip, MIN, distances)
    expect(pos).toMatchObject({ order: 1, nextOrder: 2 })
    // 始发站表内时刻就是发车：0 到 2 分钟之间 1 分钟走完一半。
    expect(pos!.progress).toBeCloseTo(0.5)
    expect(pos!.distanceFromStart).toBeCloseTo(500)
  })

  it('目标站还剩几站：下一站就是目标时为 0', () => {
    expect(tripArrivalFor(trip, 1, MIN, distances)).toMatchObject({
      etaSeconds: MIN,
      stopsAway: 0,
    })
    expect(tripArrivalFor(trip, 2, MIN, distances)).toMatchObject({
      etaSeconds: 3 * MIN,
      stopsAway: 1,
    })
  })

  it('还没发车或停站结束后没有位置，终点停站窗口内还在站上', () => {
    expect(tripPositionAt(trip, -61, distances)).toBeNull()
    expect(tripPositionAt(trip, 4 * MIN + 10, distances)).toMatchObject({
      order: 3,
      nextOrder: 3,
      progress: 0,
    })
    expect(tripPositionAt(trip, 5 * MIN, distances)).toBeNull()
  })
})

describe('subway trips: 始发站待发的车', () => {
  it('发车前 60 秒内出现在始发站，窗口外不生成位置', () => {
    const trip = buildSubwayTrips([
      [10 * MIN],
      [12 * MIN],
      [14 * MIN],
    ])[0]!
    // 10 分钟发车，08:30 还在窗口外
    expect(tripPositionAt(trip, 8 * MIN + 30)).toBeNull()
    // 09:30 进入 60 秒窗口，停在始发站；到站行按始发站位置报站数
    expect(tripPositionAt(trip, 9 * MIN + 30, [0, 1000, 2000])).toMatchObject({
      order: 1,
      nextOrder: 2,
      progress: 0,
    })
    expect(tripArrivalFor(trip, 2, 9 * MIN + 30, [0, 1000, 2000])).toMatchObject({
      stopsAway: 1,
    })
    // 始发站本身：车就在本站待发，不能报 0 分钟。
    expect(tripArrivalFor(trip, 0, 9 * MIN + 30)).toMatchObject({
      isAtStation: true,
      etaSeconds: 30,
    })
  })
})

describe('subway trips: 车在本站', () => {
  const trip = buildSubwayTrips([
    [0],
    [2 * MIN],
    [4 * MIN],
  ])[0]!

  it('始发站没有停站窗口，中间站到站后有 30 秒停站', () => {
    expect(tripArrivalFor(trip, 0, 0)).toMatchObject({
      etaSeconds: 0,
      stopsAway: 0,
      isAtStation: true,
    })
    expect(tripArrivalFor(trip, 0, 10)).toBeNull()
    expect(tripArrivalFor(trip, 1, 2 * MIN + 10)).toMatchObject({
      etaSeconds: 0,
      isAtStation: true,
    })
    expect(tripArrivalFor(trip, 1, 2 * MIN + 31)).toBeNull()
  })

  it('终点站停站期间同样是 isAtStation', () => {
    expect(tripArrivalFor(trip, 2, 4 * MIN)).toMatchObject({
      etaSeconds: 0,
      isAtStation: true,
    })
    expect(tripArrivalFor(trip, 2, 4 * MIN + 10)).toMatchObject({ isAtStation: true })
    expect(tripArrivalFor(trip, 2, 4 * MIN + 31)).toBeNull()
  })
})
