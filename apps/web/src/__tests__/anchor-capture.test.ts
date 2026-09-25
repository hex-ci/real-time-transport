import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { UpdateSettingsSchema } from '@real-time-transport/shared'

/**
 * The anchor grab, on the browser side of the boundary.
 *
 * A stored anchor is GCJ-02 and the server's `/settings` PATCH owns the one
 * conversion, so the only correct thing for this side to do with a
 * `navigator.geolocation` fix (WGS-84) is to hand it over untouched. These
 * tests hold that, and hold that the grab is ONE-SHOT: an anchor is captured
 * once when the user taps, never followed as a live position stream — that
 * stream is a different thing the store already owns, and confusing the two
 * would let an anchor drift as the user walks.
 */

/** The raw fix the test device reports, in WGS-84. */
const BROWSER_FIX = { latitude: 39.90931, longitude: 116.3974, accuracy: 12 }

/**
 * The same point in GCJ-02, from this repo's own `wgs84ToGcj02` — the value a
 * browser-side conversion would produce and which must therefore NEVER be what
 * this path returns.
 */
const GCJ02_OF_BROWSER_FIX = { lat: 39.910714, lng: 116.403644 }

/** A `GeolocationPositionError`-shaped rejection. */
function positionError(code: number) {
  return { code, message: 'test', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }
}

/**
 * Install a fake `navigator.geolocation`. Both entry points are recorded, so a
 * test can prove which one the capture used.
 */
function stubGeolocation(outcome: { position: unknown } | { error: { code: number } } | 'none') {
  const getCurrentPosition = vi.fn((success: (p: unknown) => void, failure: (e: unknown) => void) => {
    if (outcome === 'none') return
    if ('position' in outcome) success(outcome.position)
    else failure(outcome.error)
  })
  const watchPosition = vi.fn()
  vi.stubGlobal('navigator', outcome === 'none' ? {} : { geolocation: { getCurrentPosition, watchPosition } })
  return { getCurrentPosition, watchPosition }
}

/**
 * Load a store module under a PINNED GPS-override environment.
 *
 * The module decides at import time whether `VITE_GPS_SIMULATION` stands in for
 * the device, and a checkout may legitimately have it on in `.env` — so a test
 * that needs the device path has to say so, and one that needs the override has
 * to set it, rather than inheriting whatever the shell happens to hold.
 */
async function freshStore(env: Record<string, string> = {}) {
  vi.stubEnv('VITE_GPS_SIMULATION', 'false')
  vi.stubEnv('VITE_GPS_SIM_LAT', '')
  vi.stubEnv('VITE_GPS_SIM_LNG', '')
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  const { useLocationStore } = await import('../stores/location.store')
  return useLocationStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the anchor grab hands the server a raw WGS-84 fix', () => {
  it('returns the fix exactly as the browser reported it, converted by nobody', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX, timestamp: Date.now() } })
    const store = await freshStore()

    const fix = await store.captureAnchorFix()

    expect(fix).toEqual({ lat: BROWSER_FIX.latitude, lng: BROWSER_FIX.longitude, accuracyM: BROWSER_FIX.accuracy })
    // The browser converted nothing: a WGS-84 -> GCJ-02 shift here would be
    // applied a second time by the server, moving the anchor ~500 m and
    // inverting the 出门结论 against its 3-minute wait tolerance.
    expect(fix.lat).not.toBe(GCJ02_OF_BROWSER_FIX.lat)
    expect(fix.lng).not.toBe(GCJ02_OF_BROWSER_FIX.lng)
  })

  it('asks for one position and never opens a stream', async () => {
    const { getCurrentPosition, watchPosition } = stubGeolocation({
      position: { coords: BROWSER_FIX, timestamp: Date.now() },
    })
    const store = await freshStore()

    await store.captureAnchorFix()

    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    // The live position stays the live position: `watchPosition` is the store's
    // other job and this path must not start, or stop, it.
    expect(watchPosition).not.toHaveBeenCalled()
  })

  it('reports no accuracy rather than a fabricated one when the device omits it', async () => {
    stubGeolocation({ position: { coords: { latitude: BROWSER_FIX.latitude, longitude: BROWSER_FIX.longitude } } })
    const store = await freshStore()

    expect((await store.captureAnchorFix()).accuracyM).toBeNull()
  })

  it('is not a simulated fix while the override is off', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX, timestamp: Date.now() } })
    const store = await freshStore()

    expect(store.isSimulated).toBe(false)
  })
})

