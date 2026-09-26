# 测试的三层

| 层 | 命令 | 依赖 | 跑的是什么 |
|---|---|---|---|
| 0 静态 | `pnpm code-check`（`typecheck` + `lint`） | 无 | 类型与 ESLint，0 warning |
| 1 离线 | `pnpm test` | 无（**不需要数据库**） | 全仓库单元 / 契约用例，服务端跑在内存存储上 |
| 2 API/SQL | `pnpm test:db` → `pnpm test:api` | 跑着 PostgreSQL 的容器 + `transit_test` | 走 HTTP 边界（`app.inject()`），断言真的落在 SQL 上 |
| 3 浏览器 | `pnpm test:e2e` | 容器 + `transit_test_e2e` + 本机 `playwright-cli` | 真浏览器（playwright-cli）对自起的前后端跑六个场景 |

前两层串起来是 `pnpm verify`（`code-check` + `test` + `test:db` + `test:api`），
加上第 3 层是 `pnpm verify:full`。

第 1 层之所以不需要数据库：`databaseUrlFor`（`apps/server/src/db/client.ts`）在测试进程里
（`VITEST` / `NODE_ENV=test`）直接返回 `undefined`，`Database` 从不建连接池。第 2 层需要库，
因此用**单独的命令与单独的 vitest config**（`apps/server/vitest.api.config.ts`）跑，
第 1 层不受影响 —— `pnpm test` 里不会出现任何需要库的用例。

---

## 第 2 层：怎么跑

```bash
pnpm test:db     # 幂等建库 + 跑迁移（等价于 bash scripts/test-db.sh）
pnpm test:api    # 只跑 src/__tests__/api/**，串行、连 transit_test
```

`scripts/test-db.sh` 的子命令：

```bash
bash scripts/test-db.sh          # 缺库则建，然后补齐迁移（重复跑是空操作）
bash scripts/test-db.sh up       # 同上，显式写法
bash scripts/test-db.sh reset    # 删库重建再迁移：schema 改过、要一份干净的库时用
bash scripts/test-db.sh status   # 只报告库名/主机/迁移条数
```

库名怎么定（优先级从高到低）：

```bash
TEST_DB_NAME=transit_gap_test bash scripts/test-db.sh up    # 显式指定；每一批各用自己那个库
TEST_DATABASE_URL=…/transit_gap_test bash scripts/test-db.sh up   # 一条已指向测试库的连接串
bash scripts/test-db.sh up                                  # 都不给：从开发库名派生（老规矩）
```

- 显式指定使多批工作可以各建各的库，不必为了换一个库名去改 `.env`（`transit_test` 是这一套的缺省名字）。
- 库名是 `transit_test`，与开发库同一容器、同一用户（宿主端口 15432），只有库名不同。
- 派生规则只加后缀一次：给一条本身就以 `_test` 结尾的连接串时，用它自己的库名，不再自拒。
- 迁移用的是仓库里那份 `src/db/migrate.ts`，与 `pnpm migrate:up` 同一条路径 —— 开发库那份
  已应用的记录不会被读或写。
- 脚本只打印库名、主机与迁移条数（迁移器自己的逐文件日志只在失败时整段吐出）。

### 硬闸：库名必须以 `_test` 结尾

`assertTestDatabaseUrl`（`src/__tests__/api/support/api-harness.ts`）在每次建 harness 时校验目标
库名，不是 `_test` 结尾就直接拒绝运行 —— 与 `databaseUrlFor` 同一思路：让「测试连到开发库」在
结构上不可能，而不是靠纪律。钉子见 `src/__tests__/api/test-database-gate.test.ts`。

建库脚本与这条闸是同一条规则的两半（脚本造的名字必须是套件肯连的名字），故它也被钉住：
`src/__tests__/api/test-db-script.test.ts` 用 `TEST_DB_NAME` 造一个自己的库、确认建的就是它、
并确认不给名字时仍按老规矩派生、不合规的名字一个库都没建。

```bash
# 拿开发库那一条跑，会立刻被拒（不连、不读、不写）：
TEST_DATABASE_URL='postgres://transit:<pw>@localhost:15432/transit' pnpm test:api
# Error: TEST: 拒绝连接库「transit」：测试库名必须以 _test 结尾
```

连哪一条库由 `resolveTestDatabaseUrl` 决定：`TEST_DATABASE_URL` 优先，否则从开发库的
`DATABASE_URL` 派生出 `<库名>_test`（配置从仓库根的 `.env` 读，CI 里已导出的环境变量优先）。
派生出来的名字同样过闸。

