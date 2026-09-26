import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { databaseUrlFor } from '../db/client.js'

/**
 * 011 的文本，按本仓库既有的迁移约定钉住。
 *
 * 本套件钉的是**文件文本本身** —— 它做了什么、没做什么、回滚段是否存在 —— 而不是「这条
 * SQL 跑起来的效果」：`migrate.ts` 需要一个真实的 `DATABASE_URL`，测试进程的守卫会把它
 * 丢掉，开发库也不允许测试写入。文本对了不等于库被改对了，那是应用者的那一步。
 *
 * 文本层面的规则（对应 011 的意图）：
 *
 *  - 前向段只去掉起点这一列，以及点名它的那一条取值约束；别的表一个都不动；
 *  - 前向段不改写任何数据：起点由通勤目的决定（`anchorForPurpose`），故存量行不需要回填 ——
 *    一条录成矛盾组合的历史行此后一律按目的读，而不是留下列里的一半；
 *  - 回滚段在，且语句顺序是「加可空列 → 由 purpose 回填 → SET NOT NULL → 恢复 CHECK」：
 *    顺序反过来会在存量行上当场失败；文件里必须说明这一步取不回原来的取值。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

/** 本次迁移去掉的那一列，以及点名它的取值约束。 */
const COLUMN = 'origin_anchor'
const CONSTRAINT = 'commute_chains_origin_anchor_check'

const DOWN_MARKER = '-- migrate:down'

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^011_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 011_*.sql in migrations/, found: ${JSON.stringify(found)}`)
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

describe('011：通勤链路不再录入起点（只删列的结构改动）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^011_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当时的最新一步；如今 012 在它之后，是它让出了这个位置', () => {
    // 012 在它之后加了新的列（接驳方式），故「按文件名排最后」这一行 011 不再持有。
    // 钉住的是**谁在它之后**，而不是它自己永远垫底。
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    const after = files.slice(files.indexOf(FILE) + 1)
    expect(after, 'a migration landed before 011').toEqual(['012_commute-chain-leg-connection-mode.sql'])
  })

  it('前向段去掉起点这一列，并显式点名删掉只看这一列的取值约束', () => {
    const forward = codeOf(FORWARD)

    expect(forward, 'the origin column survives the migration, so a chain can still contradict its purpose')
      .toMatch(new RegExp(`ALTER\\s+TABLE\\s+commute_chains\\s+DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${COLUMN}`, 'i'))
    // 约束只提到这一列，PostgreSQL 会随列一起删；显式写出来是为了约束的去向在文件上可读，
    // 并使「先删约束、后删列」不取决于读者对依赖行为的记忆。
    expect(forward, 'the check that names only this column is not dropped explicitly')
      .toMatch(new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${CONSTRAINT}`, 'i'))
    expect(forward.match(/DROP\s+COLUMN/gi), 'more or fewer than one column was dropped').toHaveLength(1)
  })

  it('前向段只碰这一个表，别的表一个都不动', () => {
    const forward = codeOf(FORWARD)
    const altered = [...new Set(
      [...forward.matchAll(/ALTER\s+TABLE\s+(\w+)/gi)].map(match => match[1]),
    )]

    expect(altered).toEqual(['commute_chains'])
    expect(forward, 'the migration reaches into another table').not.toMatch(/_migrations|user_settings|user_favorite_lines|commute_chain_legs/i)
  })

  it('前向段不改写任何数据：起点由目的决定，存量行不需要回填', () => {
    const forward = codeOf(FORWARD)

    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'MERGE']) {
      expect(forward, `the forward section rewrites data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
    // 判据写在文件里：起点是目的的函数，而「上班从家出发、下班从公司出发」就是那条规则。
    expect(RAW, 'the file does not say where the start now comes from').toMatch(/anchorForPurpose|通勤目的/)
  })

  it('回滚段按「加列 → 回填 → 收紧 → 恢复约束」的顺序把起点变回一列', () => {
    const down = codeOf(DOWN!)

    const added = down.match(new RegExp(`ALTER\\s+TABLE\\s+commute_chains\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${COLUMN}[^;]*`, 'i'))?.[0]
    expect(added, `${COLUMN} is never added back by the rollback`).toBeTruthy()
    // 可空、无 DEFAULT：回填之前的那一列必须是空的，否则下面那条 UPDATE 就是死代码。
    expect(added, 'the restored column is NOT NULL, so the rollback would fail on every stored row')
      .not.toMatch(/NOT\s+NULL/i)
    expect(added, 'the restored column carries a DEFAULT, so the backfill would never be exercised')
      .not.toMatch(/\bDEFAULT\b/i)

    // 回填写回的正是这个版本一直在用的推导：上班=家、下班=公司。
    const backfill = down.match(/UPDATE\s+commute_chains[\s\S]*?;/i)?.[0] ?? ''
    expect(backfill, 'the rollback does not restore any value').toMatch(/\bSET\b/i)
    expect(backfill, 'the backfill does not derive the anchor from the purpose').toMatch(/purpose/i)
    expect(backfill, 'the backfill does not know both anchors').toMatch(/home/)
    expect(backfill, 'the backfill does not know both anchors').toMatch(/work/)

    // 顺序：回填在 NOT NULL 之前，NOT NULL 在恢复约束之前；反过来会在存量行上当场失败。
    const addAt = down.search(new RegExp(`ADD\\s+COLUMN[^;]*${COLUMN}`, 'i'))
    const backfillAt = down.search(/UPDATE\s+commute_chains/i)
    const notNullAt = down.search(/ALTER\s+COLUMN\s+origin_anchor\s+SET\s+NOT\s+NULL/i)
    const checkAt = down.search(new RegExp(`ADD\\s+CONSTRAINT\\s+${CONSTRAINT}`, 'i'))
    expect(notNullAt, 'the rollback never makes the restored column NOT NULL').toBeGreaterThan(-1)
    expect(checkAt, 'the rollback never restores the value check').toBeGreaterThan(-1)
    expect(addAt).toBeLessThan(backfillAt)
    expect(backfillAt).toBeLessThan(notNullAt)
    expect(notNullAt).toBeLessThan(checkAt)
    expect(down, 'the restored check does not pin the two anchor values')
      .toMatch(/CHECK\s*\(\s*origin_anchor\s+IN\s*\(\s*'home'\s*,\s*'work'\s*\)\s*\)/i)

    // 取不回原来的取值 —— 回滚的人要看见这句话。
    expect(RAW, 'the rollback silently claims to restore the stored values').toMatch(/破坏性|有损/)
  })
})

describe('这条迁移只能在真实的库上执行，本套件钉的是文本', () => {
  it('测试进程没有可用的 DATABASE_URL，所以这份 SQL 不在这里被执行', () => {
    expect(databaseUrlFor(process.env)).toBeUndefined()
    expect(Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test').toBe(true)
  })
})
