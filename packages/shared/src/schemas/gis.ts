import { z } from 'zod'

export const WalkEtaSchema = z.object({
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
})
export type WalkEta = z.infer<typeof WalkEtaSchema>

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

/**
 * 地点搜索的一条候选（`GET /api/transit/gis/place-search`）。
 *
 * 四件事：名字（给人认人）、区 + 地址（重名靠它分辨）、坐标（落库的那个值）。
 * `lng`/`lat` 是高德返回的 GCJ-02，**原样下发**：它会被存成锚点，而锚点一律是 GCJ-02，
 * 故这条路径上没有任何换算（见 `docs/PRD.md` §5.4）。
 *
 * `district` / `address` 可缺省 —— 高德对有些候选确实不给这两项，而缺省就是缺省：
 * 界面只显示它拿到的部分，绝不编造一个地址。
 */
export const PlaceSuggestionSchema = z.object({
  name: z.string(),
  district: z.string().optional(),
  address: z.string().optional(),
  lng: z.number(),
  lat: z.number(),
})
export type PlaceSuggestion = z.infer<typeof PlaceSuggestionSchema>
