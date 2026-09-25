/**
 * SQL 迁移运行器。
 *
 * 用法：pnpm migrate:up | pnpm migrate:down
 * 按文件名排序执行 migrations/ 下的 .sql 文件，已执行的记录在 _migrations 表。
 *
 * 迁移不在服务启动时自动执行：升级是显式动作，避免多实例同时启动时并发改表。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pg from 'pg'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not configured')
  process.exit(1)
}

const pool = new Pool({ connectionString: DATABASE_URL })
const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../migrations')

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

async function getApplied(): Promise<Set<string>> {
  const result = await pool.query('SELECT name FROM _migrations ORDER BY id')
  return new Set(result.rows.map((r: { name: string }) => r.name))
}

async function up(): Promise<void> {
  await ensureMigrationsTable()
  const applied = await getApplied()
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip: ${file}`)
      continue
    }
    const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8')
    // Only the part above "-- migrate:down" is the forward migration; running the
    // whole file would execute the rollback section too and undo what just ran.
    const sql = stripDownSection(raw)
    console.log(`apply: ${file}`)
    // 事务内执行：迁移中途失败时不留半应用状态
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
    }
    catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    finally {
      client.release()
    }
  }
  console.log('migrations up: done')
}

/** 会丢数据的语句：命中就必须显式确认，普通 DROP INDEX 不算。 */
const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b[^;]*/gi

/**
 * 回滚需要每个迁移自带 `-- migrate:down` 段；未提供则拒绝回滚。
 * 自动 DROP TABLE 的推断方式会误删被后续迁移扩过列的表，这里显式要求。
 *
 * 默认只回滚最后一步，且破坏性语句需 `--confirm`：整库回滚会连带删掉基线迁移建的
 * 表（里面有真实数据），而回滚不可逆（开发库 archive_mode=off，无 PITR）。这类操作必须被
 * 显式要求，不能是默认行为。
 */
async function down(): Promise<void> {
  await ensureMigrationsTable()
  const applied = await getApplied()
  const rollbackAll = process.argv[3] === 'all'
  const candidates = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort()
    .reverse()
    .filter(f => applied.has(f))
  const scope = rollbackAll ? candidates : candidates.slice(0, 1)

  if (scope.length === 0) {
    console.log('migrations down: nothing to roll back')
    return
  }

  const plan = await Promise.all(scope.map(async (file) => {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8')
    const downSql = extractDownSection(sql)
    if (!downSql) {
      console.error(`rollback aborted: ${file} has no "-- migrate:down" section`)
      process.exit(1)
    }
    return {
      file,
      downSql,
      destroys: [...downSql.matchAll(DESTRUCTIVE_SQL)].map(m => m[0].replace(/\s+/g, ' ').trim()),
    }
  }))

  const destroys = plan.flatMap(p => p.destroys)
  if (destroys.length > 0 && !process.argv.includes('--confirm')) {
    console.error(`refusing to roll back ${scope.length} of ${candidates.length} applied migration(s): the down sections destroy data`)
    for (const p of plan) {
      for (const stmt of p.destroys) console.error(`  ${p.file}: ${stmt}`)
    }
    console.error(`re-run to confirm: pnpm migrate:down${rollbackAll ? ' all' : ''} --confirm`)
    process.exit(1)
  }

  for (const { file, downSql } of plan) {
    console.log(`rollback: ${file}`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(downSql)
      await client.query('DELETE FROM _migrations WHERE name = $1', [file])
      await client.query('COMMIT')
    }
    catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    finally {
      client.release()
    }
  }
  console.log(`migrations down: done (${scope.length} of ${candidates.length} applied)`)
}

function stripDownSection(sql: string): string {
  const marker = '-- migrate:down'
  const idx = sql.indexOf(marker)
  return idx < 0 ? sql : sql.slice(0, idx).trim()
}

function extractDownSection(sql: string): string | null {
  const marker = '-- migrate:down'
  const idx = sql.indexOf(marker)
  if (idx < 0) return null
  return sql.slice(idx + marker.length).trim()
}

const command = process.argv[2]
try {
  if (command === 'up') await up()
  else if (command === 'down') await down()
  else {
    console.error('Usage: tsx src/db/migrate.ts up | down [all] [--confirm]')
    process.exit(1)
  }
}
catch (err) {
  console.error('Migration failed:', err)
  process.exit(1)
}
finally {
  await pool.end()
}
