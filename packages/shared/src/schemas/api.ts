import { z } from 'zod'

export const LineSummarySchema = z.object({
  lineId: z.string(),
  lineName: z.string(),
  direction: z.number().int().min(0).max(1),
  startStop: z.string(),
  endStop: z.string(),
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
   * Station pinned for `preferredDirection`. Undefined means no pin, in which
   * case the UI falls back to the GPS-nearest stop.
   */
  pinnedStationName: z.string().optional(),
  /**
   * Station pinned for the OPPOSITE direction. Bus routes stop at opposite ends
   * of the city depending on direction, so one pin cannot serve both; subway
   * reuses one lineId for both directions, which is why pins are keyed by
   * direction rather than by lineId.
   */
  reversePinnedStationName: z.string().optional(),
  displayOrder: z.number().int().default(0),
})
export type UserFavoriteLine = z.infer<typeof UserFavoriteLineSchema>

/**
 * Payload for updating a favourite's pinned stations.
 *
 * `null` clears the pin (falling back to GPS); `undefined` leaves it untouched.
 * Passing explicit nulls is required because a plain PATCH with optional fields
 * cannot express "remove the pin" — see the endpoint's handling.
 */
export const UpdateFavoriteSchema = z.object({
  pinnedStationName: z.string().nullable().optional(),
  reversePinnedStationName: z.string().nullable().optional(),
})
export type UpdateFavorite = z.infer<typeof UpdateFavoriteSchema>

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
