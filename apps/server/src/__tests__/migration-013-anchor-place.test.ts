import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { databaseUrlFor } from '../db/client.js'

/**
 * 013 的文本，按本仓库既有的迁移约定钉住。
 *
 * 本套件钉的是**文件文本本身** —— 它加了哪些列、约束圈了哪些取值、回滚段是否存在且不含
 * 破坏性语句 —— 而不是「这条 SQL 跑起来的效果」：`migrate.ts` 需要一个真实的 `DATABASE_URL`，
 * 测试进程的守卫会把它丢掉，开发库也不允许测试写入。文本对了不等于库被改对了，
 * 那是应用者的那一步（`x-migrations-discipline.test.ts` 在真库上验形状）。
 *
 * 文本层面的规则（对应 013 的意图）：
 *
 *  - 前向段给 `user_settings` 加四列：两个地点名（`TEXT`，可空）与两个来源
 *    （`VARCHAR`，可空、无默认值）。NULL 就是「没记过」，而 `NOT NULL DEFAULT 'device'`
 *    会把存量行说成「它来自设备」—— 那是替数据做主；
 *  - 两个来源各有一条 CHECK，圈定 `device` / `search` 且允许 NULL（`NULL IN (...)` 是 NULL
 *    而非 FALSE），空串不在取值里；
 *  - 前向段不改写任何数据，也不碰别的表；
 *  - 回滚段在，且**按运行器自己的判据不属破坏性**：操作者可回滚而不必确认丢数据 ——
 *    判据是 `migrate.ts` 里那条正则，且它作用在**含注释**的回滚段原文上。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

/** 本次迁移加的四列，以及圈定来源取值的两条约束。 */
const TABLE = 'user_settings'
const PLACE_NAME_COLUMNS = ['home_place_name', 'work_place_name']
const SOURCE_COLUMNS = ['home_anchor_source', 'work_anchor_source']
const CONSTRAINTS = [
  'user_settings_home_anchor_source_check',
  'user_settings_work_anchor_source_check',
]

const DOWN_MARKER = '-- migrate:down'

/**
 * 运行器的破坏性判据，逐字照抄 `apps/server/src/db/migrate.ts` 的 `DESTRUCTIVE_SQL`。
 *
 * 它作用在回滚段的**原文**上，注释也算 —— 于是「在回滚段里提一句那些语句」本身就会让
 * 回滚要求 `--confirm`。这条规则在此重述一遍，是为了让本文件能断言「这条迁移的回滚
 * 不需要确认」，而不是靠读一遍 SQL 猜。
 */
const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b[^;]*/gi

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^013_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 013_*.sql in migrations/, found: ${JSON.stringify(found)}`)
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

describe('013：锚点的地点名与来源入库（「这个坐标是怎么来的」有据可查）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^013_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当前最新的一步之前那一步：014 在它之后，是它让出了这个位置', () => {
    // 014 给设置行加了实时刷新间隔，故「按文件名排最后」这一行 013 不再持有。
    // 钉住的是**谁在它之后**，而不是它自己永远垫底。
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    const after = files.slice(files.indexOf(FILE) + 1)
    expect(after).toEqual(['014_user-settings-refresh-interval.sql'])
  })

  it('前向段加两个地点名列，可空、无默认值', () => {
    const forward = codeOf(FORWARD)
    for (const column of PLACE_NAME_COLUMNS) {
      const added = addColumn(forward, column)
      expect(added, `${column} is never added by the migration`).toBeTruthy()
      expect(added, `${column} is NOT NULL, so 「没有名字」 cannot be stored`).not.toMatch(/NOT\s+NULL/i)
      expect(added, `${column} carries a DEFAULT, so 「没有名字」 would read as a name`).not.toMatch(/\bDEFAULT\b/i)
    }
  })

  it('前向段加两个来源列，可空、无默认值 —— NULL 是「没记过」，不是 device', () => {
    const forward = codeOf(FORWARD)
    for (const column of SOURCE_COLUMNS) {
      const added = addColumn(forward, column)
      expect(added, `${column} is never added by the migration`).toBeTruthy()
      expect(added, `${column} is NOT NULL, so 「没记过来源」 cannot be stored`).not.toMatch(/NOT\s+NULL/i)
      expect(added, `${column} carries a DEFAULT, so a row nobody wrote would read as device`).not.toMatch(/\bDEFAULT\b/i)
    }
  })

  it('前向段用 CHECK 圈定两个已知来源，且不排掉 NULL', () => {
    const forward = codeOf(FORWARD)
    for (const [index, column] of SOURCE_COLUMNS.entries()) {
      const constraint = CONSTRAINTS[index]!
      const check = forward.match(new RegExp(`ADD\\s+CONSTRAINT\\s+${constraint}[^;]*`, 'i'))?.[0]
      expect(check, `the value check for ${column} is never added, so any string can be stored`).toBeTruthy()
      expect(check, `the check does not pin the two sources for ${column}`)
        .toMatch(new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(\\s*'device'\\s*,\\s*'search'\\s*\\)\\s*\\)`, 'i'))
      // 允许 NULL：SQL 里 `NULL IN (...)` 求值为 NULL 而非 FALSE，故没记过来源的行照常通过。
      expect(check, `the check refuses rows whose source was never recorded`).not.toMatch(/IS\s+NOT\s+NULL|NOT\s+NULL/i)
      // 空串不在取值里：它不是「没记」——那是 NULL。
      expect(forward, `the empty string is accepted as a source for ${column}`)
        .not.toMatch(new RegExp(`IN\\s*\\(\\s*'device'\\s*,\\s*'search'\\s*,\\s*''\\s*\\)`, 'i'))
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
    // 判据写在文件里：来源决定换算，NULL 是「没记过」。
    expect(RAW, 'the file does not say what the source column is for').toMatch(/换算/)
  })

  it('回滚段按运行器自己的判据不属破坏性：操作者回滚时不必确认丢数据', () => {
    // 正控制：这条判据认得出破坏性语句 —— 否则「本段不含破坏性语句」对一个坏掉的正则也成立。
    expect('ALTER TABLE x DROP COLUMN y;'.match(DESTRUCTIVE_SQL)).not.toBeNull()
    expect('-- 说一句 DROP COLUMN 也算'.match(DESTRUCTIVE_SQL)).not.toBeNull()

    // 看的是**原文**（含注释），因为运行器就是这么看的：一句关于语句的叙述就足以让回滚要 --confirm。
    const down = codeOf(DOWN!)
    expect(DOWN!.match(DESTRUCTIVE_SQL), 'rolling back this migration demands --confirm').toBeNull()

    // 回滚确实做了一件事：去掉只属于这两列的取值约束，使库回到「四列存在但来源无人约束」的状态。
    for (const constraint of CONSTRAINTS) {
      expect(down, 'the rollback does nothing at all')
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+${TABLE}\\s+DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${constraint}`, 'i'))
    }
    // 且不删列、不改写数据：已记下的地点名与来源是使用者的记录。
    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE']) {
      expect(down, `the rollback rewrites data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
    for (const dropped of ['DROP COLUMN', 'DROP TABLE']) {
      expect(down, `the rollback drops something (${dropped})`).not.toMatch(new RegExp(dropped, 'i'))
    }
  })
})

describe('这条迁移只能在真实的库上执行，本套件钉的是文本', () => {
  it('测试进程没有可用的 DATABASE_URL，所以这份 SQL 不在这里被执行', () => {
    expect(databaseUrlFor(process.env)).toBeUndefined()
    expect(Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test').toBe(true)
  })
})
