-- 016: 地铁时刻表缓存（线路 × 方向 × 日型）
--
-- 一行 = 一条线的一个方向、一个日型的整条时刻表。按线路整条存而不是按站拆行：
-- 引擎装载一条线时要全部站点（站台列表、动画、到站预测），按站存会变成几十倍行数。
-- 主键不带 service_date：每个日型只保留最新一份；service_date 用于审计与新鲜度判断。
--
-- 这是可丢弃的缓存，不是权威数据：写入成功覆盖同主键旧行，写入失败保留旧行，
-- 读取方按 fetched_at 判断是否过期。表可以随时 truncate，不会丢用户数据。

CREATE TABLE IF NOT EXISTS subway_timetable_cache (
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    line_id VARCHAR(64) NOT NULL,
    sub_line_id INTEGER NOT NULL,
    direction INTEGER NOT NULL,
    day_type VARCHAR(16) NOT NULL,
    service_date DATE,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (city_code, line_id, sub_line_id, day_type),
    CONSTRAINT subway_timetable_cache_direction_check CHECK (direction IN (0, 1)),
    CONSTRAINT subway_timetable_cache_day_type_check CHECK (day_type IN ('workday', 'weekend'))
);

-- 刷新扫描按「当前日型 + 过期时间」取行。
CREATE INDEX IF NOT EXISTS idx_subway_timetable_cache_fetched_at
    ON subway_timetable_cache (day_type, fetched_at);

-- migrate:down
-- 破坏性：这是纯缓存表，回滚直接删表；用户收藏等真实数据不在此表。
DROP TABLE IF EXISTS subway_timetable_cache;
