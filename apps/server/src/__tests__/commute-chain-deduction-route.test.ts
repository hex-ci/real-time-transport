import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F10's route: the chains of one purpose, each with the engine's own answer.
 *
 * Two things this suite pins down that the service suite cannot.
 *
 *  1. The WIRE shape. Every chain of the purpose travels in ONE response, and
 *     each chain's deduction is passed through untouched: a 「不给结论」 reason
 *     is a code with no siblings, never a sentence the server wrote — the web
 *     layer owns every word the user reads, and a server-side sentence could not
 *     be re-worded or translated without a release.
 *  2. The two targeted reads happen through the REAL provider and aggregator,
 *     with the target orders the stored legs name — so the per-station cache keys
 *     the assembly relies on (`<line>_<direction>_target_<order>`) are the ones
 *     actually used, not ones only a mock ever sees.
 *
 * 101 / 202 / 甲路 / 乙路 are placeholders: no real route, station or upstream id
 * appears in this file, and no upstream is reachable — both upstreams are stubs.
 */

const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

const LINE_A = '101'
const LINE_B = '202'

/** The stop list each line is read with, and the leg booked against it. */
const STOPS: Record<string, string[]> = {
  [LINE_A]: ['甲路', '乙路', '丙路'],
  [LINE_B]: ['丙路', '丁路', '戊路', '己路'],
}
const BOARD_ORDER: Record<string, number> = { [LINE_A]: 2, [LINE_B]: 3 }
/** What the upstream reports for each requested target order, in seconds. */
const TRAVEL: Record<string, Record<number, number>> = {
  [LINE_A]: { 2: 900, 3: 1200 },
  [LINE_B]: { 3: 2100, 4: 2400 },
}
/** The walking duration the path-service stub prices every connection at. */
const WALK_SECONDS = 300

function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const LEG_A = {
  lineId: LINE_A,
  lineName: '101路',
  cityCode: '027',
  boardStationName: '乙路',
  boardStationOrder: 2,
  alightStationName: '丙路',
  alightStationOrder: 3,
  transferExtraMinutes: null,
}

const LEG_B = {
  lineId: LINE_B,
  lineName: '202路',
  cityCode: '027',
  boardStationName: '戊路',
  boardStationOrder: 3,
  alightStationName: '己路',
  alightStationOrder: 4,
  transferExtraMinutes: null,
}

function chainBody(over: Record<string, unknown> = {}) {
  return { name: '上班链路', originAnchor: 'home', purpose: 'morning', legs: [{ ...LEG_A }, { ...LEG_B }], ...over }
}

/**
 * Both upstreams the deduction can reach, counted.
 *
 * `targets` records the target order of every LIVE read, which is how 「each leg
 * is read twice, at its own two stations」 is observable from outside. The
 * line-detail read carries no target and is not counted there.
 *
 * `noseAtByLine` moves a line's vehicle along it, so a test can reproduce the
 * upstream filter that prices no row: a vehicle whose nose has already passed the
 * requested order is not returned for it.
 */
function stubUpstream(options: { noseAtByLine?: Record<string, number> } = {}): { lines: string[], targets: string[], walking: number } {
  const state = { lines: [] as string[], targets: [] as string[], walking: 0 }

  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)

    if (href.includes('/v3/direction/walking')) {
      state.walking += 1
      return amapOk({ route: { paths: [{ distance: 400, duration: WALK_SECONDS }] } })
    }
    if (!href.includes('encryptedLineDetail')) {
      throw new Error(`unexpected upstream call: ${href}`)
    }

    const params = new URL(href).searchParams
    const lineId = String(params.get('lineId'))
    const target = params.get('targetOrder')
    if (target) state.targets.push(`${lineId}:${target}`)
    state.lines.push(lineId)

    return body(JSON.stringify({
      jsonr: { data: lineBody(lineId, target ? Number(target) : null, options.noseAtByLine?.[lineId]) },
    }))
  }))

  return state
}

/** A response the chelaile provider reads as text, which is what it does. */
function body(text: string) {
  return { ok: true, status: 200, text: async () => text }
}

