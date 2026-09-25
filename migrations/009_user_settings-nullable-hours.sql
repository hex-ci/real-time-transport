-- 009: user_settings 的四个通勤时刻改为可空 —— 「行在、但时段从未被选择」可表达
--
-- 004 给这四列声明了 NOT NULL DEFAULT（06:30 / 11:30 / 17:00 / 22:00）。后果不是「多了一组
-- 默认值」，而是「用户从没选过时段」这个状态在库里无法存在：只保存锚点的那次写入，会把内置
-- 时段当真存下来，读侧分得清「没有这一行」（settingsState: 'unset' / data: null），却分不清
-- 「行在、四个时刻用户从没选过」—— 两件事读出来字节相同，而其中一件是把默认值冒充使用者
-- 自己的配置，最后会以使用者的时段出现在首页角标、链路芯片和设置索引行上。
--
-- 所以这条迁移只做结构改动：去掉 NOT NULL 与 DEFAULT。此后 NULL 就是「从未选择」，
-- 读侧按 NULL 如实报告（响应里是 null，settingsState 仍是 'stored'，窗口状态是 unchosen），
-- 需要一段可用跨度的引擎继续用它自己具名的参数（UNCONFIGURED_COMMUTE_WINDOW），
-- 不再有任何一处把内置时刻当成使用者的选择。
--
-- 为什么没有数据步骤（不把现存行的值改成 NULL）：
--   1. 本仓库当前那一行（default_user）的四个时刻是使用者有意设定的测试窗口，改成 NULL 就是
--      把一次真实的选择抹掉；
--   2. 对任何别的行，「用户选过 06:30」与「写入时被 DEFAULT 填成 06:30」在数据里是同一组值，
--      从值本身推不出来 —— 猜错的两半都不是小错：抹掉一次真实选择，或把一个默认值继续当成
--      使用者的选择。本仓库对这类「不可推断」的既有做法是拒绝替数据做主（migrate.ts 的 down
--      拒绝自动推断、008 的重复行大声失败而不是挑一个幸存者），这里照同一个标准：
--      结构性改动 + 由人按需处理，而不是静默改写。
--   3. 能补救的窗口是关闭的：旧行里被填过的时刻与新行里被选过的时刻，从这一刻起都读作一个值 ——
--      真要区分只能靠外部记录，而库里没有那份记录。所以这条迁移不假装能修，它只保证从今往后
--      新写入的「没选过」是 NULL。
--
-- 可重复执行：DROP NOT NULL / DROP DEFAULT 对已经改过的列都是空操作。

ALTER TABLE user_settings ALTER COLUMN morning_start DROP NOT NULL;
ALTER TABLE user_settings ALTER COLUMN morning_start DROP DEFAULT;

ALTER TABLE user_settings ALTER COLUMN morning_end DROP NOT NULL;
ALTER TABLE user_settings ALTER COLUMN morning_end DROP DEFAULT;

ALTER TABLE user_settings ALTER COLUMN evening_start DROP NOT NULL;
ALTER TABLE user_settings ALTER COLUMN evening_start DROP DEFAULT;

ALTER TABLE user_settings ALTER COLUMN evening_end DROP NOT NULL;
ALTER TABLE user_settings ALTER COLUMN evening_end DROP DEFAULT;

-- migrate:down
-- 破坏性（有损）：回滚把「从未选择」这个状态彻底抹掉，不可逆。
--
-- 列要回到 NOT NULL，NULL 就必须先被某个值填上，而这个值只能是 004 的内置时刻 —— 也就是
-- 回滚之后这一列的 DEFAULT 本身。填过之后，「用户选过 06:30」与「用户从没选过」在库里再也
-- 分不开，这正是 009 要修的那个状态；回滚的人接受的代价就是它。这里不删除任何行。
--
-- 顺序是先填、再恢复默认、最后恢复 NOT NULL：NOT NULL 在还有 NULL 的列上会直接失败，
-- 所以填值必须在它之前。整个回滚段在一个事务里执行（见 migrate.ts）。

UPDATE user_settings SET morning_start = '06:30' WHERE morning_start IS NULL;
UPDATE user_settings SET morning_end = '11:30' WHERE morning_end IS NULL;
UPDATE user_settings SET evening_start = '17:00' WHERE evening_start IS NULL;
UPDATE user_settings SET evening_end = '22:00' WHERE evening_end IS NULL;

ALTER TABLE user_settings ALTER COLUMN morning_start SET DEFAULT '06:30';
ALTER TABLE user_settings ALTER COLUMN morning_start SET NOT NULL;

ALTER TABLE user_settings ALTER COLUMN morning_end SET DEFAULT '11:30';
ALTER TABLE user_settings ALTER COLUMN morning_end SET NOT NULL;

ALTER TABLE user_settings ALTER COLUMN evening_start SET DEFAULT '17:00';
ALTER TABLE user_settings ALTER COLUMN evening_start SET NOT NULL;

ALTER TABLE user_settings ALTER COLUMN evening_end SET DEFAULT '22:00';
ALTER TABLE user_settings ALTER COLUMN evening_end SET NOT NULL;
