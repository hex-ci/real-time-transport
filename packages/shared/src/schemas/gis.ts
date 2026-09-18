import { z } from 'zod'

export const WalkEtaSchema = z.object({
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
})
export type WalkEta = z.infer<typeof WalkEtaSchema>

export const NearbyStationSchema = z.object({
  name: z.string(),
  type: z.enum(['bus', 'subway']),
  lat: z.number(),
  lng: z.number(),
  distanceMeters: z.number(),
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
