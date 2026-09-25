import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F-D at the HTTP boundary: a direction the contracts do not accept is refused
 * THERE, with the accepted values named.
 *
 * The app's own contracts say what a direction is — `z.number().int().min(0)`
 * `.max(1)`, on `LineDetail`, `LiveLineStatus` and the WS messages — and this
 * boundary read the query with `Number(q.direction ?? 0)`. So `?direction=abc`
 * became NaN, which travelled through the engine and came back as
 * `train_subway_027_7_dNaN_dep118` (the `busId` of every arrivals row) with
 * `direction: null` in the payload; and `?direction=9` was answered 200 for a
 * value the same contracts forbid. The engine-side guard (`statedDirection`)
 * keeps a malformed number out of the generated ids, and that defence stays —
 * but a value the API cannot mean is a REQUEST error and belongs at the edge,
 * where the caller can be told what is accepted.
 *
 * Two things are pinned: the refusal itself (400, naming 0 and 1) and the
 * absence of the leak it prevents — no accepted request ever answers with an id
 * derived from a malformed direction.
 */

/** 08:00 Beijing: inside the fixture line's window, so the live answer has trains. */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'
/**
 * A platform TRAINS APPROACH, for the arrivals sweep below: the origin cannot
 * serve one, since a train whose next stop is the origin has already left it
 * (`nextOrder > targetOrder` drops it) — 群芳 would answer an empty list and the
 * sweep over its busIds would pass while holding nothing.
 */
const ARRIVALS_STATION = '万盛西'

/**
 * An Amap v3 success envelope around a fixture line the shipped table covers.
 *
 * The stop list is eight long on purpose: a two-stop line's whole traversal is
 * shorter than the timetable's own headway, so there are minutes of the morning
 * with no train on the line and an assertion over the generated ids would read
 * as passed while holding an empty list. Eight stations (8 × 135 s) outlast the
 * ~6 min peak headway, so the morning always has a train en route.
 */
function stubUpstream(): void {
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
            start_stop: stops[0][0],
            end_stop: stops[stops.length - 1][0],
            start_time: '0516',
            end_time: '2306',
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

/** The four routes that take a `direction`, built for the same line. */
function directionRoutes(direction: string): Array<{ route: string, url: string }> {
  const q = `direction=${encodeURIComponent(direction)}`
  return [
    { route: 'line detail', url: `/api/transit/lines/${LINE_ID}?${q}` },
    { route: 'live status', url: `/api/transit/lines/${LINE_ID}/live?${q}` },
    {
      route: 'station arrivals',
      url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION_NAME)}/arrivals?${q}`,
    },
    {
      route: 'walk decision',
      url: '/api/transit/gis/walk-decision?originLng=116.4&originLat=39.9'
        + `&lineId=${LINE_ID}&stationName=${encodeURIComponent(STATION_NAME)}&${q}`,
    },
  ]
}

describe('G1: a direction the contracts do not accept is refused at the boundary', () => {
  it('answers 400 naming the accepted values for every route that takes one', async () => {
    for (const direction of ['abc', '9', '-1', '1e0', '0x1', '', ' ']) {
      for (const { route, url } of directionRoutes(direction)) {
        stubUpstream()
        freezeAtBeijingMorning()
        const app = await buildApp({ amapKey: 'test-key' })
        try {
          const res = await app.inject({ method: 'GET', url })
          expect(res.statusCode, `${route} accepted direction=${JSON.stringify(direction)}`).toBe(400)
          expect(JSON.parse(res.body).success).toBe(false)
          // The refusal names BOTH values the schema accepts, so a caller can
          // correct the request without reading the source.
          expect(JSON.parse(res.body).error, route).toBe('direction must be 0 or 1')
        }
        finally {
          await app.close()
        }
      }
    }
  })

  it('refuses before any upstream is read', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await app.inject({ method: 'GET', url: `/api/transit/lines/${LINE_ID}/live?direction=abc` })
      // A request the boundary cannot mean must not spend upstream quota — or,
      // worse, be answered from a call made with NaN.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    }
    finally {
      await app.close()
    }
  })

  it('accepts the two stated values, and the absent one as its declared default', async () => {
    for (const url of [
      `/api/transit/lines/${LINE_ID}?direction=0`,
      `/api/transit/lines/${LINE_ID}?direction=1`,
      `/api/transit/lines/${LINE_ID}`,
    ]) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, url).toBe(200)
        expect(JSON.parse(res.body).data.direction, url).toBeLessThanOrEqual(1)
      }
      finally {
        await app.close()
      }
    }
  })
})

describe('G1: no accepted request answers with an id derived from a malformed direction', () => {
  it('names every generated train with the stated direction it was answered under', async () => {
    for (const direction of ['0', '1']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/live?direction=${direction}&cityCode=027`,
        })
        expect(res.statusCode, res.body).toBe(200)
        const data = JSON.parse(res.body).data as {
          direction: number
          buses: Array<{ id: string }>
        }
        expect(data.direction, 'the answer states a direction the contracts accept').toBe(Number(direction))
        // A direction the boundary accepted must still produce trains, or this
        // assertion would pass over an empty list and prove nothing.
        expect(data.buses.length, `direction=${direction} answered no train`).toBeGreaterThan(0)
        for (const bus of data.buses) {
          expect(bus.id, `id carries a malformed direction: ${bus.id}`).not.toMatch(/NaN|undefined|null/)
          expect(bus.id).toMatch(new RegExp(`^train_${LINE_ID}_d${direction}_dep\\d+$`))
        }
      }
      finally {
        await app.close()
      }
    }
  })

  it('carries no NaN-derived busId in the arrivals rows either', async () => {
    // The reported leak reached the screen as the `busId` of an ARRIVALS row,
    // not of the live payload — the same generated ids, one contract further
    // out. Both surfaces are swept so the invariant is stated where it was seen.
    for (const direction of ['0', '1']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(ARRIVALS_STATION)}/arrivals`
            + `?direction=${direction}&count=6&cityCode=027`,
        })
        expect(res.statusCode, res.body).toBe(200)
        const rows = JSON.parse(res.body).data.arrivals as Array<{ busId?: string }>
        const generated = rows.filter(r => r.busId?.startsWith('train_'))
        expect(generated.length, `direction=${direction} answered no generated row`).toBeGreaterThan(0)
        for (const row of generated) {
          expect(row.busId, `row carries a malformed direction: ${row.busId}`).not.toMatch(/NaN|undefined|null/)
          expect(row.busId).toMatch(new RegExp(`^train_${LINE_ID}_d[01]_dep\\d+$`))
        }
      }
      finally {
        await app.close()
      }
    }
  })
})
