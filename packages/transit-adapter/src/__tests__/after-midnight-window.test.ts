import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
  serviceWindowSeconds,
} from '../index.js'

/**
 * G2: the operating day does not start at 00:00, so a last departure after
 * midnight belongs to the NEXT calendar day.
 *
 * `parseHm` reads a 「H:MM」 into seconds of the CALENDAR day, while the clock
 * this engine compares it against runs 00:00–28:00 (`currentSecOfDay` shifts
 * 00:00–03:59 by +24 h, the same 04:00 boundary `operatingDaySecondsOf` draws in
 * `@real-time-transport/shared`). The transcribed 群芳 direction-1 table ends at
 * `00:16` — its own last departure — so `parseHm` read the window's end as 960 s,
 * EARLIER than its own 05:48 start. The inverted window matched no hour of the
 * day: no departure was enumerated and the direction answered an empty board
 * around the clock.
 *
 * The shift is pinned in both directions: a window whose last time precedes its
 * first moves a day forward, and a window stated 05:16–23:06 does not move at
 * all. The last test drives the REAL transcribed table (do not hand-edit it)
 * through the engine at 00:10, on the direction whose last departure is after
 * midnight and on the one whose day ends at 23:06.
 */

/** 00:10 Beijing on a Thursday: inside the after-midnight tail of the previous operating day. */
function freezeAtBeijing(utcIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(utcIso))
}

/** 00:10 Beijing == 16:10 UTC on the previous calendar day. */
const AFTER_MIDNIGHT = '2026-09-23T16:10:00Z'

const LINE_ID = 'subway_027_7'

/**
 * A line whose stops include the station the shipped table covers, so the
 * engine reads the REAL transcribed times. Eight stops long for the same reason
 * every simulation assertion needs length: a two-stop traversal is shorter than
 * the headway, and there are after-midnight minutes with no train on the line —
 * an assertion over an empty list would prove nothing.
 */
function stubAmap(): void {
  const stops = [
    ['群芳', '116.392540,39.924299'],
    ['万盛东', '116.399999,39.930001'],
    ['万盛西', '116.405000,39.935000'],
    ['高楼金', '116.410000,39.940000'],
    ['花庄', '116.415000,39.945000'],
    ['环球度假区', '116.420000,39.950000'],
    ['土桥', '116.425000,39.955000'],
    ['乙站', '116.430000,39.960000'],
  ] as const
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    const body = href.includes('/v3/bus/linename')
      ? {
          buslines: [{
            id: 'BJ_7',
            name: '地铁7号线',
            type: '地铁线路',
            start_stop: stops[0]![0],
            end_stop: stops[stops.length - 1]![0],
            // No start_time / end_time: the upstream does not know, so the
            // line's own published table is what the hours come from.
            busstops: stops.map(([name, location], idx) => ({
              id: `s${idx + 1}`,
              name,
              sequence: idx + 1,
              location,
            })),
          }],
        }
      : {}
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...body }) }
  }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('G2: an after-midnight last departure lands on the 24h+ timeline', () => {
  it('moves a last time that precedes the first a day forward', () => {
    // 群芳 direction 1's own window, as the engine reads it: `05:48` … `00:16`.
    expect(serviceWindowSeconds('05:48', '00:16')).toEqual({
      first: 5 * 3600 + 48 * 60,
      last: 24 * 3600 + 16 * 60,
    })
  })

  it('leaves a window that already ends after its start exactly as read', () => {
    expect(serviceWindowSeconds('05:16', '23:06')).toEqual({
      first: 5 * 3600 + 16 * 60,
      last: 23 * 3600 + 6 * 60,
    })
  })

  it('still stands in the simulation window when neither time is stated', () => {
    // The fallback is a simulation parameter, not a reported fact: absent hours
    // must enumerate the same departures they always did.
    expect(serviceWindowSeconds('', '')).toEqual({
      first: 5 * 3600 + 30 * 60,
      last: 23 * 3600,
    })
  })
})

describe('G2: the direction whose last departure is after midnight runs a coherent window', () => {
  it('answers with trains at 00:10 for direction 1, whose table ends at 00:16', async () => {
    stubAmap()
    freezeAtBeijing(AFTER_MIDNIGHT)
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const live = await engine.getLiveStatus(LINE_ID, 1, '027')

    expect(live, 'the engine answered nothing at all').not.toBeNull()
    expect(live!.buses.length, 'direction 1 answered an empty board at 00:10').toBeGreaterThan(0)
    for (const bus of live!.buses) {
      expect(bus.id).toMatch(new RegExp(`^train_${LINE_ID}_d1_dep\\d+$`))
    }
  })

  it('still answers with no train at 00:10 for direction 0, whose day ended at 23:06', async () => {
    // The shift must not fire for a window that already ends after its start: if
    // the same-day window were pushed a day forward, this direction would report
    // trains four hours after its last departure.
    stubAmap()
    freezeAtBeijing(AFTER_MIDNIGHT)
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const live = await engine.getLiveStatus(LINE_ID, 0, '027')

    expect(live, 'the engine answered nothing at all').not.toBeNull()
    expect(live!.buses).toEqual([])
  })
})
