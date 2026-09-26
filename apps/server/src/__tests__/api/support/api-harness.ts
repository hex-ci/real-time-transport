import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, vi, type Mock } from 'vitest'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../../../app.js'

/**
 * API 层的地基：把 app 装在进程里（`app.inject()`，不开端口、不发真实网络请求），
 * 并让同一份 spec 主体能分别对「内存实现」与「SQL 实现」各跑一遍。
 *
 * 为什么需要它：现有离线用例全部跑在内存存储上 —— `databaseUrlFor` 在测试进程里直接把
 * 连接串丢掉，于是 `Database` 从不建连接池，SQL 分支（迁移、唯一索引、CHECK、`ORDER BY`
 * 收敛）没有任何用例跑过。这里让「这一遍真的走了 SQL」成为可断言的事实。
 */

/** 允许连的库名后缀。见 `assertTestDatabaseUrl`。 */
const TEST_DB_SUFFIX = '_test'

export type StoreKind = 'memory' | 'sql'

/** 两条存储路径；同一份 spec 主体按这个顺序各跑一遍。 */
export const STORES: StoreKind[] = ['memory', 'sql']

/**
 * 测试进程只允许连以 `_test` 结尾的库，别的库名直接拒绝 —— 与 `databaseUrlFor` 同一思路：
 * 让「测试连到开发库」在结构上不可能，而不是靠约定或纪律。
 *
 * 这里是硬闸，不是警告：开发库上有真实数据，一次 TRUNCATE 就没了。拒绝时只报库名，
 * 不报连接串（里面是凭据）。
 */
export function assertTestDatabaseUrl(url: string): string {
  let dbName: string
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  }
  catch {
    // 解析不了的 URL 一样拒绝：连库名都读不出来，就没有「库名是测试库」这回事。
    throw new Error('TEST: 无法解析的数据库 URL')
  }
  if (!dbName.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(`TEST: 拒绝连接库「${dbName}」：测试库名必须以 ${TEST_DB_SUFFIX} 结尾`)
  }
  return url
}

/**
 * 本套件要连的测试库。
 *
 * `TEST_DATABASE_URL` 显式给的一条优先；否则从开发库的 `DATABASE_URL` 派生出 `<库名>_test`：
 * 同一个容器、同一个用户，只有库名不同。派生出来的名字同样过闸，因此没有「从 .env 来就免检」
 * 这条缝。
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TEST_DATABASE_URL
  if (explicit) return assertTestDatabaseUrl(explicit)

  const base = env.DATABASE_URL
  if (!base) {
    throw new Error('TEST: 未找到 TEST_DATABASE_URL / DATABASE_URL；先跑 `pnpm test:db`')
  }
  const parsed = new URL(base)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!name.endsWith(TEST_DB_SUFFIX)) parsed.pathname = `/${name}${TEST_DB_SUFFIX}`
  return assertTestDatabaseUrl(parsed.toString())
}

/** 夹具只允许精确删业务表：`_migrations` 不在其中（清它会让下一次 migrate:up 重放全部迁移）。 */
export type FixtureTable
  = | 'user_favorite_lines'
    | 'user_settings'
    | 'commute_chains'
    | 'commute_chain_legs'
    | 'cached_transit_lines'

export interface ApiHarness {
  /** 本实例跑的是哪条存储路径：用例的差分断言按它分支（见样本 spec）。 */
  readonly store: StoreKind
  /** 进程内的 app。**不要** `listen()`：端口就是真实网络。 */
  readonly app: FastifyInstance
  /** 上游（车来了/高德）唯一的入口 —— 默认拒绝一切调用的 fetch 桩。 */
  readonly upstream: Mock
  inject(options: InjectOptions): Promise<LightMyRequestResponse>
  /** 裸 pg 读测试库：SQL 路径的断言不经过 app 自己的读映射。 */
  rows<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>
  /** 本用例的夹具前缀；夹具 id 一律由它派生，一眼可辨是这一次跑出来的行。 */
  fixtureId(label: string): string
  /** 按 id 精确删本用例的夹具，绝不清别人的行。 */
  removeRows(table: FixtureTable, ids: readonly string[]): Promise<number>
  close(): Promise<void>
}

export interface HarnessOptions {
  /** 缺省 'sql'。 */
  store?: StoreKind
  /** 缺省从 `DATABASE_URL` 派生；无论从哪来都要过 `_test` 闸。 */
  databaseUrl?: string
}

