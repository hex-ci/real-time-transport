import { z } from 'zod'

export const TransitTypeSchema = z.enum(['bus', 'subway'])
export type TransitType = z.infer<typeof TransitTypeSchema>

export const DataSourceTypeSchema = z.enum(['chelaile', 'apizero', 'subway_schedule'])
export type DataSourceType = z.infer<typeof DataSourceTypeSchema>

/**
 * F4：一个数字的**性质**，按用户有权读到的方式区分。
 * 在数值产生处、依产生方式定档 —— 绝不依线路类型、组件所在的视图，或作答的厂商：
 *
 * - `live`                上游数据本身：真实车辆自己的读数，或对真实车辆的观测。
 * - `schedule_simulation` 本系统按时刻表 / 行车间隔推演出的值（生成的列车及其报时）。
 * - `exact_timetable`     已发布的分钟级时刻表本身。
 *
 * 词汇表只保留**有产出路径**的档：没有生产者的成员不在此声明。曾有一档「本系统自算的到站分钟」，
 * 因没有任何路径产出它而删除 —— 缺上游分钟的行改为**不写分钟**，而不是写一个误差无固定符号的推算值。
 *
 * 缺省（或 null）表示产出方没有声明来源，此时 UI 不标记，而不是标讨喜的那个：
 * 「没有来源」与「实时」是不同的事实。
 */
export const DataProvenanceSchema = z.enum([
  'live',
  'schedule_simulation',
  'exact_timetable',
])
export type DataProvenance = z.infer<typeof DataProvenanceSchema>

/** 实时状态可以携带的**车辆**读数种类。 */
export type VehicleProvenance = Extract<DataProvenance, 'live' | 'schedule_simulation'>

/**
 * 拥挤度档位。取值域取自**实测到的**上游词表，不是猜出来的分档：
 * 上游的拥挤标签只给出两种结论 —— 「不拥挤」与「拥挤」（观测到的 key 并不连续）。
 * 读数只允许携带这两种结论；`high` 指观测到的较高一档、不声称是量程顶端，
 * 且 `low` / `high` 由该标签而非 key 的编号决定。
 * 没人采样过的档（含中间档）保持 `unknown`，即「上游什么都没说」；
 * 消费方必须能把它与 不拥挤 区分开，不得当作一种结论渲染。
 */
export const CongestionLevelSchema = z.enum(['unknown', 'low', 'high'])
export type CongestionLevel = z.infer<typeof CongestionLevelSchema>

export const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().positive(),
  /**
   * 该站自身的 GCJ-02 坐标。可选：上游未给出坐标就是未给出 —— 缺省一路传到底、绝不代填，
   * (0, 0) 尤其不行：那是大西洋上的真实位置，写下来就与上游真发过的坐标无法区分。
   * 需要点位的消费方（步行路线、最近站搜索、线路几何）在缺省处拒绝，而不是拿替代点去量；
   * 任一轴为 0 也是同一种缺省：本基准面上没有落点站会落在 0 上。
   */
  lat: z.number().optional(),
  lng: z.number().optional(),
  interchanges: z.array(z.string()).default([]),
})
export type Station = z.infer<typeof StationSchema>

export const LiveBusSchema = z.object({
  id: z.string(),
  /** 车辆刚驶过 / 正在服务的站序；上游未给位置时缺省。 */
  order: z.number().int().positive().optional(),
  nextOrder: z.number().int().positive().optional(),
  /** order 与 nextOrder 之间 0..1 的进度；未知时缺省。 */
  progress: z.number().min(0).max(1).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  speed: z.number().min(0).optional(),
  congestion: CongestionLevelSchema.default('unknown'),
  /**
   * 到车辆下一等待站的米数。-1 是 chelaile 的哨兵值，表示「已驶过请求的 targetOrder」——
   * 调用方用它排除已过站的车辆，而不是当成正在接近。
   */
  distanceToWaitStn: z.number().optional(),
  /**
   * 自线路起点沿真实道路 / 轨道的米数，是权威的连续位置：
   * 上游由 jxPath 路线长减去 distanceToWaitStn 得出，地铁引擎由自己的几何得出。
   * 上游没有可用位置时缺省。
   */
  distanceFromStart: z.number().min(0).optional(),
  travelTimeSec: z.number().optional(),
  license: z.string().optional(),
  updatedAt: z.number(),
})
export type LiveBus = z.infer<typeof LiveBusSchema>

