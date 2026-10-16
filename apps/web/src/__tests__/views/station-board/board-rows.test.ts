import { describe, expect, it } from 'vitest'
import { UserFavoriteLineSchema, type StationBoard, type StationBoardLine, type UserFavoriteLine } from '@real-time-transport/shared'
import {
  boardRowsOf,
  commutePurposesOf,
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
 *  - 排序就是那个答案本身（有分钟的按最快那班在前，只有站数的紧跟其后，只有发车间隔
 *    预报的其次，都没有的最后）；
 *  - 分钟与预报是两种东西，绝不互填；到站时刻与站数也是两种读数，各说各的、绝不互算；
 *  - 一行只陈述**这辆车**的事实（剩余分钟、距本站的距离、拥挤度、车辆标签）；线路自己的
 *    静态事实（总站数、本站序、下一站名）不进契约、也不在这屏上 —— 它们不随车走，
 *    说在这儿会被读成车辆状态；
 *  - 数字都从**这次读数自己的时刻**推出来，缺一个就不编（零假数据）。
 *
 * `NNN路` / `NN站` 是占位：本文件不出现真实线路与站名。
 */

const READ_AT = 1_800_000_000_000
/** 城市码：详情页地址的一半（线路 id + 方向 + 城市）。 */
const CITY = '027'

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
    stopsAway: null,
    distanceToStationMeters: meters,
    congestion: 'unknown' as const,
    tags: [],
  }
}

/** 一辆**没有时刻**的车：数据源只给了「还有几站」，站数是它当家的一条读数。 */
function untimedArrivalOf(busId: string, stopsAway: number, meters: number | null = null) {
  return {
    busId,
    arriveAt: null,
    remainSeconds: null,
    stopsAway,
    distanceToStationMeters: meters,
    congestion: 'unknown' as const,
    tags: [],
  }
}

function boardOf(lines: StationBoardLine[]): StationBoard {
  return { stationId: '010-00001', readAt: READ_AT, dataSource: 'chelaile', lines }
}

describe('每行指向自己的详情页', () => {
  it('地址由线路 id + 方向 + 城市定：同一条线的两个方向是两个地址', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', direction: 0 }),
      lineOf({ lineId: 'B', lineName: '101路', direction: 1 }),
    ]), CITY)

    expect(rows.map(row => row.detailHref)).toEqual([
      `/line/A?direction=0&cityCode=${CITY}`,
      `/line/B?direction=1&cityCode=${CITY}`,
    ])
  })
})

describe('每行标出它服务哪一腿通勤', () => {
  /** 一条关注线路；方向按用例给，其余走 schema 自己的缺省。 */
  function favoriteOf(over: Record<string, unknown> = {}): UserFavoriteLine {
    return UserFavoriteLineSchema.parse({
      cityCode: CITY,
      lineId: 'A',
      lineName: '101路',
      reverseLineId: 'B',
      ...over,
    })
  }

  it('上班方向标上班、反向标下班（按上游 lineId 对上，不猜行自己的方向字段）', () => {
    const favorite = favoriteOf({ morningDirection: 0, eveningDirection: 1 })

    expect(commutePurposesOf('A', [favorite])).toEqual(['morning'])
    expect(commutePurposesOf('B', [favorite])).toEqual(['evening'])
  })

  it('不是关注线路的行：不标', () => {
    expect(commutePurposesOf('ZZZ', [favoriteOf({ morningDirection: 0 })])).toEqual([])
  })

  it('方向没配过就不标：绝不替使用者声明一个他没选过的方向', () => {
    expect(commutePurposesOf('A', [favoriteOf()])).toEqual([])
  })

  it('两腿都用同一个方向时两个都标（单向线路就是这种）', () => {
    // 单向线路上没有可做的方向选择，两腿解析为同一个方向 —— 两腿都由它服务，两个都说出来。
    const oneWay = favoriteOf({ reverseLineId: undefined })

    expect(commutePurposesOf('A', [oneWay])).toEqual(['morning', 'evening'])
  })

  it('行上存的是「哪一腿」：措辞与色调由 purpose-badge 一处给出', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', direction: 0 }),
      lineOf({ lineId: 'B', lineName: '101路', direction: 1 }),
      lineOf({ lineId: 'C', lineName: '101路', direction: 0 }),
    ]), CITY, [favoriteOf({ morningDirection: 0, eveningDirection: 1 })])

    expect(rows.map(row => row.commutePurposes)).toEqual([['morning'], ['evening'], []])
  })
})

