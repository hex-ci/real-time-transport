import { afterEach, describe, expect, it, vi } from 'vitest'
import { operatingStatusOf } from '@real-time-transport/shared'
import type { LineDetail } from '@real-time-transport/shared'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
} from '../index.js'

/**
 * 服务时间是关于线路的事实，没有就是没有。
 *
 * 窗口仍需要用来枚举模拟发车，所以它只作为内部模拟参数存在：上报的
 * 时间来自上游、来自线路自己的精确时刻表，或者为空 —— 绝不把模拟
 * 窗口当作已上报的事实。
 */

/** 高德可能返回的那种无服务时间的两站 GCJ-02 地铁线路。 */
function lineWithoutHours(lineName: string, stops: Array<[string, string]>): Record<string, unknown> {
  return {
    id: 'BJ_10',
    name: lineName,
    type: '地铁线路',
    start_stop: stops[0]![0],
    end_stop: stops[stops.length - 1]![0],
    // 没有 start_time / end_time：上游确实不知道。
    busstops: stops.map(([name, location], idx) => ({
      id: `s${idx + 1}`,
      name,
      sequence: idx + 1,
      location,
    })),
  }
}

function stubAmap(line: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/v3/bus/linename')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: '1', infocode: '10000', info: 'OK', buslines: [line] }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK' }) }
  }))
}

/** 引擎没有精确时刻表覆盖的线路：任何东西都不能填这个空。 */
const UNCOVERED_STOPS: Array<[string, string]> = [
  ['甲站', '116.300000,39.950000'],
  ['乙站', '116.305000,39.955000'],
]

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('service hours are reported as the facts they are, or not at all', () => {
  it('reports empty hours — never 05:30 / 23:00 — when the upstream omits them', async () => {
    stubAmap(lineWithoutHours('地铁88号线', UNCOVERED_STOPS))
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const detail = await engine.getLineDetail('subway_027_88', 0, '027')
    expect(detail).not.toBeNull()
    expect(detail!.firstBusTime).toBe('')
    expect(detail!.lastBusTime).toBe('')
    expect(detail!.firstBusTime).not.toBe('05:30')
    expect(detail!.lastBusTime).not.toBe('23:00')

    // 下游状态正是由这两个字段推导：窗口缺失必须答「未知」，
    // 而不是在正午答「运营中」。
    expect(operatingStatusOf({
      firstDeparture: detail!.firstBusTime,
      lastDeparture: detail!.lastBusTime,
      nowSecOfDay: 12 * 3600,
    })).toEqual({ state: 'unknown', firstDeparture: null, lastDeparture: null })
  })

  it('prefers the line’s own exact timetable over the empty value when upstream has none', async () => {
    stubAmap(lineWithoutHours('地铁88号线', [
      ['群芳', '116.392540,39.924299'],
      ['乙站', '116.399999,39.930001'],
    ]))
    // 已发布的官方时刻表覆盖本夹具的线路/站点（方向 0 = 5:16 / 23:06）。
    // 真实数据永远优先于替代值和空值。
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const detail = await engine.getLineDetail('subway_027_7', 0, '027')
    expect(detail).not.toBeNull()
    expect(detail!.firstBusTime).toBe('05:16')
    expect(detail!.lastBusTime).toBe('23:06')
    expect(operatingStatusOf({
      firstDeparture: detail!.firstBusTime,
      lastDeparture: detail!.lastBusTime,
      nowSecOfDay: 12 * 3600,
    }).state).toBe('operating')
  })

  it('reports hours verbatim when the upstream does supply them', async () => {
    stubAmap({
      ...lineWithoutHours('地铁88号线', UNCOVERED_STOPS),
      start_time: '0516',
      end_time: '2306',
    })
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const detail = await engine.getLineDetail('subway_027_88', 0, '027')
    expect(detail!.firstBusTime).toBe('05:16')
    expect(detail!.lastBusTime).toBe('23:06')
  })
})

describe('the departure simulation keeps its window as a parameter, not a report', () => {
  /** 八站、无上报服务时间：窗口只用来枚举车次。 */
  const detailWithoutHours: LineDetail = {
    lineId: 'subway_027_88',
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 辛站',
    firstBusTime: '',
    lastBusTime: '',
    cityCode: '027',
    type: 'subway',
    stops: [
      { id: 's1', name: '甲站', order: 1, lat: 39.95, lng: 116.3, interchanges: [] },
      { id: 's2', name: '乙站', order: 2, lat: 39.955, lng: 116.305, interchanges: [] },
      { id: 's3', name: '丙站', order: 3, lat: 39.96, lng: 116.31, interchanges: [] },
      { id: 's4', name: '丁站', order: 4, lat: 39.965, lng: 116.315, interchanges: [] },
      { id: 's5', name: '戊站', order: 5, lat: 39.97, lng: 116.32, interchanges: [] },
      { id: 's6', name: '己站', order: 6, lat: 39.975, lng: 116.325, interchanges: [] },
      { id: 's7', name: '庚站', order: 7, lat: 39.98, lng: 116.33, interchanges: [] },
      { id: 's8', name: '辛站', order: 8, lat: 39.985, lng: 116.335, interchanges: [] },
    ],
    routeLengthMeters: 40000,
    stationDistances: [0, 2000, 6000, 12000, 18000, 24000, 32000, 40000],
  }

  it('still enumerates simulated departures with the window absent', async () => {
    // 北京 08:00，运营中。时钟被冻结，因为模拟窗口是固定的 05:30–23:00
    // 参数：不冻结的话，这个断言就成了关于测试套件碰巧运行在几点。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'))

    const engine = new UniversalSubwayEngine(
      new AmapGisService(''),
      undefined,
      async () => detailWithoutHours,
    )
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(live!.buses.length).toBeGreaterThan(0)
    // 位置仍完全推导得出，所以这些车可用而不是桩。
    expect(live!.buses.every(b => typeof b.distanceFromStart === 'number')).toBe(true)

    // 这个参数正是过去被上报的那个窗口：无服务时间的线路枚举出的发车，
    // 与一条真的跑 05:30–23:00 的线路完全相同。清空推演器不是修法。
    const sameWindow = new UniversalSubwayEngine(
      new AmapGisService(''),
      undefined,
      async () => ({ ...detailWithoutHours, firstBusTime: '05:30', lastBusTime: '23:00' }),
    )
    const reported = await sameWindow.getLiveStatus('subway_027_88', 0, '027')
    expect(reported!.buses.length).toBe(live!.buses.length)
  })
})
