import { z } from 'zod'

export const TransitTypeSchema = z.enum(['bus', 'subway'])
export type TransitType = z.infer<typeof TransitTypeSchema>

export const DataSourceTypeSchema = z.enum(['chelaile', 'apizero', 'subway_schedule'])
export type DataSourceType = z.infer<typeof DataSourceTypeSchema>

/**
 * F4: the NATURE of a number, as the user is entitled to read it.
 *
 * Decided where the value is produced, from how it was produced — never from the
 * route type, from the view a component happens to be rendered in, or from the
 * vendor that answered:
 *
 * - `live`               上游数据本身：the value came from the data source — a real
 *                        vehicle's own reading, or an observation of a real vehicle.
 *                        A number this app computed is NOT this.
 * - `position_estimate`  本系统自行算出的到站分钟：按真实车辆的位置与速度算出。该档
 *                        仍是 F4 声明的四态之一（`arrivalProvenanceOf` 仍为「真实车辆 +
 *                        本系统算术」回答它），但位置/停站推算式已从服务端删除，因此当前
 *                        没有任何路径产出它：缺少上游分钟的行改为**不写分钟**，而不是写
 *                        一个误差无固定符号的推算值。收起这一档需要同步 PRD §F4，未做。
 * - `schedule_simulation` 本系统按时刻表/行车间隔推演出的值（生成的列车及其报时）。
 * - `exact_timetable`    已发布的分钟级时刻表本身。
 *
 * Absent (or null) means the producer did not state where the value came from, and
 * the UI then shows no mark rather than the flattering one: 「没有来源」 and
 * 「实时」 are different facts.
 */
export const DataProvenanceSchema = z.enum([
  'live',
  'position_estimate',
  'schedule_simulation',
  'exact_timetable',
])
export type DataProvenance = z.infer<typeof DataProvenanceSchema>

/** The kinds of VEHICLE reading a live status can carry. */
export type VehicleProvenance = Extract<DataProvenance, 'live' | 'schedule_simulation'>

/**
 * Crowding levels. The domain is the OBSERVED upstream vocabulary, not a guessed
 * ladder: measured live, the upstream states exactly two crowding verdicts on its
 * crowding tag — 「不拥挤」 (keys `拥挤度_1`) and 「拥挤」 (`拥挤度_3`, `拥挤度_5`,
 * the observed keys are not contiguous). Those are the only two verdicts a reading
 * may carry; `high` names the upper observed rung and does not claim to be the top
 * of the scale, and `low`/`high` are decided from that label, not from a key's
 * number. A level nobody has sampled (the middle rung included) stays `unknown`,
 * which means "the upstream stated nothing"; consumers must keep that tellable
 * apart from 不拥挤 rather than rendering it as a verdict.
 */
export const CongestionLevelSchema = z.enum(['unknown', 'low', 'high'])
export type CongestionLevel = z.infer<typeof CongestionLevelSchema>

export const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().positive(),
  /**
   * The stop's own GCJ-02 position. Optional because an upstream that states no
   * coordinate has stated no coordinate: the absence travels end to end and is
   * never substituted, (0, 0) least of all — it is a real position in the
   * Atlantic and, once written, is indistinguishable from one the upstream
   * really sent. A consumer that needs a point (a walking route, a nearest-stop
   * search, a line's geometry) refuses on the absence instead of measuring from
   * a stand-in, and a zero on either axis is that same absence: no placed stop on
   * this datum sits at 0, so `statedCoordinate` reads a zero as no position too,
   * and a row that carries one cannot be told apart from an unplaced stop.
   */
  lat: z.number().optional(),
  lng: z.number().optional(),
  interchanges: z.array(z.string()).default([]),
})
export type Station = z.infer<typeof StationSchema>

export const LiveBusSchema = z.object({
  id: z.string(),
  /** Stop ordinal the vehicle last passed / is serving. Undefined when upstream provides no position. */
  order: z.number().int().positive().optional(),
  nextOrder: z.number().int().positive().optional(),
  /** Progress (0..1) between order and nextOrder. Undefined when unknown. */
  progress: z.number().min(0).max(1).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  speed: z.number().min(0).optional(),
  congestion: CongestionLevelSchema.default('unknown'),
  /**
   * Distance to the vehicle's next wait station in meters. -1 is chelaile's
   * sentinel meaning "already past the requested targetOrder" — callers use it
   * to exclude passed buses instead of treating them as approaching.
   */
  distanceToWaitStn: z.number().optional(),
  /**
   * Distance from the route START to the vehicle, in meters along the real
   * road/track. The authoritative continuous position: chelaile derives it from
   * the jxPath route length minus distanceToWaitStn; the subway engine from its
   * own geometry. Undefined when the upstream provides no usable position.
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
   * Total route length in meters along the real road/track polyline.
   * Derived from the upstream trajectory (chelaile jxPath) or station geometry.
   * Enables meter-accurate continuous vehicle positioning on the client.
   */
  routeLengthMeters: z.number().positive().optional(),
  /**
   * Cumulative road distance (meters) from the route start to each stop.
   * Length equals stops.length; stationDistances[0] is 0. Optional when the
   * upstream provides no trajectory (client falls back to even spacing).
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
 * F3: whether the line is running right now.
 *
 * `state` is deliberately four-valued rather than a boolean with a caveat
 * string: 「首班车之前」/「末班车已过」/「运营中」 are different facts, each with
 * its own answer, and a line whose service hours are not known says so instead
 * of defaulting to 运营中. `firstDeparture` / `lastDeparture` carry the line's
 * own times (「HH:MM」, the last one possibly after midnight) whenever they are
 * known; they are null when they are not, never a defaulted clock.
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
 * One row of a station's arrival list — the wire shape `/lines/:lineId/stations/
 * :stationName/arrivals` answers with.
 *
 * `provenance` is per ROW rather than per response, because one response can mix:
 * a vehicle whose upstream travels arrived (实时) sits next to one the subway
 * model priced (排班推演), and the exact-timetable overlay answers for a platform
 * the live path would otherwise have priced. Nullish means the row's producer
 * stated nothing — the UI then marks nothing.
 *
 * A row may also state NO MINUTE AT ALL, and that is data rather than a gap:
 * `time` and `etaSeconds` are then both absent and `provenance` is null. It is
 * what a targeted bus reading that published no arrival time for a vehicle
 * produces — this app no longer extrapolates one from the vehicle's snapshot
 * speed and a nominal per-stop dwell, because that arithmetic's error had no fixed
 * sign and reached ~12 minutes mean (28 min worst). The row is still SERVED: the
 * vehicle is really on its way, and `stopsAway` / `distanceMeters` / `busId` say
 * what is observed about it. Consumers render the same honest absence the platform
 * board uses for an unknown arrival (`statedArrivalMinutes` answers `null`, and
 * `@/arrival-copy` words it) — never a number.
 */
export const ArrivalRowSchema = z.object({
  time: z.string().optional(),
  etaSeconds: z.number().min(0).optional(),
  stopsAway: z.number().int().min(0).optional(),
  distanceMeters: z.number().min(0).optional(),
  isAtStation: z.boolean().optional(),
  /** The provider's own vehicle id, when the row is tied to one. */
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