describe('排序：哪趟先来', () => {
  it('有分钟的按最快那班升序在前，只有站数的紧跟其后，只有预报的其次，都没有的最后；同档按线路名', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'E', lineName: '505路' }),
      lineOf({ lineId: 'D', lineName: '404路', intervalForecast: '16:41~16:51' }),
      lineOf({ lineId: 'C', lineName: '303路', arrivals: [untimedArrivalOf('c1', 7)] }),
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 720)] }),
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ]), CITY)

    expect(rows.map(row => row.lineName)).toEqual(['101路', '202路', '303路', '404路', '505路'])
  })

  it('都没有分钟时按站数升序：站数是它们唯一的时间次序', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [untimedArrivalOf('b1', 12)] }),
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [untimedArrivalOf('a1', 3)] }),
    ]), CITY)

    expect(rows.map(row => row.lineName)).toEqual(['101路', '202路'])
  })

  it('上游没给新东西时次序不变：同样的一批行排法一致', () => {
    const board = boardOf([
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 700)] }),
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ])

    const once = boardRowsOf(board, CITY).map(row => row.key)
    const again = boardRowsOf({ ...board, readAt: board.readAt + 12_000 }, CITY).map(row => row.key)
    expect(again).toEqual(once)
  })

  it('两个方向的同一条线路是两行，各自算各自的车', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', direction: 0, arrivals: [arrivalOf('a1', 300)] }),
      lineOf({ lineId: 'A', lineName: '101路', direction: 1, arrivals: [arrivalOf('a2', 120)] }),
    ]), CITY)

    expect(rows.map(row => row.key)).toEqual(['A_1', 'A_0'])
    expect(rows[0]!.etaMinutes).toBe(2)
  })
})

describe('分钟从这次读数自己的时刻推出来', () => {
  it('30 秒读作 1 分钟，0 秒是正进站（与全站同一口径）', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 30)] }),
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [arrivalOf('b1', 0)] }),
    ]), CITY)

    expect(rows.map(etaTextOf)).toEqual(['正进站', '还有 1 分钟'])
  })

  it('分钟是读取那一刻的分钟：同一份读数读几次都是同一个数，年龄由「最后更新」那句披露', () => {
    const board = boardOf([lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] })])

    expect(boardRowsOf(board, CITY)[0]!.etaMinutes).toBe(5)
    // 读数自己的时刻不动，故数字不动：页面停多久都不会把它自己走成另一个数。
    expect(boardRowsOf(board, CITY)[0]!.etaMinutes).toBe(5)
    expect(board.readAt).toBe(READ_AT)
  })

  it('到站钟点取自上游给的绝对时刻，后面几班并列', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [arrivalOf('a1', 300), arrivalOf('a2', 900)],
      }),
    ]), CITY)

    const row = rows[0]!
    const first = new Date(READ_AT + 300_000)
    const later = new Date(READ_AT + 900_000)
    const clock = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(row.firstArrivalClock).toBe(clock(first))
    expect(row.laterClocks).toEqual([clock(later)])
    expect(row.laterMinutes).toEqual([15])
  })
})

describe('没有到站时刻的车：站数当家', () => {
  it('主位说站数：0 站说「即将到站」；没有分钟的行不再报「暂无到站信息」', () => {
    const rows = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [untimedArrivalOf('a1', 7)] }),
      lineOf({ lineId: 'B', lineName: '202路', arrivals: [untimedArrivalOf('b1', 0)] }),
    ]), CITY)

    expect(rows.map(row => [row.lineName, etaTextOf(row)])).toEqual([
      ['202路', '即将到站'],
      ['101路', '还有 7 站'],
    ])
    expect(rows.map(quietTextOf)).toEqual([null, null])
  })

  it('它没有到站钟点：小字转说这条线自己的运营事实', () => {
    const row = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [untimedArrivalOf('a1', 7)],
        firstBusTime: '05:00',
        lastBusTime: '22:00',
      }),
    ]), CITY)[0]!

    expect(row.firstArrivalClock).toBeNull()
    expect(footnoteTextOf(row)).toBe('首末班 05:00–22:00')
  })

  it('站数与距离来自同一份记录：站数当家的行照样说「距本站」', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [untimedArrivalOf('a1', 7, 4341)] }),
    ]), CITY)[0]!

    expect(distanceToStationTextOf(row)).toBe('距本站 4.3 公里')
  })

  it('有分钟的行由分钟做主：同一辆车带着两个读数时站数不抢答', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [{ ...arrivalOf('a1', 300), stopsAway: 2 }] }),
    ]), CITY)[0]!

    expect(etaTextOf(row)).toBe('还有 5 分钟')
  })
})

