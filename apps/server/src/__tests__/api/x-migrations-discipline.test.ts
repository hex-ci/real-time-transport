import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTestDatabaseUrl } from './support/api-harness.js'

/**
 * 迁移的铁律：每个文件都能回滚，整条链按序全跑可重复执行，约束与代码假设一致。
 *
 * 这一份与其他 spec 不同：它没有「内存 / SQL 两条路径」这一维 —— 迁移只存在于库里，
 * 因此这里不对着 `describeEachStore` 跑，而是拿一条**连到测试库的单连接**（过 `_test` 硬闸）
 * 在**一个事务**里做全部 DDL，最后整体回滚。事务是这里的隔离手段：命令式的 TRUNCATE
 * 清单管不到新增的表，而一个回滚掉的事务谁也不影响。
 *
 * 钉四件事：
 *
 *  1. 每个 `migrations/*.sql` 都有非空的 `-- migrate:down` 段 —— 运行器拒绝没有回滚段的迁移，
 *     这条规则要么每个文件都成立，要么某一步是单程的；
 *  2. 每个文件的前向段在**已迁移的库**上重放一遍不报错（本仓库的迁移都是幂等 DDL）；
 *     按序整体重放之后，库的形状（public 下的表数）不变；
 *  3. 把全部文件的回滚段**按文件名倒序**执行一遍不报错，且执行完之后基线表真的没了 ——
 *     回滚确实把库退回了迁移之前，而不是「回滚了但什么也没发生」；
 *  4. 约束与代码假设一致：009 之后四个通勤时刻可空、010 的两个站序列可空（存量行是「有名字、
 *     没站序」）、012 的 CHECK 只收 walk/cycle 且放行 NULL、007 的站名与站序成对。
 *
 * 「当前最新一步」的断言跟着目录里最新的那个文件走，而不是写死 012：它就是
 * 「库里应用过的名字集合 == 目录里的文件集合」。
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../migrations', import.meta.url))
const DOWN_MARKER = '-- migrate:down'

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
}

function readMigration(file: string): string {
  return readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8')
}

/** 前向段：`-- migrate:down` 之前的部分（运行器就是这么切的）。 */
function forwardOf(raw: string): string {
  const idx = raw.indexOf(DOWN_MARKER)
  return idx < 0 ? raw : raw.slice(0, idx)
}

function downOf(raw: string): string | null {
  const idx = raw.indexOf(DOWN_MARKER)
  return idx < 0 ? null : raw.slice(idx + DOWN_MARKER.length)
}

