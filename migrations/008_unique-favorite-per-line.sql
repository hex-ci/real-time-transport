-- 008: 一条线路只允许关注一次 —— user_favorite_lines 的唯一性
--
-- 「只允许关注一条」：同一条线路对同一个用户只允许存在一行。两个方向是同一个关注 ——
-- 行上的 morning_direction / evening_direction 与 reverse_line_id 已经承载了方向，
-- 方向不该再变成第二行。应用层 guard 给出友好结果（已关注），这里是不依赖应用层的兜底：
-- 并发关注、或反向 lineId 解析不出来时，第二次关注只会撞在这条索引上。
--
-- 为什么不是「先合并重复行再建索引」：合并必须从若干行里挑出一个幸存者，而每一行都可能
-- 带着用户自己的东西（置顶、上下车点、通勤方向）。哪一行才是「用户真正的那一行」无法从
-- 数据里推导 —— 静默丢掉一行的上车点就是一次不可见的损失，而本仓库在 migrate.ts 里已经
-- 拒绝过同类的静默推断（拒绝自动推断回滚）。所以这里选择大声失败：把重复行报清楚再中止
-- 整个迁移事务（ROLLBACK，且不写入 _migrations），由人自行合并后重跑。
--
-- 实测状态（引入本条约束前核对）：表内共 4 行，(user_id, city_code, line_id) 上 0 组重复，
-- 因此下面的前置检查在本次应用中是空操作；重复只可能来自更早的库。
-- 索引要求三列都非空，三列在当前表结构里都是 NOT NULL，普通唯一索引即可。
DO $$
DECLARE
    dup RECORD;
BEGIN
    FOR dup IN
        SELECT user_id, city_code, line_id, count(*) AS row_count
          FROM user_favorite_lines
         GROUP BY user_id, city_code, line_id
        HAVING count(*) > 1
         ORDER BY user_id, city_code, line_id
    LOOP
        RAISE EXCEPTION
            'user_favorite_lines holds % rows for (user_id=%, city_code=%, line_id=%): one line may be followed only once per user. Fold those rows into one by hand, then re-run `pnpm migrate:up`. Nothing was deleted by this migration.',
            dup.row_count, dup.user_id, dup.city_code, dup.line_id;
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_favorite_per_user_city_line
    ON user_favorite_lines (user_id, city_code, line_id);

-- migrate:down
DROP INDEX IF EXISTS uniq_favorite_per_user_city_line;
