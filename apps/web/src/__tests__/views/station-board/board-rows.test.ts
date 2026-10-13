import { describe, expect, it } from 'vitest'
import type { StationBoard, StationBoardLine } from '@real-time-transport/shared'
import {
  boardRowsOf,
  etaTextOf,
  footnoteTextOf,
  forecastTextOf,
  quietTextOf,
  serviceTextOf,
  distanceToStationTextOf,
} from '../../../views/station-board/board-rows'

/**
 * 电子站牌屏的行规则（PRD F5）。
 *
 * 这一屏要回答的问题只有一句：**这个站台上哪趟先来**。故本文件守四件事：
 *  - 排序就是那个答案本身（有车的按最快那班在前，只有发车间隔预报的其次，都没有的最后）；
 *  - 分钟与预报是两种东西，绝不互填；
 *  - 一行只陈述**这辆车**的事实（剩余分钟、距本站的距离、拥挤度、车辆标签）；线路自己的
 *    静态事实（总站数、本站序、下一站名）不进契约、也不在这屏上 —— 它们不随车走，
 *    说在这儿会被读成车辆状态；
 *  - 数字都从**这次读数自己的时刻**推出来，缺一个就不编（零假数据）。
 *
 * `NNN路` / `NN站` 是占位：本文件不出现真实线路与站名。
 */

const READ_AT = 1_800_000_000_000

function lineOf(params: Partial<StationBoardLine> & { lineId: string, lineName: string }): StationBoardLine {
  return {
    direction: 0,
    destination: 'NN终点站',
    firstBusTime: null,
    lastBusTime: null,
    isSubway: false,
    arrivals: [],
    intervalForecast: null,
    ...params,
  }
}

/** 一辆车：`seconds` 是它相对读取时刻的剩余秒数，`meters` 是它距本站还有多远。 */
function arrivalOf(busId: string, seconds: number, meters: number | null = null) {
  return {
    busId,
    arriveAt: READ_AT + seconds * 1000,
    remainSeconds: seconds,
    distanceToStationMeters: meters,
    congestion: 'unknown' as const,
    tags: [],
  }
}

function boardOf(lines: StationBoardLine[]): StationBoard {
  return { stationId: '010-00001', readAt: READ_AT, dataSource: 'chelaile', lines }
}

describe('排序：哪趟先来', () => {
  it('有车的按最快那班升序在前，只有预报的其次，都没有的最后；同档按线路名', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'D', lineName: '404路' }),
      lineOf({ lineId: 'C', lineName: '303路', intervalForecast: '16:41~16:51' }),
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 720)] }),
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ]))

    expect(rows.map(row => row.lineName)).toEqual(['101路', '202路', '303路', '404路'])
  })

  it('上游没给新东西时次序不变：同样的一批行排法一致', () => {
    const board = boardOf([
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 700)] }),
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ])

    const once = boardRowsOf(board).map(row => row.key)
    const again = boardRowsOf({ ...board, readAt: board.readAt + 12_000 }).map(row => row.key)
    expect(again).toEqual(once)
  })

  it('两个方向的同一条线路是两行，各自算各自的车', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', direction: 0, arrivals: [arrivalOf('a1', 300)] }),
      lineOf({ lineId: 'A', lineName: '101路', direction: 1, arrivals: [arrivalOf('a2', 120)] }),
    ]))

    expect(rows.map(row => row.key)).toEqual(['A_1', 'A_0'])
    expect(rows[0]!.etaMinutes).toBe(2)
  })
})

describe('分钟从这次读数自己的时刻推出来', () => {
  it('30 秒读作 1 分钟，0 秒是正进站（与全站同一口径）', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 30)] }),
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 0)] }),
    ]))

    expect(rows.map(etaTextOf)).toEqual(['正进站', '还有 1 分钟'])
  })

  it('分钟是读取那一刻的分钟：同一份读数读几次都是同一个数，年龄由「最后更新」那句披露', () => {
    const board = boardOf([lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] })])

    expect(boardRowsOf(board)[0]!.etaMinutes).toBe(5)
    // 读数自己的时刻不动，故数字不动：页面停多久都不会把它自己走成另一个数。
    expect(boardRowsOf(board)[0]!.etaMinutes).toBe(5)
    expect(board.readAt).toBe(READ_AT)
  })

  it('到站钟点取自上游给的绝对时刻，后面几班并列', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [arrivalOf('a1', 300), arrivalOf('a2', 900)],
      }),
    ]))

    const row = rows[0]!
    const first = new Date(READ_AT + 300_000)
    const later = new Date(READ_AT + 900_000)
    const clock = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(row.firstArrivalClock).toBe(clock(first))
    expect(row.laterClocks).toEqual([clock(later)])
    expect(row.laterMinutes).toEqual([15])
  })
})