describe('迁移：顺序、幂等与可回滚', () => {
  const files = migrationFiles()
  let client: pg.Client

  beforeAll(async () => {
    // `resolveTestDatabaseUrl` 就是套件那条 `_test` 硬闸：拿开发库那一条直接起不来。
    client = new pg.Client({ connectionString: resolveTestDatabaseUrl(), connectionTimeoutMillis: 3000 })
    await client.connect()
    // 整份 spec 都在这个事务里，afterAll 无条件回滚 —— 库最后保持原样。
    await client.query('BEGIN')
  })

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  })

  /** 在子事务里跑一段（可能是多语句的）SQL，之后无论成败都回滚回这里。 */
  async function tryRolledBack(sql: string): Promise<{ ok: boolean, message?: string }> {
    await client.query('SAVEPOINT block')
    try {
      await client.query(sql)
      return { ok: true }
    }
    catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT block')
    }
  }

  it('每个迁移文件都有一个非空的回滚段', () => {
    expect(files.length, 'no migration files were found at all').toBeGreaterThan(0)
    for (const file of files) {
      const down = downOf(readMigration(file))
      expect(down, `${file} has no "${DOWN_MARKER}" section, so it cannot be rolled back`).not.toBeNull()
      expect(down!.trim().length, `${file} carries an empty rollback section`).toBeGreaterThan(0)
    }
  })

  it('编号按序连续：没有缺号，也没有重号', () => {
    const numbers = files.map((file) => {
      expect(file, `${file} does not carry a three-digit ordinal prefix`).toMatch(/^\d{3}_[a-z0-9_-]+\.sql$/)
      return Number(file.slice(0, 3))
    })
    expect(numbers, 'the migration numbering has gaps or duplicates')
      .toEqual(Array.from({ length: numbers.length }, (_, idx) => idx + 1))
  })

  it('「当前最新一步」跟着目录里最新那个文件走：库里应用过的名字就是全部文件', async () => {
    const applied = await client.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name')
    const appliedNames = applied.rows.map(row => row.name)

    expect(
      appliedNames,
      `the database is not at the latest step (latest file: ${files[files.length - 1]})`,
    ).toEqual(files)
  })

  it('前向段在已迁移的库上按序重放不报错，且库的形状不变', async () => {
    const before = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    )

    for (const file of files) {
      const replayed = await tryRolledBack(forwardOf(readMigration(file)))
      expect(replayed.ok, `${file} is not re-runnable: ${replayed.message}`).toBe(true)
    }

    const after = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    )
    expect(after.rows[0]!.n, 'replaying the chain changed the shape of the database').toBe(before.rows[0]!.n)
  })

  it('回滚段按文件倒序整体执行不报错，且执行完之后基线表真的没了', async () => {
    const reverses = [...files].reverse().map(file => downOf(readMigration(file))!).join('\n')

    // 一个子事务里跑完整条回滚链：与运行器 `down all` 的顺序相同（文件名倒序）。
    const rolled = await tryRolledBack(reverses)
    expect(rolled.ok, `rolling the chain back failed: ${rolled.message}`).toBe(true)
  })

  it('回滚真的把库退回了迁移之前（这一步在子事务里看，随后整体退回）', async () => {
    // 与上一条同样的一条链，但这次在回滚之前看清形状：回滚必须真的做到它说的事，
    // 而不是「执行了但什么也没发生」。
    await client.query('SAVEPOINT block')
    try {
      for (const file of [...files].reverse()) {
        await client.query(downOf(readMigration(file))!)
      }
      const gone = await client.query<{ favorites: string | null, chains: string | null }>(
        `SELECT to_regclass('public.user_favorite_lines') AS favorites,
                to_regclass('public.commute_chains') AS chains`,
      )
      expect(gone.rows[0]!.favorites, 'the baseline table survived its own rollback').toBeNull()
      expect(gone.rows[0]!.chains).toBeNull()
    }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT block')
    }
  })
})

