import { describe, expect, it, vi } from 'vitest'
import { ChelaileProvider } from '../providers/chelaile.js'

/**
 * F-A：上游自己给出的 0 是事实，不是缺值。`?order=N` 时源对每辆车给出
 * `travels: [{ order: N, travelTime }]`，车辆停在站台上时报的是
 * `travelTime 0`。
 *
 * 断言针对 provider 交出的值：0 原样通过，负哨兵（车来了的
 * 「已过目标站」）不通过。
 */

function providerAnswering(payload: Record<string, unknown>): ChelaileProvider {
  const provider = new ChelaileProvider()
  const internals = provider as unknown as {
    request: (endpoint: string, params: Record<string, string>) => Promise<unknown>
  }
  vi.spyOn(internals, 'request').mockResolvedValue(payload)
  return provider
}

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
    // -1 是车来了的「已过目标站」，不是时长：只有非负的时长才算行程时间。
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
