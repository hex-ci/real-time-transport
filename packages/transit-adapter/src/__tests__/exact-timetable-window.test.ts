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
 * F-B: the declared window and the departures must be the SAME table read twice.
 *
 * The shipped 群芳 table (real transcription, do not hand-edit) declares its
 * direction-1 window as `first 5:49 / last 0:01` while its own departures include
 * `05:48` and `00:08 / 00:16`. The declared ends fed `operatingStatusOf` while the
 * departures drove the arrival rows, so the two could state different things about
 * the same service: at 00:05 the API would answer `after_last` TOGETHER WITH
 * departures (the board saying the day is over while listing trains), and at 05:48
 * `before_first` beside a departure that had already gone.
 *
 * The fix derives the window from the departures — the list the rows are built
 * from — so the state and the list cannot disagree. These assertions compare the
 * window against the departures mechanically (not against hard-coded clock strings
 * alone) so a table whose transcription changes is judged by its own numbers.
 */

/** Seconds of the operating day for a 「H:MM」 the table declares (tail shifted +24h). */
function secsOf(clock: string): number {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  const sec = h * 3600 + m * 60
  return h < 4 ? sec + 24 * 3600 : sec
}

/** The departures a table lists, in operating-day seconds: the ground truth. */
function departureSeconds(day: DayTimetable): number[] {
  return operatingDaySeconds(day)
}

/** Every (direction, dayType) table the repo ships. */
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
    // The shipped table exists and is read: a suite that silently covered zero
    // tables would pass this file's other assertions too.
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
    // 05:48 workday: the declared `5:49` said 首班前 while the row right beside it
    // was the 05:48 departure. The state and the list are the same table here.
    const nowSec = 5 * 3600 + 48 * 60
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 1, nowSec, { dayType: 'workday' })
    expect(r!.arrivals.length).toBeGreaterThan(0)
    expect(r!.arrivals[0]!.time).toBe('05:48')
    expect(operatingStatusOf({ firstDeparture: r!.first, lastDeparture: r!.last, nowSecOfDay: nowSec }).state)
      .toBe('operating')
  })

  it('is 运营中 after midnight while the tail departures are still listed', () => {
    // 00:05 belongs to the previous operating day, whose tail runs 00:01 / 00:08 /
    // 00:16. The declared `last 0:01` said 已过末班 over a list of departures.
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
    // Direction 0's declared 5:16 / 23:06 IS its own first and last departure, so
    // deriving must not move it — a fix that changed this table would be rewriting
    // data rather than making the window agree with it.
    const r = queryStationArrivals(STATION_TIMETABLES[0]!, 0, 12 * 3600, { dayType: 'workday' })
    expect({ first: r!.first, last: r!.last }).toEqual({ first: '5:16', last: '23:06' })
  })
})

/**
 * The same rule one level up: the LINE's reported hours come from the same table,
 * so they cannot disagree with the platform's departures either. The engine
 * prefers upstream hours; when the upstream declares none, the table is the
 * source — and it is read through the same window derivation.
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
              // No start_time / end_time: the upstream genuinely does not know.
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
