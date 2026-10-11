-- 015: 关注线路加「关注站」—— 按方向各存一个 (站名, 站序)，时间无关。
--
-- 背景：morning/evening 上车点是时间绑定的（通勤时段用）；「关注站」是常规实时公交
-- 功能（对标车来了的站点关注）：非通勤时段、异地查线时，卡片锚点不再只能依赖 GPS。
-- 附近模式卡片锚点链：GPS最近站(≤3km) → 关注站[方向] → 早/晚通勤上车站。
--
-- 站的身份是 (站名, 站序) 一对（见 010）：上下行站名经常不同（路口东/路口西），
-- 环线还有同名多站，故按方向各存一对，沿用 010 的可空双列模式。
--   followed_station_name_0  + followed_station_order_0  → 方向 0 的关注站
--   followed_station_name_1  + followed_station_order_1  → 方向 1 的关注站
--
-- 两列可空、无 CHECK：未设置是合法状态，回退链跳过它。

ALTER TABLE user_favorite_lines
  ADD COLUMN IF NOT EXISTS followed_station_name_0 TEXT,
  ADD COLUMN IF NOT EXISTS followed_station_order_0 INTEGER,
  ADD COLUMN IF NOT EXISTS followed_station_name_1 TEXT,
  ADD COLUMN IF NOT EXISTS followed_station_order_1 INTEGER;
