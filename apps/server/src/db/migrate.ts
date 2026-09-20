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

/**
 * 回滚需要每个迁移自带 `-- migrate:down` 段；未提供则拒绝回滚。
 * 自动 DROP TABLE 的推断方式会误删被后续迁移扩过列的表，这里显式要求。
 */
async function down(): Promise<void> {
  await ensureMigrationsTable()
  const applied = await getApplied()
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort()
    .reverse()

  for (const file of files) {
    if (!applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8')
    const downSql = extractDownSection(sql)
    if (!downSql) {
      console.error(`rollback aborted: ${file} has no "-- migrate:down" section`)
      process.exit(1)
    }
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
  console.log('migrations down: done')
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
    console.error('Usage: tsx src/db/migrate.ts up|down')
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
