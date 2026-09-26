import { z } from 'zod'

export const WalkEtaSchema = z.object({
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
})
export type WalkEta = z.infer<typeof WalkEtaSchema>

export const NearbyStationSchema = z.object({
  name: z.string(),
  type: z.enum(['bus', 'subway']),
  /** POI 自身的 GCJ-02 坐标；上游未给出即缺省，绝不用替代值填充。 */
  lat: z.number().optional(),
  lng: z.number().optional(),
  /**
   * 到站台的米数；上游未测到即缺省，绝不用替代值填充。
   * `0` 是真实读数（POI 就在测点上），不是缺省。
   */
  distanceMeters: z.number().optional(),
})
export type NearbyStation = z.infer<typeof NearbyStationSchema>

/** 由步行 ETA 与车辆 ETA 比较得出的赶车结论。 */
export const CatchDecisionSchema = z.enum(['comfortable', 'hurry', 'missed', 'unknown'])
export type CatchDecision = z.infer<typeof CatchDecisionSchema>

export const WalkDecisionSchema = z.object({
  walkSeconds: z.number().min(0),
  walkMeters: z.number().min(0),
  vehicleEtaSeconds: z.number().min(0).nullable(),
  bufferSeconds: z.number().nullable(),
  decision: CatchDecisionSchema,
  advice: z.string(),
})
export type WalkDecision = z.infer<typeof WalkDecisionSchema>

export const TransitCitySchema = z.object({
  code: z.string(),
  name: z.string(),
  pinyin: z.string().default(''),
  hasMetro: z.boolean().default(false),
  hot: z.boolean().default(false),
})
export type TransitCityDto = z.infer<typeof TransitCitySchema>
