import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 016 的文本，按本仓库既有的迁移约定钉住。
 *
 * 这张表是**可丢弃的缓存**，不是权威数据：前向段只建表与索引，不碰用户表；
 * 回滚段只删这张表，删掉不会伤到收藏等真实数据。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

const TABLE = 'subway_timetable_cache'

const DOWN_MARKER = '-- migrate:down'

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^016_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 016_*.sql in migrations/, found: ${JSON.stringify(found)}`)
  }
  return found[0]!
}

const FILE = findMigration()
const RAW = readFileSync(new URL(`../../../../migrations/${FILE}`, import.meta.url), 'utf8')

const markerIndex = RAW.indexOf(DOWN_MARKER)
const FORWARD = markerIndex < 0 ? RAW : RAW.slice(0, markerIndex)
const DOWN = markerIndex < 0 ? null : RAW.slice(markerIndex + DOWN_MARKER.length)

function codeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

const COLUMNS = [
  'city_code',
  'line_id',
  'sub_line_id',
  'direction',
  'day_type',
  'service_date',
  'payload',
  'fetched_at',
]

describe('016：地铁时刻表缓存（线路 × 方向 × 日型）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^016_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当前最新的一步', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe(FILE)
  })

  it('前向段建的是这张缓存表，列齐全', () => {
    const forward = codeOf(FORWARD)
    expect(forward).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${TABLE}\\b`, 'i'))
    for (const column of COLUMNS) {
      expect(forward, `missing column ${column}`).toContain(column)
    }
    expect(forward).toMatch(/PRIMARY\s+KEY\s*\([^)]*city_code[^)]*line_id[^)]*sub_line_id[^)]*day_type[^)]*\)/i)
  })

  it('刷新扫描有索引，且前向段不碰别的表', () => {
    const forward = codeOf(FORWARD)
    expect(forward).toMatch(new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+\\w+[^;]*${TABLE}\\s*\\(day_type,\\s*fetched_at\\)`, 'i'))

    const created = [...new Set(
      [...forward.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map(match => match[1]),
    )]
    expect(created).toEqual([TABLE])
    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'ALTER']) {
      expect(forward, `the forward section touches data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
  })

  it('回滚段只删这张缓存表', () => {
    const down = codeOf(DOWN!)
    const dropped = [...new Set(
      [...down.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+(\w+)/gi)].map(match => match[1]),
    )]
    expect(dropped).toEqual([TABLE])
  })
})
