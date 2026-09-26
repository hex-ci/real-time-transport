-- 012: 通勤链路的接驳方式入库（步行 / 骑行）—— 每段乘车段各一份
--
-- 缺陷（结构性）：引擎早就会按方式计价（`packages/shared/src/commute-chain.ts` 的
-- `ChainConnectionMode`：骑行在骑行时长之外还要加上找车与停车的 `DEFAULT_CYCLE_EXTRA_MINUTES`），
-- 而库里没有这一列 —— 于是服务端把这 5 处接驳一律按 `'walk'` 装配，
-- 使用者即使想要骑行，也只会得到按步行定价的余量：一段本来骑车的接驳被算成步行，
-- 而这正好会把「赶不上」显示成「充裕」。这是具名缺口，不是测量结果。
--
-- 粒度 = **进入每一段乘车段的那一段接驳**：引擎的模型就是每段一份（`ChainLegInput.connectionMode`），
-- 故一条链路里可以一段走路、一段骑车，列因此挂在 `commute_chain_legs` 上而不是 `commute_chains` 上。
--
-- 为什么可空、无默认值：
--   1. NULL 就是「没选过」，与本仓库对「未选」的一贯口径一致（站名 / 站序未选是 NULL，
--      设置里的四个通勤时刻自 009 起也是 NULL）。写成 `NOT NULL DEFAULT 'walk'` 会把
--      「从没选过」在库里存成「他选了步行」——两个状态此后读起来字节相同，与 004 的
--      默认时刻被 009 拆掉的是同一个缺陷；
--   2. 没选过时的行为仍是**步行计价**，但那是引擎的读侧默认（`?? 'walk'`），不是这一列的取值：
--      一个默认值会让「谁都没选过」这件事无处可查；
--   3. 存量行不回填：它们确实没录过方式，按步行读正是本版本一直在做的事，把结论写进列里
--      不会让它更真。本迁移不改写任何数据。
--
-- CHECK 只圈定两个已知方式，且允许 NULL（SQL 里 `NULL IN (...)` 是 NULL 而非 FALSE，
-- 故未选过的行照常通过）。空串不在两个取值里：它不是「没选」——那是 NULL ——
-- 把它读成「没选过」会把一个没人做过的选择当成使用者的选择。
--
-- 可重复执行：`ADD COLUMN IF NOT EXISTS` 对已加过的列是空操作；约束先去掉再加，
-- 故重跑时它不会撞上已存在的同名约束。

ALTER TABLE commute_chain_legs ADD COLUMN IF NOT EXISTS connection_mode VARCHAR(8);
ALTER TABLE commute_chain_legs DROP CONSTRAINT IF EXISTS commute_chain_legs_connection_mode_check;
ALTER TABLE commute_chain_legs ADD CONSTRAINT commute_chain_legs_connection_mode_check
    CHECK (connection_mode IN ('walk', 'cycle'));

-- migrate:down
-- 回滚只去掉这一列的取值约束，**不删列**：列是加法，012 之前的所有读侧都不认识它，
-- 留着它既不会让谁多读到东西，也不改任何既有行的取值。把列真正去掉的那类语句是运行器
-- 要求显式确认的破坏性操作（见 010 的回滚段如何写它），而这一步刻意不需要那次确认 ——
-- 回滚一条新增的列不该要求操作者确认丢数据，因为本段不丢任何数据。
-- 因此回滚之后库里回到「这列存在、但无人约束它」的状态，而 012 之前的**读侧**行为与
-- 回滚前完全相同：应用版本回退到 012 之前时，没有任何代码读写这一列。
-- 本段不改写数据：已选的步行 / 骑行是使用者的记录，回滚不得把它抹成 NULL。
-- 可重复执行：DROP CONSTRAINT IF EXISTS 对已经去过的东西是空操作。
-- 回滚后再执行一次本迁移会把约束照原样加回来。

ALTER TABLE commute_chain_legs DROP CONSTRAINT IF EXISTS commute_chain_legs_connection_mode_check;
