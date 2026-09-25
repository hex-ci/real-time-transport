import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { databaseUrlFor } from '../db/client.js'

/**
 * 009 的文本，按本仓库既有的迁移约定钉住。
 *
 * 这个仓库没有可在此处执行的迁移校验器：`migrate.ts` 需要一个真实的 `DATABASE_URL`，
 * 而测试进程的守卫会把它丢掉（`db-connection-guard.test.ts` 钉的就是这条丢弃），
 * 开发库也不允许测试写入。所以下面钉的是文件文本本身 —— 它做了什么、没做什么、
 * 以及回滚段是否存在 —— 而不是「这条 SQL 跑起来的效果」。后半句是这个测试的边界，
 * 写在这里而不是省略掉：文本对了不等于库被改对了，那是应用者的那一步。
 *
 * 文本层面的规则（对应 009 的意图）：
 *
 *  - 前向段只做结构改动：四个时刻列 `DROP NOT NULL` + `DROP DEFAULT`，各一次，
 *    一个不落、也不多改别的列；
 *  - 前向段不改写任何数据：没有 UPDATE / INSERT / DELETE / TRUNCATE —— 现有那一行的
 *    时段是使用者有意设定的，而任何其他行「选过还是被默认填过」在数据里推不出来
 *    （两者是同一组值），改写它就是把一个不可推导的推断写成事实；
 *  - 回滚段在：`-- migrate:down` 之后恢复 NOT NULL 与 DEFAULT，并且先把 NULL 填上
 *    （否则 SET NOT NULL 会直接失败）。这一步是有损的，文件里必须说明。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

/** The four TIME columns 004 declared NOT NULL DEFAULT. */
const TIME_COLUMNS = ['morning_start', 'morning_end', 'evening_start', 'evening_end'] as const

const DOWN_MARKER = '-- migrate:down'

/** The one migration file this test is about, or a thrown error naming what was missing. */
function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^009_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 009_*.sql in migrations/, found: ${JSON.stringify(found)}`)
  }
  return found[0]!
}

const FILE = findMigration()
const RAW = readFileSync(new URL(`../../../../migrations/${FILE}`, import.meta.url), 'utf8')

const markerIndex = RAW.indexOf(DOWN_MARKER)
const FORWARD = markerIndex < 0 ? RAW : RAW.slice(0, markerIndex)
const DOWN = markerIndex < 0 ? null : RAW.slice(markerIndex + DOWN_MARKER.length)

/** SQL with its comments removed, so prose about a statement is never read as one. */
function codeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

describe('009：四个通勤时刻列变成可空（结构改动）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^009_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当前最新的一步：按文件名排，它排在已有的每一条之后', () => {
    // The runner applies migrations by filename order, so 「最新」 IS 「排在最后」.
    // This is the claim 008's own suite used to make about itself; it moved here
    // with the number, so the newest migration is still the one that says so.
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe(FILE)
  })

  it('四个列的 NOT NULL 与 DEFAULT 都被去掉，各一次', () => {
    const forward = codeOf(FORWARD)

    for (const column of TIME_COLUMNS) {
      expect(forward, `${column} keeps NOT NULL, so 「从未选择」 is still unrepresentable`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_settings\\s+ALTER\\s+COLUMN\\s+${column}\\s+DROP\\s+NOT\\s+NULL`, 'i'))
      expect(forward, `${column} keeps a DEFAULT, so an omitted field still becomes a built-in hour`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_settings\\s+ALTER\\s+COLUMN\\s+${column}\\s+DROP\\s+DEFAULT`, 'i'))
    }

    expect(forward.match(/DROP\s+NOT\s+NULL/gi), 'more or fewer than the four time columns were nullable-ized').toHaveLength(4)
    expect(forward.match(/DROP\s+DEFAULT/gi), 'more or fewer than the four time columns lost their default').toHaveLength(4)
  })

  it('前向段只碰这四个列，别的表一个都不动', () => {
    const forward = codeOf(FORWARD)
    const altered = [...new Set(
      [...forward.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ALTER\s+COLUMN\s+(\w+)/gi)]
        .map(match => `${match[1]}.${match[2]}`),
    )]

    expect(altered.sort()).toEqual(
      TIME_COLUMNS.map(column => `user_settings.${column}`).sort(),
    )
    expect(forward, 'the migration reaches into another table').not.toMatch(/_migrations|user_favorite_lines|commute_chain/i)
  })

  it('前向段不改写任何数据', () => {
    // 现有的那一行（default_user）的时段是使用者有意设定的测试窗口；其余行「选过还是被默认
    // 填过」不可推导。改写值就是把默认值写成使用者的选择 —— 正是这条迁移要消灭的那种谎。
    const forward = codeOf(FORWARD)

    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'MERGE']) {
      expect(forward, `the forward section rewrites data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
  })

  it('回滚段恢复 NOT NULL 与 DEFAULT，并先填掉 NULL', () => {
    const down = codeOf(DOWN!)

    for (const column of TIME_COLUMNS) {
      expect(down, `${column} is not restored to NOT NULL by the rollback`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_settings\\s+ALTER\\s+COLUMN\\s+${column}\\s+SET\\s+DEFAULT\\s+'\\d{2}:\\d{2}'`, 'i'))
      expect(down, `${column} is not restored to NOT NULL by the rollback`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_settings\\s+ALTER\\s+COLUMN\\s+${column}\\s+SET\\s+NOT\\s+NULL`, 'i'))
      // SET NOT NULL 在还有 NULL 的列上会直接失败，所以回滚必须先填。
      expect(down, `${column} is left NULL before SET NOT NULL, which cannot succeed`)
        .toMatch(new RegExp(`UPDATE\\s+user_settings\\s+SET[^;]*${column}[^;]*IS\\s+NULL`, 'i'))
    }
    expect(down.match(/SET\s+NOT\s+NULL/gi)).toHaveLength(4)
  })

  it('回滚的有损之处写在文件里，不是留给人猜', () => {
    expect(RAW, 'the rollback silently destroys the 「never chosen」 state').toMatch(/破坏性|有损/)
  })
})

describe('这条迁移只能在真实的库上执行，本套件钉的是文本', () => {
  it('测试进程没有可用的 DATABASE_URL，所以这份 SQL 不在这里被执行', () => {
    expect(databaseUrlFor(process.env)).toBeUndefined()
    expect(Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test').toBe(true)
  })
})
