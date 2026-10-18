import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 015 的文本，按本仓库既有的迁移约定钉住。
 *
 * 本套件钉的是**文件文本本身** —— 它加了哪几列、可空无默认值、前向段不改写数据、
 * 回滚段存在且按运行器判据不属破坏性 —— 而不是「这条 SQL 跑起来的效果」。
 *
 * 文本层面的规则（对应 015 的意图）：
 *
 *  - 前向段给 `user_favorite_lines` 加四列：两个方向各一对 (站名, 站序)。
 *    站的身份是 (站名, 站序) 一对（010 的先例），上下行站名经常不同、环线还有同名多站，
 *    故按方向各存一对，而不是只存一个名字；
 *  - 四列都可空、无默认值、无 CHECK：没设过关注站是合法状态（回退链跳过它），
 *    而默认值会把「没设过」说成「设过这一站」——那是替数据做主；
 *  - 前向段不改写任何数据，也不碰别的表；
 *  - 回滚段在，且**按运行器自己的判据不属破坏性**：操作者可回滚而不必确认丢数据 ——
 *    判据是 `migrate.ts` 里那条正则，且它作用在**含注释**的回滚段原文上。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

const TABLE = 'user_favorite_lines'

/** 两列站名、两列站序：方向 0 与方向 1 各一对。 */
const COLUMNS: Record<string, 'TEXT' | 'INTEGER'> = {
  followed_station_name_0: 'TEXT',
  followed_station_order_0: 'INTEGER',
  followed_station_name_1: 'TEXT',
  followed_station_order_1: 'INTEGER',
}

const DOWN_MARKER = '-- migrate:down'

/**
 * 运行器的破坏性判据，逐字照抄 `apps/server/src/db/migrate.ts` 的 `DESTRUCTIVE_SQL`。
 */
const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b[^;]*/gi

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^015_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 015_*.sql in migrations/, found: ${JSON.stringify(found)}`)
  }
  return found[0]!
}

const FILE = findMigration()
const RAW = readFileSync(new URL(`../../../../migrations/${FILE}`, import.meta.url), 'utf8')

const markerIndex = RAW.indexOf(DOWN_MARKER)
const FORWARD = markerIndex < 0 ? RAW : RAW.slice(0, markerIndex)
const DOWN = markerIndex < 0 ? null : RAW.slice(markerIndex + DOWN_MARKER.length)

/** 去掉注释的 SQL，免得关于语句的叙述被当成语句读。 */
function codeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/** 前向段里 `ADD COLUMN` 过的列名，按出现顺序。 */
function addedColumns(sql: string): string[] {
  return [...sql.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map(match => match[1]!)
}

/** 某一列自己那一段 `ADD COLUMN` 子句（到逗号或分号为止），或 null。 */
function addColumnClause(sql: string, column: string): string | null {
  return sql.match(new RegExp(`ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\b[^,;]*`, 'i'))?.[0] ?? null
}

describe('015：关注线路记下两个方向的关注站（与时段无关的常规实时公交锚点）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^015_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('曾经是当前最新的一步：016 在它之后，是它让出了这个位置', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe('016_subway_timetable_cache.sql')
    expect(files[files.length - 2]).toBe(FILE)
  })

  it('前向段加的就是那四列：两个方向各一对 (站名, 站序)', () => {
    const forward = codeOf(FORWARD)
    // 名字精确相等：少一列是回退链少一个方向，多一列是没人读的列（010 的配对写法是两个名字，
    // 而不是一个名字加一个索引号 —— 加错形状的行会静默对不上站）。
    expect(addedColumns(forward).sort()).toEqual(Object.keys(COLUMNS).sort())
  })

  it('四列都可空、无默认值、无 CHECK —— 没设过关注站是合法状态', () => {
    const forward = codeOf(FORWARD)
    for (const [column, type] of Object.entries(COLUMNS)) {
      const clause = addColumnClause(forward, column)
      expect(clause, `${column} is never added by the migration`).toBeTruthy()
      expect(clause, `${column} is ${type}`).toMatch(new RegExp(`\\b${type}\\b`, 'i'))
      expect(clause, `${column} is NOT NULL, so 「没设过」 cannot be stored`).not.toMatch(/NOT\s+NULL/i)
      expect(clause, `${column} carries a DEFAULT, so 「没设过」 would read as a chosen station`).not.toMatch(/\bDEFAULT\b/i)
      expect(clause, `${column} carries a CHECK, so the read side is no longer the only place that judges it`).not.toMatch(/\bCHECK\b/i)
    }
  })

  it('前向段只碰这一个表，且不改写任何数据', () => {
    const forward = codeOf(FORWARD)
    const altered = [...new Set(
      [...forward.matchAll(/ALTER\s+TABLE\s+(\w+)/gi)].map(match => match[1]),
    )]

    expect(altered).toEqual([TABLE])
    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'MERGE']) {
      expect(forward, `the forward section rewrites data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
  })

  it('回滚段按运行器自己的判据不属破坏性：操作者回滚时不必确认丢数据', () => {
    // 正控制：这条判据认得出破坏性语句 —— 否则「本段不含破坏性语句」对一个坏掉的正则也成立。
    expect('ALTER TABLE x DROP COLUMN y;'.match(DESTRUCTIVE_SQL)).not.toBeNull()
    expect('-- 说一句 DROP COLUMN 也算'.match(DESTRUCTIVE_SQL)).not.toBeNull()

    // 看的是**原文**（含注释），因为运行器就是这么看的：一句关于语句的叙述就足以让回滚要 --confirm。
    expect(DOWN!.match(DESTRUCTIVE_SQL), 'rolling back this migration demands --confirm').toBeNull()

    // 本段是个无操作：加法列的回滚刻意不删列（013 与 014 的先例），已经记下的关注站是使用者的选择，
    // 回滚不得把它抹掉。
    expect(codeOf(DOWN!).trim().length).toBeGreaterThan(0)
  })
})
