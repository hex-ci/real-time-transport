import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'
import { buildApp } from '../app.js'

/**
 * F4 on the server: every arrival row states what KIND of number it is.
 *
 * The measurement that makes this necessary: an arrivals query names a target
 * order (`/lines/010-1-0/stations/<terminal>/arrivals?order=N`), and the upstream
 * then returns that stop's own travel time — so the payload on this path CAN
 * carry the arrival minute. It need not, and it need not for every vehicle in one
 * response (one vehicle arrives with upstream travels, the next does not); on a
 * board queried without a target it never does. The provenance therefore has to
 * be attached where each minute is produced, per row: a value the payload carried,
 * or the subway engine's model.
 *
 * A row the payload priced NOTHING for no longer receives a minute of this app's
 * own: the position/dwell extrapolation was removed (its error had no fixed sign
 * — see `no-estimated-arrival-minute.test.ts`, which pins that decision), so such
 * a row is served with no `etaSeconds`, no `time` and no provenance. What is
 * asserted here is the other half, and the one F4 exists for: 「没有来源」 and
 * 「实时」 are different facts, and a row whose provenance is unknown must not come
 * back telling the UI it is live.
 */

/** Freeze the wall clock; only `Date` is faked, so nothing else stalls. */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function station(name: string, order: number) {
  return { id: `s${order}`, name, order, lat: 39.9 + order / 100, lng: 116.4 + order / 100, interchanges: [] }
}

/**
 * A three-stop bus whose middle platform is the one being queried, so the branch
 * that produces each minute is decided by the vehicle, not by the fixture.
 */
function busDetail(geometry: boolean): LineDetail {
  return {
    lineId: '010-1-0',
    lineName: '1',
    direction: 0,
    directionName: '开往 丙站',
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    stops: [station('甲站', 1), station('乙站', 2), station('丙站', 3)],
    ...(geometry ? { routeLengthMeters: 3000, stationDistances: [0, 1500, 3000] } : {}),
  }
}

/** A subway line with no registered timetable for these stops. */
function subwayDetail(): LineDetail {
  return { ...busDetail(true), lineId: 'subway_027_88', type: 'subway', directionName: '开往 丙站' }
}

function vehicle(partial: Record<string, unknown>): Record<string, unknown> {
  return { id: 'b1', order: 1, nextOrder: 2, congestion: 'unknown', updatedAt: Date.now(), ...partial }
}

function liveStatus(dataSource: LiveLineStatus['dataSource'], buses: Array<Record<string, unknown>>): LiveLineStatus {
  return {
    lineId: 'x',
    direction: 0,
    buses: buses as LiveLineStatus['buses'],
    dataSource,
    isDegraded: false,
    updatedAt: Date.now(),
  }
}

/** The service under test, wired to a stub db so no upstream can be reached. */
function serviceFor(detail: LineDetail, status: LiveLineStatus | null) {
  const db = {
    getCachedLine: async () => detail,
    getUserSettings: async () => null,
    // Reached only by the geometry-less fixture, whose backfill attempt is
    // expected to fail: the service then serves the cached row as-is.
    upsertCachedLine: async () => {},
  } as unknown as Database

  // Every test here is network-free by construction: a call that escaped would
  // throw rather than spend real quota.
  forbidNetwork()

  const service = new TransitService(db, { amapKey: 'test-key' })
  vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
  return service
}

/** Every network call is a bug here: fail loudly rather than spend quota. */
function forbidNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))
}

async function arrivalsFor(
  service: TransitService,
  lineId: string,
  stationName: string,
  order: number,
) {
  const result = await service.getStationArrivals(lineId, stationName, 0, 6, '027', order)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  return result!
}

