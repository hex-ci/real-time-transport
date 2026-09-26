import type { ArrivalRow, DepartureReference, OperatingStatus } from '@real-time-transport/shared'
import type { ReadValue } from '@/read-state'
import type { CommuteLegState } from './commute-leg'

export interface CardRow {
  lineId: string
  direction: 0 | 1
  stopOrder: number | null
  /** 头牌标签（「开往 X」）：让这一行可辨认、可被无障碍读出。 */
  directionName: string
}

export interface ArrivalsFeed {
  /**
 * 到站行，每一行自带它的 F4 来源。卡片的标记由这些行推出（`listProvenanceOf`），绝不来自
 * 应答级别的标志：一个应答可以混有 payload 携带分钟的车、和这个应用自己算出来的一辆。
 */
  arrivals: ArrivalRow[]
  /**
 * F3：这条线路此刻是否在运营。
 *
 * 服务端根据线路自己的首末班决定，所以卡片不读自己的时钟。空的 `arrivals` 数组「不是」这个
 * 事实：首班前、已过末班、运营中但范围内无车是三个不同的答案，而卡片在没有分钟可显示时渲染
 * 的是这一个。
 */
  operatingStatus: OperatingStatus
  /**
 * F1 给这个站台的参考行：从用户所在的锚点出发的步行时间，以及由「上面同一批」到站数据得出的
 * 出发结论。
 *
 * 服务端解析（锚点从不经过浏览器，那里的第二次坐标转换会把它挪走），不存在诚实结论时为 null。
 */
  reference: DepartureReference | null
  /**
 * F-C：登记时刻表给这个站台自己的附注，逐字（例如只在半程运行的末班），或回答路径没有它时为
 * null。为展示该站台发车的界面携带；这张卡片显示接下来几分钟，不渲染它。
 */
  note?: string | null
}

/**
 * 一条方向行的到站读数，连同产生它的那次读取。
 *
 * `ReadValue<ArrivalsFeed>`：只有 `state: 'read'` 才带着答案。读取的三态由 `@/read-state`
 * 定义，各处共用同一套。
 */
export type ArrivalsRead = ReadValue<ArrivalsFeed>

/**
 * 卡片收到的一条方向行：基础行加上它的到站数据，由卡片网格从到站映射里并进来。
 */
export interface CardRowWithArrivals extends CardRow {
  arrivals: ArrivalsRead
}

export interface MiniCardConfig {
  lineName: string
  directionName: string
  stopName: string | null
  stopDistanceMeters: number | null
  detailLoaded: boolean
  /** 地铁用琥珀色、公交用青色 —— 共用的线路类型规则。 */
  isSubway: boolean
  /**
 * 这条线路是被钉住的那条。置顶是铺在列表顺序之上的一种状态，所以总览是标记这张卡片，而不是
 * 把它从列表里抬出来。
 */
  isPinned: boolean
  /** 通勤模式恰好一行；附近模式每个可用方向一行。 */
  rows: CardRow[]
  /**
 * 卡片可以就这一段通勤说的东西，由调用方从关注行自己的字段建立 —— 它的上车点与用户选的方向 ——
 * 附近视图没有通勤段时为 null，所选方向的站表尚未加载时也为 null。
 *
 * 在这里建立而不是在卡片里：读不出的通勤段同样一行都没有，所以卡片不能从「行缺席」读出状态。
 */
  legState: CommuteLegState | null
  primaryDirection: 0 | 1 | null
  /**
 * 点按卡片去哪里：一条线路无论用户有没有为它配好通勤段都看得了，所以这来自关注行，绝不来自
 * `rows`（后者在方向未选或详情未加载时合法地是空的）。
 */
  detailLineId: string
  detailDirection: 0 | 1
  /** 这张卡片属于哪个关注，使一次方向选择能记在它上面。 */
  favoriteId: string | null
}

/** 总览当前显示什么，由通勤时段或一次手动选择驱动。 */
export type OverviewMode = 'morning' | 'evening' | 'nearby'
