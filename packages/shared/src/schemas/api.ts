import { z } from 'zod'

export const LineSummarySchema = z.object({
  lineId: z.string(),
  lineName: z.string(),
  direction: z.number().int().min(0).max(1),
  startStop: z.string(),
  endStop: z.string(),
  /**
   * Destination-board label for this direction (「开往 X」).
   *
   * The same field `LineDetail` carries, so a search hit and the direction
   * selector name a direction identically. Only the provider knows the terminal
   * at search time, so it is built there rather than re-composed by callers.
   */
  directionName: z.string().default(''),
  cityCode: z.string().default('027'),
})
export type LineSummary = z.infer<typeof LineSummarySchema>

export const SearchLineQuerySchema = z.object({
  keyword: z.string().min(1),
  cityCode: z.string().default('027'),
})
export type SearchLineQuery = z.infer<typeof SearchLineQuerySchema>

export const UserFavoriteLineSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().default('default_user'),
  cityCode: z.string().default('027'),
  lineId: z.string(),
  lineName: z.string(),
  /**
   * Default direction shown for this route. Following a route always covers
   * BOTH directions; this only picks which one is displayed first.
   */
  preferredDirection: z.number().int().min(0).max(1).default(0),
  /**
   * lineId of the opposite direction. Bus routes use two distinct upstream
   * lineIds (one per direction), so switching direction must swap the lineId;
   * subway routes reuse one lineId for both. Absent for favourites saved before
   * this field existed, in which case direction switching is unavailable for
   * that route rather than resolving to a wrong lineId.
   */
  reverseLineId: z.string().optional(),
  /**
   * Board stop for the morning (AM commute departure) leg. Backed by the
   * pinned_station_name column. Undefined means not set — the commute card
   * then shows an explicit "no morning board stop" state.
   */
  morningStopName: z.string().optional(),
  /**
   * Board stop for the evening (PM commute departure) leg. Backed by the
   * reverse_pinned_station_name column.
   */
  eveningStopName: z.string().optional(),
  /**
   * Direction the user commutes in the MORNING, as an explicit choice.
   *
   * `null`/absent means the user has not chosen yet — the settings UI requires a
   * direction before offering stops, so an unset value is a real state and must
   * not be coerced to 0. Deliberately NOT derived from the two board stops: the
   * derivation could disagree with the direction whose stops the user was shown
   * while picking, and it degenerates whenever a stop exists in only one
   * direction (913 has four such stops).
   */
  morningDirection: z.number().int().min(0).max(1).nullable().optional(),
  /** Direction the user commutes in the EVENING, chosen independently. */
  eveningDirection: z.number().int().min(0).max(1).nullable().optional(),
  displayOrder: z.number().int().default(0),
})
export type UserFavoriteLine = z.infer<typeof UserFavoriteLineSchema>

/**
 * Payload for updating a favourite's board stops and their commute directions.
 *
 * `null` clears the value (stop: no board stop; direction: not chosen yet);
 * `undefined` leaves it untouched. Passing explicit nulls is required because a
 * plain PATCH with optional fields cannot express "remove the stop" — see the
 * endpoint's handling.
 */
export const UpdateFavoriteSchema = z.object({
  morningStopName: z.string().nullable().optional(),
  eveningStopName: z.string().nullable().optional(),
  morningDirection: z.number().int().min(0).max(1).nullable().optional(),
  eveningDirection: z.number().int().min(0).max(1).nullable().optional(),
})
export type UpdateFavorite = z.infer<typeof UpdateFavoriteSchema>

/** User-level global settings (single row keyed by user id). */
export const UserSettingsSchema = z.object({
  morningStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  morningEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  eveningStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  eveningEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
})
export type UserSettings = z.infer<typeof UserSettingsSchema>

/** PATCH payload: partial update, each field independently validated. */
export const UpdateSettingsSchema = UserSettingsSchema.partial().refine(
  (s) => {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
    if (s.morningStart && s.morningEnd && toMin(s.morningStart) >= toMin(s.morningEnd)) return false
    if (s.eveningStart && s.eveningEnd && toMin(s.eveningStart) >= toMin(s.eveningEnd)) return false
    return true
  },
  { message: '时段起点必须早于终点' },
)
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>

export const CommuteProfileSchema = z.object({
  mode: z.enum(['work', 'home', 'auto']),
  activeDirection: z.number().int().min(0).max(1),
  targetStationName: z.string().optional(),
  description: z.string(),
})
export type CommuteProfile = z.infer<typeof CommuteProfileSchema>

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  })
