import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  WsClientMessageSchema,
  SearchLineQuerySchema,
  UserFavoriteLineSchema,
  UpdateFavoriteSchema,
  UpdateSettingsSchema,
  RefreshLiveRequestSchema,
  CommuteChainSchema,
  CommuteChainPurposeSchema,
  UpdateCommuteChainSchema,
  groupLineSummaries,
  type CommuteProfile,
  type UpdateSettings,
  type UserFavoriteLine,
} from '@real-time-transport/shared'
import { TransitService } from './services/transit.service.js'
import { Database, databaseUrlFor, isUniqueViolation } from './db/client.js'
import { resolveUserId } from './user-id.js'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'

/**
 * The HTTP boundary is where browser coordinates enter the server, so it is the
 * single place that converts them.
 *
 * The web app sends the raw `navigator.geolocation` fix, which is WGS-84, and
 * everything downstream is GCJ-02 (`docs/PRD.md` standardizes every stored and
 * delivered coordinate on GCJ-02; `AmapGisService` takes GCJ-02 and converts
 * nothing). Convert a fix here, once, and pass it on.
 *
 * A station coordinate is NOT a device fix: it comes from an Amap static station
 * sequence and is already GCJ-02, so it must be forwarded exactly as held — a
 * second conversion shifts the walking destination by ~500 m.
 */
function deviceFixToGcj02(lng: number, lat: number): { lng: number, lat: number } {
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
  return { lng: gcjLng, lat: gcjLat }
}

/**
 * The refusal for a `direction` the contracts do not accept, worded once and
 * naming both values they do.
 */
const DIRECTION_QUERY_ERROR = 'direction must be 0 or 1'

/**
 * The refusal for an `order` that is not a station ordinal, worded once and stating what
 * is accepted.
 */
const TARGET_ORDER_QUERY_ERROR = 'order must be a positive integer station ordinal'

/**
 * How many arrivals a caller gets when it names no `count`, and the most it may ask for.
 *
 * The default is the number the app's own two callers send; the bound was already
 * implied by this route (`Math.min(..., 20)`) and is now stated rather than applied
 * silently — see `countQueryOf`.
 */
const DEFAULT_ARRIVAL_COUNT = 6
const MAX_ARRIVAL_COUNT = 20

/**
 * The refusal for a `count` that is not a row count, worded once and naming the domain.
 */
const COUNT_QUERY_ERROR = `count must be a positive integer no greater than ${MAX_ARRIVAL_COUNT}`

/**
 * The `count` query parameter: how many arrival rows the caller wants.
 *
 * The query string is TEXT, and `Number()` accepts far more than a row count:
 * `Number('abc')` is NaN, which reached `vehicleArrivals(...).slice(0, NaN)` and
 * came back as **200 with an empty list** — a fabricated 「此刻没车」 at a moment
 * when the same line's `/live` carried vehicles (measured: 11 of them, with
 * `count=abc` answering 0 rows). The `direction` and `order` boundaries already
 * refuse a present-but-unusable value instead of normalizing it, and this is the
 * same rule one parameter over: `Number('')` is 0, `Number('3.7')` is a fraction
 * `.slice()` silently floors, `Number('1e2')` is a spelling no client sends, and
 * `Number('999')` was silently capped at 20 by the `Math.min` this constant
 * replaces.
 *
 * ABSENT is not malformed: a caller that names no count gets the route's own
 * `DEFAULT_ARRIVAL_COUNT`, which is the behaviour it has today.
 */
function countQueryOf(raw: unknown): { count: number } | null {
  if (raw === undefined) return { count: DEFAULT_ARRIVAL_COUNT }
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null
  const count = Number(raw)
  if (count > MAX_ARRIVAL_COUNT) return null
  return { count }
}

/**
 * The `direction` query parameter, read as the app's own contracts declare it:
 * `z.number().int().min(0).max(1)` on `LineDetail`, `LiveLineStatus` and the WS
 * messages — so 0 or 1, and an absent parameter is the declared default 0.
 *
 * The query string is TEXT, so the boundary reads the two literals and nothing
 * else. `Number()` — what this boundary used — accepts far more than a
 * direction: `Number('abc')` is NaN, which travelled through the engine and came
 * back as `train_subway_027_7_dNaN_dep118` (the `busId` of every arrivals row)
 * with `direction: null` in the payload; `Number('9')` accepted a value the same
 * contracts forbid; and `Number('1e0')`, `Number('0x1')` and `Number(' ')` are
 * `1` or `0` — spellings no client sends and no contract declares. A parameter
 * that is PRESENT but is neither literal is a request the boundary cannot mean,
 * and it is refused rather than normalized: the value the answer carries must be
 * the value the caller stated, or there must be no answer.
 *
 * `null` means refuse. A repeated parameter arrives as an array, which is not a
 * direction either.
 */
