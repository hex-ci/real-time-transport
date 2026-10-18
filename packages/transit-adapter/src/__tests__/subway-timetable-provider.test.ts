import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { signSubwayTimestamp } from '../subway-sign.js'
import {
  parseDepartures,
  SubwayTimetableFetcher,
} from '../providers/subway-timetable.provider.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

const NOW = Date.UTC(2026, 9, 17, 2, 0, 0) // 2026-10-17 10:00 北京（周六）
/** 测试专用 24 字节 key；不要把它当成上游凭据。 */
const TEST_SIGN_KEY = '0123456789abcdefghijklmn'

beforeAll(() => {
  vi.stubEnv('CHELAILE_SUBWAY_SIGN_KEY', TEST_SIGN_KEY)
})
afterAll(() => {
  vi.unstubAllEnvs()
})

interface Call {
  url: string
  headers: Record<string, string>
}

function upstream() {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })

    if (url.includes('nSearch')) {
      return jsonResponse({
        jsonr: {
          data: {
            result: {
              lines: [{ lineId: '1016', subLineId: '47', name: '地铁7号线', subwayV2: 1 }],
            },
          },
        },
      })
    }
    if (url.includes('lineDetail')) {
      return jsonResponse({
        jsonr: {
          data: {
            line: { lineName: '地铁7号线' },
            subLine: { subLineId: 47, startName: 'A', endName: 'C', oppositeSubLineId: 46 },
            stations: [
              { sname: 'A', pStopId: 1 },
              { sname: 'B', pStopId: 2 },
              { sname: 'C', pStopId: 3 },
            ],
          },
        },
      })
    }
    if (url.includes('preTimetable')) {
      const subLineId = new URL(url).searchParams.get('subLineId')
      // 47：北京 05:10；46：北京 06:05
      const arrivalTime = subLineId === '47'
        ? Date.UTC(2026, 9, 16, 21, 10)
        : Date.UTC(2026, 9, 16, 22, 5)
      return jsonResponse({ jsonr: { data: { timetable: [{ ftime: '05:00', etime: '06:00', times: [{ arrivalTime }] }] } } })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  return { calls, fetchImpl }
}

describe('signSubwayTimestamp', () => {
  it('signs a timestamp with a provided 24-byte key', () => {
    // 合成 key 的固定向量；仓库里不保存任何真实抓包 sign。
    expect(signSubwayTimestamp(1597629788180, TEST_SIGN_KEY)).toBe('VhCD70B+6OlslCTuE+np+g==')
  })
})

describe('SubwayTimetableFetcher', () => {
  it('抓一条线：nSearch → lineDetail → 每站每方向 preTimetable', async () => {
    const { calls, fetchImpl } = upstream()
    const fetcher = new SubwayTimetableFetcher({
      fetchImpl,
      now: () => NOW,
      delayMs: 0,
      amap: { getLineByName: async () => ({ stations: [{ name: 'C' }] }) } as never,
    })

    const rows = await fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_7',
      lineName: '地铁7号线',
    })

    expect(rows).toHaveLength(2)
    const dir1 = rows.find(row => row.direction === 1)!
    const dir0 = rows.find(row => row.direction === 0)!

    expect(dir1.subLineId).toBe(47)
    expect(dir0.subLineId).toBe(46)
    expect(dir1.dayType).toBe('weekend')
    expect(dir1.serviceDate).toBe('2026-10-17')

    // 47 是 A→C；46 是对向，站序反转。
    expect(dir1.payload.stations.map(station => station.name)).toEqual(['A', 'B', 'C'])
    expect(dir0.payload.stations.map(station => station.name)).toEqual(['C', 'B', 'A'])
    expect(dir1.payload.directionName).toBe('开往 C')
    expect(dir0.payload.directionName).toBe('开往 A')

    expect(dir1.payload.stations[0]!.departures).toEqual({ 5: [10] })
    expect(dir0.payload.stations[0]!.departures).toEqual({ 6: [5] })

    // 1 nSearch + 1 lineDetail + 3 站 × 2 方向
    expect(calls).toHaveLength(8)
    const timetableCalls = calls.filter(call => call.url.includes('preTimetable'))
    expect(timetableCalls).toHaveLength(6)
    expect(timetableCalls[0]!.headers.Referer).toContain('subway_time')
    expect(timetableCalls[0]!.url).toContain('sCode=')
    expect(timetableCalls[0]!.url).toMatch(/sign=[A-Za-z0-9+/=]+/)
  })

  it('高德首站等于 subLine.startName 时，subLine 是方向 0', async () => {
    const { fetchImpl } = upstream()
    const fetcher = new SubwayTimetableFetcher({
      fetchImpl,
      now: () => NOW,
      delayMs: 0,
      amap: { getLineByName: async () => ({ stations: [{ name: 'A' }] }) } as never,
    })

    const rows = await fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_7',
      lineName: '地铁7号线',
    })

    expect(rows.find(row => row.subLineId === 47)!.direction).toBe(0)
    expect(rows.find(row => row.subLineId === 46)!.direction).toBe(1)
  })

  it('高德不可用时退回 7 号线约定：subLine = 1，对向 = 0', async () => {
    const { fetchImpl } = upstream()
    const fetcher = new SubwayTimetableFetcher({ fetchImpl, now: () => NOW, delayMs: 0 })

    const rows = await fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_7',
      lineName: '地铁7号线',
    })

    expect(rows.find(row => row.subLineId === 47)!.direction).toBe(1)
    expect(rows.find(row => row.subLineId === 46)!.direction).toBe(0)
  })

  it('找不到线路时抛错，不返回半张表', async () => {
    const fetcher = new SubwayTimetableFetcher({
      fetchImpl: async () => jsonResponse({ jsonr: { data: { result: { lines: [] } } } }),
      now: () => NOW,
      delayMs: 0,
    })

    await expect(fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_999',
      lineName: '不存在线',
    })).rejects.toThrow(/not found/)
  })
})

