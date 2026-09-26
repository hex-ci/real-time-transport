import { afterEach, describe, expect, it, vi } from 'vitest'
import { operatingStatusOf } from '@real-time-transport/shared'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
  queryStationArrivals,
  operatingDaySeconds,
} from '../index.js'
import type { DayTimetable, DayType } from '../index.js'
import { STATION_TIMETABLES } from '../data/subway-timetables.data.js'

/**
 * F-B：声明的窗口与发车必须是同一张表的两次读取。
 *
 * 声明的 ends 曾喂给 `operatingStatusOf`，而到达行由发车驱动，于是两者
 * 可能对同一段服务说出不同的话：接口会在列出车次的同时答 `after_last`，
 * 也会在刚发出的发车旁边答 `before_first`。
 *
 * 修正后窗口由发车 —— 行所依据的那张表 —— 推导，状态与列表就不可能
 * 不一致。这里的断言机械地比较窗口与发车，而不是只比硬编码的时刻串。
 */

/** 表声明的「H:MM」对应的运营日秒数（跨 0 点尾班 +24h）。 */
function secsOf(clock: string): number {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  const sec = h * 3600 + m * 60
  return h < 4 ? sec + 24 * 3600 : sec
}

function departureSeconds(day: DayTimetable): number[] {
  return operatingDaySeconds(day)
}

function everyTable(): Array<{ label: string, table: (typeof STATION_TIMETABLES)[number], direction: number, dayType: DayType, day: DayTimetable }> {
  const out: Array<{ label: string, table: (typeof STATION_TIMETABLES)[number], direction: number, dayType: DayType, day: DayTimetable }> = []
  for (const t of STATION_TIMETABLES) {
    for (const [direction, dir] of Object.entries(t.directions)) {
      for (const dayType of ['workday', 'weekend'] as const) {
        out.push({
          label: `${t.lineId}/${t.stationName}/dir${direction}/${dayType}`,
          table: t,
          direction: Number(direction),
          dayType,
          day: dir[dayType],
        })
      }
    }
  }
  return out
}

describe('F-B: the state\'s window is derived from the table\'s own departures', () => {
  it('pins the window to the departures for EVERY shipped table', () => {
    const tables = everyTable()
    // 已发布的表确实存在且被读到：静默覆盖零张表的测试套件也会
    // 通过本文件其它断言。
    expect(tables.length).toBeGreaterThan(0)

    for (const { label, table, direction, dayType, day } of tables) {
      const departures = departureSeconds(day)
      const morningFirst = Math.min(...departures.filter(s => s < 24 * 3600))
      const last = Math.max(...departures)

      const result = queryStationArrivals(table, direction, 12 * 3600, { dayType })
      expect(result, label).not.toBeNull()
      expect(secsOf(result!.first), `${label}: first must be the first departure listed`).toBe(morningFirst)
      expect(secsOf(result!.last), `${label}: last must be the last departure listed`).toBe(last)
    }
  })

  it('is 运营中 at the first departure the list itself has, not 首班前', () => {
    const nowSec = 5 * 3600 + 48 * 60
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 1, nowSec, { dayType: 'workday' })
    expect(r!.arrivals.length).toBeGreaterThan(0)
    expect(r!.arrivals[0]!.time).toBe('05:48')
    expect(operatingStatusOf({ firstDeparture: r!.first, lastDeparture: r!.last, nowSecOfDay: nowSec }).state)
      .toBe('operating')
  })

  it('is 运营中 after midnight while the tail departures are still listed', () => {
    const nowSec = 24 * 3600 + 5 * 60
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 1, nowSec, { dayType: 'workday' })
    expect(r!.arrivals.map(a => a.time)).toEqual(['00:08', '00:16'])
    expect(operatingStatusOf({ firstDeparture: r!.first, lastDeparture: r!.last, nowSecOfDay: nowSec }).state)
      .toBe('operating')
  })

  it('is 已过末班 only after the last departure the list has, when there is nothing to list', () => {
    const nowSec = 24 * 3600 + 17 * 60
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 1, nowSec, { dayType: 'workday' })
    expect(r!.arrivals).toEqual([])
    expect(operatingStatusOf({ firstDeparture: r!.first, lastDeparture: r!.last, nowSecOfDay: nowSec }).state)
      .toBe('after_last')
  })

  it('leaves a table that was already consistent exactly as it was', () => {
    // 方向 0 声明的 5:16 / 23:06 就是它自己的首末班，所以推导不能移动它：
    // 一个改动这张表的「修正」是在改写数据，而不是让窗口与数据一致。
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 0, 12 * 3600, { dayType: 'workday' })
    expect({ first: r!.first, last: r!.last }).toEqual({ first: '5:16', last: '23:06' })
  })
})

/**
 * 同一条规则再上一层：线路上报的服务时间来自同一张表，因此也不可能
 * 与站台的发车不一致。引擎优先用上游的时间；上游没有声明时以该表为源，
 * 并且同样经由这套窗口推导读取。
 */
describe('F-B: the line\'s hours are read through the same window', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the table\'s own departures as the line\'s hours, after midnight included', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      const body = href.includes('/v3/bus/linename')
        ? {
            status: '1',
            infocode: '10000',
            info: 'OK',
            buslines: [{
              id: 'BJ_7',
              name: '地铁7号线',
              type: '地铁线路',
              start_stop: '群芳',
              end_stop: '乙站',
              // 没有 start_time / end_time：上游确实不知道。
              busstops: [
                { id: 's1', name: '群芳', sequence: 1, location: '116.392540,39.924299' },
                { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
              ],
            }],
          }
        : { status: '1', infocode: '10000', info: 'OK' }
      return { ok: true, status: 200, json: async () => body }
    }))

    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())
    const detail = await engine.getLineDetail('subway_027_7', 1, '027')

    expect(detail).not.toBeNull()
    expect(detail!.firstBusTime).toBe('05:48')
    expect(detail!.lastBusTime).toBe('00:16')
  })
})
