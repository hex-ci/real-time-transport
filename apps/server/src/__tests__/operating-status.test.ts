import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommuteProfileSchema, OperatingStatusSchema } from '@real-time-transport/shared'
import { buildApp } from '../app.js'

/**
 * F3: the operating state, on five frozen clocks.
 *
 * The state answers 「今天还有没有车」 from the line's own first/last departure
 * times — not from the wall clock and not from a built-in 05:30/23:00 rule — and
 * WHICH first/last those are depends on the branch that answered. This station
 * has a registered minute-level table (the fixture line's own station), so the
 * exact-timetable branch answers and the TABLE's own hours decide every
 * assertion here; the fixture's upstream `start_time` / `end_time` are never
 * consulted on this path. The live branch, which does read them, is covered by
 * its own block below.
 *
 * Five clocks are frozen because the interesting hours are the boundaries: two
 * inside the service day, two past midnight, and 04:00 where the operating day
 * itself rolls over.
 */

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'

/** The registered table's own hours for that station, which is where the state comes from. */
const FIRST_DEPARTURE = '05:16'
const LAST_DEPARTURE = '23:06'

/**
 * A two-stop GCJ-02 subway line, so the engine can build a detail from the stub.
 *
 * The station the five clocks below query has a registered minute-level table,
 * so `start_time` / `end_time` on this fixture are carried but never read: the
 * state comes from that table. The fixture below declares the hours that ARE
 * read, on a line with no table.
 */
const subwayLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '乙站',
  start_time: '0516',
  end_time: '2306',
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/**
 * The live-branch case: a line the timetable registry has NO entry for, so the
 * state is derived from the first/last departure its OWN static detail carries.
 *
 * `LIVE_FIRST` / `LIVE_LAST` are deliberately not the registered table's
 * 05:16 / 23:06, so an assertion against them cannot pass by reading that table
 * instead — and the station queried is one no table covers.
 */
const LIVE_LINE_ID = 'subway_027_88'
const LIVE_STATION_NAME = '丙站'
const LIVE_FIRST = '06:00'
const LIVE_LAST = '22:00'

const upstreamHoursLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: LIVE_STATION_NAME,
  start_time: '0600',
  end_time: '2200',
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: LIVE_STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** The same line with no hours at all: what the detail does not carry, it states. */
const upstreamWithoutHours = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: LIVE_STATION_NAME,
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: LIVE_STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** An Amap v3 success envelope around `payload`. */
function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * Counted stand-in for every upstream the server can reach: no test here spends
 * real quota, and the service hours the state reads are the fixture's. `line` is
 * what any line search answers with, so a case can declare its own hours.
 */
function stubUpstream(line: Record<string, unknown> = subwayLine): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/v3/bus/linename')) return ok({ buslines: [line] })
    if (href.includes('/v3/place/around')) return ok({ pois: [] })
    return ok({})
  }))
}

