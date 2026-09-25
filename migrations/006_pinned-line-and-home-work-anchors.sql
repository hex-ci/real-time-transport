-- 006: 关注线路支持置顶（同时只能一条）；user_settings 增加家/公司位置锚点

ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- 同时只能置顶一条：只约束 is_pinned = TRUE 的行，未置顶行不受影响
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pinned_favorite_per_user
    ON user_favorite_lines (user_id)
    WHERE is_pinned;

-- DOUBLE PRECISION 而非 NUMERIC：pg 驱动把 NUMERIC 读成字符串，
-- 而契约层 lat/lng 是 number，用 NUMERIC 会引入静默的类型转换。
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_lat DOUBLE PRECISION;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS work_lng DOUBLE PRECISION;

-- migrate:down
DROP INDEX IF EXISTS uniq_pinned_favorite_per_user;
ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS is_pinned;
ALTER TABLE user_settings DROP COLUMN IF EXISTS home_lat;
ALTER TABLE user_settings DROP COLUMN IF EXISTS home_lng;
ALTER TABLE user_settings DROP COLUMN IF EXISTS work_lat;
ALTER TABLE user_settings DROP COLUMN IF EXISTS work_lng;