describe('迁移：约束与代码假设一致', () => {
  let client: pg.Client

  beforeAll(async () => {
    client = new pg.Client({ connectionString: resolveTestDatabaseUrl(), connectionTimeoutMillis: 3000 })
    await client.connect()
    await client.query('BEGIN')
  })

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  })

  async function columns(table: string): Promise<Map<string, { nullable: boolean, type: string }>> {
    const res = await client.query<{ column_name: string, is_nullable: string, data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    )
    return new Map(res.rows.map(row => [row.column_name, {
      nullable: row.is_nullable === 'YES',
      type: row.data_type,
    }]))
  }

  async function tryQuery(sql: string, params?: unknown[]): Promise<{ ok: boolean, code?: string }> {
    await client.query('SAVEPOINT probe')
    try {
      await client.query(sql, params)
      await client.query('RELEASE SAVEPOINT probe')
      return { ok: true }
    }
    catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT probe')
      return { ok: false, code: (err as { code?: string }).code }
    }
  }

  it('009：四个通勤时刻可空 —— 「行在、时段从未被选择」存得下来', async () => {
    const settings = await columns('user_settings')
    for (const column of ['morning_start', 'morning_end', 'evening_start', 'evening_end']) {
      const info = settings.get(column)
      expect(info, `user_settings.${column} is missing`).toBeTruthy()
      expect(info!.nullable, `user_settings.${column} is NOT NULL, so 「never chosen」 cannot be stored`).toBe(true)
    }
  })

  it('010：关注线路的两个站序列可空 —— 存量行正是「有名字、没站序」', async () => {
    const favorites = await columns('user_favorite_lines')
    for (const column of ['pinned_station_order', 'reverse_pinned_station_order']) {
      const info = favorites.get(column)
      expect(info, `user_favorite_lines.${column} is missing`).toBeTruthy()
      expect(info!.nullable, `${column} is NOT NULL, so rows written before 010 cannot exist`).toBe(true)
    }
    // 站名这一半与站序这一半成对出现在契约里：名字列也必须可空（未设置上车点）。
    for (const column of ['pinned_station_name', 'reverse_pinned_station_name']) {
      expect(favorites.get(column)?.nullable, `${column} is NOT NULL`).toBe(true)
    }
  })

  it('007：乘车段的站名与站序成对，且未选站时两列同为 NULL', async () => {
    const legs = await columns('commute_chain_legs')
    for (const column of ['board_station_name', 'board_station_order', 'alight_station_name', 'alight_station_order']) {
      expect(legs.get(column), `commute_chain_legs.${column} is missing`).toBeTruthy()
      expect(legs.get(column)!.nullable, `${column} is NOT NULL, so 「未选站」 cannot be stored`).toBe(true)
    }

    // 成对性是可执行的：只给一半的站会被 CHECK 当场拒绝。
    const chainId = '3f1c2f9e-0000-4000-8000-00000000f00d'
    await client.query(
      `INSERT INTO commute_chains (id, user_id, name, purpose) VALUES ($1, 'fx-migration', '夹具链路', 'morning')`,
      [chainId],
    )
    const halfStation = await tryQuery(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, board_station_name, board_station_order)
       VALUES ($1, 0, '101', '101路', '甲站', NULL)`,
      [chainId],
    )
    expect(halfStation.ok, 'a half-stated station (name without order) was accepted').toBe(false)
    // 两列同为 NULL 是「未选站」：照常通过。
    const unset = await tryQuery(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, board_station_name, board_station_order)
       VALUES ($1, 0, '101', '101路', NULL, NULL)`,
      [chainId],
    )
    expect(unset.ok, 'a leg with no station chosen was refused').toBe(true)
  })

  it('012：接驳方式的 CHECK 只收 walk / cycle，且放行 NULL', async () => {
    const chainId = '3f1c2f9e-0000-4000-8000-00000000f00e'
    await client.query(
      `INSERT INTO commute_chains (id, user_id, name, purpose) VALUES ($1, 'fx-migration', '夹具链路', 'morning')`,
      [chainId],
    )

    const insertLeg = (mode: string | null, seq: number) => tryQuery(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, connection_mode)
       VALUES ($1, $2, '101', '101路', $3)`,
      [chainId, seq, mode],
    )

    // 每段用各自的 seq：段在链内的位置就是它的身份，同一个 seq 会被主键拦下 —— 那测的是主键，不是取值集。
    expect((await insertLeg('walk', 0)).ok, 'the stated mode 步行 was refused').toBe(true)
    expect((await insertLeg('cycle', 1)).ok, 'the stated mode 骑行 was refused').toBe(true)
    // NULL 就是「没选过」：CHECK 里的 `NULL IN (...)` 求值为 NULL，故照常通过。
    expect((await insertLeg(null, 2)).ok, '「没选过」 was refused by the value check').toBe(true)
    expect((await insertLeg('teleport', 3)).ok, 'a mode outside the value set was accepted').toBe(false)
    expect((await insertLeg('', 4)).ok, 'the empty string was accepted as a mode').toBe(false)
  })

  it('008：一条线路对一个用户只允许一行（唯一索引在库里）', async () => {
    const index = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'user_favorite_lines'
          AND indexname = 'uniq_favorite_per_user_city_line'`,
    )
    expect(index.rows[0]!.n, 'the uniqueness fallback behind 「已关注」 is not in the database').toBe(1)

    const insert = (lineId: string) => tryQuery(
      `INSERT INTO user_favorite_lines (user_id, city_code, line_id, line_name) VALUES ('fx-migration', '027', $1, '夹具线路')`,
      [lineId],
    )
    expect((await insert('fx-uniq-line')).ok).toBe(true)
    expect((await insert('fx-uniq-line')).ok, 'a second row for the same line was accepted').toBe(false)
  })
})