---

## 怎么加一个新的功能点 spec

新建 `apps/server/src/__tests__/api/<功能点>.test.ts`：

```ts
import { afterEach, beforeEach, it, expect } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

describeEachStore('关注线路', (store) => {
  let api: ApiHarness

  // 每例一条全新的 app 与连接池：上一条用例的行不会渗进来（库里 TRUNCATE ... CASCADE，
  // 内存路径本来就是新的实例）。`?.` 只应付 beforeEach 自己失败那一次。
  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  it('关注后库里真的有一行', async () => {
    const lineId = api.fixtureId('line')          // 统一前缀的夹具 id
    const res = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { cityCode: '027', lineId, lineName: '某线路', reverseLineId: `${lineId}-r` },
    })
    expect(res.statusCode, res.body).toBe(200)

    const rows = await api.rows('SELECT id FROM user_favorite_lines WHERE line_id = $1', [lineId])
    expect(rows, store === 'sql' ? '关注没落到库里' : '内存路径不该在库里留下行')
      .toHaveLength(store === 'sql' ? 1 : 0)
  })
})
```

harness 的接口（`src/__tests__/api/support/api-harness.ts`）：

| 成员 | 说明 |
|---|---|
| `describeEachStore(名字, spec)` | 同一份主体对 `memory` 与 `sql` 各跑一遍（默认形状，不是可选开关） |
| `createApiHarness({ store, databaseUrl? })` | 建 app + 断言用的连接；库名过 `_test` 闸；开工前 TRUNCATE |
| `api.store` | `'memory' \| 'sql'`，差分断言按它分支 |
| `api.inject({ method, url, payload })` | 进程内 `app.inject()`：**不开端口、不发真实网络**（app 一旦 listen 就抛错） |
| `api.rows(sql, params?)` | 裸 pg 读测试库，不经过 app 的读映射 —— 「真的在 SQL 上」靠它断言 |
| `api.upstream` | 上游（车来了/高德）唯一的入口：默认**拒绝一切调用**的 fetch 桩；要上游数据的用例自己装回答 |
| `api.fixtureId(标签)` | 本用例的夹具前缀，一眼可辨是这一次跑出来的行 |
| `api.removeRows(表, ids)` | 按 id 精确删自己的夹具，绝不清别人的行 |
| `api.app` | 需要更多 fastify 能力时直接用（路由注册、钩子） |
| `api.close()` | 关 app 的池与断言连接 |

隔离与清洁：每例开始前对测试库 `TRUNCATE ... CASCADE`，表名从 `pg_tables` 动态取（迁移加了表
不用改这里），`_migrations` 除外 —— 清它会让下一次 `migrate:up` 重放全部迁移。不走 `pg_dump`：
备份/恢复比 TRUNCATE 慢几个数量级，还会把它自己的状态一起搬运。

---

## 失败时怎么定位

| 症状 | 原因 | 处置 |
|---|---|---|
| `TEST: 拒绝连接库「transit」…` | 环境变量/命令把测试指向了开发库 | 改成 `_test` 结尾的库；不要绕过闸 |
| `TEST: 测试库不存在；先跑 pnpm test:db` | 库还没建（或 `reset` 到一半） | `pnpm test:db` |
| `TEST: 测试库没有业务表（迁移没跑）` | 库在但迁移没跑 | `pnpm test:db` |
| `ECONNREFUSED 127.0.0.1:15432` | 容器没起来 | `docker compose up -d`（容器名 `real-time-transport-postgres`） |
| `TEST: 未桩掉的上游调用 <url>` | 用例真的去调上游了 | 用 `api.upstream.mockImplementation(...)` 装回答；真调上游在 CI 里既慢又不可复现 |
| 只有 `[sql]` 实例失败 | SQL 分支的行为与内存不同 —— 这正是这一层存在的理由 | 看真实断言：迁移缺列/缺索引、`ORDER BY` 没收敛、唯一索引拒绝写入 |
| 两条实例都失败 | 路由或契约本身的问题 | 先看第 1 层同一个功能点的用例，再回来 |
| `pnpm test` 变慢或报连不上库 | 有 API 用例被收进了快道 | 用例要放在 `src/__tests__/api/**`；`apps/server/vitest.config.ts` 里排除了这个目录 |
| 偶发互相清空数据 | 文件被并行了 | `vitest.api.config.ts` 的 `fileParallelism: false` 不能去掉（SQL 用例靠 TRUNCATE 隔离） |

