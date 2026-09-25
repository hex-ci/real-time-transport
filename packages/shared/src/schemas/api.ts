import { z } from 'zod'
import { DataSourceTypeSchema } from './transit.js'
import { DEFAULT_USER_ID } from '../constants.js'

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
  userId: z.string().default(DEFAULT_USER_ID),
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
   * direction.
   */
  morningDirection: z.number().int().min(0).max(1).nullable().optional(),
  /** Direction the user commutes in the EVENING, chosen independently. */
  eveningDirection: z.number().int().min(0).max(1).nullable().optional(),
  displayOrder: z.number().int().default(0),
  /**
   * When the row was followed, ISO-8601. The order's final tiebreak: rows that
   * share a `displayOrder` are separated by which was followed first, which is
   * the tail of the server's `ORDER BY is_pinned DESC, display_order ASC,
   * created_at ASC`. Optional because a create request has no instant of its
   * own — the column, and therefore the value, belongs to the server.
   */
  createdAt: z.string().optional(),
  /**
   * Pinned as the home screen's single hero card. A state, not a position: the
   * stored order is never rewritten, so unpinning drops the row back where it
   * was. At most one favourite per user may be pinned, enforced by a partial
   * unique index on the column.
   */
  isPinned: z.boolean().default(false),
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
  /** Position in the user's own ordering, 0-based, written as a whole list. */
  displayOrder: z.number().int().min(0).optional(),
  /** Pin state. Not nullable: a pin is never cleared into a third state. */
  isPinned: z.boolean().optional(),
})
export type UpdateFavorite = z.infer<typeof UpdateFavoriteSchema>

/**
 * User-level global settings (single row keyed by user id).
 *
 * The anchors are the saved home/work coordinates used to derive walking time
 * to a board stop. They arrive as raw WGS-84 from a one-off GPS read on the
 * phone and are converted server-side — the AMap key is a Web-service key and
 * must never reach the browser. Nullable because "no anchor saved yet" is a
 * real state the home screen has to render without inventing a default.
 *
 * The four times are nullable for the same reason, one level further in: since
 * migration 009 the columns hold NULL for 「用户从未选择过这个时刻」, and that is a
 * different fact from 「选择了 06:30」. Before 009 the columns declared NOT NULL
 * DEFAULT, so a row created by saving an anchor alone silently carried the
 * built-in window and no column could tell the two apart — the read then printed
 * the built-in hours as the user's own configuration. NULL is the honest value,
 * and it is never presented as a time anywhere.
 */
export const UserSettingsSchema = z.object({
  morningStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  morningEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  eveningStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  eveningEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  homeLat: z.number().min(-90).max(90).nullable().optional(),
  homeLng: z.number().min(-180).max(180).nullable().optional(),
  workLat: z.number().min(-90).max(90).nullable().optional(),
  workLng: z.number().min(-180).max(180).nullable().optional(),
})
export type UserSettings = z.infer<typeof UserSettingsSchema>

/**
 * PATCH payload: partial update, each field independently validated.
 *
 * `undefined` leaves a field as stored; an explicit `null` clears it. `null` is
 * what makes the four times clearable at all, and it is why the schema is
 * partial-of-nullable rather than partial-of-required.
 *
 * A WINDOW IS ONE VALUE, so its two ends are given together or not at all: a
 * lone `morningStart` would store half a window, which is neither a window (no
 * end means it contains no time) nor 「从未选择」 (one end is on the row). That is
 * the same rule 007 applies to a leg's station — 「站名与站序同生同灭」 — and the
 * reason it is a refinement here rather than a route check is the reason the two
 * station-pair refinements are: POST, PATCH and any direct write are then covered
 * by one rule. The ordering rule was already here, so the boundary that rules on
 * one window's shape is the boundary that rules on the other.
 */
export const UpdateSettingsSchema = UserSettingsSchema.partial()
  .refine(
    s => (s.morningStart === undefined) === (s.morningEnd === undefined),
    { message: '早高峰的起点与终点必须同时给出或同时留空' },
  )
  .refine(
    s => (s.eveningStart === undefined) === (s.eveningEnd === undefined),
    { message: '晚高峰的起点与终点必须同时给出或同时留空' },
  )
  .refine(
    (s) => {
      const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
      if (s.morningStart && s.morningEnd && toMin(s.morningStart) >= toMin(s.morningEnd)) return false
      if (s.eveningStart && s.eveningEnd && toMin(s.eveningStart) >= toMin(s.eveningEnd)) return false
      return true
    },
    { message: '时段起点必须早于终点' },
  )
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>

