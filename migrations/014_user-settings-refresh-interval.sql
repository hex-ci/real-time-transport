-- 014: 实时数据刷新间隔 —— 让用户可调整个系统的实时性
--
-- 背景：服务端有三处写死的 18 秒，构成一条"实时节拍链"：
--   1. TransitService 的轮询间隔（拉上游 + WS 推送的节拍）—— .env 里有
--      TRANSIT_POLL_INTERVAL_SEC，但 index.ts 从没把它传进 buildApp()，改了不生效；
--   2. TransitAggregator 的 LIVE_CACHE_TTL_MS（18s 硬编码）—— 轮询调快了也会被
--      缓存挡住，照样 18 秒才新一次，这是真正的硬限制；
--   3. 手动刷新的冷却窗口 REFRESH_COOLDOWN_MS（= TTL）—— 防刷上游的保护。
-- 三者必须同源：TTL 短于轮询是浪费，冷却与节拍脱钩则语义混乱。
--
-- 因此加一列 `refresh_interval_sec`（INTEGER，可空，单位秒），由设置页写入；
-- 服务端三处全部从它推导。NULL 就是"没选过"，读侧回退 18s —— 与本仓库
-- "NULL 即未记"（009 的时刻、013 的锚点来源）同一口径。
--
-- 为什么可空、无默认值：NOT NULL DEFAULT 18 会把"用户从未调过"说成"用户选了 18"，
-- 那是替数据做主；而读侧对 NULL 的回退是明确的（18s），两者行为一致，无需把结论写进列里。
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS refresh_interval_sec INTEGER NULL;

-- migrate:down
-- 回滚不删列（加法列，013 的先例）：只去掉取值约束的说明，本段实际无操作 ——
-- 列的取值范围由应用层 schema（10~120）保证，库里不加 CHECK 是刻意的：
-- 读侧对越界值的回退（钳制到 10~120）与"未设置"的回退走同一条路，见 TransitService。
-- 本段不改写数据：已记下的间隔是使用者的选择，回滚不得把它抹成 NULL。
-- 可重复执行：ADD COLUMN IF NOT EXISTS 对已有的列是空操作。
SELECT 1;
