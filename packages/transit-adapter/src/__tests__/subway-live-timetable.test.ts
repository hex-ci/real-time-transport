import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AmapGisService,
  StationTimetableService,
  UniversalSubwayEngine,
} from '../index.js'
import type { StationTimetable } from '../station-timetable.js'

const LINE_ID = 'subway_027_7'

function freezeAt(utcIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(utcIso))
}

function timetable(stationName: string, offsetMin: number): StationTimetable {
  return {
    lineId: LINE_ID,
    lineName: '地铁7号线',
    cityCode: '027',
    stationName,
    sourceNote: 'test',
    directions: {
      0: {
        name: '开往北京西站',
        weekend: {
          first: '06:00',
          last: '06:14',
          note: '',
          departures: { 6: [offsetMin] },
        },
      },
    },
  }
}

function stubAmap(withLocations: boolean): void {
  const names = ['群芳', '万盛东', '万盛西', '高楼金', '花庄', '环球度假区', '土桥', '乙站']
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: '1',
      infocode: '10000',
      info: 'OK',
      buslines: [{
        id: 'BJ_7',
        name: '地铁7号线',
        type: '地铁线路',
        start_stop: names[0],
        end_stop: names[names.length - 1],
        busstops: names.map((name, idx) => ({
          id: `s${idx + 1}`,
          name,
          sequence: idx + 1,
          location: withLocations ? `${116.39 + idx * 0.01},${39.92 + idx * 0.01}` : '',
        })),
      }],
    }),
  })))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('subway live: 有精确表时按车次跑，不用 135 秒推演', () => {
  it('06:01 的列车在第二站区间，旅行时间取表里的终点时刻', async () => {
    // 北京 2026-10-17 06:01（周六）
    freezeAt('2026-10-16T22:01:00Z')
    stubAmap(true)
    const timetables = new StationTimetableService([
      timetable('群芳', 0),
      timetable('万盛东', 2),
      timetable('万盛西', 4),
      timetable('高楼金', 6),
      timetable('花庄', 8),
      timetable('环球度假区', 10),
      timetable('土桥', 12),
      timetable('乙站', 14),
    ])
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), timetables)

    const live = await engine.getLiveStatus(LINE_ID, 0, '027')
    expect(live).not.toBeNull()
    expect(live!.buses).toHaveLength(1)
    const bus = live!.buses[0]!
    expect(bus.id).toBe(`train:${LINE_ID}:0:trip:0:21600`)
    expect(bus.order).toBe(1)
    expect(bus.nextOrder).toBe(2)
    // 始发站 06:00 发车，06:02 到下一站：06:01 时在区间一半。
    expect(bus.progress).toBeCloseTo(0.5)
    expect(bus.travelTimeSec).toBe(13 * 60)
    expect(bus.distanceFromStart).toBeGreaterThan(0)
    expect(bus.speed).toBeUndefined()
    expect(bus.schedule).toHaveLength(4)
    expect(bus.schedule![0]).toMatchObject({ order: 1 })
    expect(bus.schedule![1]).toMatchObject({ order: 2 })
    expect(bus.schedule![1]!.arrivalAt - bus.schedule![0]!.arrivalAt).toBe(120 * 1000)
    // 始发时刻即发车，没有额外的 30 秒停站；下一站才有停站。
    expect(bus.schedule![0]!.departureAt - bus.schedule![0]!.arrivalAt).toBe(0)
    expect(bus.schedule![1]!.departureAt - bus.schedule![1]!.arrivalAt).toBe(30 * 1000)
  })

  it('发车前 60 秒在始发站生成车辆，表内时刻直接发车', async () => {
    // 北京 2026-10-17 05:59:30，首班 06:00
    freezeAt('2026-10-16T21:59:30Z')
    stubAmap(true)
    const timetables = new StationTimetableService([
      timetable('群芳', 0),
      timetable('万盛东', 2),
      timetable('万盛西', 4),
      timetable('高楼金', 6),
      timetable('花庄', 8),
      timetable('环球度假区', 10),
      timetable('土桥', 12),
      timetable('乙站', 14),
    ])
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), timetables)

    const live = await engine.getLiveStatus(LINE_ID, 0, '027')
    expect(live!.buses).toHaveLength(1)
    const bus = live!.buses[0]!
    expect(bus.order).toBe(1)
    expect(bus.progress).toBe(0)
    expect(bus.schedule![0]!.departureAt).toBe(bus.schedule![0]!.arrivalAt)
  })

  it('站点没有坐标时不报速度，也不报距离', async () => {
    freezeAt('2026-10-16T22:01:00Z')
    stubAmap(false)
    const timetables = new StationTimetableService([
      timetable('群芳', 0),
      timetable('万盛东', 2),
      timetable('万盛西', 4),
      timetable('高楼金', 6),
      timetable('花庄', 8),
      timetable('环球度假区', 10),
      timetable('土桥', 12),
      timetable('乙站', 14),
    ])
    const engine = new UniversalSubwayEngine(new AmapGisService('test-key'), timetables)

    const live = await engine.getLiveStatus(LINE_ID, 0, '027')
    expect(live!.buses).toHaveLength(1)
    const bus = live!.buses[0]!
    expect(bus.speed).toBeUndefined()
    expect(bus.distanceFromStart).toBeUndefined()
    expect(bus.distanceToWaitStn).toBeUndefined()
    expect(bus.travelTimeSec).toBe(13 * 60)
  })
})
