import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE_CACHE_TTL_MS, TransitAggregator } from '@real-time-transport/transit-adapter'
import type { ITransitProvider } from '@real-time-transport/transit-adapter'
import { RefreshLiveResultSchema } from '@real-time-transport/shared'
import type { LiveLineStatus } from '@real-time-transport/shared'
import type { Database } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'
import { buildApp } from '../app.js'

/**
 * F11's server half: `POST /api/transit/refresh`.
 *
 * The refresh exists for the one thing the push loop cannot give: a definite
 * reading, now, with the instant it was obtained attached to it. Two hazards
 * shape this file.
 *
 *  1. It is the only entry that can bypass the shared live cache, so it is the
 *     one place a user can spend upstream quota on demand. Hence a cooldown
 *     keyed by (user, data class) — shared by every screen, because two screens
 *     refreshing once each must not equal a bypass — and a refusal that spends
 *     no upstream call of its own.
 *  2. A refresh that cannot reach the upstream must say so. Reporting a fresh
 *     `lastUpdatedAt` for a reading nobody obtained is the failure mode this
 *     project treats as worse than an error.
 *
 * The 18 s cadence is the live cache's TTL: every screen reads through it, so it
 * is what bounds how new a reading can be. A refresh pressed inside that window
 * cannot produce a reading the cache would not have produced anyway, which is
 * why the window below refuses at 17 999 ms and opens at 18 000 ms.
 *
 * 101 / 202 / 甲路 / 乙路 are placeholders: no real route, station or upstream id
 * appears in this file.
 */

const LINE_ID = '101'
const OTHER_LINE_ID = '202'
const STATION_NAME = '乙路'

/** The frozen clock every deadline below is measured from, as local time. */
const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

/**
 * The cadence the design names: the live cache's TTL. Written as the design
 * value, and asserted against the cache's own exported constant below, so
 * retuning one side without the other cannot pass this file.
 */
const LIVE_CADENCE_MS = 18_000

/** Freeze the wall clock. Only `Date` is faked: the app's timers stay real. */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * A real-time read as the wire carries it: two stations and one vehicle, and no
 * trajectory, so the provider resolves its geometry from the station list and
 * spends exactly one request.
 */
const liveBody = JSON.stringify({
  jsonr: {
    data: {
      line: { name: LINE_ID, direction: 0, firstTime: '05:00', lastTime: '23:00' },
      stations: [
        { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
        { sId: 's2', sn: STATION_NAME, order: 2, lat: 39.91, lng: 116.41 },
      ],
      buses: [{ busId: 'v1', order: 2, distanceToWaitStn: 900, mileage: 300, speed: 6 }],
    },
  },
})

/**
 * Counted stand-in for every upstream the server can reach. All providers issue
 * their HTTP through `fetch`, so no test here spends real quota.
 *
 * `unavailable` answers with a body the provider cannot read (no `jsonr.data`),
 * which is how an unreachable upstream arrives at the service: the provider's
 * own `try`/`catch` turns the parse failure into null. Flipping `mode` mid-test
 * is therefore how "the upstream went away" is expressed.
 */
function stubUpstream(): { urls: string[], mode: 'ok' | 'unavailable' } {
  const state: { urls: string[], mode: 'ok' | 'unavailable' } = { urls: [], mode: 'ok' }

  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    state.urls.push(href)

    if (!href.includes('encryptedLineDetail')) return body(JSON.stringify({ jsonr: { data: {} } }))
    return state.mode === 'ok' ? body(liveBody) : body(JSON.stringify({ jsonr: {} }))
  }))

  return state
}

/** A response the provider reads as text, which is what it does for this upstream. */
function body(text: string) {
  return { ok: true, status: 200, text: async () => text }
}