function directionQueryOf(raw: unknown): 0 | 1 | null {
  if (raw === undefined) return 0
  if (raw === '0') return 0
  if (raw === '1') return 1
  return null
}

/**
 * The `order` query parameter: the stop the reading should be priced to.
 *
 * `{}` means the caller named no target, which is a valid request and not the same thing
 * as a refused one — a reading with no target is what a line's own board shows (every
 * station at once, priced to the terminus). `null` means refuse.
 *
 * A parameter that IS present must be a station ordinal: a positive integer. Every
 * consumer indexes a stop list with it (`sd[order - 1]`, `stops.find(s => s.order ===
 * order)`), and `Number('abc')` would travel as NaN, price nothing, and answer a request
 * about one platform with a figure about the terminus — the silently-wrong-answer shape
 * `directionQueryOf` exists to refuse. Absent, zero, negative and non-integer spellings
 * are therefore not "no target": only the absent parameter is.
 */
function targetOrderQueryOf(raw: unknown): { targetOrder?: number } | null {
  if (raw === undefined) return {}
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null
  return { targetOrder: Number(raw) }
}

type AnchorPatch = {
  homeLat?: number | null
  homeLng?: number | null
  workLat?: number | null
  workLng?: number | null
}

/**
 * The outcome of a follow this server already holds, worded with the label the
 * settings screen already prints for a followed line (「已关注」) — one fact, one
 * vocabulary, on both sides of the wire.
 */
const ALREADY_FOLLOWED = '已关注'

/**
 * The row that already covers the line a caller is trying to follow, if any.
 *
 * A route is followed ONCE for both directions, so a follow is a duplicate when
 * the requested lineId is the stored row's own lineId OR EITHER SIDE's opposite
 * direction: the candidate's stated `reverseLineId` (the client names both
 * directions of the route it searched), or the row's stored one. The same route
 * read in a different city is a different route, which is why the columns of the
 * unique index (`user_id`, `city_code`, `line_id` — migration 008) are the ones
 * compared here.
 *
 * This function only reads what it is handed. Filling the row's `reverseLineId`
 * is the caller's job, because the column can still be NULL — it is written by the
 * GET /favorites self-heal and by nothing else — and a comparison over the stored
 * columns alone let the opposite direction INSERT a second row. `app.post`
 * therefore resolves both sides before calling in; see the route.
 */
export function findFollowedRoute(
  existing: readonly UserFavoriteLine[],
  candidate: { cityCode: string, lineId: string, reverseLineId?: string },
): UserFavoriteLine | undefined {
  const ids = new Set<string>([candidate.lineId])
  if (candidate.reverseLineId) ids.add(candidate.reverseLineId)

  return existing.find(f =>
    f.cityCode === candidate.cityCode
    && (ids.has(f.lineId) || (f.reverseLineId !== undefined && ids.has(f.reverseLineId))),
  )
}

/**
 * The answer to a follow this server already holds.
 *
 * A refusal, not a success: the caller asked for a line to be followed and got
 * back a row that was already there, so `success` (did this request follow it?)
 * is false and the outcome is stated outright. `data` still carries the row — the
 * caller needs it to show the line as followed at all, and `alreadyFollowed` is
 * what keeps that row from being read as a new card.
 *
 * The status is 409 (`Conflict`) for the same reason: on the wire the request was
 * refused by the state of the resource, and a 2xx would tell every client that a
 * follow happened.
 */
function alreadyFollowedBody(row: UserFavoriteLine): {
  success: false
  alreadyFollowed: true
  error: string
  data: UserFavoriteLine
} {
  return { success: false, alreadyFollowed: true, error: ALREADY_FOLLOWED, data: row }
}

/**
 * The anchor pairs `/settings` accepts, each written as a unit.
 *
 * A pair is the smallest honest write: the WGS-84 → GCJ-02 offset depends on
 * BOTH axes, so a lone latitude has no conversion at all, and storing one raw
 * would leave a WGS-84 value inside a column every walking route reads as GCJ-02.
 */
const ANCHOR_PAIRS = [
  { label: '家', lat: 'homeLat', lng: 'homeLng' },
  { label: '公司', lat: 'workLat', lng: 'workLng' },
] as const