describe('F4: a bus minute is 实时 only when the payload carried it', () => {
  it('keeps the upstream travel time as 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    const service = serviceFor(detail, liveStatus('chelaile', [vehicle({ travelTimeSec: 300 })]))
    try {
      for (const row of (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals) {
        expect(row.provenance).toBe('live')
      }
    }
    finally {
      service.stop()
    }
  })

  it('serves no minute and no mark when the reading published none for the vehicle', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    // A real vehicle, a real odometer, a real speed — and no upstream ETA. This is
    // the shape the live bus board actually shows, and the row it yields states NO
    // minute: the minute that used to stand here was this app's own extrapolation
    // of that speed and a nominal dwell across every remaining stop. A mark
    // qualifies a number, so this row carries none either.
    const service = serviceFor(detail, liveStatus('chelaile', [
      vehicle({ distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.etaSeconds, 'an extrapolated minute was served').toBeUndefined()
        expect(row.provenance, 'a mark rode on a row with no number').toBeNull()
        expect(row.busId).toBeTypeOf('string')
      }
    }
    finally {
      service.stop()
    }
  })

  it('serves no minute without geometry either, rather than a per-stop constant', async () => {
    freezeAt('2026-09-24T08:30:00')
    // The other half of the removed arithmetic: with no `distanceFromStart` it
    // answered `stopsAway * 150`, a flat nominal hop. No minute is stated now.
    const detail = busDetail(false)
    const service = serviceFor(detail, liveStatus('chelaile', [vehicle({})]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.etaSeconds).toBeUndefined()
        expect(row.provenance).toBeNull()
      }
    }
    finally {
      service.stop()
    }
  })

  it('keeps a vehicle observed at the platform as 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    // Nose at the queried platform's own distance mark: an observation of a real
    // vehicle, not an arithmetic result.
    const service = serviceFor(detail, liveStatus('chelaile', [
      vehicle({ distanceFromStart: 3000 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows[0]?.isAtStation).toBe(true)
      expect(rows[0]?.provenance).toBe('live')
    }
    finally {
      service.stop()
    }
  })
})

describe('F4: the subway engine\'s trains never come back as live data', () => {
  it('marks a generated train 排班推演 however its minute was produced', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = subwayDetail()
    // The engine puts a travelTimeSec on every train, so the row reaches the
    // "upstream sent the minute" branch while the train itself is generated.
    const service = serviceFor(detail, liveStatus('subway_schedule', [
      vehicle({ travelTimeSec: 300 }),
      vehicle({ id: 'b2', distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, 'subway_027_88', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.provenance).toBe('schedule_simulation')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      service.stop()
    }
  })

  it('marks a generated train seen at a platform 排班推演, not 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = subwayDetail()
    const service = serviceFor(detail, liveStatus('subway_schedule', [
      vehicle({ distanceFromStart: 3000 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, 'subway_027_88', '丙站', 3)).arrivals
      expect(rows[0]?.isAtStation).toBe(true)
      expect(rows[0]?.provenance).toBe('schedule_simulation')
    }
    finally {
      service.stop()
    }
  })
})

describe('F4: an unclassifiable source yields no claim', () => {
  it('leaves rows unclassified when the answering source is not one this build knows', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    const service = serviceFor(detail, liveStatus(
      'apizero' as LiveLineStatus['dataSource'],
      [vehicle({ distanceFromStart: 500, speed: 6 })],
    ))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      // apizero is a real vehicle feed, so its rows are classified; the point of
      // this case is the guard below, which a foreign source must trigger.
      expect(rows.every(r => r.provenance !== undefined)).toBe(true)

      const foreign = serviceFor(detail, liveStatus(
        'unknown_source' as LiveLineStatus['dataSource'],
        [vehicle({ distanceFromStart: 500, speed: 6 })],
      ))
      try {
        const rows2 = (await arrivalsFor(foreign, '010-1-0', '丙站', 3)).arrivals
        expect(rows2.length).toBeGreaterThan(0)
        for (const row of rows2) expect(row.provenance).toBeNull()
      }
      finally {
        foreign.stop()
      }
    }
    finally {
      service.stop()
    }
  })

  it('never reaches upstream while classifying', async () => {
    freezeAt('2026-09-24T08:30:00')
    forbidNetwork()
    const service = serviceFor(busDetail(true), liveStatus('chelaile', [
      vehicle({ distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      await arrivalsFor(service, '010-1-0', '丙站', 3)
    }
    finally {
      service.stop()
    }
  })
})

/**
 * The same two answers through the real HTTP route, so the wire shape the web app
 * receives is the one asserted here.
 */
describe('F4: the arrivals route ships a provenance on every row', () => {
  const OK = (payload: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  })

  /** An amap line fixture with `count` stops, ~1.3 km apart. */
  function subwayLineFixture(names: string[]) {
    return {
      id: 'BJ_88',
      name: '地铁88号线',
      type: '地铁线路',
      start_stop: names[0],
      end_stop: names[names.length - 1],
      start_time: '0516',
      end_time: '2306',
      busstops: names.map((name, i) => ({
        id: `s${i + 1}`,
        name,
        sequence: i + 1,
        location: `${(116.39 + i * 0.012).toFixed(6)},39.92`,
      })),
    }
  }

  function stubAmap(buslines: unknown[]): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      if (href.includes('/v3/bus/linename')) return OK({ buslines })
      if (href.includes('/v3/place/around')) return OK({ pois: [] })
      return OK({})
    }))
  }

  async function arrivals(app: Awaited<ReturnType<typeof buildApp>>, stationName: string, extra = '') {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/subway_027_7/stations/${encodeURIComponent(stationName)}/arrivals`
        + `?direction=0&count=3&cityCode=027${extra}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as {
      isExact: boolean
      arrivals: Array<{ time: string, etaSeconds: number, provenance?: string | null }>
    }
  }

  it('marks a registered station timetable 精确时刻表, per row', async () => {
    freezeAt('2026-09-24T08:30:00')
    stubAmap([subwayLineFixture(['群芳', '乙站'])])
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // The fixture's first stop is the one station this repo holds a published
      // minute-level timetable for (direction 0).
      const data = await arrivals(app, '群芳')
      expect(data.isExact).toBe(true)
      expect(data.arrivals.length).toBeGreaterThan(0)
      for (const row of data.arrivals) {
        expect(row.provenance).toBe('exact_timetable')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      await app.close()
    }
  })

  it('marks a platform with no timetable from the engine\'s trains 排班推演', async () => {
    freezeAt('2026-09-24T08:30:00')
    // Long enough that the engine always has a train inside the trip, whatever
    // the headway: a two-stop fixture leaves windows with nothing in transit.
    stubAmap([subwayLineFixture(
      ['甲站', '乙站', '丙站', '丁站', '戊站', '己站', '庚站', '辛站', '壬站', '癸站', '子站', '丑站'],
    )])
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = await arrivals(app, '己站', '&order=6')
      expect(data.isExact).toBe(false)
      expect(data.arrivals.length).toBeGreaterThan(0)
      for (const row of data.arrivals) {
        expect(row.provenance).toBe('schedule_simulation')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      await app.close()
    }
  })
})
