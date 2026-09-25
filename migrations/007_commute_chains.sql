-- 007: F10 换乘链路（通勤链）—— 链路表 + 乘车段表
--
-- 一条链路 = 起点锚点（家/公司）+ 通勤目的（上班/下班）+ 若干段「线路 + 上车站 + 下车站」。
-- 链路由使用者录入，不由系统规划。
--
-- 接驳段（步行/骑行）不入库：相邻两站的坐标都在线路详情里，耗时由路径服务按
-- 真实距离算；存下来只会与站坐标漂移出第二个事实。
--
-- 乘车段按 seq 排序，N 段设计（当前 UI 只支持首尾接驳 + 两段乘车，放开时不必改模型）。
-- 不存方向列：公交上下行是两个 lineId，方向由 line_id 本身定；地铁两个方向共用
-- 一个 lineId，方向由上/下车的站序推出 —— 所以站序必须存，它同时也是「这一站能
-- 回到线路站序里定位」的凭据（同名站不止一个，且地铁上下行的站序并不相同）。
--
-- 站名与站序成对：站序是定位凭据，站名供显示，缺一不可，未选站时两列同为 NULL
-- （不是空串 —— 空串会读成一个名字为 "" 的站，那是编造出来的站）。

CREATE TABLE IF NOT EXISTS commute_chains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL DEFAULT 'default_user',
    name VARCHAR(64) NOT NULL,
    origin_anchor VARCHAR(8) NOT NULL,
    purpose VARCHAR(8) NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 两个封闭取值各只有两个：写错的锚点或目的不会在这里才被发现，而是当场拒绝。
    CONSTRAINT commute_chains_origin_anchor_check CHECK (origin_anchor IN ('home', 'work')),
    CONSTRAINT commute_chains_purpose_check CHECK (purpose IN ('morning', 'evening'))
);

-- 与列表读取的排序一致：同一用户的链路按 display_order 排，同序按创建时刻收敛。
CREATE INDEX IF NOT EXISTS idx_commute_chains_user_order
    ON commute_chains (user_id, display_order, created_at);

CREATE TABLE IF NOT EXISTS commute_chain_legs (
    chain_id UUID NOT NULL REFERENCES commute_chains (id) ON DELETE CASCADE,
    seq INT NOT NULL,
    line_id VARCHAR(64) NOT NULL,
    line_name VARCHAR(64) NOT NULL,
    city_code VARCHAR(16) NOT NULL DEFAULT '027',
    board_station_name VARCHAR(64),
    board_station_order INT,
    alight_station_name VARCHAR(64),
    alight_station_order INT,
    transfer_extra_minutes INT,
    -- 段在链内的位置就是它的身份：一条链不会有两段同号，也不会留空号。
    PRIMARY KEY (chain_id, seq),
    -- 站名与站序同生同灭，否则「有一半的站」既定位不到也不是未选。
    CONSTRAINT commute_chain_legs_board_station_check
        CHECK ((board_station_name IS NULL) = (board_station_order IS NULL)),
    CONSTRAINT commute_chain_legs_alight_station_check
        CHECK ((alight_station_name IS NULL) = (alight_station_order IS NULL))
);

-- migrate:down
-- 破坏性：会丢失全部已录入的链路与其乘车段。
-- 先删乘车段：它引用链路表，反序才不会撞上外键。
DROP TABLE IF EXISTS commute_chain_legs;
DROP TABLE IF EXISTS commute_chains;
