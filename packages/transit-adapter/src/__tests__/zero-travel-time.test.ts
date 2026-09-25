import { describe, expect, it, vi } from 'vitest'
import { ChelaileProvider } from '../providers/chelaile.js'

/**
 * F-A: the upstream's own ZERO is a fact, not an absence.
 *
 * A target-ordered read (`?order=N`) makes chelaile answer, for each vehicle,
 * `travels: [{ order: N, travelTime }]` — the source's own seconds-to-that-stop.
 * When the vehicle is STANDING at the platform the source reports `travelTime 0`
 * (observed alongside `distanceToWaitStn 0` and `speed` ~0). The mapping used to
 * keep only `travelTime > 0`, so that fact was discarded at the provider and the
 * row fell through to this app's own position/dwell estimate, which prints a
 * minute (「3 分」 on the reported reproduction) for a bus at the platform.
 *
 * The assertion is on the VALUE the provider hands on: zero travels through, and
 * a negative sentinel does not (chelaile uses -1 for 「已过目标站」, which is not
 * an arrival time).
 */

/**
 * Drive the provider without a network: `request` is the only door it fetches
 * through, and a payload with no `jxPath` leaves the road-geometry lookup with
 * nothing to fetch (it negative-caches and returns null).
 */
function providerAnswering(payload: Record<string, unknown>): ChelaileProvider {
  const provider = new ChelaileProvider()
  const internals = provider as unknown as {
    request: (endpoint: string, params: Record<string, string>) => Promise<unknown>
  }
  vi.spyOn(internals, 'request').mockResolvedValue(payload)
  return provider
}

/** One chelaile bus row, with the fields the mapping reads. */
function bus(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    busId: 'B1',
    order: 31,
    speed: 0,
    distanceToWaitStn: 0,
    lat: 39.9,
    lng: 116.4,
    ...partial,
  }
}

function payload(travelTime: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    line: { name: '1', direction: 0, firstTime: '05:00', lastTime: '22:40' },
    stations: [
      { sId: 's1', sn: '甲站', order: 1, lat: '39.90', lng: '116.40' },
      { sId: 's2', sn: '乙站', order: 2, lat: '39.91', lng: '116.41' },
    ],
    buses: [bus({ travels: [{ order: 2, travelTime }], ...overrides })],
  }
}

describe('F-A: a vehicle at the platform is reported as being there, not as a minute', () => {
  it('carries an upstream travelTime of exactly 0 through to the vehicle', async () => {
    const provider = providerAnswering(payload(0))
    const status = await provider.getLiveStatus('010-1-0', 0, '010', { targetOrder: 2 })

    expect(status).not.toBeNull()
    expect(status!.buses[0]!.travelTimeSec).toBe(0)
  })

  it('still carries a positive travel time, the source\'s own minute', async () => {
    const provider = providerAnswering(payload(270))
    const status = await provider.getLiveStatus('010-1-0', 0, '010', { targetOrder: 2 })

    expect(status!.buses[0]!.travelTimeSec).toBe(270)
  })

  it('never turns the past-station sentinel into an arrival time', async () => {
    // -1 is chelaile's 「已过目标站」, not a duration: only a non-negative
    // duration is a travel time at all.
    const provider = providerAnswering(payload(-1))
    const status = await provider.getLiveStatus('010-1-0', 0, '010', { targetOrder: 2 })

    expect(status!.buses[0]!.travelTimeSec).toBeUndefined()
  })

  it('states no travel time for a vehicle the payload gave none for', async () => {
    const provider = providerAnswering(payload(0, { travels: [] }))
    const status = await provider.getLiveStatus('010-1-0', 0, '010', { targetOrder: 2 })

    expect(status!.buses[0]!.travelTimeSec).toBeUndefined()
  })
})
