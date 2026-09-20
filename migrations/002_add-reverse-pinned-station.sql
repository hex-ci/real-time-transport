-- 002: 分方向的固定站点
-- 固定站点必须按方向区分：上行与下行停靠城市两端完全不同的站，只存一个会让
-- 反向卡片算错到站时间。pinned_station_name 对应 preferred_direction，
-- reverse_pinned_station_name 对应反向。
-- 地铁两个方向复用同一 lineId，因此不能按 lineId 建模，只能按方向建字段。

ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS reverse_pinned_station_name VARCHAR(64);

-- migrate:down
ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS reverse_pinned_station_name;
