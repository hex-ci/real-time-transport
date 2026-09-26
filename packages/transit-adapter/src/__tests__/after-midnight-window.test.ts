import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
  serviceWindowSeconds,
} from '../index.js'

/**
 * G2：运营日不从 00:00 开始，所以跨 0 点的末班属于下一个日历日。
 *
 * `parseHm` 把「H:MM」读成日历日秒数，而引擎拿来比较的时钟跑的是
 * 00:00–28:00（`currentSecOfDay` 把 00:00–03:59 平移 +24h，与
 * `@real-time-transport/shared` 的 `operatingDaySecondsOf` 画的是同一条
 * 04:00 边界）。末班早于首班的窗口因此需要整体前移一天。
 *
 * 两个方向都钉住：末班早于首班的窗口前移一天，05:16–23:06 这样的窗口
 * 一动不动。最后一个用例在 00:10 让引擎跑真实的转录表。
 */

function freezeAtBeijing(utcIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(utcIso))
}

const AFTER_MIDNIGHT = '2026-09-23T16:10:00Z'

const LINE_ID = 'subway_027_7'

/**
 * 站点表包含已发布表覆盖的那一站，使引擎读到真实转录的时刻。八站之长
 * 是每条推演断言都需要长度的同一个原因：两站的运行时间短于发车间隔，
 * 而跨 0 点存在线路上没有车的分钟 —— 对一个空列表的断言什么都证明不了。
 */
function stubAmap(): void {
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
            start_stop: stops[0]![0],
            end_stop: stops[stops.length - 1]![0],
            // 没有 start_time / end_time：上游不知道，所以服务时间
            // 来自线路自己发布的时刻表。
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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('G2: an after-midnight last departure lands on the 24h+ timeline', () => {
  it('moves a last time that precedes the first a day forward', () => {
    expect(serviceWindowSeconds('05:48', '00:16')).toEqual({
      first: 5 * 3600 + 48 * 60,
      last: 24 * 3600 + 16 * 60,
    })
  })

  it('leaves a window that already ends after its start exactly as read', () => {
    expect(serviceWindowSeconds('05:16', '23:06')).toEqual({
      first: 5 * 3600 + 16 * 60,
      last: 23 * 3600 + 6 * 60,
    })
  })

  it('still stands in the simulation window when neither time is stated', () => {
    // 兜底值是模拟参数，不是可上报的事实：时间缺失时必须枚举出
    // 与以往相同的发车。
    expect(serviceWindowSeconds('', '')).toEqual({
      first: 5 * 3600 + 30 * 60,
      last: 23 * 3600,
    })
  })
})

describe('G2: the direction whose last departure is after midnight runs a coherent window', () => {
  it('answers with trains at 00:10 for direction 1, whose table ends at 00:16', async () => {
    stubAmap()
    freezeAtBeijing(AFTER_MIDNIGHT)
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const live = await engine.getLiveStatus(LINE_ID, 1, '027')

    expect(live, 'the engine answered nothing at all').not.toBeNull()
    expect(live!.buses.length, 'direction 1 answered an empty board at 00:10').toBeGreaterThan(0)
    for (const bus of live!.buses) {
      expect(bus.id).toMatch(new RegExp(`^train_${LINE_ID}_d1_dep\\d+$`))
    }
  })

  it('still answers with no train at 00:10 for direction 0, whose day ended at 23:06', async () => {
    // 对「末班本就晚于首班」的窗口，平移绝不能触发：若把同日窗口
    // 整体推后一天，这个方向会在末班几小时之后仍报出车。
    stubAmap()
    freezeAtBeijing(AFTER_MIDNIGHT)
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), new StationTimetableService())

    const live = await engine.getLiveStatus(LINE_ID, 0, '027')

    expect(live, 'the engine answered nothing at all').not.toBeNull()
    expect(live!.buses).toEqual([])
  })
})
