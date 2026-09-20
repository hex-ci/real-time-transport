-- 001: 关注线路表 + 静态线路缓存表（基线）
-- 收敛自 src/db/client.ts 原有的内联 DDL，此处成为唯一权威定义。
-- 这是既有部署的表结构基线：对已有库为幂等空操作，新库由此建立初始结构。
-- 后续结构变更一律新增编号迁移文件，不再改写本文件。

CREATE TABLE IF NOT EXISTS user_favorite_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL DEFAULT 'default_user',
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    line_id VARCHAR(64) NOT NULL,
    line_name VARCHAR(64) NOT NULL,
    preferred_direction INT NOT NULL DEFAULT 0,
    reverse_line_id VARCHAR(64),
    pinned_station_name VARCHAR(64),
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cached_transit_lines (
    line_id VARCHAR(64) NOT NULL,
    direction INT NOT NULL DEFAULT 0,
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    detail_json JSONB NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'amap',
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (line_id, direction)
);

-- migrate:down
-- 破坏性：会丢失全部关注线路与静态缓存。
DROP TABLE IF EXISTS cached_transit_lines;
DROP TABLE IF EXISTS user_favorite_lines;