/**
 * Whether the settings ROW the caller asked about exists at all.
 *
 * `unset` is not a failure and not a value: it is the answer of a read that
 * succeeded and found no row for this user, so `GET /settings` answers it with
 * `data: null` rather than a plausible set of hours the user never configured.
 * §4.1 requires exactly this distinction — 读失败与确实为空必须分得开 — and the
 * surfaces that show a window (the 设置 index row, the 通勤时段 page, the home
 * card's commute slot, the chain page's default purpose) branch on it instead of
 * printing the built-in hours as the user's own.
 *
 * `stored` means the row exists and the payload carries it. It does NOT mean the
 * user chose every field: an anchor column may be null, and since 009 the four
 * times may be null too — 「行在，但通勤时段从未被选过」. That is a fact about the
 * row's CONTENT and it travels as the content itself: a `stored` row whose four
 * times are null. Whether there is a WINDOW to be inside is a second question
 * with its own word (`CommuteWindowStateSchema`), and it is not this one.
 */
export const SettingsReadStateSchema = z.enum(['stored', 'unset'])
export type SettingsReadState = z.infer<typeof SettingsReadStateSchema>

/**
 * Whether there was a stored WINDOW — a state about the window, not about the row.
 *
 * Two of its members say what `SettingsReadStateSchema` says (`stored`/`unset`),
 * and the third exists because a row can exist while the hours do not: `unchosen`
 * is 「行在，四个时刻是 NULL」, i.e. the user saved something (an anchor, or an empty
 * PATCH) and never chose a commute window. It is NOT a smaller `unset`: one says
 * there is no row to hold a window, the other that the row holds none.
 *
 * Required on the profile with no default, for the reason the field was added at
 * all: `mode: 'auto'` already meant two different facts (outside the configured
 * windows / no window configured at all), and a consumer could not tell which.
 * With `unchosen` the clock is compared against nothing — a window nobody chose
 * cannot contain the current time — so the profile answers `auto` with
 * 「未设置通勤时段」, and every consumer of the payload says the same thing.
 */
export const CommuteWindowStateSchema = z.enum(['stored', 'unchosen', 'unset'])
export type CommuteWindowState = z.infer<typeof CommuteWindowStateSchema>

export const CommuteProfileSchema = z.object({
  mode: z.enum(['work', 'home', 'auto']),
  description: z.string(),
  /** Whether there was a stored window for this profile to be inside. */
  windowState: CommuteWindowStateSchema,
})
export type CommuteProfile = z.infer<typeof CommuteProfileSchema>

/**
 * F10 — a chain starts from one of the two saved anchors, and serves one of the
 * two commute purposes. Both are closed sets: a third value is not a smaller
 * version of one of these, it is an unanswerable chain.
 */
export const CommuteChainAnchorSchema = z.enum(['home', 'work'])
export type CommuteChainAnchor = z.infer<typeof CommuteChainAnchorSchema>

export const CommuteChainPurposeSchema = z.enum(['morning', 'evening'])
export type CommuteChainPurpose = z.infer<typeof CommuteChainPurposeSchema>

/**
 * One RIDE leg of a chain: a line plus the station boarded at and the station
 * alighted at, inside that line.
 *
 * The walking/cycling connections between legs are deliberately absent — the
 * stations' coordinates are already in the line detail, so their duration is
 * computed from the real distance rather than typed in (and a stored copy would
 * drift into a second, contradictory fact).
 *
 * A station is identified by its name AND its stop order, which travel
 * together: the order is what locates it in the line's stop list (a line can
 * repeat a name, and a subway line numbers the same station differently per
 * direction), while the name is what the user recognizes. The pair is one
 * value, so a lone half is rejected rather than half-stored.
 *
 * `null` is the honest value for a station not chosen yet. It is never `''`:
 * an empty string reads back as a station named "", which does not exist.
 *
 * A leg runs in ONE direction of its line, and the stored stop orders say which.
 * On a bus the alight order must be GREATER than the board order: the two ways
 * there are two distinct line ids, so a stored `lineId` names one of them, and the
 * other way round is the user's entry backwards. On a subway the two ways share
 * ONE line id while numbering the same station oppositely, so either order is a
 * real ride — a lesser alight order runs the leg the other way, and the read side
 * resolves that direction from these very orders. A leg whose two ends are the
 * SAME station is an error on both, because it is not a ride at all.
 *
 * The rule is a refinement here rather than a route check so that POST, PATCH and
 * any direct write all reject a bad record at one boundary. It is the write-end
 * twin of the engine's `leg-recorded-backwards` (`commute-chain.ts`), which asks
 * the same question of a row that is already stored.
 *
 * No direction column: on a bus the two directions are two different line ids,
 * and on a subway the two stop orders say which way round the leg runs.
 */
