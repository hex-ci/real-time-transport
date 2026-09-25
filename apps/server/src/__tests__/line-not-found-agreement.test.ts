import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D1 at the HTTP boundary: every route keyed by a line id states the SAME fact
 * about whether the upstream knows that line.
 *
 * Measured live against the running server: `GET /api/transit/lines/
 * NO_SUCH_LINE_999/live` answered **200** with
 * `{buses: [], dataSource: 'chelaile', isDegraded: false}` — byte-identical to a
 * real line with no vehicle in transit right now — while `GET /api/transit/lines/
 * NO_SUCH_LINE_999` answered **404**. One id, two opposite facts, and the wrong
 * one was the one a client could not tell from 「此刻没车」.
 *
 * The miss is refused at the source (the provider's live read answers null for a
 * payload holding no record of the line — `line-record-identity.test.ts` in
 * `packages/transit-adapter`), so the boundary's existing 404 branch fires. What
 * is pinned HERE is the consequence a client sees: the four line-keyed routes
 * agree on 404, and the POSITIVE CONTROL — a real line with no vehicle in
 * transit — keeps answering 200 with an empty list, because a blanket refusal
 * would be worse than the defect.
 *
 * 甲路 / 乙路 and `line_027_1` are placeholders: no real route or upstream id
 * appears here, and no upstream is reachable — every read below is a stub.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A line id the upstream has no record of. */
const GHOST_LINE = 'NO_SUCH_LINE_999'
/** A line the upstream does know, with nothing in transit in this stub. */
const REAL_LINE = 'line_027_1'
const STATION = '甲路'

const STATIONS = [
  { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
  { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
]

/**
 * The upstream's answer about whatever line is asked about.
 *
 * One payload for every id — the shape the endpoint really returns for an id it
 * has never heard of is an envelope with no `line`, no `stations` and no
 * `buses`; a line that exists answers with its stop list and, when nothing is
 * running, no vehicles.
 */
function stubUpstream(payload: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonr: { data: payload } }),
    }
  }))
}

/** The upstream has never heard of the id: no name, no stop list, no vehicle. */
const NO_RECORD: Record<string, unknown> = {}
/** A line that exists with nothing in transit right now. */
const NO_VEHICLE: Record<string, unknown> = {
  line: { name: '甲路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
  stations: STATIONS,
  buses: [],
}

/** Every route that takes a line id, as a caller reaches it. */
function lineRoutes(lineId: string): Array<{ route: string, url: string }> {
  const id = encodeURIComponent(lineId)
  return [
    { route: 'line detail', url: `/api/transit/lines/${id}` },
    { route: 'live status', url: `/api/transit/lines/${id}/live` },
    { route: 'station arrivals', url: `/api/transit/lines/${id}/stations/${encodeURIComponent(STATION)}/arrivals` },
    {
      route: 'walk decision',
      url: `/api/transit/gis/walk-decision?originLng=116.4&originLat=39.9`
        + `&lineId=${id}&stationName=${encodeURIComponent(STATION)}`,
    },
  ]
}

describe('G-D1: a line id the upstream has no record of is refused on every line-keyed route', () => {
  it('answers 404 with a legible body, on all four routes', async () => {
    for (const { route, url } of lineRoutes(GHOST_LINE)) {
      stubUpstream(NO_RECORD)
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `${route} answered ${res.statusCode} for a line the upstream does not know`).toBe(404)
        const body = JSON.parse(res.body)
        expect(body.success, route).toBe(false)
        // A refusal names the outcome rather than handing back a value that
        // reads like a real answer.
        expect(typeof body.error, route).toBe('string')
        expect(body.error.length, route).toBeGreaterThan(0)
      }
      finally {
        await app.close()
      }
    }
  })

  it('answers the routes that can answer 200 for a real line with no vehicle', async () => {
    // The positive control, route by route: the refusal above must be about the
    // LINE, not about an empty list. `/live` is the one the defect was measured
    // on; the detail is the route the live route must agree with.
    //
    // Walk-decision is NOT in this list, and deliberately: it prices a walking
    // route through Amap, and a build with no Amap key cannot answer it for any
    // line — including a real one. Asserting 200 there would be asserting that a
    // key is configured, which is not what this file is about.
    for (const { route, url } of lineRoutes(REAL_LINE).filter(r => r.route !== 'walk decision')) {
      stubUpstream(NO_VEHICLE)
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `${route} refused a line that exists: ${res.body}`).toBe(200)
      }
      finally {
        await app.close()
      }
    }
  })

  it('answers 200 with an empty vehicle list for a real line with no vehicle', async () => {
    stubUpstream(NO_VEHICLE)
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: `/api/transit/lines/${REAL_LINE}/live` })
      expect(res.statusCode, res.body).toBe(200)
      const data = JSON.parse(res.body).data
      expect(data.buses).toEqual([])
      // 此刻没车 is a state of a line that exists: the answer still names it.
      expect(data.lineId).toBe(REAL_LINE)
      expect(data.isDegraded).toBe(false)
    }
    finally {
      await app.close()
    }
  })

  it('refuses a ghost line id even in simulate mode, where an empty reading would be filled', async () => {
    // A fabricated id must not become real by the simulation switch: the
    // simulated generator resolves the line detail first and refuses to invent a
    // line — see `TransitService.generateSimulatedLiveStatus`.
    vi.stubEnv('TRANSIT_SIMULATION', 'true')
    stubUpstream(NO_RECORD)
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: `/api/transit/lines/${GHOST_LINE}/live` })
      expect(res.statusCode, res.body).toBe(404)
    }
    finally {
      await app.close()
      vi.unstubAllEnvs()
    }
  })
})
