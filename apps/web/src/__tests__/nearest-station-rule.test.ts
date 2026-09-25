import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { haversineMeters } from '@real-time-transport/shared/geo'
import type { Station } from '@real-time-transport/shared'

/**
 * The nearest stop a line has to the user's fix — and the rule that decides
 * which stops may be measured at all.
 *
 * A stop is a candidate only for a position the payload actually stated. A zero
 * on either axis is the ABSENCE of a coordinate on this app's GCJ-02 datum (no
 * placed stop sits at 0), so measuring from one would price a walk to a point in
 * the Atlantic and make an unplaced platform the nearest thing to the user. That
 * rule lives ONCE, in `statedCoordinate`, and this file holds both halves of
 * using it here: the store reads its coordinates through it, and the answers that
 * follow are the honest ones — a nearest stop when one is placed, and NONE when
 * none is, rather than a fallback to the first stop in the list.
 */

/** The fix the tests stand at, via the store's own development override. */
const FIX = { lat: 39.9, lng: 116.4 }

/** A stop of the line on screen, with no position at all unless one is given. */
function stop(id: string, name: string, lat?: number, lng?: number): Station {
  const s: Station = { id, name, order: 1, interchanges: [] }
  if (lat !== undefined) s.lat = lat
  if (lng !== undefined) s.lng = lng
  return s
}

/**
 * Load the store under a PINNED GPS-override environment.
 *
 * `VITE_GPS_SIMULATION` is the store's own stand-in for a device fix, so the
 * nearest-stop computation can be exercised without a browser; the module reads
 * the flag at import time, hence the pinned env and the fresh module registry.
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

/** A store tracking the fixed development position. */
function storeAtFix(over: Record<string, string> = {}) {
  return freshStore({
    VITE_GPS_SIMULATION: 'true',
    VITE_GPS_SIM_LAT: String(FIX.lat),
    VITE_GPS_SIM_LNG: String(FIX.lng),
    ...over,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the nearest stop is chosen from the stops that state a position', () => {
  it('picks the placed stop nearest the fix, in metres', async () => {
    const store = await storeAtFix()
    const near = stop('s2', '乙站', FIX.lat, 116.41)
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.5), near])

    expect(store.nearestStation?.id).toBe('s2')
    // The app's own definition of the distance, plus a bound derived from the
    // geometry so the number is checked and not merely re-computed: 0.01° of
    // longitude at 39.9°N is 1113.2 m/° × cos(39.9°) ≈ 854 m.
    expect(store.nearestDistanceM).toBe(Math.round(haversineMeters(FIX.lat, FIX.lng, near.lat!, near.lng!)))
    expect(store.nearestDistanceM).toBeGreaterThan(840)
    expect(store.nearestDistanceM).toBeLessThan(870)
  })

  it('reports NO nearest stop when no stop of the line states a position', async () => {
    const store = await storeAtFix()
    // Neither stop may be measured: the first states no coordinate, the second
    // states a zero — the same absence on this datum, and not a point at (0, 0).
    // A store that measured either one would answer with the nearer-looking of
    // them and present an unplaced platform as the nearest thing to the user.
    store.updateNearestStation([stop('s1', '甲站'), stop('s2', '乙站', 0, 0)])

    expect(store.nearestStation).toBeNull()
    expect(store.nearestDistanceM).toBeNull()
  })

  it('reports nothing at all before a fix exists, whatever the pool holds', async () => {
    // No fix: there is nothing to measure FROM, so the answer is none rather than
    // a stop measured against nowhere.
    const store = await freshStore()
    store.updateNearestStation([stop('s1', '甲站', FIX.lat, 116.41)])

    expect(store.nearestStation).toBeNull()
    expect(store.nearestDistanceM).toBeNull()
  })
})

describe('the coordinate rule is READ here, not spelled again', () => {
  /** Source with comments stripped: this file's prose may state the rule. */
  function source(file: string): string {
    return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('routes the store\'s stop reads through the shared helper', () => {
    const store = source('stores/location.store.ts')
    // `!st.lat || !st.lng` is the rule re-written by hand: a second copy that can
    // drift from `statedCoordinate`, which is where every other read of an
    // upstream coordinate in this app gets its answer.
    expect(store, 'the store spells the zero-is-not-a-position rule itself')
      .not.toMatch(/!st\.(lat|lng)/)
    expect(store, 'the store does not read a stop coordinate through the shared rule')
      .toContain('statedCoordinate(')
  })
})