/**
 * Convert the PATCH's anchor writes to GCJ-02, or report why they cannot land.
 *
 * This is the anchor write path, and the ONE place a stored coordinate changes
 * datum: the web app sends the browser's raw `navigator.geolocation` fix
 * (WGS-84) and converts nothing, so the conversion happens here — the same
 * boundary that already converts the GIS routes' incoming device fix. Everything
 * that later reads a stored anchor (F1's walking time first) holds GCJ-02 and
 * converts nothing: a second conversion moves the origin ~500 m, which against
 * F1's 3-minute wait tolerance is ~19.6 minutes of error and inverts the
 * 出门结论.
 *
 * Validated numerically BEFORE the write, because a coordinate that is not a
 * finite, in-range number poisons every later walking route — NaN metres, or a
 * garbage origin that silently looks like an anchor the user saved.
 *
 * A paired (0, 0) is refused as well, and only as a pair: it is what a device
 * reports when it could not make a fix, so it is not a position the user chose.
 * One axis of 0 is the equator or the prime meridian — a real fix — and stays
 * legal.
 */
function anchorPatchToGcj02(body: UpdateSettings): { error: string } | { patch: AnchorPatch } {
  const patch: AnchorPatch = {}

  for (const pair of ANCHOR_PAIRS) {
    const lat = body[pair.lat]
    const lng = body[pair.lng]
    // Untouched pairs stay `undefined`, so a PATCH of one anchor leaves the
    // other exactly as stored.
    patch[pair.lat] = undefined
    patch[pair.lng] = undefined
    if (lat === undefined && lng === undefined) continue

    if (lat === null && lng === null) {
      // An explicit null pair clears the anchor. Clearing is a real operation
      // (the user moved), and it stays a pair for the same reason setting does.
      patch[pair.lat] = null
      patch[pair.lng] = null
      continue
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { error: `${pair.label}位置必须成对提交经纬度，或成对清空` }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { error: `${pair.label}位置坐标无效，请重新定位` }
    }
    // The GPS-failure sentinel, refused before it can be stored. A device that
    // could not make a fix reports (0, 0), and this is the path a raw browser fix
    // arrives on, so a stored pair of zeros is indistinguishable from an anchor
    // the user saved and becomes the origin of every walking route — a point in
    // the Gulf of Guinea, thousands of km from anywhere this app serves.
    //
    // As a PAIR only. One axis of 0 is a real coordinate, not a sentinel, and
    // refusing it would invent a rule about where the user may stand.
    //
    // Nothing is reused from `statedCoordinate` (packages/shared/src/geo.ts): that
    // helper reads a 0 on EITHER axis as absence for UPSTREAM station data, where
    // a row nobody placed and a point at 0 are the same fact. The user's own path
    // spells absence as a NULL column instead — the branch above — so a 0 arriving
    // here is a value, and this check refuses the sentinel pair rather than
    // re-reading that rule on a different source.
    if (lat === 0 && lng === 0) {
      return { error: `${pair.label}位置坐标为 (0, 0)，通常是定位失败，请重新定位` }
    }

    const converted = deviceFixToGcj02(lng, lat)
    patch[pair.lat] = converted.lat
    patch[pair.lng] = converted.lng
  }

  return { patch }
}

/**
 * One stored commute window, or null when its user never chose it.
 *
 * A window is ONE value: a start with no end (or the other way round) contains no
 * time, so it is not a window. The write contract refuses half a window, which is
 * why this only has to answer 「两个端点都在吗」 — and a window that is not both ends
 * is reported as nothing at all, never as a partial time.
 */
function storedWindow(start: string | null, end: string | null): { start: string, end: string } | null {
  return start !== null && end !== null ? { start, end } : null
}

