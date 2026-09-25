import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveLineStatusSchema } from '@real-time-transport/shared'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
  simulatedTrainId,
} from '../index.js'

/**
 * F-D: a direction this build cannot read must not become part of a vehicle id.
 *
 * Observed on the running dev server: `GET /lines/subway_027_7/live?direction=abc`
 * → the HTTP boundary computes `Number('abc')` = NaN, and the generated trains
 * came back as `train_subway_027_7_dNaN_dep118` with `"direction": null` in the
 * payload — NaN, serialized. Those ids are the `busId` of every arrivals row, so a
 * malformed query parameter travelled into the value the UI carries as a
 * vehicle's handle.
 *
 * The engine already reads any direction but 1 as the normal stop order, so the
 * direction is normalized once, where the trains are named. Both halves are
 * pinned: the name itself (no clock needed) and the whole answer through the
 * engine (an id that reached the API, and a `direction` the contract accepts).
 */

/**
 * Freeze the wall clock at 08:00 Beijing on a Thursday. The instant is built from
 * UTC so a worker in another timezone reads the same hour, and 08:00 is inside the
 * fixture's service window with the headway model placing trains on the line —
 * a frozen instant with no train would make the id assertions below vacuous.
 */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubAmap(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    const body = href.includes('/v3/bus/linename')
      ? {
          status: '1',
          infocode: '10000',
          info: 'OK',
          buslines: [{
            id: 'BJ_88',
            name: '地铁88号线',
            type: '地铁线路',
            start_stop: '甲站',
            end_stop: '丙站',
            start_time: '0500',
            end_time: '2300',
            busstops: [
              { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
              { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
              { id: 's3', name: '丙站', sequence: 3, location: '116.405000,39.935000' },
            ],
          }],
        }
      : { status: '1', infocode: '10000', info: 'OK' }
    return { ok: true, status: 200, json: async () => body }
  }))
}

function engine(): UniversalSubwayEngine {
  stubAmap()
  freezeAtBeijingMorning()
  return new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())
}

describe('F-D: the train name carries a stated direction, never the argument', () => {
  it('names a train with direction 0 when the direction is not a number', () => {
    // Exactly what `?direction=abc` produces at the HTTP boundary.
    expect(simulatedTrainId('subway_027_7', Number('abc'), 118))
      .toBe('train_subway_027_7_d0_dep118')
  })

  it('names a train with direction 1 when direction 1 was stated', () => {
    expect(simulatedTrainId('subway_027_7', 1, 7)).toBe('train_subway_027_7_d1_dep7')
  })
})

describe('F-D: no generated id reaches the API carrying a malformed direction', () => {
  it('answers every train with a finite direction in its id', async () => {
    const live = await engine().getLiveStatus('subway_027_88', Number('abc'), '027')

    expect(live, 'the engine answered nothing, so this pin proves nothing').not.toBeNull()
    expect(live!.buses.length).toBeGreaterThan(0)
    for (const bus of live!.buses) {
      expect(bus.id, `id carries a malformed direction: ${bus.id}`).not.toMatch(/NaN|undefined|null/)
      expect(bus.id).toMatch(/^train_subway_027_88_d0_dep\d+$/)
    }
  })

  it('states a direction the wire contract accepts', async () => {
    const live = await engine().getLiveStatus('subway_027_88', Number('abc'), '027')

    expect(live!.direction).toBe(0)
    // NaN reached the payload as `direction: null`; the schema is the contract
    // that says a direction is an integer in 0..1.
    expect(LiveLineStatusSchema.safeParse(live).success).toBe(true)
  })

  it('keeps a real direction, in the id and in the answer', async () => {
    const live = await engine().getLiveStatus('subway_027_88', 1, '027')

    expect(live!.direction).toBe(1)
    expect(live!.buses.length).toBeGreaterThan(0)
    for (const bus of live!.buses) {
      expect(bus.id).toMatch(/^train_subway_027_88_d1_dep\d+$/)
    }
  })
})
