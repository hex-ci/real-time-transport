-- 005: 通勤方向显式化
--
-- 方向不再从两个上车点的站序反推，改为用户显式选择。
--
-- 反推的问题：它假设「上班上车点 + 下班上车点」能唯一定出方向，但两个方向
-- 的站名并不完全一致（913 有 4 个站只在其中一个方向停靠），且反推结果与设置页
-- 展示的方向可以矛盾 —— 用户看到的下拉框属于 preferred_direction，卡片却按
-- 反推结果取另一个方向。方向是用户真正知道的事实，不该猜。
--
-- 两列均可为 NULL，且 NULL 与 0 含义不同：
--   NULL = 用户尚未选择该用途的方向（UI 要求先选方向才允许选上车点）
--   0/1  = 该用途乘坐的方向
--
-- preferred_direction 语义不变：它仍标记「哪个 lineId 是 dir0」，是 lineId 的
-- 锚点（resolveFavoriteLineId 依赖它），并在用户未设通勤方向时充当显示默认。

ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS morning_direction INT;
ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS evening_direction INT;

-- migrate:down
ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS evening_direction;
ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS morning_direction;
