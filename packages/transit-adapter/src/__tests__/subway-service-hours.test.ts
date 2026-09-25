import { afterEach, describe, expect, it, vi } from 'vitest'
import { operatingStatusOf } from '@real-time-transport/shared'
import type { LineDetail } from '@real-time-transport/shared'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
} from '../index.js'

/**
 * Service hours are a FACT about a line, or they are absent.
 *
 * Amap omits `start_time` / `end_time` for some lines. The engine used to
 * substitute 05:30 / 23:00 into `firstBusTime` / `lastBusTime`, which made a
 * line whose hours are unknown answer 「运营中」 at 12:00 — a fabricated fact.
 * The window is still needed to enumerate simulated departures, so it survives
 * as an internal simulation parameter only: a reported time comes from the
 * upstream, from the line's own exact timetable, or is empty.
 */

/** A two-stop GCJ-02 subway line with no service hours, as Amap may return it. */
function lineWithoutHours(lineName: string, stops: Array<[string, string]>): Record<string, unknown> {
  return {
    id: 'BJ_10',
    name: lineName,
    type: '地铁线路',
    start_stop: stops[0]![0],
    end_stop: stops[stops.length - 1]![0],
    // No start_time / end_time: the upstream genuinely does not know.
    busstops: stops.map(([name, location], idx) => ({
      id: `s${idx + 1}`,
      name,
      sequence: idx + 1,
      location,
    })),
  }
}

/** An Amap v3 success envelope around `buslines`, with the wire fields intact. */
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

/** A line the engine holds no exact timetable for: nothing may fill the gap in. */
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

    // The state downstream is derived from these two fields: an absent window
    // must answer 未知, not 「运营中」 at midday.
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
    // The shipped official timetable covers this fixture's own line/station
    // (dir 0 = 5:16 / 23:06). Real data always wins over both the substitute and
    // the blank.
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
  /** Eight stops, no reported hours: the window exists only to enumerate trains. */
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
    // 08:00 Beijing, mid-service. The clock is frozen because the simulated
    // window is a fixed 05:30–23:00 parameter: without freezing, this assertion
    // would be about the hour the suite happened to run at.
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
    // Positions are still fully derived, so the trains are usable, not stubs.
    expect(live!.buses.every(b => typeof b.distanceFromStart === 'number')).toBe(true)

    // The parameter is exactly the window that used to be published: a line with
    // absent hours enumerates precisely the departures a line that genuinely
    // runs 05:30–23:00 would. Emptying the simulator is not the fix.
    const sameWindow = new UniversalSubwayEngine(
      new AmapGisService(''),
      undefined,
      async () => ({ ...detailWithoutHours, firstBusTime: '05:30', lastBusTime: '23:00' }),
    )
    const reported = await sameWindow.getLiveStatus('subway_027_88', 0, '027')
    expect(reported!.buses.length).toBe(live!.buses.length)
  })
})
