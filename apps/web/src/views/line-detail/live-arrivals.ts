import type { ArrivalRow, LiveBus } from '@real-time-transport/shared'

/**
 * 弹窗的到站答案最多 30 秒才重读，而线路图每 18 秒就换一份实时读数。
 * 一辆车驶离本站之后，旧答案还会说「车辆正在本站」，而线路图已经按新读数
 * 把它画到下一段路上了 —— 两个屏幕对「车在不在本站」各说各话。
 *
 * 这里用最新一份读数把已开过本站的实时行去掉。判据与服务端 `vehicleArrivals`
 * 的过滤同一条：上游把 `order` 报成车辆**正前往**的站，故 `nextOrder > 本站序`
 * 就是它已经开过去了。
 *
 * 只裁实时行：精确时刻表与排班推演的行由各自的模型决定在场，不归实时读数裁决
 * （地铁的 `order` 语义也不同 —— 那是车所在的站，不是刚驶过的那一站）。
 */
export function arrivalsAfterLivePass(
  arrivals: ArrivalRow[],
  buses: LiveBus[],
  targetOrder: number,
): ArrivalRow[] {
  if (buses.length === 0) return arrivals
  const byId = new Map(buses.map(bus => [bus.id, bus]))
  return arrivals.filter((row) => {
    if (row.provenance !== 'live' || !row.busId) return true
    const bus = byId.get(row.busId)
    // 读数里没有这辆车时不删：那是「这一轮没读到」，不是「它开走了」。
    if (!bus) return true
    return !hasPassedStation(bus, targetOrder)
  })
}

function hasPassedStation(bus: LiveBus, targetOrder: number): boolean {
  if (bus.nextOrder !== undefined) return bus.nextOrder > targetOrder
  // 没有 nextOrder 时 `order` 是刚驶过的那一站：等于本站序即已开往下一站。
  if (bus.order !== undefined) return bus.order >= targetOrder
  return false
}
