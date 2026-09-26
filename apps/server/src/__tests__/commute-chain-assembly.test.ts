import { describe, expect, it } from 'vitest'
import type { ArrivalBasis, LiveLineStatus, OperatingStatus } from '@real-time-transport/shared'
import { legLiveReading, pairTargetedReads } from '../services/commute-chain-assembly.js'

/**
 * F10 服务端的纯逻辑部分：两个定向读数合成推算所用的那一个读数。
 *
 * 每个读数只回答一个目标站，因此一辆车的上车分钟与下车分钟只能来自两次读数，而两次读数各按
 * 自己的到达顺序排列：一切只由上游稳定的车辆 id 判定，别的都不算数。
 *
 * 101 / 甲路 / 乙路 是占位：本文件不出现真实线路、站点或车辆 id。
 */

const NOW = 1_700_000_000_000

/** 该段的 F3 运营状态，由线路时刻推出。 */
const STATE: OperatingStatus = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' }

/** 一辆车在一个目标站的到达，按实时路径定价。 */
function arrival(vehicleId: string, etaSeconds: number, basis: ArrivalBasis = 'upstream') {
  return { vehicleId, etaSeconds, basis }
}

/** 一段的定向读数：线路状态，没有值得关注的车辆。 */
function reading(over: Partial<LiveLineStatus> = {}): LiveLineStatus {
  return {
    lineId: '101',
    direction: 0,
    buses: [],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: NOW,
    ...over,
  }
}

describe('F10 assembly: the two targeted reads are matched by vehicle id', () => {
  it('pairs each vehicle\'s board minute with its own alight minute, never by position', () => {
    // 两次读数各按自己的到达分钟排列，第二段读数的首行与第一段的首行不是同一辆车：
    // 按第 n 对第 n 配对，会把一辆车的下车分钟放到另一辆车的上车分钟旁边。
    const vehicles = pairTargetedReads(
      [arrival('A', 180), arrival('B', 480)],
      [arrival('B', 1200), arrival('A', 1500)],
    )

    expect(vehicles).toEqual([
      { vehicleId: 'A', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 1500, basis: 'upstream' },
      { vehicleId: 'B', arrivalAtBoardSeconds: 480, arrivalAtAlightSeconds: 1200, basis: 'upstream' },
    ])
  })

  it('drops a vehicle only one of the two reads carries', () => {
    // 只出现在一次读数里的车不成对，不能交给推算：过了上车站的只在下车读数里，
    // 被本次构建从下车读数里丢掉的那辆则根本没有下车分钟。
    const vehicles = pairTargetedReads(
      [arrival('A', 180), arrival('B', 480)],
      [arrival('C', 900), arrival('B', 1200)],
    )

    expect(vehicles.map(v => v.vehicleId)).toEqual(['B'])
    expect(vehicles[0]?.arrivalAtBoardSeconds).toBe(480)
    expect(vehicles[0]?.arrivalAtAlightSeconds).toBe(1200)
  })

  it('pairs the strict superset upstream actually sends, id by id', () => {
    // 真实形状。上游只返回尚未越过所请求站序的车，该过滤对站序单调，因此上车读数的行是
    // 下车读数行的子集，多出来的那行正是已经过了上车站的车。
    const vehicles = pairTargetedReads(
      [arrival('v1', 180), arrival('v2', 480)],
      // 下车读数按自己的到达分钟排列，其首行与上车读数的首行不是同一辆车。
      [arrival('v3', 900), arrival('v1', 1500), arrival('v2', 1200)],
    )

    // v3 没有上车分钟：丢弃，不编造。
    expect(vehicles.map(v => v.vehicleId)).toEqual(['v1', 'v2'])
    expect(vehicles[0]).toEqual({
      vehicleId: 'v1', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 1500, basis: 'upstream',
    })
    expect(vehicles[1]).toEqual({
      vehicleId: 'v2', arrivalAtBoardSeconds: 480, arrivalAtAlightSeconds: 1200, basis: 'upstream',
    })
  })

  it('carries no vehicle at all when the two reads share none', () => {
    expect(pairTargetedReads([arrival('A', 180)], [arrival('B', 900)])).toEqual([])
    expect(pairTargetedReads([], [arrival('B', 900)])).toEqual([])
  })

  it('takes the basis of the ALIGHT minute, which is the minute the mark qualifies', () => {
    // 标记修饰的是下车分钟（`ChainLegVehicle.basis`）：载荷带来的上车分钟不参与，
    // 故它不会被读成本应用算出的那一分钟（见 F4：词汇表已不含该档）。
    const [vehicle] = pairTargetedReads(
      [arrival('A', 180, 'upstream')],
      [arrival('A', 900, 'our_estimate')],
    )

    expect(vehicle?.basis).toBe('our_estimate')
  })
})

