import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D2 at the HTTP boundary: a `count` that is PRESENT but is not a row count is
 * refused, not silently turned into an empty board.
 *
 * Measured live: `GET /lines/<id>/stations/公主坟/arrivals?count=abc` answered
 * **200 with 0 rows** at a moment when the same line's `/live` carried 11
 * vehicles. The mechanism is `Math.min(Number('abc'), 20)` — `NaN` — travelling
 * into `vehicleArrivals(...).slice(0, NaN)`, which is `[]`: a fabricated empty
 * state that reads exactly like 「这条线路此刻没有车」. Same family as the
 * `direction` and `order` boundaries this repo already refuses at the edge: the
 * value the answer carries must be the value the caller stated, or there must be
 * no answer.
 *
 * Both halves are pinned: a malformed value 400s naming the accepted form, and a
 * valid value still answers rows. The absent parameter is pinned too, because it
 * is the one case that is NOT a refusal — it keeps the default it has today.
 *
 * 甲路..辛路 and `line_027_1` are placeholders: no real route or upstream id
 * appears here, and no upstream is reachable — every read below is a stub.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LINE_ID = 'line_027_1'
/** The platform the readings below are about: the fourth stop of the fixture. */
const STATION = '丁路'
const STATION_ORDER = 4

const STATIONS = ['甲路', '乙路', '丙路', '丁路', '戊路', '己路', '庚路', '辛路'].map((name, idx) => ({
  sId: `s${idx + 1}`,
  sn: name,
  order: idx + 1,
  lat: 39.9 + idx * 0.01,
  lng: 116.4 + idx * 0.01,
}))

/**
 * The upstream answer for this line: it exists, its stops are known, and EIGHT
 * vehicles are on their way to the fourth stop with stated travel times — so a
 * correct arrivals answer is a list of rows whose LENGTH is the `count` the caller
 * asked for (up to the eight that exist), and an empty list can only be a
 * fabrication. Eight, not one: with a single vehicle, `count=6` and `count=1` and an
 * absent count all answer the same one row, and no assertion over the rows could
 * tell the route's default from a value the caller stated.
 */
function stubUpstream(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonr: {
          data: {
            line: { name: '甲路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
            stations: STATIONS,
            buses: Array.from({ length: 8 }, (_, idx) => ({
              busId: `b${idx + 1}`,
              order: 3,
              speed: 5,
              travels: [{ order: STATION_ORDER, travelTime: 60 * (idx + 1) }],
            })),
          },
        },
      }),
    }
  }))
}

/** The arrivals URL for this platform, with whatever query the test states. */
function arrivalsUrl(query: string): string {
  return `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION)}/arrivals`
    + `?direction=0&cityCode=027&order=${STATION_ORDER}${query}`
}

/** The rows one arrivals answer carries. */
function rowsOf(body: string): unknown[] {
  return (JSON.parse(body).data?.arrivals ?? []) as unknown[]
}