export const CommuteChainLegSchema = z.object({
  /**
   * Position in the chain, 0-based. Written by the server from the order of the
   * array it receives — a request may omit it (the order it sends IS the
   * order), and a value it carries is not trusted, because a gap or a duplicate
   * would leave the legs' sequence unreadable.
   */
  seq: z.number().int().min(0).optional(),
  lineId: z.string().min(1),
  /** The line's name at entry time, so the chain is readable without an upstream read. */
  lineName: z.string().min(1),
  cityCode: z.string().default('027'),
  boardStationName: z.string().nullable(),
  boardStationOrder: z.number().int().positive().nullable(),
  alightStationName: z.string().nullable(),
  alightStationOrder: z.number().int().positive().nullable(),
  /**
   * Minutes added to the connection that leads INTO this leg, beyond the
   * route service's own duration (cycling: finding and parking the bike).
   * `null` means the user configured nothing — the deduction layer then uses
   * its default; it is not 0, which would mean "no extra time at all".
   */
  transferExtraMinutes: z.number().int().min(0).nullable(),
})
  .refine(
    leg => (leg.boardStationName === null) === (leg.boardStationOrder === null),
    { message: '上车站的站名与站序必须同时给出或同时留空' },
  )
  .refine(
    leg => (leg.alightStationName === null) === (leg.alightStationOrder === null),
    { message: '下车站的站名与站序必须同时给出或同时留空' },
  )
  .refine(
    // The leg must run in ONE direction of its line, and only the lineId says which
    // way is downstream. On a bus the two ways are two lineIds, so a stored lineId
    // names one of them and the alight order must be the greater one: a lesser
    // alight order there is the user's entry the wrong way round. On a subway one
    // lineId carries BOTH ways while numbering the same station oppositely, so the
    // very same pair of orders is a real ride the other way — the read side resolves
    // that direction from the orders — and rejecting it here would make a
    // legitimate reverse subway chain unrecordable. Equality is neither: a ride from
    // a station to itself is not a shorter version of one of these legs.
    //
    // Same spirit as the two pair refinements above — the bad record is rejected at
    // the boundary rather than stored and later explained as a fact about our
    // reading — and a refinement rather than a route check, so POST, PATCH and any
    // direct write are covered by one rule. An unchosen station has no order to
    // compare and stays allowed; the pair refinement already governs it.
    //
    // The subway test is the project's own convention, not a second predicate: a
    // subway line id carries the `subway_` prefix, which is what routes a read to
    // the subway engine (`subway-router.ts`, `universal-subway.ts`, and
    // `transit.service.ts`'s live path). The engine asks the same question of the
    // same field at the read end, so the two layers cannot disagree about a line.
    leg => leg.boardStationOrder === null || leg.alightStationOrder === null
      || leg.alightStationOrder > leg.boardStationOrder
      || (leg.lineId.startsWith('subway_') && leg.alightStationOrder < leg.boardStationOrder),
    { message: '下车站的站序必须大于上车站的站序；只有地铁可以反向（下车站站序小于上车站站序），同一站不是乘车段' },
  )
export type CommuteChainLeg = z.infer<typeof CommuteChainLegSchema>

/**
 * F10 — a named commute chain: where it starts from, which purpose it serves,
 * and the ordered ride legs it is made of.
 *
 * `legs` is the whole sequence, written as one value: a chain is its legs, so
 * replacing them replaces the chain's substance rather than merging into it. At
 * least one ride leg — a chain with none carries no conclusion at all.
 *
 * `id` and `createdAt` are the server's, optional on the way in like a
 * favourite's.
 */
export const CommuteChainSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().default(DEFAULT_USER_ID),
  name: z.string().min(1),
  originAnchor: CommuteChainAnchorSchema,
  purpose: CommuteChainPurposeSchema,
  /** Position in the user's own ordering, 0-based. */
  displayOrder: z.number().int().min(0).default(0),
  createdAt: z.string().optional(),
  legs: z.array(CommuteChainLegSchema).min(1, { message: '换乘链至少需要一段乘车段' }),
})
export type CommuteChain = z.infer<typeof CommuteChainSchema>

/**
 * PATCH payload: a partial update, each field independently validated.
 *
 * Omitting `legs` leaves the chain's legs alone; sending them replaces the
 * whole sequence. There is no per-leg PATCH — the seq numbers are positions, so
 * editing "one leg" would renumber the rest anyway.
 */
export const UpdateCommuteChainSchema = z.object({
  name: z.string().min(1).optional(),
  originAnchor: CommuteChainAnchorSchema.optional(),
  purpose: CommuteChainPurposeSchema.optional(),
  displayOrder: z.number().int().min(0).optional(),
  legs: z.array(CommuteChainLegSchema).min(1, { message: '换乘链至少需要一段乘车段' }).optional(),
})
export type UpdateCommuteChain = z.infer<typeof UpdateCommuteChainSchema>

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  })