/**
 * Freeze the wall clock. Only `Date` is faked: the timers stay real, because the
 * app under test polls and the providers use request timeouts.
 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type App = Awaited<ReturnType<typeof buildApp>>

/** The arrivals answer for the fixture platform, through the real route. */
async function arrivals(app: App, lineId = LINE_ID, stationName = STATION_NAME) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/transit/lines/${lineId}/stations/${encodeURIComponent(stationName)}/arrivals`
      + '?direction=0&count=3&cityCode=027',
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().data as {
    arrivals: Array<{ etaSeconds: number }>
    operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
  }
}

/** One frozen clock, one assertion: the state the API answers with. */
async function statusAt(localIso: string) {
  stubUpstream()
  freezeAt(localIso)
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    return (await arrivals(app)).operatingStatus
  }
  finally {
    await app.close()
  }
}

/**
 * One frozen clock on the LIVE branch: the same route, a line the registry has no
 * table for, and the hours the upstream detail declares.
 */
async function liveStatusAt(localIso: string, line: Record<string, unknown> = upstreamHoursLine) {
  stubUpstream(line)
  freezeAt(localIso)
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    return (await arrivals(app, LIVE_LINE_ID, LIVE_STATION_NAME)).operatingStatus
  }
  finally {
    await app.close()
  }
}

describe('F3: the operating state is stated, not implied, at every hour that matters', () => {
  it('is 运营中 at 08:30, mid-morning on a running line', async () => {
    expect(await statusAt('2026-09-24T08:30:00'))
      .toEqual({ state: 'operating', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 运营中 at 22:00, inside the evening window', async () => {
    expect(await statusAt('2026-09-24T22:00:00'))
      .toEqual({ state: 'operating', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 已过末班 at 23:59, naming the last departure that has gone', async () => {
    expect(await statusAt('2026-09-24T23:59:00'))
      .toEqual({ state: 'after_last', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 已过末班 at 01:00 — after midnight belongs to the previous operating day', async () => {
    expect(await statusAt('2026-09-24T01:00:00'))
      .toEqual({ state: 'after_last', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 首班前 at 04:00, where the operating day rolls over', async () => {
    expect(await statusAt('2026-09-24T04:00:00'))
      .toEqual({ state: 'before_first', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })
})

/**
 * F3 on the LIVE branch — the other two `operatingStatus` sites in
 * `transit.service.ts`, reached whenever the queried station has no registered
 * table. There the first/last departure the state reports are the ones the line's
 * own static detail carries, and a detail that carries none must answer 未知
 * rather than borrow a window.
 *
 * Each assertion names the hours by VALUE, so passing the registered table's
 * 05:16 / 23:06 through the same route cannot satisfy them.
 */
describe('F3: with no published table, the state comes from the detail\'s own hours', () => {
  it('is 首班前 at 04:00, before the first departure the detail declares', async () => {
    expect(await liveStatusAt('2026-09-24T04:00:00'))
      .toEqual({ state: 'before_first', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('is 运营中 at 08:30, inside those declared hours', async () => {
    expect(await liveStatusAt('2026-09-24T08:30:00'))
      .toEqual({ state: 'operating', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('is 已过末班 at 23:59, after the last departure the detail declares', async () => {
    expect(await liveStatusAt('2026-09-24T23:59:00'))
      .toEqual({ state: 'after_last', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('states 运营时间未知 — never 运营中 — when the detail declares no hours', async () => {
    // Same clock as the 运营中 case above: the only difference is that the detail
    // carries no hours, and that difference is what the answer must show.
    expect(await liveStatusAt('2026-09-24T08:30:00', upstreamWithoutHours))
      .toEqual({ state: 'unknown', firstDeparture: null, lastDeparture: null })
  })
})

describe('F3: every arrivals answer carries a well-formed operating status', () => {
  it('states a schema-valid status even when no vehicle is in the list', async () => {
    // 01:00: nothing is running, and the answer says so as a state — the row is
    // never left to the client to guess from an empty array.
    stubUpstream()
    freezeAt('2026-09-24T01:00:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = await arrivals(app)
      expect(OperatingStatusSchema.safeParse(data.operatingStatus).success).toBe(true)
    }
    finally {
      await app.close()
    }
  })
})

describe('F3: the commute profile states facts and carries no dead field', () => {
  it('answers with a mode and a factual slot, and no 恒为 0 的 activeDirection', async () => {
    stubUpstream()
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data
      // `activeDirection` was hardcoded 0 for every caller — a field with no
      // meaning. Nothing in the web app read it, so it is gone from the payload
      // and from the contract.
      expect(data).not.toHaveProperty('activeDirection')
      expect(CommuteProfileSchema.safeParse(data).success).toBe(true)
    }
    finally {
      await app.close()
    }
  })

  it('names the window it is in, without advertising it', async () => {
    stubUpstream()
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // This user has saved NO settings, and 08:30 is inside the built-in morning
      // window — which is exactly why he may not be told 「早通勤时段」: the window
      // that would contain him does not exist. The read states that instead.
      const unset = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data
      expect(unset.windowState).toBe('unset')
      expect(unset.mode).not.toBe('work')
      expect(unset.description).toBe('未设置通勤时段')

      // With a window actually saved, the copy names the window and adds nothing
      // else: not a mode, not a destination, not a mood.
      await app.inject({
        method: 'PATCH',
        url: '/api/transit/settings',
        payload: { morningStart: '08:00', morningEnd: '09:00' },
      })
      const data = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data as {
        mode: string
        description: string
        windowState: string
      }
      expect(data.windowState).toBe('stored')
      expect(data.mode).toBe('work')
      expect(data.description).toBe('早通勤时段')
    }
    finally {
      await app.close()
    }
  })
})
