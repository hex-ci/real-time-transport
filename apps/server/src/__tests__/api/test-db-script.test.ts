import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiHarness, resolveTestDatabaseUrl, type ApiHarness } from './support/api-harness.js'

/**
 * 建库脚本的钉子：显式给的名字就是它建的库，不给名字时仍按老规矩派生。
 *
 * `scripts/test-db.sh` 与套件的硬闸是同一条规则的两半 —— 脚本造的名字必须是套件肯连的名字。
 * 这一批起之所以要能显式指定库名（`TEST_DB_NAME`）：每一批工作各用自己那个 `_test` 库，
 * 就不必为了换一个库名去绕路改开发库那一份 `.env`。
 *
 * 钉子只碰两个自己的库名（从本套件的库名派生，故与它、与开发库都不同名），且只读地看第三个；
 * 「拒绝」那一例断言的是**什么都没建**，不是某条消息好看。
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const SCRIPT = 'scripts/test-db.sh'

/** 本套件连的那个库的库名（`_test` 结尾）。 */
function suiteDatabaseName(): string {
  return decodeURIComponent(new URL(resolveTestDatabaseUrl()).pathname.replace(/^\//, ''))
}

const SUITE_DB = suiteDatabaseName()
/** 本钉子造的那一个：从套件的库名派生，故任何一次跑都不会撞上套件自己的库。 */
const PEG_DB = `${SUITE_DB.replace(/_test$/, '')}_script_peg_test`
/** 派生规则那一例用的（不建库）：这个名字不存在，故只报告。 */
const MISSING_DEV_DB = `${SUITE_DB.replace(/_test$/, '')}_script_peg_missing`
/** 不合规的名字：不以 `_test` 结尾。 */
const NON_TEST_DB = `${SUITE_DB.replace(/_test$/, '')}_script_peg_plain`

/** 开发库形状的一条 URL，只换库名 —— 派生规则要看的就是库名。凭据从不打印。 */
function devShapedUrl(name: string): string {
  const base = new URL(process.env.DATABASE_URL ?? resolveTestDatabaseUrl())
  base.pathname = `/${name}`
  return base.toString()
}

interface ScriptRun {
  status: number
  stdout: string
  stderr: string
}

/** 按用法里写的那样调脚本；非零退出与它的 stderr 一起带回来。 */
function runScript(subcommand: string, env: Record<string, string> = {}): ScriptRun {
  try {
    const stdout = execFileSync('bash', [SCRIPT, subcommand], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  }
  catch (err) {
    const failure = err as { status?: number, stdout?: string, stderr?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('建库脚本：显式指定的库名就是它建的库', () => {
  let api: ApiHarness

  beforeAll(async () => {
    // 只要一条连接读 `pg_database`；脚本本身与哪条存储实现无关。
    api = await createApiHarness({ store: 'sql' })
  })

  afterAll(async () => {
    await api?.close()
  })

  async function databaseExists(name: string): Promise<boolean> {
    const rows = await api.rows<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [name],
    )
    return rows.length === 1
  }

  it('TEST_DB_NAME=xxx_test 时，建的是那个库并跑好迁移', async () => {
    expect(PEG_DB.endsWith('_test')).toBe(true)
    const run = runScript('up', { TEST_DB_NAME: PEG_DB })

    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout, 'the script did not name the database it built').toContain(`测试库 ${PEG_DB} @`)
    expect(await databaseExists(PEG_DB), `${PEG_DB} was reported but not created`).toBe(true)

    // 建完就补齐迁移：这不是一个空壳库。
    const migrated = Number(/迁移 (\d+) 条/.exec(run.stdout)?.[1] ?? '0')
    expect(migrated, `the script reported ${migrated} migrations`).toBeGreaterThan(0)
  })

  it('不给名字时仍按老规矩从开发库名派生', () => {
    const run = runScript('status', {
      TEST_DB_NAME: '',
      TEST_DATABASE_URL: '',
      DATABASE_URL: devShapedUrl(MISSING_DEV_DB),
    })

    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(`测试库 ${MISSING_DEV_DB}_test @`)
    // status 只报告：这个名字不存在，故什么都没建。
    expect(run.stdout).toContain('不存在')
  })

  it('已经以 _test 结尾的 URL 照用，不当成「开发库名」拒绝', () => {
    const run = runScript('status', {
      TEST_DB_NAME: '',
      TEST_DATABASE_URL: '',
      DATABASE_URL: resolveTestDatabaseUrl(),
    })

    expect(run.status, `an already-test database URL was refused: ${run.stderr}`).toBe(0)
    expect(run.stdout).toContain(`测试库 ${SUITE_DB} @`)
  })

  it('不是 _test 结尾的名字被拒，且一个库都没建', async () => {
    const run = runScript('up', { TEST_DB_NAME: NON_TEST_DB })

    expect(run.status, 'a database name outside the gate was accepted').not.toBe(0)
    expect(run.stderr).toContain('_test')
    expect(await databaseExists(NON_TEST_DB), 'the refused name was created anyway').toBe(false)
  })
})