describe('a failed grab says the departure time is unavailable', () => {
  it('names the permission and the departure time when location access is denied', async () => {
    stubGeolocation({ error: positionError(1) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('权限')
    // Step 3: never fail silently — the copy states WHY it matters.
    expect((err as Error).message).toContain('出门时间')
  })

  it('names the timeout and the departure time when no fix arrives in time', async () => {
    stubGeolocation({ error: positionError(3) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('超时')
    expect((err as Error).message).toContain('出门时间')
  })

  it('reports an unavailable position instead of resolving a stale one', async () => {
    stubGeolocation({ error: positionError(2) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('出门时间')
  })

  it('reports an unsupported browser instead of failing silently', async () => {
    stubGeolocation('none')
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('出门时间')
  })

  it('clears the in-flight flag after a failure, so the button is usable again', async () => {
    stubGeolocation({ error: positionError(2) })
    const store = await freshStore()

    await store.captureAnchorFix().catch(() => null)

    expect(store.isCapturingAnchor).toBe(false)
  })
})

describe('VITE_GPS_SIMULATION stands in for the device fix', () => {
  it('returns the fixed development position, touches no device, and says so', async () => {
    const { getCurrentPosition } = stubGeolocation({ position: { coords: BROWSER_FIX } })
    const store = await freshStore({
      VITE_GPS_SIMULATION: 'true',
      VITE_GPS_SIM_LAT: '39.90931',
      VITE_GPS_SIM_LNG: '116.3974',
    })

    const fix = await store.captureAnchorFix()

    expect(fix).toEqual({ lat: 39.90931, lng: 116.3974, accuracyM: null })
    expect(getCurrentPosition).not.toHaveBeenCalled()
    // The marker the page must show: a simulated fix is never dressed as real.
    expect(store.isSimulated).toBe(true)
  })

  it('requires both simulated coordinates, so a half-configured pair is not a fix', async () => {
    const { getCurrentPosition } = stubGeolocation({ position: { coords: BROWSER_FIX } })
    // An empty longitude is the half-configured case: `Number('')` is 0, which
    // would otherwise be stored as a real (if absurd) longitude.
    const store = await freshStore({ VITE_GPS_SIMULATION: 'true', VITE_GPS_SIM_LAT: '39.90931', VITE_GPS_SIM_LNG: '' })

    const fix = await store.captureAnchorFix()

    expect(store.isSimulated).toBe(false)
    expect(fix.lat).toBe(BROWSER_FIX.latitude)
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
  })

  it('stays off entirely when the flag is not set', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX } })
    const store = await freshStore({ VITE_GPS_SIM_LAT: '39.90931', VITE_GPS_SIM_LNG: '116.3974' })

    expect(store.isSimulated).toBe(false)
    expect((await store.captureAnchorFix()).lat).toBe(BROWSER_FIX.latitude)
  })
})

describe('the browser side of the anchor path converts nothing', () => {
  /**
   * Source with comments stripped, so a comment may STATE the rule (this file's
   * own prose does) without tripping a guard that is about executable code.
   */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  function source(file: string): string {
    return stripComments(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'))
  }

  it('carries no coordinate conversion in the picker or the store', () => {
    // The one conversion lives in the server's `/settings` PATCH. A converter
    // reachable from here would shift a fix the server shifts again — the
    // double conversion that inflated a 1.2 km walking leg to 2.7 km.
    for (const file of ['stores/location.store.ts', 'views/settings/components/anchor-picker.vue']) {
      expect(source(file), `${file} can convert a coordinate in the browser`)
        .not.toMatch(/wgs84ToGcj02|gcj02ToWgs84|transit-adapter/)
    }
  })

  it('sends each anchor under the contract\'s own field names', () => {
    // The picker names the wire fields in `latKey`/`lngKey`, so those names ARE
    // the request body: a rename in the contract that missed this file would
    // PATCH fields the endpoint does not accept and silently store nothing.
    const picker = source('views/settings/components/anchor-picker.vue')
    for (const key of ['homeLat', 'homeLng', 'workLat', 'workLng']) {
      expect(picker, `${key} is missing from the picker`).toContain(key)
      expect(UpdateSettingsSchema.safeParse({ [key]: 39.90931 }).success, key).toBe(true)
    }
  })

  it('labels a simulated grab with a marker of its own, not the vehicle one', () => {
    const picker = source('views/settings/components/anchor-picker.vue')
    // The GPS override is a different kind of simulation from the line/vehicle
    // one, so it gets its own attribute and its own wording.
    expect(picker).toMatch(/data-anchor-gps-simulation/)
    expect(picker).not.toMatch(/data-simulation-banner/)
    expect(picker).toContain('模拟定位')
  })
})
