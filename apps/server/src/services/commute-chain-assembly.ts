import type {
  ArrivalBasis,
  ChainLegLive,
  ChainLegVehicle,
  LiveLineStatus,
  OperatingStatus,
} from '@real-time-transport/shared'

/**
 * F10 的服务端一半，纯逻辑部分：两次定向读取合成引擎吃的那一份读数。
 *
 * 每次定向读取只回答一个被请求的目标站，因此同一辆车的上车分钟与下车分钟只能来自两次读取，
 * 各自按自己的到站顺序返回。两次之间会出岔子的一切都在这里裁决，且只按 provider 稳定的
 * vehicle id（`LiveBusSchema.id`）裁决。
 *
 * 本文件不读时钟、不读 socket、不读距离：两次读数与这次匹配就是全部输入。
 */

export interface TargetedArrival {
  vehicleId: string
  etaSeconds: number
  basis: ArrivalBasis
}

/**
 * 定向行只有在它给出分钟时才进入这个类型。
 *
 * 定向读取未给某辆车发布到站时间时，`vehicleArrivals` 会给出没有 `time`/`etaSeconds`/`basis`
 * 的行；这样的行在配对前被滤掉，而不是带着缺失的分钟穿过这份契约：行程时长需要两端都有分钟。
 * 过滤由调用方（`readChainLeg`）完成，那辆车仍被计为一辆在途车。
 */

/**
 * 把一条腿的两次定向读取配对成扣减可用的车辆。
 *
 * 匹配按 vehicle id，绝不按位置：两次读取各按自己的到站分钟排序，把第 n 个配第 n 个会把一辆车
 * 的下车分钟放到另一辆车的上车分钟旁边。
 *
 * 只有一次读取带的车辆被丢弃，它没有配对，端出去就等于凭空造出缺的另一半。上车读取的行是
 * 下车读取的行的子集（下车站在其被读取的方向上更靠后的腿）；反向存储的地铁腿也在这条关系下
 * 到达这里。
 *
 * 这种包含关系是前提，不是任何输入的属性：alight order 在 board order 之前的公交腿会把它反转，
 * 因此扣减会先把这种腿判为 `leg-recorded-backwards`，schema 在写入时也拒绝它。没有这个前提，
 * 这里任何地方都不得假定该关系。
 */
export function pairTargetedReads(
  board: readonly TargetedArrival[],
  alight: readonly TargetedArrival[],
): ChainLegVehicle[] {
  const alightById = new Map(alight.map(row => [row.vehicleId, row]))

  const vehicles: ChainLegVehicle[] = []
  for (const row of board) {
    const other = alightById.get(row.vehicleId)
    if (!other) continue
    vehicles.push({
      vehicleId: row.vehicleId,
      arrivalAtBoardSeconds: row.etaSeconds,
      arrivalAtAlightSeconds: other.etaSeconds,
      // 配对是一辆车，但行上显示的 mark 限定的是下车分钟（`ChainLegVehicle.basis`），
      // 因此走的是那次读取的 basis：payload 带的上车分钟配本应用算出的下车分钟不是同一份读数。

      basis: other.basis,
    })
  }
  return vehicles
}

/**
 * 这条腿的读数，来自产生它的两次读取 —— 或者什么都没有。
 *
 * 一条腿只有一份读数，因此它声明一个来源、一个时刻、一个降级标记和一个运营状态。
 * 来源只在两次读取命名同一个时才给，否则引擎报告 `provenance-unknown`；
 * 时刻取两者中更旧的那个；任一次读取回退即降级。
 *
 * `operatingStatus` 不从任一次读取推导：它是这条腿所属线路的 F3 状态，由调用方从它已解析出的
 * 线路详情算一次后传入（`operatingStatusOf`）。它与站牌的推导共用，但输入不共用，
 * 因此两者对同一条线可以不一致 —— 链路声明的是线路自己的服务时段，站牌的精确时刻表分支声明的
 * 是该站自己的官方表。这不是第二套状态模型。
 */
export function legLiveReading(params: {
  board: LiveLineStatus | null
  alight: LiveLineStatus | null
  vehicles: readonly ChainLegVehicle[]
  /**
   * 上车读取带的车辆数，在按 id 匹配之前 —— 所有尚未到达上车 order 的行，无论那次读数是否
   * 发布了它的到站时间，且不含下车读取的行。正是它让引擎能答 `no-shared-vehicle`（读取带了车，
   * 匹配一辆没留）而不是 `no-vehicle`（读取什么车都没带）。定不出价的车也算，因为它在途。
   */
  boardVehiclesOnTheWay: number
  operatingStatus: OperatingStatus
}): ChainLegLive | null {
  const { board, alight } = params
  // 半对不是读数：任一次读取缺失就没有上车分钟
  // 也没有下车分钟可比，报告回答的那一半
  // 等于声明这条腿没有的读数。
  if (!board || !alight) return null

  return {
    dataSource: board.dataSource === alight.dataSource ? board.dataSource : null,
    updatedAt: Math.min(board.updatedAt, alight.updatedAt),
    isDegraded: board.isDegraded || alight.isDegraded,
    vehicles: params.vehicles,
    boardVehiclesOnTheWay: params.boardVehiclesOnTheWay,
    operatingStatus: params.operatingStatus,
  }
}
