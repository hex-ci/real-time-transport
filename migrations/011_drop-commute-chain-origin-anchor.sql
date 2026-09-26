-- 011: 通勤链路的起点不再录入 —— 它由通勤目的决定（上班从家出发、下班从公司出发）
--
-- 缺陷（结构性）：007 把起点存成一列 `origin_anchor`，与 `purpose` 彼此独立、没有配对校验，
-- 于是库里能存出与目的矛盾的组合 ——「上班·从公司出发」这样的链路在引擎里会拿公司坐标起步，
-- 而设置页上要修的是「家」，同一条记录因此有两个起点。
--
-- 起点本来就不是使用者要录入的事实，而是「上班从家出发、下班从公司出发」这条规则的结论
-- （推导只有一处，见 packages/shared/src/commute-chain.ts 的 `anchorForPurpose`，web 读同一个函数）。
-- 把它当输入就必须额外守住它与目的的配对，而守住之后它仍是与目的并列、可以各自漂移的第二个事实。
-- 所以这里删掉这一列：起点成为目的的函数 —— 一个事实，一处推导。
--
-- 存量数据不需要回填：开发库现有的 8 条链路全部符合配对（7 × home/morning + 1 × work/evening）。
-- 若某条历史行确实录成了矛盾的组合，它此后一律按目的读 —— 也就是说，矛盾的**那一半**被纠正，
-- 而不是被保留下来：本迁移不做任何数据改写。
--
-- 列上的取值约束 `commute_chains_origin_anchor_check` 只提到这一列，会随列一起被删除；
-- 这里显式点名删它，使约束的去向在文件上读得出来，也让「先删约束、后删列」不依赖读者
-- 对 PostgreSQL 依赖行为的记忆。删列本身是本迁移唯一的结构改动，别的表一个都不动。
--
-- 可重复执行：DROP ... IF EXISTS 对已经删掉的东西是空操作。

ALTER TABLE commute_chains DROP CONSTRAINT IF EXISTS commute_chains_origin_anchor_check;
ALTER TABLE commute_chains DROP COLUMN IF EXISTS origin_anchor;

-- migrate:down
-- 破坏性：回滚把起点重新变回一列，但**行里原本的取值并不回来** —— 它在正向迁移里已经没了，
-- 一个删掉的列没有第二个来源可推。回滚写回的是按目的重新推导的那一个（上班=家、下班=公司），
-- 也就是这个版本一直在用的那个起点。
--
-- 语句顺序不能颠倒：先加可空列、再由目的回填、最后才收紧为 NOT NULL 并恢复取值约束 ——
-- 反过来会在存量行上当场失败（NOT NULL 撞上空值、约束撞上 NULL）。
-- 这一段没有 DROP COLUMN / DROP TABLE，运行器不把它算作破坏性操作，故回滚不需要 --confirm。

ALTER TABLE commute_chains ADD COLUMN IF NOT EXISTS origin_anchor VARCHAR(8);
UPDATE commute_chains SET origin_anchor = CASE purpose WHEN 'morning' THEN 'home' ELSE 'work' END
    WHERE origin_anchor IS NULL;
ALTER TABLE commute_chains ALTER COLUMN origin_anchor SET NOT NULL;
ALTER TABLE commute_chains DROP CONSTRAINT IF EXISTS commute_chains_origin_anchor_check;
ALTER TABLE commute_chains ADD CONSTRAINT commute_chains_origin_anchor_check CHECK (origin_anchor IN ('home', 'work'));
