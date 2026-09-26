import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * API/SQL 层：`pnpm test:api`。用例连的是 `transit_test`（见 scripts/test-db.sh），
 * app 仍装在进程里（`app.inject()`，不开端口）。
 *
 * 与离线快道分开的两个原因：这一层需要迁移跑过的测试库，而快道连数据库都不碰；
 * 以及这一层不能并行跑文件 —— SQL 用例之间靠 TRUNCATE 隔离，并行文件会互相清空对方的行。
 */

// 凭据只有仓库根的 .env 那一份（宿主端口 15432），与 `pnpm dev` 用的相同。
// 部署/CI 里已经导出的环境变量优先：`process.loadEnvFile` 不覆盖已有的键。
const envFile = new URL('../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

/** 只把数据库相关的键显式交给 worker；其余（日志级别等）用进程自带的那份。 */
const databaseEnv: Record<string, string> = {}
for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
  const value = process.env[key]
  if (value) databaseEnv[key] = value
}

// 用例的噪声预算给断言：请求日志默认是 info，一屏 JSON 会把失败信息埋掉。
databaseEnv.LOG_LEVEL = process.env.LOG_LEVEL_TEST ?? 'silent'

export default defineConfig({
  test: {
    include: ['src/__tests__/api/**/*.test.ts'],
    // 一个进程一个库：并行文件会在彼此的行上 TRUNCATE。
    fileParallelism: false,
    // 上游一律桩掉；真跑到上游的那次调用必须在超时前就失败。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: databaseEnv,
  },
})
