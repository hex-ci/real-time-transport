/**
 * 把「每站一张到站表」还原成「一趟趟列车」。
 *
 * 时刻表只有站 × 时间，没有车次 id；发车间隔可能短于区间运行时间，所以相邻站之间
 * 同时有多班车在跑，不能按第 k 个对第 k 个。这里按「站间单调匹配」还原：
 *
 *   1. 先对相邻两站的时刻序列估一个区间耗时窗口（中位数 ± 余量）；
 *   2. 每推进一站，把「已存在的列车」与「下一站的时刻」做保序匹配
 *      （最大化匹配数，其次最小化 |gap - 中位数|）；
 *   3. 没匹配上的下一站时刻，视为中途加入的列车（短线车/回库车），开一趟新车。
 *
 * 还原出的列车只用于「位置/还剩几站/距离」这类可由时刻表确定的事实；不改变
 * 到站时刻本身（时刻仍取该站表里的原文）。
 */

export interface SubwayTrip {
  /** 稳定 id：由首次出现的站序与时刻组成，重建后不变。 */
  id: string
  /** times[stationIndex]：运营日秒；null = 这趟车还没开始 / 已经结束。 */
  times: Array<number | null>
}

export interface SegmentWindow {
  lo: number
  hi: number
  med: number
}

export interface TripPosition {
  /** 刚经过的站（1-based）。 */
  order: number
  /** 正驶向的站（1-based）。 */
  nextOrder: number
  progress: number
  distanceFromStart?: number
}

export interface TripArrival {
  etaSeconds: number
  stopsAway: number
  /** 车已经在本站停靠（到站后、发车前）；这时没有「还有几分钟」。 */
  isAtStation?: boolean
}

const MIN_RUN_SEC = 30
const MAX_RUN_SEC = 600
/** 停站时长（秒）。时刻表只给到站时刻，这是动画/进站口径的固定停站。 */
export const SUBWAY_DWELL_SEC = 30
/** 发车前提前出现在始发站的窗口（秒）；窗口外视为还没上线路。 */
export const SUBWAY_PRE_DEPARTURE_SEC = 60
const DEFAULT_WINDOW: SegmentWindow = { lo: 60, hi: 300, med: 120 }

function lowerBound(values: number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 相邻两站的区间耗时窗口：取每个上游时刻到下游最近的可疑时刻的差，
 * 用中位数定中心，再留 ±余量吸收停站与快慢车差异。
 */
export function segmentWindow(from: number[], to: number[]): SegmentWindow {
  const gaps: number[] = []
  for (const t of from) {
    const at = lowerBound(to, t + MIN_RUN_SEC)
    for (let k = at; k < Math.min(at + 2, to.length); k++) {
      const gap = to[k]! - t
      if (gap >= MIN_RUN_SEC && gap <= MAX_RUN_SEC) gaps.push(gap)
    }
  }
  if (gaps.length === 0) return DEFAULT_WINDOW
  gaps.sort((a, b) => a - b)
  const med = gaps[Math.floor(gaps.length / 2)]!
  return {
    lo: Math.max(MIN_RUN_SEC, med - 90),
    hi: Math.min(MAX_RUN_SEC, med + 120),
    med,
  }
}

/**
 * 保序匹配：active 与 candidates 都按时间升序。返回 [activeIndex, candidateIndex]。
 *
 * 目标是「尽量多匹配」，匹配数相同时「区间耗时尽量贴近中位数」；跳过不计分，
 * 所以一趟车/一个时刻最多只用一次，且不会交叉。
 */
export function matchSegment(
  active: number[],
  candidates: number[],
  window: SegmentWindow,
): Array<[number, number]> {
  const n = active.length
  const m = candidates.length
  if (n === 0 || m === 0) return []
  const width = m + 1
  const score = new Float64Array((n + 1) * width)
  const choice = new Uint8Array((n + 1) * width)
  const MATCH_REWARD = 1_000_000
  const NEG = -1e15

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = score[(i - 1) * width + j]!
      let pick: number = 1 // skip this active trip
      const skipCandidate = score[i * width + (j - 1)]!
      if (skipCandidate > best) {
        best = skipCandidate
        pick = 2
      }
      const gap = candidates[j - 1]! - active[i - 1]!
      if (gap >= window.lo && gap <= window.hi) {
        const matched = score[(i - 1) * width + (j - 1)]!
          + MATCH_REWARD - Math.abs(gap - window.med)
        if (matched >= best) {
          best = matched
          pick = 3
        }
      }
      score[i * width + j] = best === NEG ? 0 : best
      choice[i * width + j] = pick
    }
  }

  const pairs: Array<[number, number]> = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const pick = choice[i * width + j]
    if (pick === 3) {
      pairs.push([i - 1, j - 1])
      i--
      j--
    }
    else if (pick === 1) {
      i--
    }
    else {
      j--
    }
  }
  pairs.reverse()
  return pairs
}