describe('预报与到站时刻是两种东西', () => {
  it('只有预报的行没有分钟，预报原文照说并标明它是预报', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'C', lineName: '303路', intervalForecast: '16:41~16:51' }),
    ]))[0]!

    expect(row.etaMinutes).toBeNull()
    expect(etaTextOf(row)).toBeNull()
    expect(forecastTextOf(row)).toBe('预报 16:41~16:51')
    expect(quietTextOf(row)).toBeNull()
  })

  it('有车的行不会同时被预报顶上：预报那份措辞只属于没有车的行', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)], intervalForecast: '16:41~16:51' }),
    ]))[0]!

    expect(etaTextOf(row)).toBe('还有 5 分钟')
    expect(quietTextOf(row)).toBeNull()
  })
})

describe('缺一个就不编', () => {
  it('这趟车距本站多远：上游给了米数就说，用的是全站那一条距离规则', () => {
    const far = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300, 2408)] }),
    ]))[0]!
    expect(distanceToStationTextOf(far)).toBe('距本站 2.4 公里')

    const near = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300, 850)] }),
    ]))[0]!
    expect(distanceToStationTextOf(near)).toBe('距本站 850 米')
  })

  it('上游没给这个读数时不说，也不拿分钟或站数折一个出来', () => {
    const unknown = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ]))[0]!
    expect(distanceToStationTextOf(unknown)).toBeNull()

    // 只有预报的行没有车，也就没有车的位置。
    const forecastOnly = boardRowsOf(boardOf([
      lineOf({ lineId: 'B', lineName: '202路', intervalForecast: '16:41~16:51' }),
    ]))[0]!
    expect(distanceToStationTextOf(forecastOnly)).toBeNull()
  })

  it('距离说的是最快那班那辆车的位置：与那一行的分钟同一辆车、同一份读数', () => {
    const row = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [arrivalOf('a1', 120, 900), arrivalOf('a2', 900, 9000)],
      }),
    ]))[0]!

    expect(row.etaMinutes).toBe(2)
    expect(distanceToStationTextOf(row)).toBe('距本站 900 米')
  })

  it('没有车也没有预报时主位说「暂无到站信息」，首末班由底下那行小字照说', () => {
    const withService = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', firstBusTime: '05:00', lastBusTime: '22:00' }),
    ]))[0]!
    expect(quietTextOf(withService)).toBe('暂无到站信息')
    expect(footnoteTextOf(withService)).toBe('首末班 05:00–22:00')

    // 首末班缺一个就整句不说：半个首末班不是一条运营事实。
    const half = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', firstBusTime: '05:00' }),
    ]))[0]!
    expect(serviceTextOf(half)).toBeNull()
    expect(footnoteTextOf(half)).toBeNull()
  })

  it('小字两种内容互斥：有车说到站钟点，没有车说首末班', () => {
    const at = new Date(READ_AT + 300_000)
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

    const withBus = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [arrivalOf('a1', 300)],
        firstBusTime: '05:00',
        lastBusTime: '22:00',
      }),
    ]))[0]!
    const forecastOnly = boardRowsOf(boardOf([
      lineOf({ lineId: 'B', lineName: '202路', intervalForecast: '16:41~16:51', firstBusTime: '05:00', lastBusTime: '22:00' }),
    ]))[0]!

    expect(footnoteTextOf(withBus)).toBe(`${clock} 到站`)
    expect(footnoteTextOf(forecastOnly)).toBe('发车间隔 · 首末班 05:00–22:00')
  })

  it('没有在途车时拥挤度与标签都从缺：不借上一趟车的标签', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', intervalForecast: '16:41~16:51' }),
    ]))[0]!

    expect(row.congestion).toBe('unknown')
    expect(row.tags).toEqual([])
  })
})
