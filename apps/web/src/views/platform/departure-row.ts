/**
 * 站台屏的一行，由一次定点实时读数构造。
 *
 * 分钟只来自数据源自己给的 `travelTimeSec`（仅定点读数才有），刻意不退回逐站推算：
 * 本行不替数据源陈述它没给的等车时间。
 *
 * 在范围内的车按车头方向（`nextOrder`）与数据源自己的「已过所请求的站」哨兵
 * （`distanceToWaitStn === -1`）判定，绝不只看 `order`——与服务端定价到站行用的是同一套
 * 划分，故站台屏与首页卡不会对哪些车已经过站给出不一致的答案。
 *
 * 行携带哪一类数字不在此决定：由 `platformRowProvenanceOf` 从响应声明的来源作答，
 * 故一块屏可以同时持有不同类别的行。
 */
import type { DataSourceType, LiveBus } from '@real-time-transport/shared'
import { platformRowProvenanceOf } from './provenance'
import type { DepartureItem, PlatformLineRule } from './types'

/** 构造一行所依据的实时答案：它声明的来源，以及车辆列表。 */
export interface LiveAnswer {
  /**
   * 响应声明的来源。本版本不认识时为 null，此时行保留分钟、不显示标记——绝不用好看的那个。
   */
  dataSource: DataSourceType | null
  buses: LiveBus[]
}

/**
 * 仍朝本站台行驶的最近一辆车。
 *
 * `nextOrder` 是车头正驶向的站，故由它决定该车是否还会到达本站台；`order`（刚过的站）
 * 只用于在候选之间取最近。
 */
function vehicleHeadingTo(buses: LiveBus[], stationOrder: number): LiveBus | null {
  let nearest: LiveBus | null = null
  for (const bus of buses) {
    if (typeof bus.order !== 'number') continue
    // 数据源直接说：这辆车已过所请求的站。
    if (bus.distanceToWaitStn === -1) continue
    // 无车头可读（没有站序的读数）退回车尾，
    // 这是这种读数唯一携带的位置。
    const heading = bus.nextOrder ?? bus.order
    if (heading > stationOrder) continue
    if (!nearest || bus.order > (nearest.order ?? 0)) nearest = bus
  }
  return nearest
}

/**
 * 数据源为本站台给出的分钟。
 *
 * `0` 是「车正停在站台」的陈述而非缺值：它落到 1 分钟，丢进未知分支会藏起一辆
 * 已经到站的车。负值与非有限值不算时长，视为没陈述。
 */
function servedMinuteOf(bus: LiveBus): number | null {
  if (typeof bus.travelTimeSec !== 'number' || !Number.isFinite(bus.travelTimeSec)) return null
  if (bus.travelTimeSec < 0) return null
  return Math.max(1, Math.round(bus.travelTimeSec / 60))
}

/**
 * 一行：答案里陈述的分钟与站数，或本行自己没有分钟的原因。
 *
 * `answer: null` 只表示请求失败；到达了响应但没有读数（线路 404、车列表为空）是
 * 「已作答、范围内无车」，此时陈述线路的运营事实而非失败。
 */
export function departureRowOf(params: {
  /** 行的 id，由调用方按其来源规则构造。 */
  id: string
  rule: PlatformLineRule
  /** 定点实时答案；请求本身失败时为 null。 */
  answer: LiveAnswer | null
}): DepartureItem {
  const { id, rule, answer } = params
  const base = { id, lineName: rule.lineName, terminal: rule.terminal }

  if (!answer) {
    // 什么都没有回来：车辆与运营日都未知，
    // 故不陈运营事实，也不陈来源。
    return {
      ...base,
      etaMinutes: null,
      stopsAway: null,
      congestion: 'unknown',
      unavailable: true,
      operatingText: null,
      provenance: platformRowProvenanceOf({ dataSource: null, hasMinute: false }),
    }
  }

  const bus = vehicleHeadingTo(answer.buses, rule.stationOrder)
  if (!bus) {
    // 本站台没有可读的车：请求已作答，
    // 故陈述线路自己的运营事实而非失败。
    return {
      ...base,
      etaMinutes: null,
      stopsAway: null,
      congestion: 'unknown',
      unavailable: false,
      operatingText: rule.operatingText,
      // 运营事实不是数字，没有可供标记限定的东西。
      provenance: platformRowProvenanceOf({ dataSource: answer.dataSource, hasMinute: false }),
    }
  }

  const etaMinutes = servedMinuteOf(bus)
  return {
    ...base,
    etaMinutes,
    // 从车头到本站台的站数，下限 1——与服务端定价到站行
    // 用同一算式，两个界面不会数出不同结果。
    stopsAway: Math.max(1, rule.stationOrder - (bus.nextOrder ?? bus.order!)),
    // 拥挤度判决属于车辆自己，无分钟时依然成立。
    congestion: bus.congestion,
    unavailable: false,
    // 范围内有车：本行的答案是数字，或数字的缺失。
    operatingText: null,
    // 标记只搭载在存在的分钟上。
    provenance: platformRowProvenanceOf({ dataSource: answer.dataSource, hasMinute: etaMinutes !== null }),
  }
}
