import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmapGisService } from '../index.js'
import { WALK_ETA_MAX_ENTRIES } from '../services/amap-gis.service.js'

/**
 * GCJ-02 coordinates — the app's normalized system and what this service sends
 * upstream (the conversion happens at the HTTP boundary, see
 * `amap-gis-coordinate-contract.test.ts`): a user anchor, and a stop ~2 km away.
 */
const ANCHOR = { lng: 116.403640, lat: 39.910710 }
const STOP = { lng: 116.392540, lat: 39.924299 }

const PRICED = { distanceMeters: 540, durationSeconds: 420 }

type Upstream = 'route' | 'network-error' | 'qps-limit' | 'no-route'

let reply: Upstream = 'route'

/** Wall clock the service reads: a poll moves it on, so TTLs can be crossed. */
let clock = 0

/**
 * Counted stand-in for the Amap upstream. Tests assert the CALL COUNT, not only
 * equal return values, so a cache cannot pass by accident.
 */
function stubUpstream(): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url))
    if (reply === 'network-error') throw new Error('socket hang up')
    if (reply === 'qps-limit') {
      return { ok: true, status: 200, json: async () => ({ status: '0', infocode: '10014', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }) }
    }
    if (reply === 'no-route') {
      return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [{ distance: '540', duration: '420' }] } }) }
  }))
  return urls
}

/** One home-screen poll for a single anchor/stop pair. */
function poll(amap: AmapGisService, anchor = ANCHOR, stop = STOP) {
  clock += 1000
  return amap.getWalkingEta(anchor.lng, anchor.lat, stop.lng, stop.lat)
}

beforeEach(() => {
  reply = 'route'
  clock = Date.UTC(2026, 0, 1)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AmapGisService.getWalkingEta caching', () => {
  it('prices a repeated (anchor, stop) leg upstream once', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const first = await poll(amap)
    const second = await poll(amap)
    const third = await poll(amap)

    expect(first).toEqual(PRICED)
    expect(second).toEqual(PRICED)
    expect(third).toEqual(PRICED)
    expect(urls).toHaveLength(1)
  })

  it('sends the given GCJ-02 pair upstream unchanged', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)

    const params = new URL(urls[0]!).searchParams
    expect(params.get('origin')).toBe(`${ANCHOR.lng.toFixed(6)},${ANCHOR.lat.toFixed(6)}`)
    expect(params.get('destination')).toBe(`${STOP.lng.toFixed(6)},${STOP.lat.toFixed(6)}`)
  })

  it('shares one entry for anchors inside the same ~1 m upstream cell', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    // ~0.4 m east: both anchors land in the same 5-decimal cell, so drifting GPS
    // inside one cell is served rather than re-priced. (A 5-decimal cell is ~1 m
    // wide, so an equally small change can also cross a boundary and cost a
    // fresh price.)
    await poll(amap, { lng: ANCHOR.lng + 0.000004, lat: ANCHOR.lat })
    expect(urls).toHaveLength(1)

    // Another cell, then another stop: neither may reuse the entry...
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    await poll(amap, ANCHOR, { lng: STOP.lng + 0.0001, lat: STOP.lat })
    expect(urls).toHaveLength(3)

    // ...and each of those keeps its own entry.
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    await poll(amap, ANCHOR, { lng: STOP.lng + 0.0001, lat: STOP.lat })
    expect(urls).toHaveLength(3)
  })

  it('serves the last known good leg when upstream fails after the entry expires', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'network-error'
    const afterFailure = await poll(amap)

    // It did retry upstream, so this is the fallback and not a fresh hit.
    expect(urls).toHaveLength(2)
    expect(afterFailure).toEqual(good)
  })

  it('serves the last known good leg when upstream refuses on QPS or quota', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'qps-limit'
    const afterThrottle = await poll(amap)

    expect(urls).toHaveLength(2)
    expect(afterThrottle).toEqual(good)
  })

  it('reports no leg rather than a guessed one when upstream fails with nothing cached', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')
    reply = 'network-error'

    await expect(poll(amap)).resolves.toBeNull()
    expect(urls).toHaveLength(1)
  })

  it('reports no leg when upstream answers that no route exists, even with a stale entry', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'no-route'

    // A valid "no walking route" answer is the current truth: a day-old leg for
    // a route that no longer exists must not be served in its place.
    await expect(poll(amap)).resolves.toBeNull()
    expect(urls).toHaveLength(2)
  })

  it('drops expired entries on demand', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    expect(amap.clearExpired()).toBe(0)

    clock += 24 * 3600 * 1000
    expect(amap.clearExpired()).toBe(2)
    expect(amap.clearExpired()).toBe(0)
  })

  it('caps the cache so a drifting fix cannot grow it without bound', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    // 110 m apart, as a moving user's fixes are: a distinct key every poll.
    for (let i = 0; i <= WALK_ETA_MAX_ENTRIES; i++) {
      await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + i * 0.001 })
    }
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 1)

    // The oldest anchor was shed to make room, so it is priced again...
    await poll(amap, ANCHOR)
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 2)

    // ...while the newest one is still served from the cache.
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + WALK_ETA_MAX_ENTRIES * 0.001 })
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 2)
  })
})

describe('AmapGisService.getWalkingEta: a path the payload does not price is no route', () => {
  /**
   * Answers the walking request with ONE `route.paths[0]`, spelled the way the
   * upstream spells it — both numbers as strings. A real route carries a price on
   * both axes; a path missing either one states no price this app can use, and
   * `0` (a number the upstream CAN state: two coincident points are priced at one
   * second) is not a stand-in for it.
   */
  function pathReply(path: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [path] } }),
    })))
  }

  /** One priced request against a FRESH service, so no cached entry can answer for it. */
  function pollOnce(): Promise<Awaited<ReturnType<AmapGisService['getWalkingEta']>>> {
    clock += 1000
    return new AmapGisService('test-key').getWalkingEta(ANCHOR.lng, ANCHOR.lat, STOP.lng, STOP.lat)
  }

  it('reads a price the payload states on both axes, including zero', async () => {
    pathReply({ distance: '0', duration: '1' })
    await expect(pollOnce()).resolves.toEqual({ distanceMeters: 0, durationSeconds: 1 })
  })

  it('keeps a zero DURATION priced: two coincident points are a legal 0-second walk', async () => {
    // The other half of 「zero is a number the payload can state」. A distance of
    // 0 is a real coincidence of the two points, and so is a duration of 0 — so
    // the priced-zero branch is pinned on BOTH axes. Reading a stated 0 as 「no
    // price」 would drop a legal walk, exactly as inventing one for a missing
    // value would.
    pathReply({ distance: '540', duration: '0' })
    await expect(pollOnce()).resolves.toEqual({ distanceMeters: 540, durationSeconds: 0 })
  })

  it('reports no route when the payload states no duration', async () => {
    pathReply({ distance: '540' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states an empty duration', async () => {
    pathReply({ distance: '540', duration: '' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states a non-numeric duration', async () => {
    // A field the payload CARRIED but did not spell as a number is still no
    // price: `Number('abc')` is NaN, and NaN printed as a walk time is worse than
    // an absent route.
    pathReply({ distance: '540', duration: 'abc' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states no distance', async () => {
    pathReply({ duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states an empty distance', async () => {
    pathReply({ distance: '', duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states a non-numeric distance', async () => {
    pathReply({ distance: 'abc', duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })
})
