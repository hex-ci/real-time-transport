import { describe, expect, it } from 'vitest'
import { stationBoardLinesOf } from '../providers/chelaile.js'

/**
 * 站台载荷 → 屏上的行（PRD F5「电子站牌」）。
 *
 * 上游一次应答里 `stationList` 是**若干组站台**，只有被查的那一组带线路身份与在途车，
 * 其余几组只有站名与线路名。判据因此是「这一组里有没有带 lineId 的线路」：
 * 拿错了组会把一屏空行渲染成「这站没有线路」，而那是一句关于站台的话，不是关于载荷的。
 *
 * 夹具用中性名（`NNN路` / `XX站`）：本仓是公开的，真实线路与站名不落在文件里。
 */

/** 一次应答的最小形状：一组完整的站台 + 两组只有站名与线路名的邻近站台。 */
function payloadOf(lines: unknown[]): unknown {
  return {
    stationList: [
      { lat: 39.9, distance: -1, lines },
      { lat: 39.91, distance: -1, lines: [{ line: { name: '101', direction: 0 } }] },
    ],
  }
}

/** 一条线路记录（上游形状）。 */
function lineOf(params: {
  lineId: string
  name: string
  direction?: number
  destination?: string
  first?: string
  last?: string
  isSubway?: number
  forecast?: string
  states?: unknown[]
}): unknown {
  return {
    line: {
      lineId: params.lineId,
      name: params.name,
      direction: params.direction ?? 0,
      endSn: params.destination ?? '末站',
      firstTime: params.first,
      lastTime: params.last,
      isSubway: params.isSubway,
    },
    preArrivalTime: params.forecast,
    stnStates: params.states ?? [],
  }
}

const READ_AT = 1_800_000_000_000

describe('站台载荷里取哪一组、取哪几条线', () => {
  it('只取带线路身份的那一组：只报了站名与线路名的组不算行', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'A1', name: '101' }),
      lineOf({ lineId: 'A2', name: '102', direction: 1 }),
    ]), READ_AT)

    expect(lines.map(line => line.lineId)).toEqual(['A1', 'A2'])
  })

  it('lineId 缺失的线路记录不成行：没有身份就没有可读的线路', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: '', name: '101' }),
      lineOf({ lineId: 'A2', name: '102' }),
    ]), READ_AT)

    expect(lines.map(line => line.lineId)).toEqual(['A2'])
  })

  it('载荷里没有完整的一组时是空数组，而不是抛错（空数组 = 这站没有可读的线路）', () => {
    expect(stationBoardLinesOf({ stationList: [{ lines: [{ line: { name: '101' } }] }] }, READ_AT)).toEqual([])
    expect(stationBoardLinesOf({}, READ_AT)).toEqual([])
    expect(stationBoardLinesOf(null, READ_AT)).toEqual([])
  })
})

describe('同一条线的两个方向各占一行', () => {
  it('两个方向都留下：行数不按线路名合并', () => {
    // 全站视图（带 `lineId` 的那次调用）会把两侧站牌并成一组，同一条线的上行与下行各有自己的
    // `lineId` 与开往。按线路名合并会让这一站只剩一个方向 —— 而这一页答的是「这个站上哪趟先来」。
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: '10114983855', name: 'T12', direction: 0, destination: '房辛店' }),
      lineOf({ lineId: '10114983856', name: 'T12', direction: 1, destination: '通州北苑路口南' }),
    ]), READ_AT)

    expect(lines.map(line => [line.lineName, line.direction, line.destination])).toEqual([
      ['T12', 0, '房辛店'],
      ['T12', 1, '通州北苑路口南'],
    ])
  })
})

