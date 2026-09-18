import { z } from 'zod'

export const TransitTypeSchema = z.enum(['bus', 'subway'])
export type TransitType = z.infer<typeof TransitTypeSchema>

export const DataSourceTypeSchema = z.enum(['chelaile', 'apizero', 'subway_schedule'])
export type DataSourceType = z.infer<typeof DataSourceTypeSchema>

export const CongestionLevelSchema = z.enum(['unknown', 'low', 'medium', 'high'])
export type CongestionLevel = z.infer<typeof CongestionLevelSchema>

export const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().positive(),
  lat: z.number(),
  lng: z.number(),
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
