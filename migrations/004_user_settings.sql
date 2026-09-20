-- 004: 用户全局设置表
-- 用户级偏好的单一落点（当前只有通勤时段，未来锚点等全局配置都进这张表，
-- 不再为每个偏好单独迁移）。单行表，user_id 主键。
-- 通勤时段用于首页「上班/下班/附近」三态的默认选择，不参与方向推导
-- （方向只由两个上车点的站序决定）。

CREATE TABLE IF NOT EXISTS user_settings (
    user_id VARCHAR(64) PRIMARY KEY DEFAULT 'default_user',
    morning_start TIME NOT NULL DEFAULT '06:30',
    morning_end TIME NOT NULL DEFAULT '11:30',
    evening_start TIME NOT NULL DEFAULT '17:00',
    evening_end TIME NOT NULL DEFAULT '22:00',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down
DROP TABLE IF EXISTS user_settings;