/** An Amap v3 success envelope, for the static reads the subway path uses. */
function amapOk(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * A provider that records how it was read.
 *
 * A cache is invisible from outside the aggregator — a cached reading and a
 * freshly obtained one are the same object — so what a cache did is only ever
 * observable as whether the provider was asked at all.
 */
class CountingProvider implements ITransitProvider {
  readonly name = 'chelaile' as const
  readonly reads: string[] = []

  async searchLines(): Promise<never[]> {
    return []
  }

  async getLineDetail(): Promise<null> {
    return null
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    _cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus> {
    this.reads.push(options?.targetOrder ? `station ${options.targetOrder}` : 'whole-line')
    return {
      lineId,
      direction,
      buses: [],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: Date.now(),
    }
  }

  async isAvailable(): Promise<boolean> {
    return true
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

/** One press of a screen's refresh entry. */
function refresh(app: App, lines: unknown[], userId?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/transit/refresh',
    payload: userId ? { userId, lines } : { lines },
  })
}

function target(lineId: string) {
  return { lineId, direction: 0, cityCode: '027' }
}

describe('F11: one refresh per cooldown per user, shared by every screen', () => {
  it('refuses the second press inside the window, and spends no upstream call refusing', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const first = await refresh(app, [target(LINE_ID)])
      expect(first.statusCode, first.body).toBe(200)

      const firstData = first.json().data
      expect(firstData.throttled).toBe(false)
      expect(firstData.dataClass).toBe('live')
      expect(RefreshLiveResultSchema.safeParse(firstData).success, first.body).toBe(true)
      // The reading was obtained at the frozen instant, so the reported instant
      // is that instant — not the instant the answer was written.
      expect(firstData.lastUpdatedAt).toBe(T0_MS)
      expect(firstData.lines).toEqual([
        { lineId: LINE_ID, direction: 0, lastUpdatedAt: T0_MS, dataSource: 'chelaile', isDegraded: false },
      ])
      expect(firstData.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      // The success path sits inside a window it has just spent, so the wait is
      // the whole cadence: reporting 0 here tells a countdown to say 「可以刷新」
      // and the next press is refused.
      expect(firstData.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)

      const spentByFirst = upstream.urls.length
      expect(spentByFirst).toBeGreaterThan(0)

      vi.setSystemTime(T0_MS + 5_000)
      const second = await refresh(app, [target(LINE_ID)])

      expect(second.statusCode, second.body).toBe(429)
      const data = second.json().data
      expect(data.throttled).toBe(true)
      expect(RefreshLiveResultSchema.safeParse(data).success, second.body).toBe(true)
      // The refusal states when it may be tried again, as a deadline and as a
      // wait — the same number the header carries.
      expect(second.headers['retry-after']).toBe('13')
      // Refusing is not reading: the second press must not reach the upstream.
      expect(upstream.urls.length).toBe(spentByFirst)
      // The held reading's instant, unchanged — the payload never claims a
      // freshness it did not obtain.
      expect(data.lastUpdatedAt).toBe(T0_MS)
      // Honest retry information: 13 s of the 18 s window are left.
      expect(data.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      expect(data.retryAfterSeconds).toBe(13)
      expect(data.lines).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('shares one window between the home screen and the line page', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)

      // A different screen, asking about a different line, one second later.
      // Keying the window by line would let the two screens each refresh once
      // and so double the on-demand upstream reads.
      vi.setSystemTime(T0_MS + 1_000)
      const second = await refresh(app, [target(OTHER_LINE_ID)])

      expect(second.statusCode, second.body).toBe(429)
      expect(second.json().data.throttled).toBe(true)
      expect(upstream.urls.length).toBe(1)
    }
    finally {
      await app.close()
    }
  })

  it('keeps a separate window per user', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)], 'user-a')).statusCode).toBe(200)
      const spentByFirst = upstream.urls.length

      vi.setSystemTime(T0_MS + 1_000)
      const second = await refresh(app, [target(LINE_ID)], 'user-b')

      expect(second.statusCode, second.body).toBe(200)
      expect(second.json().data.throttled).toBe(false)
      expect(upstream.urls.length).toBeGreaterThan(spentByFirst)
    }
    finally {
      await app.close()
    }
  })

  it('opens the window again at the cadence, and reports the NEW instant it obtained', async () => {
    // The cadence is the live cache's own TTL, and it is the design's 18 s: the
    // cache and the cooldown are one number, so the button can never be pressed
    // faster than the data every screen reads through can change.
    expect(LIVE_CACHE_TTL_MS).toBe(LIVE_CADENCE_MS)

    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)
      const spentByFirst = upstream.urls.length

      // One millisecond short of the cadence: still the same window.
      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS - 1)
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(429)

      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      const third = await refresh(app, [target(LINE_ID)])

      expect(third.statusCode, third.body).toBe(200)
      expect(upstream.urls.length).toBeGreaterThan(spentByFirst)
      // What this proves is the WINDOW opening: the reported instant is the new
      // reading's, taken at the instant the cooldown expired. It does not prove
      // invalidation — the clock advanced by exactly the cadence, so the previous
      // entry has expired by TTL here and no legal press can happen earlier; with
      // `invalidateLive` replaced by a no-op this test still passes. Invalidation
      // is detected by the tests that count provider reads: 「keeps a separate
      // window per user」, 「drops the per-station readings the home overview uses,
      // not only the whole-line one」 and 「re-reads the whole-line reading and the
      // per-station reading」.
      expect(third.json().data.lines[0].lastUpdatedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      expect(third.json().data.lastUpdatedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    }
    finally {
      await app.close()
    }
  })

  it('drops the per-station readings the home overview uses, not only the whole-line one', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const board = () => app.inject({
        method: 'GET',
        url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION_NAME)}/arrivals`
          + '?direction=0&count=3&cityCode=027&order=2',
      })

      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)

      // The board is opened at the instant the window allows the next press. It
      // reads its own per-station entry, and its station table comes from the
      // line-detail cache — long-TTL data, which is why this costs exactly one
      // upstream read.
      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      expect((await board()).statusCode).toBe(200)
      const afterBoard = upstream.urls.length

      // Same instant, second press. Its own read is the whole-line one.
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)
      const afterRefresh = upstream.urls.length
      expect(afterRefresh).toBeGreaterThan(afterBoard)

      // The board asks again immediately, inside the cache's window. Its entry
      // was primed a moment ago; a press that dropped only the whole-line key
      // would leave this read served from it, spending nothing.
      expect((await board()).statusCode).toBe(200)
      expect(upstream.urls.length).toBe(afterRefresh + 1)
    }
    finally {
      await app.close()
    }
  })

  it('reads a line once even when the request names it twice', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      // A repeated line is one reading, not two: the request names lines, and a
      // repeat must not multiply the upstream reads the cooldown is bounding.
      const res = await refresh(app, [target(LINE_ID), target(LINE_ID)])

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.lines).toHaveLength(1)
      expect(upstream.urls.length).toBe(1)
    }
    finally {
      await app.close()
    }
  })

  it('validates the request instead of guessing what to refresh', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp()
    try {
      const empty = await refresh(app, [])
      expect(empty.statusCode, empty.body).toBe(400)
      expect(empty.json().success).toBe(false)

      const tooMany = await refresh(app, Array.from({ length: 9 }, (_, i) => target(`10${i}`)))
      expect(tooMany.statusCode, tooMany.body).toBe(400)
    }
    finally {
      await app.close()
    }
  })
})

describe('F11: a refresh that obtained nothing says exactly that', () => {
  it('reports the previous instant — never the instant it answered — when the upstream cannot answer', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const good = await refresh(app, [target(LINE_ID)])
      expect(good.statusCode, good.body).toBe(200)
      expect(good.json().data.lastUpdatedAt).toBe(T0_MS)

      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      upstream.mode = 'unavailable'
      const failed = await refresh(app, [target(LINE_ID)])

      expect(failed.statusCode, failed.body).toBe(502)
      expect(failed.json().success).toBe(false)
      const data = failed.json().data
      expect(RefreshLiveResultSchema.safeParse(data).success, failed.body).toBe(true)
      expect(data.throttled).toBe(false)
      expect(data.lines).toEqual([
        { lineId: LINE_ID, direction: 0, lastUpdatedAt: null, dataSource: null, isDegraded: null },
      ])
      // The instant of the reading actually held; the clock moved on by 18 s and
      // the payload must not follow it.
      expect(data.lastUpdatedAt).toBe(T0_MS)
      expect(data.lastUpdatedAt).not.toBe(T0_MS + LIVE_CADENCE_MS)
      expect(data.nextAllowedAt).toBe(T0_MS + 2 * LIVE_CADENCE_MS)
      // A failed read spends the window exactly as a successful one does, so the
      // wait is the cadence — not 0, which is what a 502 body would otherwise
      // carry while the deadline above is 18 s away.
      expect(data.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)
    }
    finally {
      await app.close()
    }
  })

  it('answers null — never the clock — when no refresh has ever obtained anything', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    upstream.mode = 'unavailable'
    const app = await buildApp()
    try {
      const failed = await refresh(app, [target(LINE_ID)])

      expect(failed.statusCode, failed.body).toBe(502)
      expect(failed.json().data.lastUpdatedAt).toBeNull()
      expect(failed.json().data.lines[0].lastUpdatedAt).toBeNull()
      expect(failed.json().data.lastUpdatedAt).not.toBe(T0_MS)
    }
    finally {
      await app.close()
    }
  })

  it('spends the window on a failed attempt, so a failure cannot become a retry loop', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    upstream.mode = 'unavailable'
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(502)
      const spentByFailure = upstream.urls.length

      vi.setSystemTime(T0_MS + 500)
      const again = await refresh(app, [target(LINE_ID)])

      expect(again.statusCode, again.body).toBe(429)
      expect(upstream.urls.length).toBe(spentByFailure)
    }
    finally {
      await app.close()
    }
  })
})

/**
 * The cache keys a refresh has to drop, at the layer that owns them.
 *
 * The home overview reads through a per-station key and a whole-line read
 * through another, so both must go: dropping one leaves the screen that pressed
 * the button showing exactly the reading it was trying to replace. A stale cache
 * entry and a fresh one are the same object from outside, so the number of
 * provider reads is the only honest observation of whether a key was dropped.
 */
describe('F11: a refresh drops both live cache key shapes', () => {
  it('re-reads the whole-line reading and the per-station reading', async () => {
    // Frozen, so the entries cannot expire mid-test: the only thing that can
    // make the reads below reach the provider is the invalidation itself.
    freezeAt(T0)

    const provider = new CountingProvider()
    const aggregator = new TransitAggregator([provider])

    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toEqual(['whole-line', 'station 2'])

    // Inside the window both readings come from the cache, so nothing is spent.
    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toHaveLength(2)

    aggregator.invalidateLive(LINE_ID, 0)

    // Both are read again. Dropping only the whole-line key would make the last
    // read a cache hit and leave this list three long.
    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toEqual(['whole-line', 'station 2', 'whole-line', 'station 2'])
  })
})

/**
 * The long-TTL read count for the subway live path.
 *
 * The subway live path resolves its static geometry through `getLineDetail`, so
 * a refresh that dropped that cache would re-read the line from the upstream —
 * quota spent on data that does not change, which F11 rules out.
 *
 * The stub db returns no cached row, so what this suite proves is that the
 * refresh spends no upstream read at all under a frozen clock. It does NOT prove
 * WHICH cache served the reads: the Amap layer keeps its own 24 h line cache
 * (`AmapGisService.getLineByName`), which answers a re-read without any upstream
 * call, so this suite stays green even when `invalidateLive` also drops the
 * aggregator's `detailCache`. The detector for that property is the bus-path test
 * 「drops the per-station readings the home overview uses, not only the whole-line
 * one」, which counts the reads a refresh and a board open spend and fails when
 * the detail cache is dropped.
 */
describe('F11: a refresh never re-reads long-TTL line data', () => {
  const SUBWAY_LINE_ID = 'subway_027_88'

  const subwayLine = {
    id: 'BJ_88',
    name: '地铁88号线',
    type: '地铁线路',
    start_stop: '甲路',
    end_stop: STATION_NAME,
    start_time: '0600',
    end_time: '2200',
    busstops: [
      { id: 's1', name: '甲路', sequence: 1, location: '116.392540,39.924299' },
      { id: 's2', name: STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
    ],
  }

  function stubStaticUpstream(): { urls: string[] } {
    const state = { urls: [] as string[] }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      state.urls.push(String(url))
      // The static read this suite counts. Anything else is a bug here.
      if (String(url).includes('/v3/bus/linename')) return amapOk({ buslines: [subwayLine] })
      return amapOk({})
    }))
    return state
  }

  it('leaves the static line cache intact while dropping the live readings', async () => {
    freezeAt(T0)
    const upstream = stubStaticUpstream()

    const db = {
      getCachedLine: async () => null,
      upsertCachedLine: async () => {},
      getUserSettings: async () => null,
    } as unknown as Database

    const service = new TransitService(db, { amapKey: 'test-key' })
    try {
      const detail = await service.getLineDetail(SUBWAY_LINE_ID, 0, '027')
      expect(detail?.stops.length).toBe(2)
      const staticReads = upstream.urls.length
      expect(staticReads).toBe(1)

      // The cache really is what serves the second read.
      await service.getLineDetail(SUBWAY_LINE_ID, 0, '027')
      expect(upstream.urls.length).toBe(staticReads)

      const outcome = await service.refreshLive({ userId: 'user-a', lines: [target(SUBWAY_LINE_ID)] })

      expect(outcome.outcome).toBe('ok')
      expect(upstream.urls.length).toBe(staticReads)

      // And the reading the refresh produced is the one the live path derived
      // from that same cached detail: nothing was re-fetched to produce it.
      // Its provenance travels with it, because this reading is the engine's
      // own output rather than something a source obtained: `dataSource` names
      // that engine, and F4 marks it 排班推演 from there instead of letting it
      // pass for an obtained reading. `isDegraded` is NOT the field that says
      // this — it is the answering provider's own word that it stood in for
      // another source, and for a `subway_` id the engine is the only source
      // that can answer at all, so it declares false. Deriving it from the
      // provider's position made this line read 「备用来源 · 仅供参考」, which
      // is false: its number comes from the timetable, not from a backup.
      expect(outcome.result.lines).toEqual([
        {
          lineId: SUBWAY_LINE_ID,
          direction: 0,
          lastUpdatedAt: T0_MS,
          dataSource: 'subway_schedule',
          isDegraded: false,
        },
      ])
      expect(outcome.result.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    }
    finally {
      service.stop()
    }
  })
})