开发库 `transit` 任何时候都不该被这套东西连上：第 2 层只 TRUNCATE `transit_test`，`transit` 的
读写在硬闸之外不存在。第 1 层连 `pg.Pool` 都不建。

---

## 第 3 层：怎么跑

```bash
pnpm test:e2e                    # 全部六个场景
node tests/e2e/run.mjs --only 首页卡片
node tests/e2e/run.mjs --red 首页卡片   # 红灯演示：故意改坏被测行为，证明这个场景真的会红，再复原
```

自己起、自己停，跑完不留进程：

| 东西 | 值 | 为什么 |
|---|---|---|
| 后端 | 端口 `25282` | 开发机上的开发服务在 25181/25182，**这两个端口一律不碰** |
| 前端 | `VITE_PORT=25281`，代理 `/api`、`/ws` 到 25282 | 与 `apps/web/vite.config.ts` 的代理关系一致 |
| 数据库 | `transit_test_e2e`（容器里，宿主 15432） | 与开发库 `transit` 分开；库名与开发库同名时**拒绝启动** |
| 上游 | 车来了 / 高德真连，且 `TRANSIT_SIMULATION=true` | 无在途车时由模拟器生成车辆，故任何钟点都有可断言的行 |
| 浏览器 | 本机 `playwright-cli`（会话名 `rt-e2e`） | 不自带 playwright 依赖：命令走 CLI，收尾必定关掉浏览器 |

夹具**只经该实例自己的 HTTP 接口**造：关注线路、上车点、锚点、通勤时段、通勤链路各一次
`POST`/`PATCH`。挑哪一站不猜：从实时载荷里找「车还没到本站、且同一辆车在两站都定了价」的一对
站序，链路因此能真的推出结论，而不是被夹具自己弄成拒绝。

六个场景（`tests/e2e/scenarios/`）：

| 场景 | 钉住的行为 |
|---|---|
| 首页卡片 | 卡片上的车辆数与分钟就是接口载荷里的那些；数据源没给分钟时不出现数字；点卡片进得去详情 |
| 线路详情 | 切方向后站点列表换成另一个方向的站表；「设为上班上车点」写出的请求体里方向 = 屏幕上显示的方向（请求体级断言） |
| 站台大屏 | 刷新期间屏上的行留在同一个 DOM 节点上；「最后更新」是响应自己的 `updatedAt`；带目标站才给分钟，没给分钟就只说「暂无到站耗时」 |
| 通勤链路页 | 每段的等待 / 车程 / 下车分钟 / 余量与档位词对着**页面收到的那一份**应答比；按目的筛选；首次进入的默认页签跟随通勤时段 |
| 设置页 | 四个子页可达；链路列表拖动排序后顺序保持（当场、刷新后、服务端三处都比）；站点选择器带直线距离与「最近」；移动端线路详情头部有上下班方向标识 |
| 移动端可访问性 | 375×667 下无横向溢出；可见文字就是控件的名字、只有图标的控件自带名字；主控件（本仓写死 ≥44px 的那些）触控目标 ≥44px |

两处刻意的例外，写在这里而不是藏在断言里：

- 触控目标只断言**主控件**。本仓有若干处刻意更小的控件（城市切换 40px、通勤模式切换 32px、
  移动端线路头部的图标按钮 28–32px、画布上的「折返」42×16），它们被**测量并打印**在场景输出里，
  不做断言 —— 把已知例外混进断言，「够大」那条会因为一处例外永远为红，也就不再说明任何事。
- 控件的名字按「显式名字（aria-label/title/alt）优先，其次可见文字」取。按钮上写当前值、名字说
  这个动作是什么（如城市切换写「北京」、名字「选择城市」）是刻意的，故这类控件只打印不判红。

失败时怎么定位：

| 症状 | 原因 | 处置 |
|---|---|---|
| `拒绝运行：e2e 库名…` | 库名与开发库同名 / 不以 `_test` 结尾 | 别改这个库名，它是第 3 层的隔离面 |
| `后端/前端在 …ms 内没就绪` | 端口被占、或迁移没跑起来 | 看它打印的服务日志（后端日志与前端日志都随错误带出） |
| `容器 … 没有运行` | PostgreSQL 没起 | `docker compose up -d` |
| 场景等某个条件超时 | 上游真的没答（网络/额度） | 看 note 行里打印的载荷与屏幕文本；夹具依赖上游能答 |
| `--red` 说「居然还是绿的」 | 这条断言抓不到那个改坏 | 断言要么加强，要么它本来就没在区分行为 |
