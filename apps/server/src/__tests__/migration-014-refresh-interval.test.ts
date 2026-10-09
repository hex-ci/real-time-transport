import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 014 的文本，按本仓库既有的迁移约定钉住。
 *
 * 本套件钉的是**文件文本本身** —— 它加了哪一列、可空无默认值、前向段不改写数据、
 * 回滚段存在且按运行器判据不属破坏性 —— 而不是「这条 SQL 跑起来的效果」。
 *
 * 文本层面的规则（对应 014 的意图）：
 *
 *  - 前向段给 `user_settings` 加 `refresh_interval_sec`（`INTEGER`，可空、无默认值）。
 *    NULL 就是「没选过」，读侧回退 18s；`NOT NULL DEFAULT 18` 会把"用户从未调过"
 *    说成"用户选了 18" —— 那是替数据做主；
 *  - 取值范围（10~120）由应用层 schema 保证，库里不加 CHECK 是刻意的：
 *    读侧对越界值的回退与"未设置"的回退走同一条路；
 *  - 前向段不改写任何数据，也不碰别的表；
 *  - 回滚段在，且**按运行器自己的判据不属破坏性**：操作者可回滚而不必确认丢数据 ——
 *    判据是 `migrate.ts` 里那条正则，且它作用在**含注释**的回滚段原文上。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

const TABLE = 'user_settings'
const COLUMN = 'refresh_interval_sec'

const DOWN_MARKER = '-- migrate:down'

/**
 * 运行器的破坏性判据，逐字照抄 `apps/server/src/db/migrate.ts` 的 `DESTRUCTIVE_SQL`。
 */
const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b[^;]*/gi

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^014_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 014_*.sql in migrations/, found: ${JSON.stringify(found)}`)
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

/** 某个列被 `ADD COLUMN` 的那一段语句，或 null。 */
function addColumn(sql: string, column: string): string | null {
  return sql.match(new RegExp(`ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}[^;]*`, 'i'))?.[0] ?? null
}

describe('014：实时刷新间隔入库（用户可调整个系统的实时性）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^014_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当前最新的一步：按文件名排，它排在已有的每一条之后', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe(FILE)
  })

  it('前向段加 refresh_interval_sec 列，可空、无默认值 —— NULL 是「没选过」，不是 18', () => {
    const forward = codeOf(FORWARD)
    const added = addColumn(forward, COLUMN)
    expect(added, `${COLUMN} is never added by the migration`).toBeTruthy()
    expect(added, `${COLUMN} is INTEGER`).toMatch(/INTEGER/i)
    expect(added, `${COLUMN} is NOT NULL, so 「没选过」 cannot be stored`).not.toMatch(/NOT\s+NULL/i)
    expect(added, `${COLUMN} carries a DEFAULT, so 「没选过」 would read as a chosen value`).not.toMatch(/\bDEFAULT\b/i)
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

    // 本段是个无操作：加法列的回滚刻意不删列（013 的先例），已记下的间隔是使用者的选择，
    // 回滚不得把它抹成 NULL。
    expect(codeOf(DOWN!).trim().length).toBeGreaterThan(0)
  })
})
