import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../../db/client.js'
import type { SubwayTimetableCacheRow } from '@real-time-transport/transit-adapter'
import { createApiHarness, resolveTestDatabaseUrl, type ApiHarness } from './support/api-harness.js'

/**
 * 016 的 SQL 路径：内存用例只能证明形状，这里证明 JSONB、主键覆盖与
 * 「按日型/按线路/按过期时间」三种取法真的落在 Postgres 上。
 */

let api: ApiHarness
let db: Database

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
    fetchedAt: Date.UTC(2026, 9, 17, 12, 0),
    ...overrides,
  }
}

beforeEach(async () => {
  api = await createApiHarness({ store: 'sql' })
  db = new Database(resolveTestDatabaseUrl())
  await db.init()
})

afterEach(async () => {
  await db?.close()
  await api?.close()
})

describe('subway_timetable_cache · SQL', () => {
  it('round-trips the JSONB payload', async () => {
    await db.upsertSubwayTimetableLine(row())

    const stored = await api.rows<{ payload: SubwayTimetableCacheRow['payload'] }>(
      'SELECT payload FROM subway_timetable_cache WHERE line_id = $1',
      ['subway_027_7'],
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.payload.stations[0]!.departures).toEqual({ 5: [48, 57] })

    const loaded = await db.loadSubwayTimetables('weekend')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.fetchedAt).toBe(row().fetchedAt)
    expect(loaded[0]!.serviceDate).toBe('2026-10-17')
  })

  it('overwrites the same (city, line, subLine, dayType) key', async () => {
    await db.upsertSubwayTimetableLine(row({ fetchedAt: 1000 }))
    await db.upsertSubwayTimetableLine(row({
      fetchedAt: 2000,
      payload: { ...row().payload, directionName: '开往环球度假区（新）' },
    }))

    const stored = await api.rows<{ count: string }>(
      'SELECT count(*)::text AS count FROM subway_timetable_cache',
    )
    expect(stored[0]!.count).toBe('1')

    const loaded = await db.getSubwayTimetableLine('027', 'subway_027_7', 47, 'weekend')
    expect(loaded?.fetchedAt).toBe(2000)
    expect(loaded?.payload.directionName).toContain('新')
  })

  it('filters expired rows and lines separately', async () => {
    const now = Date.now()
    await db.upsertSubwayTimetableLine(row({ subLineId: 47, fetchedAt: now - 10 * 86400000 }))
    await db.upsertSubwayTimetableLine(row({ subLineId: 46, direction: 0, fetchedAt: now }))
    await db.upsertSubwayTimetableLine(row({ lineId: 'subway_027_1', subLineId: 2, fetchedAt: now }))

    const expired = await db.listExpiredSubwayTimetables('weekend', now - 7 * 86400000)
    expect(expired.map(item => item.subLineId)).toEqual([47])

    const line = await db.loadSubwayTimetablesForLine('subway_027_7')
    expect(line.map(item => item.subLineId).sort()).toEqual([46, 47])
  })
})