describe('parseDepartures', () => {
  it('按北京时间归到小时，跨 0 点保留为 0 点', () => {
    const data = {
      timetable: [
        { times: [{ arrivalTime: Date.UTC(2026, 9, 16, 21, 10) }, { arrivalTime: Date.UTC(2026, 9, 16, 21, 12) }] },
        { times: [{ arrivalTime: Date.UTC(2026, 9, 17, 16, 5) }] },
      ],
    }
    expect(parseDepartures(data)).toEqual({ 5: [10, 12], 0: [5] })
  })
})

describe('SubwayTimetableFetcher: 末班后的空表', () => {
  it('rejects an empty timetable instead of overwriting the cache', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('nSearch')) {
        return jsonResponse({ jsonr: { data: { result: { lines: [{ name: '地铁7号线', subLineId: '47', subwayV2: 1 }] } } } })
      }
      if (url.includes('lineDetail')) {
        return jsonResponse({
          jsonr: {
            data: {
              line: { lineName: '地铁7号线' },
              subLine: { startName: 'A', endName: 'C', oppositeSubLineId: 46 },
              stations: [{ sname: 'A', pStopId: 1 }],
            },
          },
        })
      }
      return jsonResponse({ jsonr: { data: { timetable: [] } } })
    }

    const fetcher = new SubwayTimetableFetcher({ fetchImpl, now: () => NOW, delayMs: 0 })
    await expect(fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_7',
      lineName: '地铁7号线',
    })).rejects.toThrow(/incomplete timetable/)
  })
})

describe('SubwayTimetableFetcher: 部分站已收班', () => {
  it('rejects a row where any station has no departures', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('nSearch')) {
        return jsonResponse({ jsonr: { data: { result: { lines: [{ name: '地铁7号线', subLineId: '47', subwayV2: 1 }] } } } })
      }
      if (url.includes('lineDetail')) {
        return jsonResponse({
          jsonr: {
            data: {
              line: { lineName: '地铁7号线' },
              subLine: { startName: 'A', endName: 'C', oppositeSubLineId: 46 },
              stations: [{ sname: 'A', pStopId: 1 }, { sname: 'B', pStopId: 2 }],
            },
          },
        })
      }
      const stopId = new URL(url).searchParams.get('stopId')
      return jsonResponse({
        jsonr: {
          data: {
            timetable: stopId === '1'
              ? [{ times: [{ arrivalTime: Date.UTC(2026, 9, 16, 21, 10) }] }]
              : [],
          },
        },
      })
    }

    const fetcher = new SubwayTimetableFetcher({ fetchImpl, now: () => NOW, delayMs: 0 })
    await expect(fetcher.fetchLine({
      cityCode: '027',
      lineId: 'subway_027_7',
      lineName: '地铁7号线',
    })).rejects.toThrow(/incomplete timetable/)
  })
})