/**
 * F11 — the manual refresh, as the wire carries it.
 *
 * The refresh covers the REAL-TIME class of data only: the readings that change
 * from minute to minute (vehicle positions, arrival minutes). Long-TTL line data
 * (station sequence, route geometry) is not part of it — those are not things
 * that "update" when asked again, and re-reading them spends upstream quota for
 * a value that cannot differ.
 *
 * `REFRESH_MAX_LINES` bounds the upstream reads one refresh may trigger: every
 * entry is at least one request, and the caller names the lines.
 */
export const REFRESH_MAX_LINES = 8

/**
 * One line a screen wants re-read.
 *
 * Sent by the caller rather than resolved server-side from the user's followed
 * lines: only the screen knows what it is showing, and the home screen and the
 * line page do not show the same set.
 */
export const RefreshLiveTargetSchema = z.object({
  lineId: z.string().min(1),
  direction: z.number().int().min(0).max(1).default(0),
  cityCode: z.string().optional(),
})
export type RefreshLiveTarget = z.infer<typeof RefreshLiveTargetSchema>

export const RefreshLiveRequestSchema = z.object({
  /**
   * Whose cooldown window this is. Caller-supplied: this endpoint has no auth,
   * so the id is a label rather than an identity — sending a different one buys
   * a fresh window, and since the window map is bounded by recency, a caller can
   * also push another id's window out of it. Stated rather than guarded: the
   * window exists to bound upstream reads, and it exposes no data of anyone's.
   */
  userId: z.string().min(1).default(DEFAULT_USER_ID),
  lines: z.array(RefreshLiveTargetSchema).min(1).max(REFRESH_MAX_LINES),
})
export type RefreshLiveRequest = z.infer<typeof RefreshLiveRequestSchema>

/**
 * One line's outcome of one attempt.
 *
 * `lastUpdatedAt` is the instant this line's reading was obtained from the
 * source that produced it, and null when this attempt obtained none. Null is
 * the honest answer for a failed read: the current time is not a reading.
 *
 * `dataSource` / `isDegraded` are that reading's provenance, carried from the
 * status that produced it and null exactly when there is no reading. They ride
 * along because the instant alone cannot say what kind of reading it is: with
 * simulation on, a generated vehicle's reading is stamped with the current time
 * like any other, and a caller holding only the instant would report it as an
 * obtained one. F4's mark is derived from these two, never from the clock.
 */
export const RefreshLiveLineSchema = z.object({
  lineId: z.string(),
  direction: z.number().int().min(0).max(1),
  lastUpdatedAt: z.number().nullable(),
  dataSource: DataSourceTypeSchema.nullable(),
  isDegraded: z.boolean().nullable(),
})
export type RefreshLiveLineResult = z.infer<typeof RefreshLiveLineSchema>

/**
 * The refresh's answer.
 *
 * `lastUpdatedAt` is the instant the freshest real-time reading obtained through
 * this endpoint for this user was obtained from its source, and null until a
 * refresh has obtained one. It is never the instant the server answered: that
 * value would be true of every response, and would claim a reading at a moment
 * when none was obtained. It is also NOT the age of whatever is already on
 * screen — the reading on screen carries its own instant, and the screen keeps
 * showing that until a refreshed reading replaces it.
 *
 * `nextAllowedAt` and `retryAfterSeconds` are stated even when the request was
 * refused, because the refusal is exactly where a screen needs a deadline to
 * count down to, and the instant of the data it is already showing is still
 * worth reporting while it does. Both describe the one deadline and therefore
 * agree in every outcome — including the ones where nothing was refused.
 */
export const RefreshLiveResultSchema = z.object({
  /** The class of data this refresh covers. Real-time, and only real-time. */
  dataClass: z.literal('live'),
  /** True when the cooldown refused this request: nothing was read for it. */
  throttled: z.boolean(),
  lastUpdatedAt: z.number().nullable(),
  nextAllowedAt: z.number(),
  /**
   * Seconds until `nextAllowedAt` — the wait a countdown renders, derived from
   * that deadline in every outcome. A success and a failed read each spend the
   * window for the full cooldown, so both report the remaining wait rather than
   * 0: 「now」 is only ever true of a window that is actually open.
   */
  retryAfterSeconds: z.number().min(0),
  /**
   * Per-line outcomes of THIS attempt, one per distinct line asked for. Empty
   * when the attempt was refused — reporting a null reading for a line nobody
   * read would state that it was read and answered nothing.
   */
  lines: z.array(RefreshLiveLineSchema),
})
export type RefreshLiveResult = z.infer<typeof RefreshLiveResultSchema>