/** 双引号包裹标识符：表名取自系统目录，但仍不拼接裸标识符。 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * 每例开始前把测试库清空。表名从系统目录动态取，迁移加了表这里不用跟着改；
 * `CASCADE` 处理外键（腿随链路）。不用 pg_dump：备份/恢复比 TRUNCATE 慢几个数量级，
 * 还会把它自己的状态一起搬运。
 *
 * 库里没有业务表说明迁移没跑：这里大声失败，而不是让 app 悄悄回退到内存存储
 * ——「SQL 用例其实在测内存」是最坏的失败方式。
 */
async function truncateBusinessTables(probe: pg.Pool): Promise<void> {
  const tables = await probe.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_migrations'
      ORDER BY tablename`,
  )
  if (!tables.rows.some(row => row.tablename === 'user_favorite_lines')) {
    throw new Error('TEST: 测试库没有业务表（迁移没跑）；先跑 `pnpm test:db`')
  }
  const targets = tables.rows.map(row => `"public".${quoteIdent(row.tablename)}`)
  await probe.query(`TRUNCATE ${targets.join(', ')} CASCADE`)
}

/**
 * 把 pg 的原文换成能照着做的一句话；认不出来的错误原样抛出。
 *
 * 断言连接是这一层与外部世界的唯一接口，因此它出问题时的三句话都在这里。
 */
function explainProbeError(err: unknown): Error {
  const code = (err as { code?: string }).code
  if (code === '3D000') {
    return new Error('TEST: 测试库不存在；先跑 `pnpm test:db`（scripts/test-db.sh）')
  }
  if (code === 'ECONNREFUSED') {
    return new Error('TEST: 连不上 PostgreSQL（宿主端口 15432）；先跑 `docker compose up -d`')
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function createApiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const store: StoreKind = options.store ?? 'sql'

  // 断言用的连接与 app 用的是同一个库：闸在两条路径上都过一遍。
  const databaseUrl = options.databaseUrl
    ? assertTestDatabaseUrl(options.databaseUrl)
    : resolveTestDatabaseUrl()

  const probe = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 })
  try {
    await truncateBusinessTables(probe)
  }
  catch (err) {
    await probe.end()
    throw explainProbeError(err)
  }

  // 内存路径显式不传 databaseUrl —— 走内存是因为没给库，不是因为库不可达。
  const app = await buildApp(store === 'sql' ? { databaseUrl } : {})

  // 上游（车来了/高德）在进程内只有一个入口。默认桩拒绝一切调用：真调上游在 CI 里既慢
  // 又不可复现，还会拿真实密钥打到别人家的服务上。要上游数据的用例自己装 `upstream`。
  const upstream = vi.fn(async (url: unknown) => {
    throw new Error(`TEST: 未桩掉的上游调用 ${String(url)}`)
  })
  vi.stubGlobal('fetch', upstream)

  const run = `fxt-${randomUUID().slice(0, 8)}`
  let closed = false

  return {
    store,
    app,
    upstream,
    inject: async (injectOptions: InjectOptions) => {
      if (app.server.listening) {
        throw new Error('TEST: harness 只做进程内 inject，app 不得 listen（端口就是真实网络）')
      }
      return app.inject(injectOptions)
    },
    rows: async <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => {
      const result = await probe.query<T>(sql, params as any[])
      return result.rows
    },
    fixtureId: (label: string) => `${run}-${label}`,
    removeRows: async (table: FixtureTable, ids: readonly string[]) => {
      if (ids.length === 0) return 0
      const result = await probe.query(
        `DELETE FROM "public".${quoteIdent(table)} WHERE id = ANY($1::uuid[])`,
        [ids],
      )
      return result.rowCount ?? 0
    },
    close: async () => {
      if (closed) return
      closed = true
      try {
        // onClose 钩子会关掉 app 自己的池。
        await app.close()
      }
      finally {
        await probe.end()
        vi.unstubAllGlobals()
      }
    },
  }
}

/**
 * 同一份 spec 主体对两条存储路径各跑一遍。
 *
 * 本项目最大的隐患面就是同时维护两套存储，因此对照是默认形状而不是可选开关：
 * `describeEachStore('…', store => { … })` 里写一次主体，内存与 SQL 各实例化一次。
 */
export function describeEachStore(name: string, spec: (store: StoreKind) => void): void {
  describe.each(STORES)(`[%s] ${name}`, spec)
}
