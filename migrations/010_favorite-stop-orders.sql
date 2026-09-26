-- 010: 关注线路的上车点补上「站序」—— 站的身份是 (站名, 站序) 一对
--
-- 缺陷（实测）：设置页的站点 picker 对同名站给出两个选项（300内 方向 0 的「和平东桥」在
-- 第 1 站与第 36 站，环线的首末站，两个站台相隔 194 m，上游给的是同一个 station id）。
-- 使用者选了第 36 站，而库里只留下一个名字 —— pinned_station_name 一列。于是每个读侧消费者
-- 都只能按名字在方向的站点表里 `find`，取到**第一个**同名站：他选的物理站被换成另一个，
-- 步行时间、到站分钟、整条出门结论都按另一站算，而屏幕上没有任何一处说这件事。
--
-- 本仓库对「站」的既有契约是 **(站名, 站序) 一对**：007 的 commute_chain_legs 把站名与站序
-- 成对存下（`CHECK ((name IS NULL) = (order IS NULL))`），因为同名站不止一个、且地铁上下行的
-- 站序并不相同 —— 「这一站能回到线路站序里定位」的凭据就是站序。关注线路的这两个上车点列
-- 是这条契约的漏网者：它们只存了名字。这条迁移把它们补齐。
--
--   pinned_station_name          + pinned_station_order          → 上班上车点
--   reverse_pinned_station_name  + reverse_pinned_station_order  → 下班上车点
--
-- 为什么是两列可空、没有 CHECK、也不改写数据：
--   1. 存量行的站序**真的不知道**：名字在方向里出现两次时（正是本迁移要修的那种行），哪一个
--      是使用者选的，从名字推不出来；只出现一次时也推不出他当时面对的是哪一站（他可能就是从
--      另一个同名站改过去的）。本仓库对不可推断的既有数据的既定做法是拒绝替数据做主
--      （008 的重复行大声失败而不是挑一个幸存者、009 的不改写取值），这里照同一个标准：
--      只做结构改动，由使用者按需重选。
--   2. 正因为存量行是「有名字、没站序」，007 那种成对 CHECK 不能加：它会让这条迁移在现存
--      数据上直接失败。成对性改在写入边界上把关 —— 契约层要求「给出站名就必须同时给出站序，
--      清空则两列一起清」（见 packages/shared/src/schemas/api.ts 的 UpdateFavoriteSchema），
--      读侧把「有名字、没站序」如实当作「定位不到」处理（line-group.ts 的 placeBoardStop）：
--      名字只出现一次时它仍能定位（那不是猜），出现两次时它**读不出来**，而不是取第一个。
--   3. 站序的取值原样存上游的 `order`，本迁移不做任何换算。
--   4. 可重复执行：ADD COLUMN IF NOT EXISTS 对已经加过的列是空操作。

ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS pinned_station_order INT;
ALTER TABLE user_favorite_lines ADD COLUMN IF NOT EXISTS reverse_pinned_station_order INT;

-- migrate:down
-- 破坏性（有损）：回滚去掉这两个站序列，也去掉存在里面的「哪一站」这件事 —— 而它不能再从
-- 站名推回来（同名站正是推不回来的原因）。本文件没有 CHECK、没有数据改写，所以回滚只需要
-- 去掉这两列，没有任何行会被删除。
-- 运行器把 DROP COLUMN 认得破坏性操作：不加 --confirm 会被拒绝，并先把下面两条语句打印出来。

ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS reverse_pinned_station_order;
ALTER TABLE user_favorite_lines DROP COLUMN IF EXISTS pinned_station_order;
