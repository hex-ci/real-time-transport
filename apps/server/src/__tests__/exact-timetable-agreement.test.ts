import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F-B + F-C through the real route: the exact-timetable answer must agree with
 * ITSELF, and must carry the caveat it holds.
 *
 * The shipped 群芳 table (direction 1 = 开往环球度假区) declares `first 5:49 /
 * last 0:01` while its own departures include `05:48` and `00:08 / 00:16`, and
 * its direction-1 note reads 「0:16 半程至高楼金」. Before the fix the declaration
 * drove the operating state and the departures drove the rows, so the API served
 * the two together and contradicted itself:
 *
 *   00:05 → `after_last` (「已过末班」) above a list of departures
 *   05:48 → `before_first` (「未到首班」) beside a departure that had just gone
 *
 * and `note` never left the adapter at all — so the one fact that the last train
 * does not run the whole way reached nobody.
 *
 * These are the boundary clocks, on the route the app calls (one hour either side
 * of each state change), so the assertion is about what the board answers rather
 * than about a helper's return value.
 */

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'
/** 开往环球度假区: the direction whose transcription disagrees with itself. */
const DIRECTION = 1
/** The table's own direction-1 caveat, verbatim (its 0:16 departure is a half-route). */
const NOTE = '0:16 半程至高楼金'

/** A 7号线 fixture carrying the covered station, so the platform resolves. */
const line = {
  id: 'BJ_7',
  name: '地铁7号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '环球度假区',
  // No start_time / end_time: the table's own hours are what the exact path uses.
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '环球度假区', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** An Amap v3 success envelope. Nothing here spends real quota. */
function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** A line the registry holds no timetable for: the live branch answers here. */
const line88 = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: '丙站',
  start_time: '0600',
  end_time: '2200',
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '丙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

function stubUpstream(answered: Record<string, unknown> = line): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/v3/bus/linename')) return ok({ buslines: [answered] })
    if (href.includes('/v3/place/around')) return ok({ pois: [] })
    return ok({})
  }))
}

/** Freeze the wall clock. Only `Date` is faked: the timers stay real. */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function arrivalsAt(
  localIso: string,
  direction = DIRECTION,
  query: { lineId?: string, stationName?: string, answered?: Record<string, unknown> } = {},
) {
  stubUpstream(query.answered)
  freezeAt(localIso)
  const lineId = query.lineId ?? LINE_ID
  const stationName = query.stationName ?? STATION_NAME
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/${lineId}/stations/${encodeURIComponent(stationName)}/arrivals`
        + `?direction=${direction}&count=6&cityCode=027`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as {
      isExact: boolean
      arrivals: Array<{ time: string }>
      operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
      note: string | null
    }
  }
  finally {
    await app.close()
  }
}

describe('F-B: the board never says service ended while listing departures', () => {
  it('is 运营中 at 00:05, where the tail departures are still to come', async () => {
    const data = await arrivalsAt('2026-09-25T00:05:00')
    expect(data.isExact).toBe(true)
    expect(data.arrivals.map(a => a.time)).toEqual(['00:08', '00:16'])
    expect(data.operatingStatus.state).toBe('operating')
    // The hours reported are the ones the list can be checked against.
    expect(data.operatingStatus.firstDeparture).toBe('05:48')
    expect(data.operatingStatus.lastDeparture).toBe('00:16')
  })

  it('is 已过末班 at 00:20, after the last departure the list has', async () => {
    const data = await arrivalsAt('2026-09-25T00:20:00')
    expect(data.arrivals).toEqual([])
    expect(data.operatingStatus.state).toBe('after_last')
    expect(data.operatingStatus.lastDeparture).toBe('00:16')
  })
})

describe('F-B: the board never says 未到首班 beside a departure', () => {
  it('is 运营中 at 05:48, the first departure its own table lists', async () => {
    const data = await arrivalsAt('2026-09-24T05:48:00')
    expect(data.arrivals[0]!.time).toBe('05:48')
    expect(data.operatingStatus.state).toBe('operating')
    expect(data.operatingStatus.firstDeparture).toBe('05:48')
  })

  it('is 未到首班 at 05:47, before it — with nothing to list', async () => {
    const data = await arrivalsAt('2026-09-24T05:47:00')
    expect(data.arrivals).toEqual([])
    expect(data.operatingStatus.state).toBe('before_first')
  })
})

describe('F-C: the platform\'s own caveat reaches the answer', () => {
  it('carries the half-route caveat the table holds for this direction', async () => {
    const data = await arrivalsAt('2026-09-24T23:50:00')
    expect(data.note).toBe(NOTE)
  })

  it('carries it while the last departures are listed, and after they have gone', async () => {
    // The caveat is about the day's remaining service, so it is present at both
    // hours — a list that is empty is exactly when it matters most.
    expect((await arrivalsAt('2026-09-25T00:05:00')).note).toBe(NOTE)
    expect((await arrivalsAt('2026-09-25T00:20:00')).note).toBe(NOTE)
  })

  it('states no caveat on a path that holds none', async () => {
    // Direction 0's WEEKEND table declares no note at all (empty), so the field
    // comes back null rather than an empty string a renderer would have to test
    // for. 2026-09-26 is a Saturday.
    const weekend = await arrivalsAt('2026-09-26T12:00:00', 0)
    expect(weekend.isExact).toBe(true)
    expect(weekend.note).toBeNull()

    // A line the registry holds no timetable for: the live path holds no remark
    // of its own and must not borrow the other line's.
    const live = await arrivalsAt('2026-09-24T12:00:00', 0, {
      lineId: 'subway_027_88',
      stationName: '丙站',
      answered: line88,
    })
    expect(live.isExact).toBe(false)
    expect(live.note).toBeNull()
  })

  it('carries the direction\'s OWN caveat, not a shared one', async () => {
    // Direction 0's workday remark is a different sentence about different
    // departures. Two directions, two caveats, one field.
    const east = await arrivalsAt('2026-09-24T23:50:00', 0)
    expect(east.note).toBe('晚间两班半程至双合')
    expect(east.note).not.toBe(NOTE)
  })
})
