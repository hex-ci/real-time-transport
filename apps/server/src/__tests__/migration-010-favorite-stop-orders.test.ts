import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { databaseUrlFor } from '../db/client.js'

/**
 * 010 的文本，按本仓库既有的迁移约定钉住。
 *
 * 本套件钉的是**文件文本本身** —— 它做了什么、没做什么、回滚段是否存在 —— 而不是「这条
 * SQL 跑起来的效果」：`migrate.ts` 需要一个真实的 `DATABASE_URL`，测试进程的守卫会把它
 * 丢掉，开发库也不允许测试写入。文本对了不等于库被改对了，那是应用者的那一步（见
 * `references/db-migrations.md` 的验证配方）。
 *
 * 文本层面的规则（对应 010 的意图）：
 *
 *  - 前向段只做加法：`user_favorite_lines` 上新增两个可空 INT 列（上班/下班上车点的站序），
 *    一个不落、也不多改别的列或别的表；
 *  - 两列都可空、都没有 DEFAULT，也没有 CHECK：存量行是「有站名、没站序」，而站序真的不
 *    知道（同名站哪一个是使用者选的，从名字推不出来），所以成对性改由写入边界把关
 *    （api.ts 的 UpdateFavoriteSchema）；
 *  - 前向段不改写任何数据：没有 UPDATE / INSERT / DELETE / TRUNCATE；
 *  - 回滚段在：`-- migrate:down` 之后只去掉这两列，并且说明这一步是有损的。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations', import.meta.url))

/** 本次迁移加的两列：一对站序里的站序那一半，两个通勤用途各一。 */
const ORDER_COLUMNS = ['pinned_station_order', 'reverse_pinned_station_order'] as const

const DOWN_MARKER = '-- migrate:down'

function findMigration(): string {
  const found = readdirSync(MIGRATIONS_DIR).filter(name => /^010_.*\.sql$/.test(name))
  if (found.length !== 1) {
    throw new Error(`expected exactly one 010_*.sql in migrations/, found: ${JSON.stringify(found)}`)
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

describe('010：上车点补上站序（只加列的结构改动）', () => {
  it('文件名按序号排，前向段与回滚段都存在', () => {
    expect(FILE).toMatch(/^010_[a-z0-9_-]+\.sql$/)
    expect(markerIndex, 'the migration has no "-- migrate:down" section, so it cannot be rolled back').toBeGreaterThan(-1)
    expect(DOWN!.trim().length).toBeGreaterThan(0)
  })

  it('是当前最新的一步：按文件名排，它排在已有的每一条之后', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
    expect(files[files.length - 1]).toBe(FILE)
  })

  it('两个站序列都被加上，可空、无默认值，各一次', () => {
    const forward = codeOf(FORWARD)

    for (const column of ORDER_COLUMNS) {
      expect(forward, `${column} is never added, so the pair's order half has nowhere to live`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_favorite_lines\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\s+INT`, 'i'))
    }

    expect(forward.match(/ADD\s+COLUMN/gi), 'more or fewer than the two order columns were added').toHaveLength(2)
    // 站序的「不知道」必须可表达，所以不能有 NOT NULL，也不能有 DEFAULT —— 默认值会把
    // 「没选过」写成一个具体的站（第 0 站 / 第 1 站）。
    expect(forward, 'an order column is NOT NULL, so 「no order stored」 is unrepresentable')
      .not.toMatch(/NOT\s+NULL/i)
    expect(forward, 'an order column carries a DEFAULT, so a legacy row would read as a stop nobody chose')
      .not.toMatch(/\bDEFAULT\b/i)
  })

  it('没有成对 CHECK：存量行正是「有站名、没站序」，那样的约束会让这条迁移当场失败', () => {
    // 站序的成对性改由写入边界把关，读侧把「有名字、没站序」如实当作「定位不到」；
    // 007 那种成对 CHECK 会让这条迁移在现存数据上直接失败。
    expect(codeOf(FORWARD), 'a pairing CHECK was added over rows that cannot satisfy it')
      .not.toMatch(/\bCHECK\b/i)
    expect(RAW, 'the migration does not say why it carries no pairing constraint')
      .toMatch(/CHECK/)
  })

  it('前向段只碰这两列，别的表一个都不动', () => {
    const forward = codeOf(FORWARD)
    const altered = [...new Set(
      [...forward.matchAll(/ALTER\s+TABLE\s+(\w+)/gi)].map(match => match[1]),
    )]

    expect(altered).toEqual(['user_favorite_lines'])
    expect(forward, 'the migration reaches into another table').not.toMatch(/_migrations|user_settings|commute_chain/i)
  })

  it('前向段不改写任何数据：存量行的站序不知道，就不替它猜一个', () => {
    const forward = codeOf(FORWARD)

    for (const rewrite of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE', 'MERGE']) {
      expect(forward, `the forward section rewrites data (${rewrite})`).not.toMatch(new RegExp(`\\b${rewrite}\\b`, 'i'))
    }
    expect(RAW, 'the file does not say the legacy order is unknown rather than guessable')
      .toMatch(/不知道|推不出来/)
  })

  it('回滚段只去掉这两列，并说明它是有损的', () => {
    const down = codeOf(DOWN!)

    for (const column of ORDER_COLUMNS) {
      expect(down, `${column} is not dropped by the rollback`)
        .toMatch(new RegExp(`ALTER\\s+TABLE\\s+user_favorite_lines\\s+DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${column}`, 'i'))
    }
    expect(down.match(/DROP\s+COLUMN/gi)).toHaveLength(2)
    // 去掉的列里存着「哪一站」这件事，而它不能再从站名推回来 —— 回滚的人要看见这句话。
    expect(RAW, 'the rollback silently destroys which stop the user chose').toMatch(/破坏性|有损/)
  })
})

describe('这条迁移只能在真实的库上执行，本套件钉的是文本', () => {
  it('测试进程没有可用的 DATABASE_URL，所以这份 SQL 不在这里被执行', () => {
    expect(databaseUrlFor(process.env)).toBeUndefined()
    expect(Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test').toBe(true)
  })
})