describe('G-D2: a malformed count is refused at the boundary', () => {
  it('answers rows for a valid count, so the refusal below is not measured on an empty fixture', async () => {
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=6') })
      expect(res.statusCode, res.body).toBe(200)
      // The fixture's own control: the line HAS a vehicle heading for this
      // platform, so 0 rows on the next assertion can only come from the count.
      expect(rowsOf(res.body).length, res.body).toBeGreaterThan(0)
    }
    finally {
      await app.close()
    }
  })

  it('answers 400 naming the accepted form for every malformed spelling', async () => {
    for (const raw of ['abc', '0', '-1', '3.7', '1e2', '0x6', '', ' ', '+6', '6.0', '21', '999']) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url: arrivalsUrl(`&count=${encodeURIComponent(raw)}`) })
        expect(res.statusCode, `count=${JSON.stringify(raw)} was accepted`).toBe(400)
        const body = JSON.parse(res.body)
        expect(body.success, `count=${JSON.stringify(raw)}`).toBe(false)
        // The refusal names the domain, so a caller can correct the request
        // without reading the source.
        expect(body.error, `count=${JSON.stringify(raw)}`).toContain('count')
        expect(body.error, `count=${JSON.stringify(raw)}`).toContain('20')
      }
      finally {
        await app.close()
      }
    }
  })

  it('refuses before any upstream is read', async () => {
    stubUpstream()
    const app = await buildApp({})
    try {
      await app.inject({ method: 'GET', url: arrivalsUrl('&count=abc') })
      // A request the boundary cannot mean must not spend upstream quota — nor be
      // answered from a call made with NaN.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    }
    finally {
      await app.close()
    }
  })

  it('never answers 200 with an empty board for a malformed count', async () => {
    // The defect's own shape: 200 + 0 rows while the line has a vehicle. Stated
    // as its own case because a status-only assertion could be satisfied by a
    // refusal that still answered a body.
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=abc') })
      const accidentallyEmpty = res.statusCode === 200 && rowsOf(res.body).length === 0
      expect(accidentallyEmpty, `a fabricated empty board was served: ${res.body}`).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D2: the domain itself, both halves', () => {
  it('answers rows for every count in 1..20', async () => {
    for (const count of Array.from({ length: 20 }, (_, i) => i + 1)) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url: arrivalsUrl(`&count=${count}`) })
        expect(res.statusCode, `count=${count}`).toBe(200)
        // Eight vehicles exist, so a count at or below eight is exactly that many
        // rows: the value the caller stated is the length it gets, and a route that
        // ignored `count` would answer eight for the one-row cases too.
        expect(rowsOf(res.body).length, `count=${count}`).toBe(Math.min(count, 8))
      }
      finally {
        await app.close()
      }
    }
  })

  it('does not answer more rows than the upper bound allows', async () => {
    // The bound the route already implied (`Math.min(..., 20)`), now stated
    // rather than applied silently. One vehicle is all this fixture has, so the
    // row count cannot distinguish the bounds — what is pinned is that the
    // boundary refuses a value ABOVE the bound instead of quietly capping it.
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=25') })
      expect(res.statusCode, res.body).toBe(400)
    }
    finally {
      await app.close()
    }
  })

  it('keeps today\'s default when count is ABSENT', async () => {
    // The one case that is not a refusal: no count stated, so the route's own
    // default decides. Pinned by LENGTH against the eight vehicles the fixture
    // carries, so a change to the default has to be stated here: six rows is what
    // the route answers, and five or seven would be a different default.
    stubUpstream()
    const app = await buildApp({})
    try {
      const absent = await app.inject({ method: 'GET', url: arrivalsUrl('') })
      expect(absent.statusCode, absent.body).toBe(200)
      expect(rowsOf(absent.body).length, 'the absent-count default is no longer 6').toBe(6)
      // Both reads come through the same build: the live cache may answer the
      // second one, which is fine — the rows are the same reading either way.
      const explicit = await app.inject({ method: 'GET', url: arrivalsUrl('&count=6') })
      expect(rowsOf(absent.body)).toEqual(rowsOf(explicit.body))
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D2: the same route\'s other parameters are held to the same rule', () => {
  it('refuses a malformed order instead of dropping it', async () => {
    // `order` is the stop the reading is priced to, and this route used
    // `Number(q.order)` — so `?order=abc` became NaN, failed the service's
    // `typeof === 'number' && > 0` test, and was silently dropped: the caller
    // asked about one platform and was answered about the whole line. The live
    // route already refuses it (`targetOrderQueryOf`); this one now agrees.
    for (const raw of ['abc', '0', '-1', '2.5']) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const url = `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION)}/arrivals`
          + `?direction=0&cityCode=027&count=6&order=${encodeURIComponent(raw)}`
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `order=${JSON.stringify(raw)} was accepted`).toBe(400)
        expect(JSON.parse(res.body).error).toContain('order')
      }
      finally {
        await app.close()
      }
    }
  })
})
