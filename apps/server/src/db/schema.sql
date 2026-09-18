-- 1. 支持城市表（运行时可扩充，启动时由静态字典 seed）
CREATE TABLE IF NOT EXISTS transit_cities (
    city_code VARCHAR(16) PRIMARY KEY,
    city_name VARCHAR(64) NOT NULL,
    pinyin VARCHAR(64) NOT NULL DEFAULT '',
    amap_adcode VARCHAR(16),
    support_subway BOOLEAN NOT NULL DEFAULT FALSE,
    hot BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 静态线路元数据缓存表（高德/车来了数据沉淀，避免重复消耗配额）
CREATE TABLE IF NOT EXISTS cached_transit_lines (
    line_id VARCHAR(64) NOT NULL,
    direction INT NOT NULL DEFAULT 0,
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    detail_json JSONB NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'amap',
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (line_id, direction)
);

-- 3. 用户关注线路表
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

-- 4. 通勤情境预设表
CREATE TABLE IF NOT EXISTS user_commute_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL DEFAULT 'default_user',
    profile_name VARCHAR(32) NOT NULL,
    target_line_ids TEXT[] NOT NULL,
    target_station_name VARCHAR(64),
    active_time_start TIME NOT NULL,
    active_time_end TIME NOT NULL,
    direction_rule INT NOT NULL DEFAULT 0
);
