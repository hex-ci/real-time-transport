import { describe, expect, it } from 'vitest'
import { Database } from '../db/client.js'
import type { SubwayTimetableCacheRow } from '@real-time-transport/transit-adapter'

// 没有连接串 → 内存实现，镜像 SQL 的主键与覆盖语义。
const db = new Database()

function row(overrides: Partial<SubwayTimetableCacheRow> = {}): SubwayTimetableCacheRow {
  return {
    cityCode: '027',
    lineId: 'subway_027_7',
    subLineId: 47,
    direction: 1,
    dayType: 'weekend',
    serviceDate: '2026-10-17',
    payload: {
      lineName: '地铁7号线',
      directionName: '开往环球度假区',
      stations: [{ name: '群芳', pStopId: 14711, departures: { 5: [48, 57] } }],
    },
    fetchedAt: Date.now(),
    ...overrides,
  }
}

describe('subway timetable cache: 内存路径', () => {
  it('writes then reads back by the full key', async () => {
    await db.upsertSubwayTimetableLine(row())
    const got = await db.getSubwayTimetableLine('027', 'subway_027_7', 47, 'weekend')
    expect(got?.payload.stations[0]?.name).toBe('群芳')
    expect(got?.direction).toBe(1)
  })

  it('returns null for a key that was never written', async () => {
    expect(await db.getSubwayTimetableLine('027', 'subway_027_7', 46, 'workday')).toBeNull()
  })

  it('overwrites the same primary key instead of adding a row', async () => {
    const first = row({ fetchedAt: 1000 })
    const second = row({
      fetchedAt: 2000,
      payload: { ...first.payload, directionName: '开往环球度假区（新）' },
    })
    await db.upsertSubwayTimetableLine(first)
    await db.upsertSubwayTimetableLine(second)

    const loaded = await db.loadSubwayTimetables('weekend')
    const matches = loaded.filter(item => item.lineId === 'subway_027_7' && item.subLineId === 47)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.fetchedAt).toBe(2000)
    expect(matches[0]!.payload.directionName).toContain('新')
  })

  it('separates directions and day types', async () => {
    await db.upsertSubwayTimetableLine(row({ subLineId: 47, direction: 1, dayType: 'weekend' }))
    await db.upsertSubwayTimetableLine(row({ subLineId: 46, direction: 0, dayType: 'weekend' }))
    await db.upsertSubwayTimetableLine(row({ subLineId: 47, direction: 1, dayType: 'workday' }))

    expect(await db.loadSubwayTimetables('weekend')).toHaveLength(2)
    expect(await db.loadSubwayTimetables('workday')).toHaveLength(1)
  })

  it('lists only rows older than the cutoff', async () => {
    const now = Date.now()
    await db.upsertSubwayTimetableLine(row({ subLineId: 47, fetchedAt: now - 10 * 86400000 }))
    await db.upsertSubwayTimetableLine(row({ subLineId: 46, fetchedAt: now }))

    const expired = await db.listExpiredSubwayTimetables('weekend', now - 7 * 86400000)
    expect(expired.map(item => item.subLineId)).toEqual([47])
  })
})