export interface AppOptions {
  databaseUrl?: string
  apizeroKey?: string
  /**
   * Amap Web-service key. Explicit here so a test can pin the upstream calls
   * without mutating `process.env` (a shell that once sourced `.env` would
   * otherwise leak the real key into the run).
   */
  amapKey?: string
  pollIntervalSec?: number
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  })

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  await app.register(websocket)

  // A test process never reaches a real store (see `databaseUrlFor`), and the drop
  // has to be visible: with the in-memory store in use, a database nobody
  // configured and a url that was refused look exactly the same from outside.
  const dbUrl = options.databaseUrl || databaseUrlFor(process.env)
  if (!dbUrl && process.env.DATABASE_URL) {
    console.warn(
      'DATABASE_URL ignored: this process looks like a test run (VITEST or NODE_ENV=test). Using the in-memory store.',
    )
  }
  const db = new Database(dbUrl)
  await db.init()

  const transitService = new TransitService(db, {
    apizeroKey: options.apizeroKey || process.env.APIZERO_KEY,
    amapKey: options.amapKey,
    pollIntervalSec: options.pollIntervalSec ? Number(options.pollIntervalSec) : 18,
  })

  app.addHook('onClose', async () => {
    transitService.stop()
    await db.close()
  })

  // Health check. `simulation` lets the web app label generated vehicles
  // unmistakably, so a simulated board is never mistaken for live data.
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: Date.now(),
    simulation: transitService.isSimulationEnabled(),
  }))

  /**
   * Runtime feature flags the web app needs for honest UI labelling.
   */
  app.get('/api/transit/runtime-flags', async () => {
    return {
      success: true,
      data: {
        simulation: transitService.isSimulationEnabled(),
      },
    }
  })

  // City dictionary (multi-city support)
  app.get('/api/transit/cities', async () => {
    return { success: true, data: transitService.getCities() }
  })

  /**
   * Search lines, merged into one result per route.
   *
   * A user follows a ROUTE, not a direction: 101 上行 / 101 下行 are one entry
   * with both directions attached, and the home screen switches between them.
   */
  app.get('/api/transit/lines/search', async (req, reply) => {
    const query = SearchLineQuerySchema.safeParse(req.query)
    if (!query.success) {
      return reply.status(400).send({ success: false, error: query.error.message })
    }

    const { keyword, cityCode } = query.data
    const results = await transitService.searchLines(keyword, cityCode)

    return { success: true, data: groupLineSummaries(results) }
  })

  // Line detail
  app.get('/api/transit/lines/:lineId', async (req, reply) => {
    const { lineId } = req.params as { lineId: string }
    const q = req.query as Record<string, string>
    const direction = directionQueryOf(q?.direction)
    if (direction === null) {
      return reply.status(400).send({ success: false, error: DIRECTION_QUERY_ERROR })
    }
    const cityCode = q?.cityCode

    const detail = await transitService.getLineDetail(lineId, direction, cityCode)
    if (!detail) {
      return reply.status(404).send({ success: false, error: 'Line not found' })
    }
    return { success: true, data: detail }
  })

  // Live status.
  //
  // `order` is the stop the reading is about, and it MUST reach the provider: upstream
  // fills a vehicle's `travelTimeSec` only when the request names a target stop, and
  // without it every in-transit vehicle is priced to the line's terminus. The platform
  // board asks this route about one platform, so a route that dropped the parameter left
  // its 预计到站 column unable to state a minute at all (see the board's own row builder).
  // `stationDistances` and the -1 「already past this stop」 sentinel travel with a
  // targeted reading too, so the consumer can exclude what no longer applies.
  app.get('/api/transit/lines/:lineId/live', async (req, reply) => {
    const { lineId } = req.params as { lineId: string }
    const q = req.query as Record<string, string>
    const direction = directionQueryOf(q?.direction)
    if (direction === null) {
      return reply.status(400).send({ success: false, error: DIRECTION_QUERY_ERROR })
    }
    const target = targetOrderQueryOf(q?.order)
    if (target === null) {
      return reply.status(400).send({ success: false, error: TARGET_ORDER_QUERY_ERROR })
    }
    const cityCode = q?.cityCode
    const simulate = q?.simulate === 'true'

    const status = await transitService.getLiveStatus(lineId, direction, cityCode, simulate, target)
    if (!status) {
      return reply.status(404).send({ success: false, error: 'Live status not available' })
    }
    return { success: true, data: status }
  })

  // GIS: Walking ETA (Amap real-road walking route planning)
  // origin* = raw WGS-84 device fix -> converted at this boundary.
  // dest*   = GCJ-02 station coordinate -> forwarded as held, never converted.
  app.get('/api/transit/gis/walk-eta', async (req, reply) => {
    const { originLng, originLat, destLng, destLat } = req.query as Record<string, string>
    if (!originLng || !originLat || !destLng || !destLat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const origin = deviceFixToGcj02(Number(originLng), Number(originLat))

    const result = await transitService.getWalkingEta(
      origin.lng,
      origin.lat,
      Number(destLng),
      Number(destLat),
    )
    if (!result) {
      return reply.status(404).send({ success: false, error: 'Walking route not available' })
    }
    return { success: true, data: result }
  })

  // GIS: Nearby stations radar (bus + subway within radius)
  // lng/lat = raw WGS-84 device fix -> converted at this boundary.
  app.get('/api/transit/gis/nearby-stations', async (req, reply) => {
    const { lng, lat, radius } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const origin = deviceFixToGcj02(Number(lng), Number(lat))
    const result = await transitService.getNearbyStations(origin.lng, origin.lat, Number(radius || 800))
    return { success: true, data: result }
  })

  // GIS: Reverse geocoding (GPS -> landmark)
  // lng/lat = raw WGS-84 device fix -> converted at this boundary.
  app.get('/api/transit/gis/regeo', async (req, reply) => {
    const { lng, lat } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const origin = deviceFixToGcj02(Number(lng), Number(lat))
    const result = await transitService.reverseGeocode(origin.lng, origin.lat)
    return { success: true, data: result }
  })

  // GIS: Catch-the-bus decision (walk ETA vs vehicle ETA for a target station)
  // origin* = raw WGS-84 device fix -> converted at this boundary. The station
  // is resolved server-side from the line's stored (GCJ-02) stop coordinates,
  // so nothing else crosses this boundary.
  app.get('/api/transit/gis/walk-decision', async (req, reply) => {
    const { originLng, originLat, lineId, direction, stationName, cityCode } = req.query as Record<string, string>
    if (!originLng || !originLat || !lineId || !stationName) {
      return reply.status(400).send({ success: false, error: 'Missing required parameters' })
    }
    const parsedDirection = directionQueryOf(direction)
    if (parsedDirection === null) {
      return reply.status(400).send({ success: false, error: DIRECTION_QUERY_ERROR })
    }

    const origin = deviceFixToGcj02(Number(originLng), Number(originLat))

    const result = await transitService.getWalkDecision({
      originLng: origin.lng,
      originLat: origin.lat,
      lineId,
      direction: parsedDirection,
      stationName,
      cityCode: cityCode || undefined,
    })
    if (!result) {
      return reply.status(404).send({ success: false, error: 'Station or route not found' })
    }
    return { success: true, data: result }
  })

  // Station arrivals (exact timetable overlay when available, else simulated)
  app.get('/api/transit/lines/:lineId/stations/:stationName/arrivals', async (req, reply) => {
    const { lineId, stationName } = req.params as { lineId: string, stationName: string }
    const q = req.query as Record<string, string>
    const direction = directionQueryOf(q?.direction)
    if (direction === null) {
      return reply.status(400).send({ success: false, error: DIRECTION_QUERY_ERROR })
    }
    // `order` is the stop the reading is about, and it must be a station ordinal
    // or absent — the same rule the live route applies. `Number(q.order)` used to
    // read it, so `?order=abc` became NaN, failed the engine's own positivity
    // test, and was DROPPED: the caller asked about one platform and the answer
    // was about the whole line, silently.
    const order = targetOrderQueryOf(q?.order)
    if (order === null) {
      return reply.status(400).send({ success: false, error: TARGET_ORDER_QUERY_ERROR })
    }
    // `count` is the row count, and a present-but-unusable one is refused rather
    // than normalized into an empty board — see `countQueryOf`.
    const count = countQueryOf(q?.count)
    if (count === null) {
      return reply.status(400).send({ success: false, error: COUNT_QUERY_ERROR })
    }

    const result = await transitService.getStationArrivals(
      decodeURIComponent(lineId),
      decodeURIComponent(stationName),
      direction,
      count.count,
      q?.cityCode || undefined,
      order.targetOrder,
    )
    if (!result) {
      return reply.status(404).send({ success: false, error: 'Station not found on this line' })
    }
    return { success: true, data: result }
  })

  /**
   * F11: re-read the real-time data on screen, now.
   *
   * Both of F11's entries — the home screen's and the line page's — come through
   * here, so the cooldown is one window per user rather than one per screen: two
   * screens refreshing once each would otherwise amount to two upstream reads.
   *
   * The refresh covers the real-time class only. Long-TTL line data (station
   * sequence, route geometry) is not re-read: it does not change when asked
   * again, and re-reading it spends upstream quota for nothing.
   *
   * Three outcomes, three statuses. 200 when a reading was obtained; 429 when
   * the window refused the attempt — nothing was read for it, and `Retry-After`
   * states when it may be; 502 when the reads were made and the upstream
   * answered nothing. A failed refresh is reported as failed, never as fresh.
   */
  app.post('/api/transit/refresh', async (req, reply) => {
    const body = RefreshLiveRequestSchema.safeParse(req.body ?? {})
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.issues[0]?.message })
    }

    const { outcome, result } = await transitService.refreshLive(body.data)

    if (outcome === 'throttled') {
      return reply
        .header('Retry-After', String(result.retryAfterSeconds))
        .status(429)
        .send({ success: false, error: '刷新太频繁了，请稍后再试', data: result })
    }

    if (outcome === 'unavailable') {
      return reply.status(502).send({ success: false, error: '未能取到最新数据，请稍后重试', data: result })
    }

    return { success: true, data: result }
  })

  // Favorites

  /**
   * Fold a follow that is already covered into the row that covers it.
   *
   * Nothing the row already holds is replaced: the reverse lineId is written only
   * where it was absent — from the lineId the caller just named, which is exactly
   * the direction the stored row was missing, and the reason the opposite
   * direction used to come back as a second row. The fold is what closes the
   * window the guard's resolution just opened, so the next follow needs no
   * upstream read to be recognised.
   *
   * Returns what is STORED, not what was intended: a refused write leaves the row
   * as it was, and handing back the intended merge would put a direction on screen
   * that the database never held.
   */
  async function foldInto(
    row: UserFavoriteLine,
    candidate: { lineId: string, preferredDirection: number },
  ): Promise<UserFavoriteLine> {
    const merged: UserFavoriteLine = {
      ...row,
      reverseLineId: row.reverseLineId
        ?? (candidate.lineId !== row.lineId ? candidate.lineId : undefined),
      preferredDirection: candidate.preferredDirection,
    }
    const persisted = await db.updateFavorite(merged.id!, merged).catch(() => false)
    return persisted ? merged : row
  }

  app.get('/api/transit/favorites', async (req) => {
    const userId = resolveUserId(req)
    const list = await db.getFavorites(userId)
    // One-time self-heal for rows saved before routes were followed as a whole:
    // resolves each route's opposite direction and persists it, so the home
    // screen can offer direction switching for them too.
    const enriched = await transitService.resolveFavoriteDirections(list)
    return { success: true, data: enriched }
  })

  app.post('/api/transit/favorites', async (req, reply) => {
    const body = UserFavoriteLineSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.message })
    }

    // A route is followed ONCE for both directions: re-adding it (or adding the
    // opposite direction of an already-followed route) does not create a second
    // card on the home screen.
    //
    // The stored `reverseLineId` cannot decide that on its own: the column is
    // filled by the GET /favorites self-heal and by nothing else, so a row whose
    // other direction has never been listed still holds NULL — comparing the
    // stored columns alone let the opposite direction INSERT a second row inside
    // that window. Both sides are therefore resolved HERE, at guard time, by the
    // same call the list makes; a row that already carries its reverse costs no
    // upstream read (`resolveFavoriteDirections` skips it), and what is resolved
    // is persisted, so the window closes for the next request too.
    const userId = resolveUserId(req)
    const existing = await db.getFavorites(userId)
    const followed = findFollowedRoute(
      await transitService.resolveFavoriteDirections(existing),
      body.data,
    )
    if (followed) {
      return reply.status(409).send(alreadyFollowedBody(await foldInto(followed, body.data)))
    }

    try {
      const item = await db.addFavorite({ ...body.data, userId })
      return { success: true, data: item }
    }
    catch (err) {
      // The unique index (008) is the backstop for a follow that got past the
      // guard: two requests in flight, or a reverse lineId neither side could
      // resolve. That is still an "already followed", not a failure — so answer
      // with the row that holds the line, never with a row this server did not
      // store (the memory fallback inside `addFavorite` is for an unreachable
      // database, and a refused INSERT is not that).
      if (!isUniqueViolation(err)) throw err
      const held = findFollowedRoute(
        await transitService.resolveFavoriteDirections(await db.getFavorites(userId)),
        body.data,
      )
      // Nothing to name as the holder: the refusal stands rather than being
      // dressed up as a follow this server cannot point at.
      if (!held) throw err
      return reply.status(409).send(alreadyFollowedBody(await foldInto(held, body.data)))
    }
  })

  app.patch('/api/transit/favorites/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateFavoriteSchema.safeParse(req.body)

    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.message })
    }

    const existing = (await db.getFavorites()).find(f => f.id === id)

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    // Ordering and pinning live on the favourite row; the board stops are a
    // separate concern with their own method. Each is touched only when the
    // caller actually sent it — setBoardStops reports "nothing to do" as false,
    // which must not surface as a 404 for a pin-only or order-only PATCH.
    const { displayOrder, isPinned, ...stops } = body.data

    if (isPinned !== undefined && !(await db.setPinned(existing.userId, id, isPinned))) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    if (displayOrder !== undefined) {
      await db.updateFavorite(id, { displayOrder })
    }

    // null clears the value, undefined leaves it alone — see Database.setBoardStops.
    const hasStops = Object.values(stops).some(value => value !== undefined)
    const updated = !hasStops || await db.setBoardStops(id, stops)

    if (!updated) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    const item = (await db.getFavorites()).find(f => f.id === id) ?? existing

    return { success: true, data: item }
  })

  app.delete('/api/transit/favorites/:id', async (req) => {
    const { id } = req.params as { id: string }
    const removed = await db.removeFavorite(id)
    return { success: true, data: { removed } }
  })

  /**
   * The stored settings row, or the fact that there is none.
   *
   * A read has three outcomes and they are not interchangeable (see
   * `apps/web/src/read-state.ts` and `docs/PRD.md` §4.1): still reading, read and
   * FAILED, and read. This route answers the second as an error status and the
   * third as `settingsState`. What it must never do is answer the third with a
   * row nobody stored: it used to fall back to the built-in hours, so a user who
   * had never opened 设置 read back `06:30–11:30 · 17:00–22:00` as if it were his
   * own configuration — indistinguishable on the wire from a row he had saved,
   * and printed as his own hours by the 设置 index row.
   *
   * So an unset row travels as a WORD plus an empty value: `settingsState:
   * 'unset'` and `data: null`. The word is the fact; the null is what makes a
   * consumer that ignores the word print an obviously empty row rather than a
   * plausible one. Every unset anchor is an explicit `null` on the stored row
   * for the same reason — never 0 and never a default city centre: (0, 0) is a
   * real coordinate in the Gulf of Guinea, indistinguishable from an anchor the
   * user actually saved, and would become the origin of every walking route.
   *
   * The same rule reaches the four times, one level in: since 009 a time column
   * holds NULL for 「用户从未选择过这个时刻」, and a stored row whose four times are
   * null is returned as exactly that — a `stored` row of nulls, never a row of
   * built-in hours. The row may still carry anchors (a PATCH that saved only an
   * anchor creates one), so the two domains are read from the same row and each
   * reports its own columns. Whether there is a WINDOW to be inside travels on the
   * profile (`windowState`), which is a question about the hours alone.
   */
  app.get('/api/transit/settings', async (req) => {
    const userId = resolveUserId(req)
    const stored = await db.getUserSettings(userId)
    if (!stored) {
      return { success: true, settingsState: 'unset', data: null }
    }
    return { success: true, settingsState: 'stored', data: stored }
  })

  app.patch('/api/transit/settings', async (req, reply) => {
    const body = UpdateSettingsSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.issues[0]?.message })
    }

    // Every anchor the request carries is converted here, once, before the write;
    // the returned patch names all four fields, so no raw fix can pass through.
    const anchors = anchorPatchToGcj02(body.data)
    if ('error' in anchors) {
      return reply.status(400).send({ success: false, error: anchors.error })
    }

    // Hours as sent, anchors as GCJ-02 — the stored row is one system. The answer
    // carries the state the same way the GET does, so a caller that renders the
    // row it just wrote says `stored` about it without a second read.
    //
    // The write is keyed to the SAME user the GET resolves, through the SAME
    // function: a request naming a user writes that user's row, and one naming none
    // writes the default — which is what this app's own client sends today (it names
    // no user at all), so this path's behaviour is unchanged for it. Writing
    // `default_user` unconditionally is what made a write for one user invisible to
    // the read for that same user.
    //
    // The fields the request did not carry are left as stored, and a field the user
    // has never chosen stays NULL — the write may not turn 「没选过」 into the built-in
    // hours, and it may not clear an anchor it was not asked about.
    const saved = await db.saveUserSettings(resolveUserId(req), { ...body.data, ...anchors.patch })
    return { success: true, settingsState: 'stored', data: saved }
  })

  // F10: commute chains. A chain is a named, ordered sequence of RIDE legs —
  // each one a line plus the station boarded at and the station alighted at —
  // starting from one of the two saved anchors. The walking/cycling connections
  // between legs are NOT stored: both ends' coordinates are in the line detail,
  // so their duration is computed from the real distance. Legs are written as
  // one value (see the PATCH below), and a leg's stations may be unset — as
  // null, never as an empty name.
  app.get('/api/transit/commute-chains', async (req) => {
    const userId = resolveUserId(req)
    return { success: true, data: await db.getCommuteChains(userId) }
  })

  app.get('/api/transit/commute-chains/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const chain = await db.getCommuteChain(id)
    if (!chain) {
      return reply.status(404).send({ success: false, error: '换乘链不存在' })
    }
    return { success: true, data: chain }
  })

  app.post('/api/transit/commute-chains', async (req, reply) => {
    const body = CommuteChainSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.issues[0]?.message })
    }

    const chain = await db.createCommuteChain({
      userId: resolveUserId(req),
      name: body.data.name,
      originAnchor: body.data.originAnchor,
      purpose: body.data.purpose,
      displayOrder: body.data.displayOrder,
      legs: body.data.legs,
    })
    return { success: true, data: chain }
  })

  app.patch('/api/transit/commute-chains/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateCommuteChainSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.issues[0]?.message })
    }

    // Fields the request did not carry are left as stored; `legs` present
    // replaces the whole sequence.
    const chain = await db.updateCommuteChain(id, body.data)
    if (!chain) {
      return reply.status(404).send({ success: false, error: '换乘链不存在' })
    }
    return { success: true, data: chain }
  })

  app.delete('/api/transit/commute-chains/:id', async (req) => {
    const { id } = req.params as { id: string }
    const removed = await db.removeCommuteChain(id)
    return { success: true, data: { removed } }
  })

  /**
   * F10: one purpose's worth of chains, each walked against live readings now.
   *
   * The shape answers the chain page's actual question — 「这个通勤目的下的几条
   * 链路，各自有没有余量」 — in ONE response. A route per chain would make the page
   * issue N requests, and those could be served from N different poll windows: it
   * would then be comparing 余量 computed from readings of different ages, which
   * is the 跳变 F10 rules out. One response also reads the whole purpose through
   * the same 18 s cache entries.
   *
   * A chain the engine cannot conclude on is NOT a request failure: the answer is
   * a 200 whose deduction is `{ status: 'no-conclusion', reason }` — the engine's
   * own code, from which the web layer writes the sentence. Only a request that
   * names no purpose of ours is refused, and then with a 400.
   */
  app.get('/api/transit/commute-chains/deductions', async (req, reply) => {
    const query = req.query as Record<string, string>
    const purpose = CommuteChainPurposeSchema.safeParse(query?.purpose)
    if (!purpose.success) {
      return reply.status(400).send({ success: false, error: 'purpose 只能是 morning 或 evening' })
    }

    const chains = await transitService.deduceCommuteChains({
      purpose: purpose.data,
      userId: resolveUserId(req),
    })
    return { success: true, data: { purpose: purpose.data, chains } }
  })

  /**
   * Commute profile: which of the two CONFIGURED windows the user is inside.
   *
   * The payload states the window, and nothing beyond it — no direction, no
   * destination, no advice. It deliberately carries no `activeDirection`: a
   * direction is a claim about the line being shown, and this endpoint has no
   * line to make it about, so the only value the field could ever hold is a
   * constant. A field that is always the same value is not an answer.
   *
   * It also states WHETHER there was a window to be inside (`windowState`), in
   * three values rather than two. The read used to fall back to the built-in hours,
   * so a user who had never saved any settings was told 「早通勤时段」 at 08:30 — a
   * window nobody configured cannot contain the current time, and every consumer of
   * this payload (the home card's commute slot and label, the chain page's default
   * purpose) was acting on a window the user had had no part in. With no stored row
   * the answer is `unset`; with a row whose four times were never chosen (since 009
   * they are NULL) it is `unchosen` — the row exists, but no hour of it was ever
   * picked, so the clock is compared against nothing and the copy is 「未设置通勤时段」
   * for both. `auto` then means the one thing here it can mean, 「不在任何已配置时段内」
   * including the case where none is configured. The two words stay apart because
   * they are facts about different things — no row to hold a window / a row that
   * holds none — and a surface that needs to send the user somewhere acts on which.
   */
  app.get('/api/transit/commute-profile', async (req) => {
    const now = new Date()
    const hours = now.getHours()
    const minutes = now.getMinutes()
    const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`

    const settings = await db.getUserSettings(resolveUserId(req))
    if (!settings) {
      const profile: CommuteProfile = {
        mode: 'auto',
        description: '未设置通勤时段',
        windowState: 'unset',
      }
      return { success: true, data: profile }
    }

    // A window counts only when BOTH of its ends were chosen: one end is not a
    // window — it contains no time — and the write contract refuses to store one.
    // A NULL is never read as a time here, so a schedule nobody chose cannot
    // decide which leg the user is on.
    const morning = storedWindow(settings.morningStart, settings.morningEnd)
    const evening = storedWindow(settings.eveningStart, settings.eveningEnd)
    if (!morning && !evening) {
      const profile: CommuteProfile = {
        mode: 'auto',
        description: '未设置通勤时段',
        windowState: 'unchosen',
      }
      return { success: true, data: profile }
    }

    let mode: CommuteProfile['mode'] = 'auto'

    if (morning && timeStr >= morning.start && timeStr <= morning.end) {
      mode = 'work'
    }
    else if (evening && timeStr >= evening.start && timeStr <= evening.end) {
      mode = 'home'
    }

    // The window is the whole fact: the copy names it and adds nothing. Which
    // direction a leg runs, and when the line's service starts and ends, are
    // answered by the line being looked at (F3), not by the clock.
    const description = mode === 'work' ? '早通勤时段' : mode === 'home' ? '晚通勤时段' : '非通勤时段'

    const profile: CommuteProfile = {
      mode,
      description,
      windowState: 'stored',
    }
    return { success: true, data: profile }
  })

  // WebSocket endpoint
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (data: Buffer | string) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        const raw = JSON.parse(text)
        const parsed = WsClientMessageSchema.safeParse(raw)
        if (!parsed.success) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid message payload' }))
          return
        }

        const msg = parsed.data
        if (msg.action === 'subscribe') {
          transitService.subscribe(socket, msg.lineId, msg.direction, msg.cityCode)
        }
        else if (msg.action === 'unsubscribe') {
          transitService.unsubscribe(socket, msg.lineId, msg.direction)
        }
        else if (msg.action === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }))
        }
      }
      catch (err: any) {
        socket.send(JSON.stringify({ type: 'error', message: err.message }))
      }
    })

    socket.on('close', () => {
      transitService.removeClient(socket)
    })
  })

  return app
}