describe('在途车：上游给了时刻才算一辆车', () => {
  it('每辆车的剩余秒数由读取时刻算出，按到站先后升序', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [
          { busId: 'b-late', arrivalTime: READ_AT + 600_000 },
          { busId: 'b-soon', arrivalTime: READ_AT + 120_000 },
        ],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals.map(a => [a.busId, a.remainSeconds])).toEqual([
      ['b-soon', 120],
      ['b-late', 600],
    ])
  })

  it('没有到站时刻的车不进列表：一辆车要么有时刻，要么不存在', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'A1', name: '101', states: [{ busId: 'b1', arrivalTime: 0 }, { busId: 'b2' }] }),
    ]), READ_AT)

    expect(lines[0]!.arrivals).toEqual([])
  })

  it('拥挤度与车辆标签取自这辆车自己的标签：拥挤度由芯片陈述，不混进标签里', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [
          { busId: 'b1', arrivalTime: READ_AT + 60_000, busTagList: [{ title: '无障碍' }, { title: '拥挤' }] },
          { busId: 'b2', arrivalTime: READ_AT + 90_000, busTagList: [] },
        ],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals[0]!.tags).toEqual(['无障碍'])
    expect(lines[0]!.arrivals[0]!.congestion).toBe('high')
    expect(lines[0]!.arrivals[1]!.congestion).toBe('unknown')
  })

  it('这辆车距本站还有多少米照上游带上：它是车的位置，不是线路的长度', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [{ busId: 'b1', arrivalTime: READ_AT + 484_000, distanceToDest: 2408 }],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals[0]!.distanceToStationMeters).toBe(2408)
  })

  it('距离的 -1 哨兵不是 0 米：非负数才算量到过', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [{ busId: 'b1', arrivalTime: READ_AT + 60_000, distanceToDest: -1 }],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals[0]!.distanceToStationMeters).toBeNull()
  })
})

describe('已经过去的那一班不是「正进站」', () => {
  it('上游留着过去的那一趟（travelTime 为 -1）时它不成行：剩余秒数是负的，按分钟的规则会读成 0', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [
          { busId: 'stale', arrivalTime: READ_AT - 600_000, travelTime: -1, distanceToDest: 3789 },
          { busId: 'live', arrivalTime: READ_AT + 300_000, travelTime: 300, distanceToDest: 2408 },
        ],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals.map(arrival => arrival.busId)).toEqual(['live'])
  })

  it('只是刚过去几秒的车仍成行：上游算这批时刻先于我们的读时刻，余量留 30 秒', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        states: [{ busId: 'just', arrivalTime: READ_AT - 3_000, distanceToDest: 40 }],
      }),
    ]), READ_AT)

    expect(lines[0]!.arrivals).toHaveLength(1)
    expect(lines[0]!.arrivals[0]!.remainSeconds).toBeLessThanOrEqual(0)
  })
})

describe('发车间隔预报与到站时刻是两种东西', () => {
  it('预报原文照传，不做任何换算', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'A1', name: '101', forecast: '16:41~16:51' }),
    ]), READ_AT)

    expect(lines[0]!.intervalForecast).toBe('16:41~16:51')
    expect(lines[0]!.arrivals).toEqual([])
  })

  it('有在途车的线路也照传上游给的窗口：本层不替上游取舍', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({
        lineId: 'A1',
        name: '101',
        forecast: '16:41~16:51',
        states: [{ busId: 'b1', arrivalTime: READ_AT + 60_000 }],
      }),
    ]), READ_AT)

    expect(lines[0]!.intervalForecast).toBe('16:41~16:51')
    expect(lines[0]!.arrivals).toHaveLength(1)
  })
})

describe('一条线路只带「这趟车」的事实', () => {
  it('开往、方向、首末班照上游给的原样带上；没给的是 null', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'A1', name: '101', first: '05:00', last: '21:00' }),
      lineOf({ lineId: 'A2', name: '102', direction: 1 }),
    ]), READ_AT)

    expect(lines[0]).toMatchObject({
      firstBusTime: '05:00',
      lastBusTime: '21:00',
      destination: '末站',
      direction: 0,
      isSubway: false,
    })
    expect(lines[1]).toMatchObject({
      firstBusTime: null,
      lastBusTime: null,
      direction: 1,
    })
  })

  it('线路自己的静态事实不进契约：总站数、本站序、下一站名都不在一条线路的字段里', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'A1', name: '101' }),
    ]), READ_AT)

    // 它们不随车走，同一方向的每一趟车都是同一个数；收进来只会诱使屏上把线路元数据
    // 说成车辆状态。故这里钉住字段集合本身，而不只是钉住取值。
    expect(Object.keys(lines[0]!).sort()).toEqual([
      'arrivals',
      'destination',
      'direction',
      'firstBusTime',
      'intervalForecast',
      'isSubway',
      'lastBusTime',
      'lineId',
      'lineName',
    ])
  })

  it('地铁线路的 isSubway 取自上游的 1，不是按线路名猜', () => {
    const lines = stationBoardLinesOf(payloadOf([
      lineOf({ lineId: 'subway_x', name: '地铁 1 号线', isSubway: 1 }),
    ]), READ_AT)

    expect(lines[0]!.isSubway).toBe(true)
  })
})