/** 从每站的运营日时刻还原列车；任何一站没有时刻时返回空（不猜位置）。 */
export function buildSubwayTrips(stationTimes: number[][]): SubwayTrip[] {
  const stationCount = stationTimes.length
  if (stationCount < 2) return []
  if (stationTimes.some(times => times.length === 0)) return []

  const trips: SubwayTrip[] = stationTimes[0]!.map(time => ({
    id: `trip:0:${time}`,
    times: [time, ...Array<number | null>(stationCount - 1).fill(null)],
  }))

  for (let station = 0; station < stationCount - 1; station++) {
    const window = segmentWindow(stationTimes[station]!, stationTimes[station + 1]!)
    const active = trips
      .filter(trip => trip.times[station] !== null)
      .sort((a, b) => a.times[station]! - b.times[station]!)
    const activeTimes = active.map(trip => trip.times[station]!)
    const candidates = stationTimes[station + 1]!

    const pairs = matchSegment(activeTimes, candidates, window)
    const used = new Set<number>()
    for (const [activeIndex, candidateIndex] of pairs) {
      const trip = active[activeIndex]!
      trip.times[station + 1] = candidates[candidateIndex]!
      used.add(candidateIndex)
    }

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      if (used.has(candidateIndex)) continue
      const times: Array<number | null> = Array<number | null>(stationCount).fill(null)
      times[station + 1] = candidates[candidateIndex]!
      trips.push({
        id: `trip:${station + 1}:${candidates[candidateIndex]}`,
        times,
      })
    }
  }

  return trips
}

