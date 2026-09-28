-- 013: 位置锚点的地点名与来源 —— 「家 / 公司」不再只能靠站在门口抓定位
--
-- 缺陷（结构性）：F2 原先只有一条录入路径（抓一次设备定位），而 `user_settings` 的锚点列
-- 只有坐标。于是两个能力都没有落脚处：
--
--   1. 「我知道这个地方叫什么」（搜索地点）无法成为锚点 —— 而高德的地点搜索返回的坐标
--      **本身就是 GCJ-02**，正是本应用的存储基准（见 docs/PRD.md §5.4）；
--   2. 「这个坐标是从哪来的」无处可查，于是 PATCH 边界只能一律按「原始 WGS-84 设备定位」
--      处理。搜索来的坐标若走同一条路，会被再换算一次 —— 北京两个基准之间的偏移约 500 m，
--      而存下来的仍是一个看着合理的坐标，界面上看不出来（§5.4 那条唯一换算边界）。
--
-- 因此本迁移加四列，成对地加：
--
--   - `home_place_name` / `work_place_name`（TEXT，可空）：搜索来的地点名，供界面认人。
--     没有名字（设备抓的位置没有名字）时界面显示坐标，**绝不编造**一个名字。
--   - `home_anchor_source` / `work_anchor_source`（TEXT，可空，`device` | `search`）：
--     这条契约的凭据。来源决定写入时换不换算：`device` 过 `deviceFixToGcj02` 一次，
--     `search` 原样落库。少了它，一个已经处于 GCJ-02 的坐标会被再换算一次。
--
-- 为什么可空、无默认值：
--   1. NULL 就是「没记过来源」，与本仓库对「未选 / 未记」的一贯口径一致（009 的四个时刻、
--      012 的接驳方式都是 NULL）。`NOT NULL DEFAULT 'device'` 会把存量行说成「它来自设备」——
--      那是替数据做主：013 之前写入的锚点确实都过了设备换算，但这一列从没被写过，而把结论
--      写进列里不会让它更真（同 012 的第 3 条）；
--   2. 读侧对 NULL 的行为是**明确**的：锚点坐标一律是 GCJ-02，故 NULL 与 `device` 在
--      「要不要换算」这个问题上答案相同 —— 但那是读侧的默认，不是这一列的取值；
--   3. 存量行不回填，本迁移不改写任何数据。
--
-- CHECK 只圈定两个已知来源，且允许 NULL（SQL 里 `NULL IN (...)` 是 NULL 而非 FALSE，
-- 故没记过来源的行照常通过）。空串不在两个取值里：它不是「没记」——那是 NULL ——
-- 把它读成「没记过」会把一个没人写过的来源当成记录。
--
-- 可重复执行：`ADD COLUMN IF NOT EXISTS` 对已加过的列是空操作；约束先去掉再加，
-- 故重跑时它不会撞上已存在的同名约束。

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS home_place_name TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_place_name TEXT;

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS home_anchor_source VARCHAR(8);
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_home_anchor_source_check;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_home_anchor_source_check
    CHECK (home_anchor_source IN ('device', 'search'));

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_anchor_source VARCHAR(8);
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_work_anchor_source_check;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_work_anchor_source_check
    CHECK (work_anchor_source IN ('device', 'search'));

-- migrate:down
-- 回滚只去掉这两列的取值约束，**不删列**：四列都是加法，013 之前的所有读侧都不认识它们，
-- 留着它们既不会让谁多读到东西，也不改任何既有行的取值。把列真正去掉的那类语句是运行器
-- 要求显式确认的破坏性操作（见 010 的回滚段如何写它），而这一步刻意不需要那次确认 ——
-- 回滚一条新增的列不该要求操作者确认丢数据，因为本段不丢任何数据。
-- 因此回滚之后库里回到「这四列存在、但来源无人约束」的状态，而 013 之前的**读侧**行为与
-- 回滚前完全相同：应用版本回退到 013 之前时，没有任何代码读写这四列。
-- 本段不改写数据：已记下的地点名与来源是使用者的记录，回滚不得把它抹成 NULL。
-- 可重复执行：DROP CONSTRAINT IF EXISTS 对已经去过的东西是空操作。
-- 回滚后再执行一次本迁移会把两条约束照原样加回来。

ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_home_anchor_source_check;
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_work_anchor_source_check;
