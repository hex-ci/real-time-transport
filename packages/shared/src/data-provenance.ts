import type {
  DataProvenance,
  DataSourceType,
  VehicleProvenance,
} from './schemas/transit.js'

/**
 * F4：一个数字是**哪一种**数，在其产生处定档。
 * 不变量：「没有来源」与「实时」是不同的事实，数据层不说，用户就看不见差别。
 * 故此处每个函数都能答「我不知道」（`null`），且没有任何输入能把未知抬成 `live`。
 * 本文件不读时钟、不读线路类型、也不读视图位置：组件自行判定来源，
 * 会在聚合器故障切换到给出另一种读数的源时第一次出错。
 */

/**
 * 某个 `dataSource` 声明产出的是哪一类车辆读数。
 * 源缺失或本版本不认识时一律 `null`（无声明），新提供方不会默认继承 `live`。
 */
export function vehicleProvenanceOf(
  dataSource: DataSourceType | null | undefined,
): VehicleProvenance | null {
  switch (dataSource) {
    // 真实车辆，运营方观测后实时下发。
    case 'chelaile':
    case 'apizero':
      return 'live'
    // 排班引擎生成的列车：无论位置如何都是推演而非观测。
    case 'subway_schedule':
      return 'schedule_simulation'
    default:
      return null
  }
}

/**
 * 一个到站分钟是怎么来的。
 * - `upstream`     分钟来自 payload（源自己的到站时刻）
 * - `at_platform`  观测到车辆就在本站台（`isAtStation`）
 * - `our_estimate` 本系统用自己的模型算出的分钟（当前仅地铁模型会给出）
 */
export type ArrivalBasis = 'upstream' | 'at_platform' | 'our_estimate'

/**
 * 由一个到站分钟背后的车辆、与该分钟的产生方式，定出它的来源。
 * 两个问题的顺序有意义：生成的车无论分钟怎么来，整行都是模型输出，故先问车辆。
 * `basis` 仍在签名里（产出方仍须说明分钟是怎么来的），但真实车辆的每个非缺席分钟都是 实时：
 * 词汇表已不含「本系统自算」那一档，故除了生成的车，这里不再有第二种答案。
 */
export function arrivalProvenanceOf(params: {
  vehicle: VehicleProvenance | null | undefined
  basis: ArrivalBasis
}): DataProvenance | null {
  const vehicle = params.vehicle ?? null
  if (!vehicle) return null
  if (vehicle === 'schedule_simulation') return 'schedule_simulation'
  return 'live'
}

/**
 * 列表中已分类各行共同的那一个来源，否则 `null`。
 * `null` 同时覆盖「没有任何行被分类」与「各行不一致」：那时一个词会对列表的一部分说谎。
 * 未声明来源的行被忽略，而不是当作第二种意见 —— 它不得让本就一致的行失去结论。
 */
export function listProvenanceOf(
  rows: readonly { provenance?: DataProvenance | null }[],
): DataProvenance | null {
  const known = new Set<DataProvenance>()
  for (const row of rows) {
    if (row.provenance) known.add(row.provenance)
  }
  return known.size === 1 ? [...known][0]! : null
}