/** An Amap v3 success envelope. */
function amapOk(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * A line's detail, with the vehicle the upstream reports for the requested
 * target order only — exactly like the real one, whose `travels` are matched by
 * the order the request named. No `mileage` and no `distanceToWaitStn`, so no row
 * can be read as 「正在进站」 and every minute below is the upstream's own.
 *
 * `noseAt` is where the vehicle's nose is; unset means the line's own board
 * order, which is the ordinary case. Upstream returns a vehicle for a requested
 * order iff its nose has NOT passed that order, so a nose past an order is what
 * makes that read price no row.
 */
function lineBody(lineId: string, targetOrder: number | null, noseAt?: number) {
  const names = STOPS[lineId] ?? []
  const travel = targetOrder !== null ? TRAVEL[lineId]?.[targetOrder] : undefined

  return {
    line: { name: lineId, direction: 0, firstTime: '05:00', lastTime: '23:00' },
    stations: names.map((name, i) => ({
      sId: `s${i + 1}`,
      sn: name,
      order: i + 1,
      lat: 39.9 + (i + 1) / 100,
      lng: 116.4 + (i + 1) / 100,
    })),
    buses: [{
      busId: 'v1',
      order: noseAt ?? BOARD_ORDER[lineId],
      speed: 6,
      ...(travel !== undefined ? { travels: [{ order: noseAt ?? targetOrder, travelTime: travel }] } : {}),
    }],
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

const deductions = (app: App, query = '?purpose=morning') =>
  app.inject({ url: `/api/transit/commute-chains/deductions${query}` })

const createChain = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/transit/commute-chains', payload })

const saveAnchor = (app: App) =>
  app.inject({ method: 'PATCH', url: '/api/transit/settings', payload: { homeLat: 39.9, homeLng: 116.4 } })

describe('F10 route: one response carries every chain of the purpose', () => {
  it('answers the chains with the engine\'s own deduction, over the real live path', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      expect((await saveAnchor(app)).statusCode).toBe(200)
      const created = (await createChain(app, chainBody())).json().data

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      const payload = res.json()
      expect(payload.success).toBe(true)
      expect(payload.data.purpose).toBe('morning')
      expect(payload.data.chains).toHaveLength(1)

      const view = payload.data.chains[0]
      expect(view).toMatchObject({
        chainId: created.id,
        name: '上班链路',
        originAnchor: 'home',
        purpose: 'morning',
      })

      expect(view.deduction).toEqual({
        status: 'deduced',
        band: 'comfortable',
        marginMinutes: 10,
        bindingSeq: 0,
        legs: [
          {
            seq: 0,
            lineId: LINE_A,
            lineName: '101路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 20,
            rideMinutes: 5,
            marginMinutes: 10,
            // F3's state travels with the leg: the line's own hours, and `now`.
            operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
          },
          {
            seq: 1,
            lineId: LINE_B,
            lineName: '202路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 40,
            rideMinutes: 5,
            marginMinutes: 10,
            operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
          },
        ],
        provenance: 'live',
        lastUpdatedAt: T0_MS,
      })

      // One live read per station: the adapter answers for one target order, so
      // each leg's board minute and alight minute come from two requests — and
      // the orders named are the stored ones, over the real provider.
      expect(upstream.targets).toEqual([`${LINE_A}:2`, `${LINE_A}:3`, `${LINE_B}:3`, `${LINE_B}:4`])
    }
    finally {
      await app.close()
    }
  })

  it('answers only the chains of THIS purpose and THIS user', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      const morning = (await createChain(app, chainBody())).json().data
      await createChain(app, chainBody({ name: '下班链路', purpose: 'evening' }))
      await createChain(app, chainBody({ name: '别人的链路', userId: 'someone_else' }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains.map((c: { chainId: string }) => c.chainId)).toEqual([morning.id])

      const evening = await deductions(app, '?purpose=evening')
      expect(evening.json().data.chains.map((c: { name: string }) => c.name)).toEqual(['下班链路'])
    }
    finally {
      await app.close()
    }
  })

  it('answers an empty list, not an error, for a purpose with no chain', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data).toEqual({ purpose: 'morning', chains: [] })
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: 不给结论 travels as the engine\'s code', () => {
  it('ships a code with no sentence beside it', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({
        legs: [{ ...LEG_A, boardStationName: null, boardStationOrder: null }],
      }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      const deduction = res.json().data.chains[0].deduction
      expect(deduction).toEqual({
        status: 'no-conclusion',
        reason: 'station-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // A reason, which leg refused it, and nothing else: no sentence, no
      // defaulted minutes, no guess at which bus the user might catch. WHICH leg
      // refused is not a quantity about the answer — see `ChainNoConclusion`.
      expect(Object.keys(deduction).sort()).toEqual(['leg', 'reason', 'status'])
    }
    finally {
      await app.close()
    }
  })

  it('reports an unusable chain as a 200 with a reason, not as a failure of the request', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // No anchor saved at all: the connection into the first leg cannot be
      // priced, and the engine says so rather than walking from a coordinate the
      // user never saved. The reason names THAT fact — the origin the chain was
      // recorded against was never set — because it is the one cause of an
      // unpriced connection the user can act on, and it is the same word F1's
      // own empty state uses for the same fact.
      await createChain(app, chainBody({ legs: [{ ...LEG_A }] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Nothing was walked and no platform was read: the engine refuses on the
      // connection before a reading could matter.
      expect(upstream.walking).toBe(0)
      expect(upstream.targets).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('names the unsaved anchor even when the leg could not be located either', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // Both faults at once: no anchor was ever saved, and this leg's own stop
      // list cannot place its stations (an unknown line reads as a line with no
      // stops). Only one of the two is the user's to repair, and the answer has
      // to name that one: an answer that names the other sends them to a screen
      // where the remedy is not.
      const unlocatable = { ...LEG_A, lineId: '999', lineName: '999路' }
      await createChain(app, chainBody({ legs: [unlocatable] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '999', lineName: '999路' },
      })
      expect(upstream.walking).toBe(0)
      expect(upstream.targets).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('refuses a request that names no purpose of ours, instead of picking one', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const missing = await deductions(app, '')
      expect(missing.statusCode, missing.body).toBe(400)
      expect(missing.json().success).toBe(false)
      expect(typeof missing.json().error).toBe('string')

      const unknown = await deductions(app, '?purpose=afternoon')
      expect(unknown.statusCode, unknown.body).toBe(400)
      expect(unknown.json().success).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: the refusal names the leg it is about, over the wire', () => {
  it('names the SECOND leg when the second leg is the one that refused', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({
        legs: [LEG_A, { ...LEG_B, boardStationName: null, boardStationOrder: null }],
      }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      // Leg 0 is deduceable; leg 1's station was never chosen. The refusal has to
      // say WHICH transfer point that is — a two-leg chain otherwise leaves the
      // page unable to point at it or name the line that refused there.
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'station-unset',
        leg: { seq: 1, lineId: '202', lineName: '202路' },
      })
    }
    finally {
      await app.close()
    }
  })

  it('carries the refusing leg\'s reading age and service state, not only its reason', async () => {
    freezeAt(T0)
    // LINE_A's vehicle has already passed the board order (its nose is at order 3
    // while the leg boards at order 2), so the board read prices NO row and the
    // empty answer is the SERVICE's. The refusal must date that reading and say
    // which service state governs it — 05:00–23:00 at 08:30 is 运营中, so the page
    // can state a gap in a running service rather than a day that ended.
    stubUpstream({ noseAtByLine: { [LINE_A]: 3 } })
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({ legs: [{ ...LEG_A }] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-vehicle',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        updatedAt: T0_MS,
        operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
      })
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: a leg recorded the wrong way round cannot be stored', () => {
  /** The same line, recorded with the two stations the other way round. */
  const BACKWARDS = {
    ...LEG_A,
    boardStationName: '丙路',
    boardStationOrder: 3,
    alightStationName: '乙路',
    alightStationOrder: 2,
  }

  it('refuses a POST whose leg runs upstream, with a 400 and a reason', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await createChain(app, chainBody({ legs: [BACKWARDS] }))
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().success).toBe(false)
      expect(typeof res.json().error).toBe('string')
    }
    finally {
      await app.close()
    }
  })

  it('refuses a PATCH that would store one, and changes nothing', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const created = (await createChain(app, chainBody({ legs: [LEG_A] }))).json().data

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${created.id}`,
        payload: { legs: [BACKWARDS] },
      })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().success).toBe(false)

      // The rejected write stored nothing: the leg still runs downstream.
      const read = (await app.inject({ url: `/api/transit/commute-chains/${created.id}` })).json().data
      expect(read.legs[0].boardStationOrder).toBe(2)
      expect(read.legs[0].alightStationOrder).toBe(3)
    }
    finally {
      await app.close()
    }
  })
})
