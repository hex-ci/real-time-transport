/**
 * 「到目标站还有几站」——屏幕上那个数字的规则，只此一份。
 *
 * 口径（用户定，与车来了一致）：**车下一站就是本站时是 0 站**（屏上说「即将到站」）；中间还隔一站
 * 才是 1 站。也就是数「车辆当前位置与本站之间还有几个站台」，不含本站自己 —— 「车已经停在本站」
 * 是另一件事，由在站判定（`isAtStation`）单独说。
 *
 * 不用绝对里程推：位置取数据源自己的站序（`order` = 刚经过的那一站，`nextOrder` = 车头正开向的
 * 那一站）。里程与站距表之间有系统性偏差，用它数边界会在站台附近来回跳。
 *
 * 服务端组装到站行与前端在到站答案回来之前的回退都调这里。两处各写一份时，同一个距离会在两条
 * 路径上差一站，使用者看到的就是「同一个站一会儿 2 站一会儿 1 站」——本仓已经这样错过一次。
 */
export function stopsAwayOf(params: {
  targetOrder: number
  order?: number
  nextOrder?: number
}): number {
  const { targetOrder, order, nextOrder } = params
  // 车头优先；只有「刚经过的那一站」时，车头就是它前面那一站。两者都没有时不臆造位置，答最近的那一档。
  const nose = nextOrder ?? (order !== undefined ? order + 1 : targetOrder)
  return Math.max(0, targetOrder - nose)
}
