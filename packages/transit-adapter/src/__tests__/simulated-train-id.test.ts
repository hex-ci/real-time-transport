import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveLineStatusSchema } from '@real-time-transport/shared'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
  simulatedTrainId,
} from '../index.js'

/**
 * F-D：本版本读不出的方向，绝不能进入车次 id。
 *
 * 引擎本就把 1 以外的任何方向读作正常站序，所以方向在车次命名处归一化
 * 一次。两半都被钉住：名字本身，以及经引擎得到的整个回答。
 */

/**
 * 把时钟冻结在某个北京上午：用 UTC 构造，使任何时区的 worker 读到同一
 * 小时；该时刻也落在夹具的服务窗口内、模型在线上放得出车 —— 冻结在
 * 一个没有车的时刻会让下面的 id 断言变得空洞。
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
    // 非法方向曾以 `direction: null` 进入载荷；schema 就是「方向是
    // 0..1 的整数」这条契约。
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
