# AGENTS.md — real-time-transport

移动端优先的实时公交/地铁可视化单仓（pnpm monorepo）。`packages/shared`（Zod 契约、城市字典）、`packages/transit-adapter`（数据源 providers、AMap GIS、坐标转换）、`apps/server`（Fastify 5 + WS + PostgreSQL 18，轮询并广播）、`apps/web`（Vue 3 + Vite 8 + Tailwind 4 + Pinia + Konva 报站屏）。产品权威文档是 `docs/PRD.md`。

## 环境与启动

- Node `>=22`，包管理器 pnpm（workspace：`apps/*`、`packages/*`）。
- 环境变量只有根目录一份权威源：复制 `.env.example` → `.env`。服务端脚本经 `--env-file-if-exists=../../.env` 读取，前端经 Vite `envDir` 读根目录；`apps/*` 下不放独立 `.env`。
- 关键变量（只看名字）：`DATABASE_URL`、`DB_PORT`、`AMAP_MAPS_API_KEY`（Web 服务 key，只在服务端用）、`APIZERO_KEY`、`PORT`/`VITE_PORT`（默认 3000/5173）、`VITE_HOST`、`HOST`、`WS_PATH`、`LOG_LEVEL`、`TRANSIT_POLL_INTERVAL_SEC`、`TRANSIT_SIMULATION`。
- 启动：`docker compose up -d`（PostgreSQL）→ `pnpm dev`（后端 + Vite 一起，入口 `scripts/dev.js`）。
- 仓库是公开的：提交的配置只用默认端口，真实凭据/局域网地址只留在未跟踪的 `.env`。

## 命令（逐字）

- `pnpm dev` / `pnpm dev:web` / `pnpm dev:server`
- `pnpm code-check` — 并行跑 `typecheck` + `lint`（`eslint . --max-warnings 0`，0 警告才算过）
- `pnpm test` — `pnpm -r test`（Vitest，不需要数据库）
- `pnpm test:db` — `bash scripts/test-db.sh`：建/迁移测试库 `transit_test`（库名必须以 `_test` 结尾，是硬闸）
- `pnpm test:api` — 服务端 API/SQL 层用例，依赖 `test:db` 先跑过
- `pnpm test:e2e` — `node tests/e2e/run.mjs`（浏览器 e2e）
- `pnpm verify` = `code-check` + `test` + `test:db` + `test:api`；`pnpm verify:full` 再加 e2e
- `pnpm build` = `code-check` + `pnpm -r build`
- `pnpm migrate:up` / `pnpm migrate:down`
- 完成标准：`pnpm code-check` + `pnpm test` + `pnpm build` 全绿，且每条都真的跑过（`--filter` 匹配不到包会静默退出 0）。

## 约定（代码里实际遵守的）

- Commit：`<type>(<scope>): 中文描述`，type 用 `feat/fix/refactor/docs` 等，如 `feat(follow): 附近模式补方向切换与保存 toast`。
- SFC 块顺序：`<script>` → `<template>` → `<style>`；注释用中文、克制，只写代码表达不了的约束。
- `async`/`await` 唯一选择：`.then()` 被 ESLint `no-restricted-syntax` 直接拒，`code-check` 会红。
- 测试文件也进类型检查：`apps/web/tsconfig.test.json`、`apps/server/tsconfig.test.json` 用 `exclude: []` 把 `__tests__` 收回；契约加了必填字段就把夹具补真实字段，不许 `any` / `@ts-ignore` / 删断言换绿。
- `tsconfig*.json` 是 JSONC（带注释），`write_file`/`patch` 的严格 JSON 校验会拒写——改它用普通文件写。
- 数据库 schema 只由 `migrations/` 拥有，编号递增，不许第二处 DDL。
- UI 层不出现数据源名（chelaile/apizero 等）与技术黑话；AMap key 只在 Node 层经 `AmapGisService` 走 REST，浏览器端永远没有。
- 坐标：站列表是 GCJ-02，chelaile 车辆/路径是 WGS-84，浏览器定位是 WGS-84——WGS→GCJ 转换只在 HTTP 边界做一次，站点坐标绝不二次转换。

## 坑

- 跑门禁期间工作树只读：`docs/PRD.md` 与 `tests/prd-coverage.md` 被服务端测试读取，中途改动会让那一轮结论作废（即使绿）。
- 没有 `.github/`（无 CI），`pnpm verify` 就是本地门禁。
- `.env` 在 `.gitignore` 里但门禁/启动都依赖它存在；`test-db.sh` 找不到 `DATABASE_URL` 会直接退出 1。
- `docker-compose.yml` 用 `'${DB_PORT:-5432}:5432'` 暴露端口，`.env` 里的 `DB_PORT` 改了之后宿主端口跟着变，连不上时先查这里。
- `packages/*` 没有 build 步骤（`build` 只有 server 的 `tsc --noEmit` 与 web 的 `vite build`）。
- `pnpm dev` 的 Ctrl+C 退出链是手工接的（WS/keep-alive 排空），别用 `run-p` 套 `pnpm --filter` 改写它。