describe('预报与到站时刻是两种东西', () => {
  it('只有预报的行没有分钟，预报原文照说并标明它是预报', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'C', lineName: '303路', intervalForecast: '16:41~16:51' }),
    ]), CITY)[0]!

    expect(row.etaMinutes).toBeNull()
    expect(etaTextOf(row)).toBeNull()
    expect(forecastTextOf(row)).toBe('预报 16:41~16:51')
    expect(quietTextOf(row)).toBeNull()
  })

  it('有车的行不会同时被预报顶上：预报那份措辞只属于没有车的行', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)], intervalForecast: '16:41~16:51' }),
    ]), CITY)[0]!

    expect(etaTextOf(row)).toBe('还有 5 分钟')
    expect(quietTextOf(row)).toBeNull()
  })
})

describe('缺一个就不编', () => {
  it('这趟车距本站多远：上游给了米数就说，用的是全站那一条距离规则', () => {
    const far = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300, 2408)] }),
    ]), CITY)[0]!
    expect(distanceToStationTextOf(far)).toBe('距本站 2.4 公里')

    const near = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300, 850)] }),
    ]), CITY)[0]!
    expect(distanceToStationTextOf(near)).toBe('距本站 850 米')
  })

  it('上游没给这个读数时不说，也不拿分钟或站数折一个出来', () => {
    const unknown = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', arrivals: [arrivalOf('a1', 300)] }),
    ]), CITY)[0]!
    expect(distanceToStationTextOf(unknown)).toBeNull()

    // 只有预报的行没有车，也就没有车的位置。
    const forecastOnly = boardRowsOf(boardOf([
      lineOf({ lineId: 'B', lineName: '202路', intervalForecast: '16:41~16:51' }),
    ]), CITY)[0]!
    expect(distanceToStationTextOf(forecastOnly)).toBeNull()
  })

  it('距离说的是最快那班那辆车的位置：与那一行的分钟同一辆车、同一份读数', () => {
    const row = boardRowsOf(boardOf([
      lineOf({
        lineId: 'A',
        lineName: '101路',
        arrivals: [arrivalOf('a1', 120, 900), arrivalOf('a2', 900, 9000)],
      }),
    ]), CITY)[0]!

    expect(row.etaMinutes).toBe(2)
    expect(distanceToStationTextOf(row)).toBe('距本站 900 米')
  })

  it('没有车也没有预报时主位说「暂无到站信息」，首末班由底下那行小字照说', () => {
    const withService = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', firstBusTime: '05:00', lastBusTime: '22:00' }),
    ]), CITY)[0]!
    expect(quietTextOf(withService)).toBe('暂无到站信息')
    expect(footnoteTextOf(withService)).toBe('首末班 05:00–22:00')

    // 首末班缺一个就整句不说：半个首末班不是一条运营事实。
    const half = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', firstBusTime: '05:00' }),
    ]), CITY)[0]!
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
    ]), CITY)[0]!
    const forecastOnly = boardRowsOf(boardOf([
      lineOf({ lineId: 'B', lineName: '202路', intervalForecast: '16:41~16:51', firstBusTime: '05:00', lastBusTime: '22:00' }),
    ]), CITY)[0]!

    expect(footnoteTextOf(withBus)).toBe(`${clock} 到站`)
    expect(footnoteTextOf(forecastOnly)).toBe('发车间隔 · 首末班 05:00–22:00')
  })

  it('没有在途车时拥挤度与标签都从缺：不借上一趟车的标签', () => {
    const row = boardRowsOf(boardOf([
      lineOf({ lineId: 'A', lineName: '101路', intervalForecast: '16:41~16:51' }),
    ]), CITY)[0]!

    expect(row.congestion).toBe('unknown')
    expect(row.tags).toEqual([])
  })
})
