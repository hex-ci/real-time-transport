import type { DataProvenance } from '@real-time-transport/shared'

/** 经过所选站台的一条已关注线路/方向。 */
export interface PlatformLineRule {
  lineId: string
  lineName: string
  direction: number
  terminal: string
  stationOrder: number
  /**
   * 线路自己的运营事实，取自该线路的首末班。无车可报时呈现，
   * 故「已过末班」不会被通用的无车文案顶替。数字列陈述它，芯片陈述拥挤度。
   */
  operatingText: string
}

/** 站台屏上的一行发车。 */
export interface DepartureItem {
  id: string
  lineName: string
  terminal: string
  etaMinutes: number | null
  stopsAway: number | null
  congestion: string
  /**
   * 该行背后的请求失败：车辆与运营日都未知。
   * 用具名状态而非展示用词，故行的措辞按事实分支，芯片也不会复述数字列已陈述的失败。
   */
  unavailable: boolean
  /** 该行没有可展示的到站分钟时陈述什么。 */
  operatingText: string | null
  /**
   * `etaMinutes` 是哪一类数字；按行陈述，因为一块屏混着线路、也就是混着来源。
   * 无分钟、或来源为本版本不认识时均为 null——两种情况都渲染无标记，而非好看的那个。
   */
  provenance: DataProvenance | null
}
