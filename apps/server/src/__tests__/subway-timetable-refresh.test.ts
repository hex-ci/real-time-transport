import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubwayTimetableCacheRow, SubwayTimetableFetcher } from '@real-time-transport/transit-adapter'
import { Database } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'

const LINE = {
  lineId: 'subway_027_7',
  lineName: '地铁7号线',
  cityCode: '027',
}

function rows(fetchedAt: number): SubwayTimetableCacheRow[] {
  const base = {
    cityCode: '027',
    lineId: LINE.lineId,
    dayType: 'workday' as const,
    serviceDate: '2026-10-19',
    payload: {
      lineName: '地铁7号线',
      directionName: '开往环球度假区',
      stations: [{ name: '群芳', pStopId: 14711, departures: { 5: [10] } }],
    },
    fetchedAt,
  }
  return [
    { ...base, subLineId: 47, direction: 1 },
    { ...base, subLineId: 46, direction: 0 },
  ]
}

describe('地铁时刻表 TTL', () => {
  let db: Database
  let service: TransitService
  let fetchLine: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // 2026-10-19（周一）10:00 北京：工作日、不在静默时段。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T02:00:00.000Z'))
    db = new Database()
    await db.addFavorite(LINE)
    fetchLine = vi.fn(async () => rows(Date.now()))
    service = new TransitService(db, {
      pollIntervalSec: 18,
      subwayTimetableFetcher: { fetchLine } as unknown as SubwayTimetableFetcher,
    })
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it('抓一次后，TTL 内重复 ensure 不再发请求', async () => {
    await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
    expect(fetchLine).toHaveBeenCalledTimes(1)
    expect(await db.loadSubwayTimetables('workday')).toHaveLength(2)

    await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
    expect(fetchLine).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 后再次 ensure 才重抓', async () => {
    await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
    expect(fetchLine).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-10-27T02:00:00.000Z'))
    await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
    expect(fetchLine).toHaveBeenCalledTimes(2)
  })

  it('两个方向的行都齐才算新鲜；缺一侧会补抓', async () => {
    await db.upsertSubwayTimetableLine(rows(Date.now())[0]!)
    await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
    expect(fetchLine).toHaveBeenCalledTimes(1)
  })
})

describe('地铁时刻表 TTL：残缺缓存', () => {
  it('残缺行不算新鲜，会触发补抓', async () => {
    const [full, other] = rows(Date.now())
    const partial: SubwayTimetableCacheRow = {
      ...other!,
      payload: {
        ...other!.payload,
        stations: other!.payload.stations.map(station => ({ ...station, departures: {} })),
      },
    }
    const db = new Database()
    await db.addFavorite(LINE)
    const fetchLine = vi.fn(async () => rows(Date.now()))
    const service = new TransitService(db, {
      pollIntervalSec: 18,
      subwayTimetableFetcher: { fetchLine } as unknown as SubwayTimetableFetcher,
    })
    try {
      await db.upsertSubwayTimetableLine(full!)
      await db.upsertSubwayTimetableLine(partial)
      await service.ensureSubwayTimetable(LINE.lineId, LINE.cityCode, LINE.lineName)
      expect(fetchLine).toHaveBeenCalledTimes(1)
    }
    finally {
      service.stop()
    }
  })
})