describe('F10 assembly: one leg has one reading, and it states what it knows', () => {
  const vehicles = [{ vehicleId: 'A', arrivalAtBoardSeconds: 180, arrivalAtAlightSeconds: 900, basis: 'upstream' as const }]

  it('states no reading when either of the two reads did not answer', () => {
    // 半对不成读数：没有下车分钟的上车分钟定不了价，报出应答的那一半等于宣称一段并不存在的读数。
    expect(legLiveReading({ board: null, alight: reading(), vehicles, boardVehiclesOnTheWay: 1, operatingStatus: STATE })).toBeNull()
    expect(legLiveReading({ board: reading(), alight: null, vehicles, boardVehiclesOnTheWay: 1, operatingStatus: STATE })).toBeNull()
  })

  it('states no source when the two reads were answered by different ones', () => {
    // 来自两个数据源的上车分钟与下车分钟不是一个读数：点名其中任何一个，都是宣称这一对
    // 并不具备的出处，引擎随后报 `provenance-unknown`。
    const split = legLiveReading({
      board: reading({ dataSource: 'chelaile' }),
      alight: reading({ dataSource: 'subway_schedule' }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })
    expect(split?.dataSource).toBeNull()

    const same = legLiveReading({
      board: reading({ dataSource: 'apizero' }),
      alight: reading({ dataSource: 'apizero' }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })
    expect(same?.dataSource).toBe('apizero')
  })

  it('judges the leg by its OLDER read, and a fallback on either side is a fallback', () => {
    // 新鲜度每段只判一次，所以这一段的时刻必须取两者中较旧的那个：取较新的会把这一对没有的
    // 年龄算给它，推演就会在一个陈旧读数上得出结论。
    const live = legLiveReading({
      board: reading({ updatedAt: NOW - 5_000, isDegraded: false }),
      alight: reading({ updatedAt: NOW - 60_000, isDegraded: true }),
      vehicles,
      boardVehiclesOnTheWay: 1,
      operatingStatus: STATE,
    })

    expect(live?.updatedAt).toBe(NOW - 60_000)
    expect(live?.isDegraded).toBe(true)
    expect(live?.vehicles).toEqual(vehicles)
  })

  it('carries the matched vehicles through untouched', () => {
    expect(legLiveReading({ board: reading(), alight: reading(), vehicles: [], boardVehiclesOnTheWay: 0, operatingStatus: STATE })?.vehicles)
      .toEqual([])
  })

  it('carries the count the board read carried, so an empty pair can say WHY', () => {
    // 上车读数带了三辆、配对留了零辆：这一段的读数仍带上车读数自己的数量，引擎才能把
    // 「一趟车都没有」与「两个读数没有对上的车」分开 —— 同样的空 `vehicles`，两个事实。
    const live = legLiveReading({ board: reading(), alight: reading(), vehicles: [], boardVehiclesOnTheWay: 3, operatingStatus: STATE })
    expect(live?.boardVehiclesOnTheWay).toBe(3)
    expect(live?.vehicles).toEqual([])
  })

  it('carries the leg\'s service state, so an empty answer can be governed by it', () => {
    // 状态只能来自这个读数：它由同一段读到的线路推出，页面拿着「没有可乘的车」才能把
    // 首班前 / 已过末班 与运营中的空档分开。
    const live = legLiveReading({
      board: reading(),
      alight: reading(),
      vehicles: [],
      boardVehiclesOnTheWay: 0,
      operatingStatus: { state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' },
    })
    expect(live?.operatingStatus).toEqual({ state: 'after_last', firstDeparture: '05:00', lastDeparture: '23:00' })
  })
})