/** 当前时刻这趟车在哪一段；没开始/已结束返回 null。 */
export function tripPositionAt(
  trip: SubwayTrip,
  nowSec: number,
  stationDistances?: number[],
  dwellSec: number = SUBWAY_DWELL_SEC,
): TripPosition | null {
  const startIndex = trip.times.findIndex(time => typeof time === 'number')
  let last = -1
  for (let i = 0; i < trip.times.length; i++) {
    const time = trip.times[i]
    if (time === null || time === undefined) continue
    if (time <= nowSec) last = i
    else break
  }
  if (last < 0) {
    if (startIndex < 0) return null
    const startTime = trip.times[startIndex]!
    if (nowSec < startTime - SUBWAY_PRE_DEPARTURE_SEC || nowSec >= startTime) return null
    const waiting: TripPosition = {
      order: startIndex + 1,
      nextOrder: Math.min(startIndex + 2, trip.times.length),
      progress: 0,
    }
    if (stationDistances && stationDistances.length === trip.times.length) {
      waiting.distanceFromStart = stationDistances[startIndex]
    }
    return waiting
  }

  const next = last + 1
  if (next >= trip.times.length) {
    // 终点站：没有下一段，但停站窗口内车还在站台上；不返回位置会让
    // 线路图上先消失、弹窗却说「车辆正在本站」。窗口过后才真正消失。
    const lastTime = trip.times[last]!
    if (nowSec <= lastTime + dwellSec) {
      const atTerminal: TripPosition = {
        order: last + 1,
        nextOrder: last + 1,
        progress: 0,
      }
      if (stationDistances && stationDistances.length === trip.times.length) {
        atTerminal.distanceFromStart = stationDistances[last]
      }
      return atTerminal
    }
    return null
  }
  const nextTime = trip.times[next]
  if (nextTime === null || nextTime === undefined || nextTime <= trip.times[last]!) return null

  const from = trip.times[last]!
  // 始发站的表内时刻是发车时刻，不是到站后还要再停 30 秒；中间站才是到站。
  const departure = from + (last === startIndex ? 0 : dwellSec)
  const travelSec = Math.max(1, nextTime - departure)
  const progress = nowSec <= departure
    ? 0
    : Math.min(Math.max((nowSec - departure) / travelSec, 0), 0.999)
  const position: TripPosition = {
    order: last + 1,
    nextOrder: next + 1,
    progress,
  }

  if (stationDistances && stationDistances.length === trip.times.length) {
    const d0 = stationDistances[last]!
    const d1 = stationDistances[next]!
    position.distanceFromStart = d0 + (d1 - d0) * progress
  }
  return position
}

/**
 * 这趟车到目标站（0-based 站序）的剩余：几站、多少秒；到站停站时是
 * `isAtStation`。
 *
 * 目标时刻已过 / 车还没发车 / 车已过目标站时返回 null。没发车的车不合成为
 * 「在始发站、距本站 N 站」——线路上还没有这辆车，站数就是无源之水。
 *
 * `stopsAway` 与公交的 `stopsAwayOf` 同义：车头就是本站时是 0。
 */
export function tripArrivalFor(
  trip: SubwayTrip,
  targetIndex: number,
  nowSec: number,
  stationDistances?: number[],
  dwellSec: number = SUBWAY_DWELL_SEC,
): TripArrival | null {
  const targetTime = trip.times[targetIndex]
  if (targetTime === null || targetTime === undefined) return null

  const targetOrder = targetIndex + 1
  const startIndex = trip.times.findIndex(time => typeof time === 'number')
  const stationDwell = targetIndex === startIndex ? 0 : dwellSec
  const position = tripPositionAt(trip, nowSec, stationDistances, dwellSec)
  if (!position) {
    // 终点站没有「下一段」，tripPositionAt 在到站后返回 null；停站窗口内
    // 仍然要回答「车在本站」，否则终点站永远只剩一个钟点。
    let lastServed = trip.times.length - 1
    while (lastServed >= 0 && typeof trip.times[lastServed] !== 'number') lastServed--
    if (
      targetIndex === lastServed
      && targetTime <= nowSec
      && nowSec <= targetTime + dwellSec
    ) {
      return { etaSeconds: 0, stopsAway: 0, isAtStation: true }
    }

    // 还没发车：线路上没有这辆车，不猜它在始发站。只留时刻，不报站数。
    return null
  }

  // 始发站待发：车已经在本站，行是待发的钟点；这时也不能报「0 分钟」。
  if (targetIndex === startIndex && targetTime >= nowSec) {
    return { etaSeconds: targetTime - nowSec, stopsAway: 0, isAtStation: true }
  }

  // 到站后在停站窗口内：这是「车在本站」，不是「0 分钟」。
  if (
    targetTime <= nowSec
    && position.order === targetOrder
    && nowSec <= targetTime + stationDwell
  ) {
    return { etaSeconds: 0, stopsAway: 0, isAtStation: true }
  }

  if (targetTime < nowSec) return null
  if (position.nextOrder > targetOrder) return null

  return {
    etaSeconds: targetTime - nowSec,
    stopsAway: Math.max(0, targetOrder - position.nextOrder),
  }
}
