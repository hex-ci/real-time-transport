#!/usr/bin/env bash
#
# 测试库：`transit_test` —— 与开发库分开，同一个 Postgres 容器，宿主端口 15432。
#
# API 层用例（apps/server/src/__tests__/api/**）连的就是这个库；库名以 `_test` 结尾是硬闸
# （见 apps/server/src/__tests__/api/support/api-harness.ts），因此本脚本造出来的库名
# 与套件接受的名字必须是同一个。
#
# 用法：
#   bash scripts/test-db.sh           # 幂等：缺库则建，然后补齐迁移（等同 up）
#   bash scripts/test-db.sh up        # 同上；显式子命令供脚本/CI 调用
#   bash scripts/test-db.sh reset     # 删库重建再迁移：schema 改过、要一份干净的库时用
#   bash scripts/test-db.sh status    # 只报告现状，不动任何东西
#
# 库名（优先级从高到低）：
#   TEST_DB_NAME=xxx_test bash scripts/test-db.sh up    # 显式指定：每一批用自己那个库
#   TEST_DATABASE_URL=…/xxx_test bash scripts/test-db.sh up   # 一条已经指向测试库的连接串
#   bash scripts/test-db.sh up                          # 都不给：从开发库名派生（老规矩）
#
# 只打印库名、主机与迁移条数。连接串里的凭据任何时候都不打印；迁移器自己的逐文件日志
# 只在失败时整段吐出（那时更需要看清是哪一条）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${TEST_DB_CONTAINER:-real-time-transport-postgres}"
COMMAND="${1:-up}"

BASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-}}"
# 环境里没有就取仓库根的 .env（`pnpm dev` 用的同一份）。取到之后只解析、不打印。
if [[ -z "$BASE_URL" && -f "$REPO_ROOT/.env" ]]; then
  BASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env" | head -n1 | cut -d= -f2-)"
fi
if [[ -z "$BASE_URL" ]]; then
  echo "test-db: 未找到 DATABASE_URL（环境变量或 $REPO_ROOT/.env）" >&2
  exit 1
fi

# 连接串只经手 node 的 URL 解析：密码从不落到 shell 变量里被 echo 出去。
url_field() {
  node -e '
    const u = new URL(process.argv[1])
    const picked = {
      host: u.hostname,
      port: u.port || "5432",
      db: decodeURIComponent(u.pathname.replace(/^\//, "")),
      user: decodeURIComponent(u.username),
    }[process.argv[2]]
    process.stdout.write(picked ?? "")
  ' "$BASE_URL" "$1"
}

test_url_of() {
  node -e '
    const u = new URL(process.argv[1])
    u.pathname = "/" + process.argv[2]
    process.stdout.write(u.toString())
  ' "$BASE_URL" "$TEST_DB"
}

DB_HOST="$(url_field host)"
DB_PORT="$(url_field port)"
DB_NAME="$(url_field db)"
DB_USER="$(url_field user)"
[[ -n "$DB_HOST" && -n "$DB_NAME" && -n "$DB_USER" ]] || {
  echo "test-db: 无法从 DATABASE_URL 解析出 host/db/user" >&2
  exit 1
}

# 与套件的硬闸同一条规则：本脚本造的名字必须是套件肯连的名字。
# 已经以 `_test` 结尾的库名照用（那是测试库自己的名字，不是「开发库名 + 后缀」）。
# 名字还要过一道字符集闸：它会被拼进 `CREATE DATABASE`，引号与分号不该进得来。
TEST_DB="$(node -e '
  const [explicit, testUrl, baseUrl] = process.argv.slice(1)
  const nameOf = (raw) => decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""))
  if (explicit) process.stdout.write(explicit)
  else if (testUrl) process.stdout.write(nameOf(testUrl))
  else {
    const name = nameOf(baseUrl)
    process.stdout.write(name.endsWith("_test") ? name : name + "_test")
  }
' "${TEST_DB_NAME:-}" "${TEST_DATABASE_URL:-}" "$BASE_URL")"

if [[ "$TEST_DB" != *_test ]]; then
  echo "test-db: 拒绝使用库名 '$TEST_DB'：测试库名必须以 _test 结尾" >&2
  exit 1
fi
if [[ ! "$TEST_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "test-db: 拒绝使用库名 '$TEST_DB'：只接受字母、数字与下划线" >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1; then
  echo "test-db: 容器 $CONTAINER 未运行；先跑 docker compose up -d" >&2
  exit 1
fi

# 容器内的 psql 走 unix socket（trust），因此不需要密码；-tA 只取值，便于判断。
# 维护库固定用 postgres：CREATE/DROP DATABASE 要连在别的库上，而开发库一格都不碰。
psql_value() {
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$1" -tAc "$2"
}

db_exists() {
  [[ "$(psql_value postgres "SELECT 1 FROM pg_database WHERE datname = '$TEST_DB'")" == "1" ]]
}

migration_count() {
  psql_value "$TEST_DB" 'SELECT count(*) FROM _migrations' 2>/dev/null || echo 0
}

run_migrations() {
  local log
  # migrate.ts 读 DATABASE_URL。给它测试库那一条；失败时把完整日志留给读日志的人。
  if ! log="$(cd "$REPO_ROOT/apps/server" && DATABASE_URL="$(test_url_of)" pnpm exec tsx src/db/migrate.ts up 2>&1)"; then
    echo "test-db: 迁移失败" >&2
    echo "$log" >&2
    exit 1
  fi
}

report() {
  local total delta="$2"
  total="$(migration_count)"
  if [[ -z "$delta" ]]; then
    echo "测试库 $TEST_DB @ $DB_HOST:$DB_PORT  迁移 $total 条"
  else
    echo "测试库 $TEST_DB @ $DB_HOST:$DB_PORT  迁移 $total 条（本次新增 $delta）"
  fi
}

case "$COMMAND" in
  up)
    if ! db_exists; then
      psql_value postgres "CREATE DATABASE \"$TEST_DB\"" >/dev/null
      echo "test-db: 已创建 $TEST_DB"
    fi
    before="$(migration_count)"
    run_migrations
    report "$TEST_DB" "$(( $(migration_count) - before ))"
    ;;
  reset)
    psql_value postgres "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)" >/dev/null
    psql_value postgres "CREATE DATABASE \"$TEST_DB\"" >/dev/null
    run_migrations
    report "$TEST_DB" "$(migration_count)"
    ;;
  status)
    if ! db_exists; then
      echo "测试库 $TEST_DB @ $DB_HOST:$DB_PORT  不存在"
      exit 0
    fi
    report "$TEST_DB" ""
    ;;
  *)
    echo "用法: bash scripts/test-db.sh [up|reset|status]" >&2
    exit 1
    ;;
esac
