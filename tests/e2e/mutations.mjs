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
  站台大屏: {
    file: 'apps/web/src/views/platform/index.vue',
    // 新鲜度行改成本机时钟（请求时刻），而不是产出这些行的响应自己的时刻。
    find: 'if (answeredAt !== undefined) rowsReadAt.value = answeredAt',
    replace: 'rowsReadAt.value = Date.now()',
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
    file: 'apps/web/src/views/platform/components/departure-board.vue',
    // 刷新控件（这一屏的主控件）缩到 20px：触控目标不够大。
    find: 'class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:opacity-60 lg:text-base"',
    replace: 'class="flex min-h-[20px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:opacity-60 lg:text-base"',
  },
}
