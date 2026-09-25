import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * The live route must forward the caller's TARGET ORDER, or a board that asks about one
 * platform is answered about the line's terminus.
 *
 * Upstream computes a vehicle's travel time only when the request names the stop it is
 * travelling to. Without that, a reading still carries a `travelTimeSec` — the distance
 * to the TERMINUS — which reads as a real minute and is the wrong question's answer:
 * the platform board rendered 「无法估算」 for every bus row instead of this minute,
 * because its own request named no stop. The fix is the query parameter, and this is
 * where it has to arrive: the provider, the service and the aggregator all already take
 * `options.targetOrder`, and a route that drops the parameter leaves all of them right
 * and the screen wrong.
 *
 * The subway engine is the fixture because its arithmetic is deterministic and depends
 * on the order in exactly the way the defect does: with a target it prices the hops to
 * THAT stop, and without one it prices the hops to the terminal. So the same train, in
 * the same answer, states a strictly smaller minute once the route forwards the order —
 * and the terminal figure is what a dropped parameter would put back.
 */

/** 08:00 Beijing, inside the fixture line's window, so the live answer has trains. */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

const LINE_ID = 'subway_027_7'
/** The platform the board is showing. Not the first stop: a train must still be heading there. */
const TARGET_ORDER = 4

/** An Amap v3 success envelope around a fixture line, per the shipped table. */
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

/** The live reading for one request; each call gets its own app, as the other route tests do. */
async function liveBuses(query: string): Promise<Array<{
  id: string
  order: number
  travelTimeSec?: number
}>> {
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027${query}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return JSON.parse(res.body).data.buses
  }
  finally {
    await app.close()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live route forwards a target order to the reading it asks for', () => {
  it('answers the platform\'s minute instead of the terminus one, per vehicle', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const terminal = await liveBuses('')
    stubUpstream()
    freezeAtBeijingMorning()
    const targeted = await liveBuses(`&order=${TARGET_ORDER}`)

    // The same trains, so a comparison per vehicle is a comparison of one train.
    const terminalById = new Map(terminal.map(bus => [bus.id, bus.travelTimeSec]))
    expect(terminalById.size, 'the fixture line answered no train').toBeGreaterThan(0)

    const stated = targeted.filter(bus => typeof bus.travelTimeSec === 'number')
    // Non-empty FIRST: a request that carried the order but priced nothing would make
    // the loop below pass while measuring nothing.
    expect(stated.length, 'the targeted read stated no minute at all').toBeGreaterThan(0)

    for (const bus of stated) {
      const terminus = terminalById.get(bus.id)
      expect(terminus, `${bus.id} is missing from the untargeted reading`).toBeTypeOf('number')
      // Strictly smaller: the minute is the hops to the requested platform, not the
      // hops to the end of the line. A route that dropped the parameter answers the
      // terminus figure here, which is what this assertion catches.
      expect(bus.travelTimeSec!, `${bus.id} states the terminus figure, not the platform's`)
        .toBeLessThan(terminus!)
    }

    // …and the vehicles past the platform state none, rather than a figure about a stop
    // they have already cleared: a row for them would be a minute for the wrong place.
    for (const bus of targeted) {
      if (bus.order >= TARGET_ORDER) {
        expect(bus.travelTimeSec, `${bus.id} has cleared the platform but states a minute`).toBeUndefined()
      }
    }
  })

  it('states no minute for a platform no train is heading to, rather than one about the terminus', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    // Order 1 is the line's own origin: no train is on its way TO it, so every vehicle is
    // past it and none may state a minute. A dropped parameter would answer the terminus
    // figure for all of them — the fabricated-minute shape, for the wrong platform.
    const atOrigin = await liveBuses('&order=1')
    expect(atOrigin.length, 'the fixture line answered no train').toBeGreaterThan(0)
    for (const bus of atOrigin) {
      expect(bus.travelTimeSec, `${bus.id} states a minute at the line's origin`).toBeUndefined()
    }
  })

  it('refuses an order that is not a station ordinal, before reading upstream', async () => {
    // A target that travelled as NaN would be a request about one platform answered with
    // a figure about another, so a value the boundary cannot mean is refused rather than
    // normalized into 「no target」 — the same rule `direction` follows.
    for (const order of ['abc', '0', '-1', '1e0', '2.5', '', ' ']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027&order=${encodeURIComponent(order)}`,
        })
        expect(res.statusCode, `accepted order=${JSON.stringify(order)}`).toBe(400)
        expect(JSON.parse(res.body).error).toBe('order must be a positive integer station ordinal')
        expect(vi.mocked(fetch), `order=${JSON.stringify(order)} spent an upstream read`).not.toHaveBeenCalled()
      }
      finally {
        await app.close()
      }
    }
  })

  it('still answers a reading that names no target, which is what a line board shows', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027`,
      })
      expect(res.statusCode, res.body).toBe(200)
      // Every vehicle is priced to the terminus without a target — the reading the line
      // page's own board consumes, and not an error.
      const buses = JSON.parse(res.body).data.buses as Array<{ travelTimeSec?: number }>
      expect(buses.length).toBeGreaterThan(0)
      for (const bus of buses) {
        expect(bus.travelTimeSec, 'an untargeted reading states no minute').toBeTypeOf('number')
      }
    }
    finally {
      await app.close()
    }
  })
})
