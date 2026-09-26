import { defineConfig } from 'vitest/config'

/**
 * 离线快道：`pnpm test`（以及 `pnpm -r test`）跑的就是它。
 *
 * 它到不了数据库 —— `databaseUrlFor` 在测试进程里（VITEST / NODE_ENV=test）返回 undefined，
 * 于是 `Database` 从不建连接池，用例跑在内存存储上，不需要任何外部服务。
 *
 * API/SQL 层（`src/__tests__/api/**`）在这里被排除：它们需要 migration 跑过的 transit_test，
 * 与「快道不依赖任何外部服务」是两件事，分开跑（见 tests/README.md）。
 *
 * exclude 是 vitest 的默认清单加上一条 —— 设了 exclude 就会整个替换默认值，
 * 因此默认的那几项必须原样带上。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'src/__tests__/api/**',
    ],
  },
})
