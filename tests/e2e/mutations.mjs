/**
 * 红灯演示的改法：每个场景一条，改的是**被测行为本身**，不是断言。
 *
 * 一条改法只动一处、且必须让那个场景真的红 —— 场景里那些断言若连它都抓不到，
 * 它们就没有在区分行为（这正是这个文件存在的理由）。复原由运行器负责，走 sha256 对照。
 */
export const MUTATIONS = {
  首页卡片: {
    file: 'apps/web/src/views/overview/components/line-mini-card.vue',
    // 卡片自己编一个分钟：屏幕上那个数字不再是任何一份载荷说过的。
    find: '{{ minutesOf(primaryArrivals) }}',
    replace: '{{ 99 }}',
  },
  线路详情: {
    file: 'apps/web/src/views/line-detail/index.vue',
    // 写上车点时把方向反过来 —— 站序属于另一个方向，正是修过的那一个缺陷的形状。
    find: 'direction: dir })',
    replace: 'direction: (1 - dir) as 0 | 1 })',
  },
  电子站牌: {
    file: 'apps/web/src/views/station-board/index.vue',
    // 换站时不再把选中的站记下来：屏上换了名字，页头还是上一个站 —— 换站成了一件只换名字的事。
    // 顺带也打掉「最后看的那个站台」这条记忆（它记的正是这里选中的那个），故刷新后也回不去。
    find: `  currentStationId.value = option?.stationId ?? ''`,
    replace: `  void option`,
  },
  通勤链路页: {
    file: 'apps/web/src/views/commute-chain/index.vue',
    // 默认页签钉死在上班：时段换到傍晚也不跟。
    find: 'commutePurposeOf(commuteProfile.value) ?? \'morning\')',
    replace: '\'morning\')',
  },
  设置页: {
    file: 'apps/web/src/stores/transit.store.ts',
    // 拖动之后不再给各行重新编号：位置没变，于是没有一行要被写回，顺序留不下来。
    find: 'return next.map((row, index) => ({ ...row, displayOrder: index }))',
    replace: 'return next',
  },
  移动端可访问性: {
    file: 'apps/web/src/views/station-board/index.vue',
    // 刷新入口从顶部控件那行掉出去：屏上不再量得到它，而它属于那一行（F11）。
    find: `            label="刷新本站台到站"`,
    replace: `            label="刷新本站台到站" v-show="false"`,
  },
}