export const LineDetailSchema = z.object({
  lineId: z.string(),
  lineName: z.string(),
  direction: z.number().int().min(0).max(1),
  directionName: z.string(),
  firstBusTime: z.string().default(''),
  lastBusTime: z.string().default(''),
  cityCode: z.string().default('027'),
  type: TransitTypeSchema.default('bus'),
  stops: z.array(StationSchema),
  /**
   * 沿真实道路 / 轨道折线的线路总长（米）。
   * 由上游轨迹或站点几何得出，使客户端可做米级精度的连续车辆定位。
   */
  routeLengthMeters: z.number().positive().optional(),
  /**
   * 自线路起点到各站的累计道路距离（米）。长度等于 stops.length，stationDistances[0] 为 0。
   * 上游没有轨迹时缺省（客户端回落到等距分布）。
   */
  stationDistances: z.array(z.number()).optional(),
  otherDirectionLineId: z.string().optional(),
})
export type LineDetail = z.infer<typeof LineDetailSchema>

export const LiveLineStatusSchema = z.object({
  lineId: z.string(),
  direction: z.number().int().min(0).max(1),
  buses: z.array(LiveBusSchema),
  dataSource: DataSourceTypeSchema,
  isDegraded: z.boolean(),
  updatedAt: z.number(),
})
export type LiveLineStatus = z.infer<typeof LiveLineStatusSchema>

/**
 * F3：线路此刻是否在运营。
 * `state` 刻意取四态，而不是布尔加一句保留文本：「首班车之前」/「末班车已过」/「运营中」
 * 是不同的事实、各有各的答案；服务时刻未知的线路就说未知，而不是默认成 运营中。
 * `firstDeparture` / `lastDeparture` 在已知时携带线路自己的时刻（「HH:MM」，末班可能晚于零点），
 * 未知时为 null，绝不填一个默认时刻。
 */
export const OperatingStateSchema = z.enum(['before_first', 'operating', 'after_last', 'unknown'])
export type OperatingState = z.infer<typeof OperatingStateSchema>

export const OperatingStatusSchema = z.object({
  state: OperatingStateSchema,
  firstDeparture: z.string().nullable(),
  lastDeparture: z.string().nullable(),
})
export type OperatingStatus = z.infer<typeof OperatingStatusSchema>

/**
 * 某站到站列表的一行 —— `/lines/:lineId/stations/:stationName/arrivals` 的线上形状。
 * `provenance` 按**行**而非按响应：一次响应可以混合 —— 上游有车抵达的车辆（实时）
 * 与地铁模型计价的车辆（排班推演）相邻，精确时刻表覆盖层还会替实时路径本该计价的站台作答。
 * 空值表示该行的产出方什么都没声明，此时 UI 不标记。
 * 一行也可能**完全没有分钟**，那是数据而非空缺：`time` 与 `etaSeconds` 同时缺省、`provenance` 为 null ——
 * 这是某车的定向读数未发布时间的结果。该行仍然**照常下发**：车确实在途，
 * `stopsAway` / `distanceMeters` / `busId` 陈述所观测到的东西。
 * 消费方渲染与站台看板处理未知到站时相同的诚实缺省（`statedArrivalMinutes` 答 `null`，
 * 文案由 `@/arrival-copy` 落地），绝不写数字。
 */
export const ArrivalRowSchema = z.object({
  time: z.string().optional(),
  etaSeconds: z.number().min(0).optional(),
  stopsAway: z.number().int().min(0).optional(),
  distanceMeters: z.number().min(0).optional(),
  isAtStation: z.boolean().optional(),
  /** 该行绑定到具体车辆时，提供方自己的车辆 id。 */
  busId: z.string().optional(),
  provenance: DataProvenanceSchema.nullish(),
})
export type ArrivalRow = z.infer<typeof ArrivalRowSchema>

export const StationArrivalEstimateSchema = z.object({
  lineId: z.string(),
  lineName: z.string(),
  terminalName: z.string(),
  stationId: z.string(),
  stationName: z.string(),
  buses: z.array(z.object({
    id: z.string(),
    stopsRemaining: z.number().int().min(0),
    etaMinutes: z.number().min(0),
    distanceMeters: z.number().min(0),
    congestion: CongestionLevelSchema,
  })),
  updatedAt: z.number(),
})
export type StationArrivalEstimate = z.infer<typeof StationArrivalEstimateSchema>
