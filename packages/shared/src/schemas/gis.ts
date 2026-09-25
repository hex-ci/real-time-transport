import { z } from 'zod'

export const WalkEtaSchema = z.object({
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
})
export type WalkEta = z.infer<typeof WalkEtaSchema>

export const NearbyStationSchema = z.object({
  name: z.string(),
  type: z.enum(['bus', 'subway']),
  /** The POI's own GCJ-02 position, absent when the upstream stated none — see `StationSchema`. */
  lat: z.number().optional(),
  lng: z.number().optional(),
  /**
   * Metres to the platform, absent when the radar did not measure it.
   *
   * Optional for the same reason the coordinates are: an upstream that states no
   * distance has stated no distance, and the absence travels end to end instead
   * of being substituted. `0` is NOT that absence — a POI on the measured point
   * really is 0 m away — so it stays a reading, and a consumer renders the number
   * when it is present and nothing where it is not (`statedNumber` reads it).
   */
  distanceMeters: z.number().optional(),
})
export type NearbyStation = z.infer<typeof NearbyStationSchema>

/** Catch-the-bus decision derived from walk ETA vs vehicle ETA. */
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
