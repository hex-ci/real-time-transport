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
  DEFAULT_CITY_CODE,
  groupLineSummaries,
  type AnchorSource,
  type CommuteProfile,
  type UpdateSettings,
  type UserFavoriteLine,
} from '@real-time-transport/shared'
import { TransitService } from './services/transit.service.js'
import { Database, databaseUrlFor, isUniqueViolation } from './db/client.js'
import { resolveUserId } from './user-id.js'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'

/**
 * HTTP 边界是浏览器坐标进入服务端的地方，因此也是唯一做换算的地方。
 *
 * 站点坐标不是设备定位：它本身就是 GCJ-02，必须原样转发，不能再换算。
 */
function deviceFixToGcj02(lng: number, lat: number): { lng: number, lat: number } {
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
  return { lng: gcjLng, lat: gcjLat }
}

const DIRECTION_QUERY_ERROR = 'direction must be 0 or 1'

const TARGET_ORDER_QUERY_ERROR = 'order must be a positive integer station ordinal'

/** 调用方未命名 `count` 时返回的条数，以及最多可以要多少。 */
const DEFAULT_ARRIVAL_COUNT = 6
const MAX_ARRIVAL_COUNT = 20

const COUNT_QUERY_ERROR = `count must be a positive integer no greater than ${MAX_ARRIVAL_COUNT}`

/**
 * `count` query 参数：调用方要多少条到站行。
 *
 * query string 是文本，因此只接受十进制正整数：给了值但不可用的直接拒绝，不归一化。
 * 缺省不是畸形 —— 没命名 count 的调用方拿到 `DEFAULT_ARRIVAL_COUNT`。
 */
function countQueryOf(raw: unknown): { count: number } | null {
  if (raw === undefined) return { count: DEFAULT_ARRIVAL_COUNT }
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null
  const count = Number(raw)
  if (count > MAX_ARRIVAL_COUNT) return null
  return { count }
}

/**
 * `direction` query 参数：按契约只能是 0 或 1，参数缺省即默认 0。
 *
 * query string 是文本，因此只认这两个字面量：存在但不是其中之一的（含重复参数以数组到达）
 * 是这个边界无法表达的请求，直接拒绝而不归一化 —— 答案带的值必须是调用方声明的值。
 *
 * `null` 表示拒绝。
 */
function directionQueryOf(raw: unknown): 0 | 1 | null {
  if (raw === undefined) return 0
  if (raw === '0') return 0
  if (raw === '1') return 1
  return null
}

/**
 * `order` query 参数：读数应该定价到的那一站。
 *
 * `{}` 表示调用方没有命名目标，这是合法请求：没有目标的读数就是线路自己站牌显示的东西
 * （所有站点一起，定价到终点站）。给了值就必须是站点序号（正整数）—— `null` 表示拒绝。
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
  homePlaceName?: string | null
  workPlaceName?: string | null
  homeAnchorSource?: AnchorSource | null
  workAnchorSource?: AnchorSource | null
}

const ALREADY_FOLLOWED = '已关注'

/**
 * 已经覆盖调用方想关注的那条线路的行，如果有。
 *
 * 一条线路对两个方向只关注一次，因此请求的 lineId 是已存行自己的 lineId，或任一侧的反方向时，
 * 这次关注就是重复。同一条线路在另一个城市是另一条线路，因此比较的是唯一索引的列
 * （`user_id`、`city_code`、`line_id`）。
 *
 * 本函数只读它拿到的数据：填该行的 `reverseLineId` 是调用方的事。
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
 * 本服务端已持有的关注所对应的答复：`success` 为 false、状态 409，`data` 仍带那一行 ——
 * 调用方需要它才能把线路显示为已关注，`alreadyFollowed` 让那行不被读成新卡片。
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
 * `/settings` 接受的锚点对：一对是最小的诚实写入，只写一个轴无从换算。
 *
 * 每个锚点还带地点名与来源两列，它们描述**同一对坐标**，故跟着这一对一起走：
 * 清空坐标时一并清空（名字与来源说的是一个不再存在的坐标对）。
 */
const ANCHOR_PAIRS = [
  { label: '家', lat: 'homeLat', lng: 'homeLng', placeName: 'homePlaceName', source: 'homeAnchorSource' },
  { label: '公司', lat: 'workLat', lng: 'workLng', placeName: 'workPlaceName', source: 'workAnchorSource' },
] as const

/**
 * 把 PATCH 的锚点写入换算成 GCJ-02，或者报告它们为什么落不下来。
 *
 * 这是锚点写路径，也是存储坐标换基准的唯一的地方：此后读存储锚点的一切都按 GCJ-02 用、
 * 不做换算。坐标在写入之前按数值校验；成对的 (0, 0) 作为一对拒绝，单轴为 0 合法。
 *
 * **按来源决定换不换算**（`docs/PRD.md` §5.4）：
 *   - `device`（缺省）—— 浏览器上报的原始 WGS-84 设备定位，过 `deviceFixToGcj02` 一次；
 *   - `search` —— 高德地点搜索返回的坐标，**本身就是 GCJ-02**，原样落库。
 * 来源随坐标一起存，它就是这个判据的凭据：一次搜索来的坐标若也走换算，会被再挪约 500 m，
 * 而存下来的仍是一个看着合理的坐标，界面上看不出来。
 *
 * 来源缺省（`undefined`）按 `device` 处理，且**据此写下 `device`**：013 之前的调用方
 * （包括既有测试与任何未跟上的客户端）提交的都是原始设备定位，而一条 PATCH 必须留下
 * 「这次的坐标是怎么来的」的记录 —— 不写就等于下一次读的人只能猜。
 */
function anchorPatchToGcj02(body: UpdateSettings): { error: string } | { patch: AnchorPatch } {
  const patch: AnchorPatch = {}

  for (const pair of ANCHOR_PAIRS) {
    const lat = body[pair.lat]
    const lng = body[pair.lng]
    // 未触碰的锚点对保持 `undefined`，因此只 PATCH 一个锚点
    // 会让另一个完全保持存储的样子。
    patch[pair.lat] = undefined
    patch[pair.lng] = undefined
    patch[pair.placeName] = undefined
    patch[pair.source] = undefined
    if (lat === undefined && lng === undefined) {
      // 名字与来源描述的是那一对坐标，故没有坐标时它们无处可落。**说出来**而不是静静丢掉：
      // 一个只带 `homePlaceName` 的 PATCH 若被无声接受，写入方会以为名字存下来了。
      if (body[pair.placeName] !== undefined || body[pair.source] !== undefined) {
        return { error: `${pair.label}位置的地点名与来源必须随一对经纬度一起提交` }
      }
      continue
    }

    if (lat === null && lng === null) {
      // 显式的 null 对清空锚点。清空是真实操作
      // （用户搬家了），它保持成对的原因与设置相同。
      patch[pair.lat] = null
      patch[pair.lng] = null
      // 名字与来源描述的是那一对坐标，故随它一起清空：留着一个属于已删坐标的名字，
      // 会让索引行说出一个库里已不存在的地点。
      patch[pair.placeName] = null
      patch[pair.source] = null
      continue
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { error: `${pair.label}位置必须成对提交经纬度，或成对清空` }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { error: `${pair.label}位置坐标无效，请重新定位` }
    }
    // GPS 定位失败的哨兵值，在能存下来之前就被拒，且只作为一对拒：成对的 (0, 0)
    // 是设备定位失败时报的值，不是用户选的位置；单轴为 0 是真实坐标，仍然合法。
    if (lat === 0 && lng === 0) {
      return { error: `${pair.label}位置坐标为 (0, 0)，通常是定位失败，请重新定位` }
    }

    const source: AnchorSource = body[pair.source] ?? 'device'
    const stored = source === 'search' ? { lng, lat } : deviceFixToGcj02(lng, lat)
    patch[pair.lat] = stored.lat
    patch[pair.lng] = stored.lng
    patch[pair.source] = source
    // 名字是搜索来的那一个（设备抓的位置没有名字），故只随 `search` 落库。
    // 一次设备写入把名字清掉：旧名字会说出一个已被覆盖的坐标。
    patch[pair.placeName] = source === 'search' ? (body[pair.placeName] ?? null) : null
  }

  return { patch }
}

/**
 * 一条存储的通勤时段，或者用户从未选择过它时的 null：有开始没结束（或反过来）不含任何时间，
 * 因此不是时段 —— 报告为完全没有，绝不报告为部分时间。
 */
function storedWindow(start: string | null, end: string | null): { start: string, end: string } | null {
  return start !== null && end !== null ? { start, end } : null
}

export interface AppOptions {
  databaseUrl?: string
  apizeroKey?: string
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

  // 测试进程永远到不了真实存储（见 `databaseUrlFor`），且这次丢弃必须看得见。
  const dbUrl = options.databaseUrl || databaseUrlFor(process.env)
  if (!dbUrl && process.env.DATABASE_URL) {
    console.warn(
      'DATABASE_URL ignored: this process looks like a test run (VITEST or NODE_ENV=test). Using the in-memory store.',
    )
  }
  const db = new Database(dbUrl)
  await db.init()

  // 实时刷新间隔的优先级：用户在设置页的选择 > 环境变量 > 默认 18s。
  // DB 里 null 即"没选过"，走后面的回退；normalize 在 TransitService 构造里统一做。
  const storedSettings = await db.getUserSettings().catch(() => null)
  const configuredIntervalSec = storedSettings?.refreshIntervalSec
    ?? (process.env.TRANSIT_POLL_INTERVAL_SEC ? Number(process.env.TRANSIT_POLL_INTERVAL_SEC) : undefined)

  const transitService = new TransitService(db, {
    apizeroKey: options.apizeroKey || process.env.APIZERO_KEY,
    amapKey: options.amapKey,
    pollIntervalSec: options.pollIntervalSec ?? configuredIntervalSec,
  })

  app.addHook('onClose', async () => {
    transitService.stop()
    await db.close()
  })

  // `simulation` 让 web 端能明确标出生成的车辆，
  // 模拟站牌不会被误认成实时数据。
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: Date.now(),
    simulation: transitService.isSimulationEnabled(),
  }))

  app.get('/api/transit/runtime-flags', async () => {
    return {
      success: true,
      data: {
        simulation: transitService.isSimulationEnabled(),
      },
    }
  })

  // 城市字典（多城市支持）
  app.get('/api/transit/cities', async () => {
    return { success: true, data: transitService.getCities() }
  })

  /**
   * 搜索线路，按线路合并成一条结果：用户关注的是线路，不是方向 ——
   * 101 上行 / 101 下行 是一个条目，首页在它们之间切换。
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

  // 线路详情
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

  // `order` 是这次读数针对的站点，必须原样传到 provider；
  // `stationDistances` 和 -1「已过此站」哨兵也随定向读数一起走。
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

  // origin* = 原始 WGS-84 设备定位 -> 在本边界换算。
  // dest*   = GCJ-02 站点坐标 -> 原样转发，绝不换算。
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

  // lng/lat = 原始 WGS-84 设备定位 -> 在本边界换算。
  app.get('/api/transit/gis/nearby-stations', async (req, reply) => {
    const { lng, lat, radius } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const origin = deviceFixToGcj02(Number(lng), Number(lat))
    const result = await transitService.getNearbyStations(origin.lng, origin.lat, Number(radius || 800))
    return { success: true, data: result }
  })

  // lng/lat = 原始 WGS-84 设备定位 -> 在本边界换算。
  app.get('/api/transit/gis/regeo', async (req, reply) => {
    const { lng, lat } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const origin = deviceFixToGcj02(Number(lng), Number(lat))
    const result = await transitService.reverseGeocode(origin.lng, origin.lat)
    return { success: true, data: result }
  })

  /**
   * F2：地点搜索 —— 把自由文本变成若干候选地点，供「家 / 公司」的锚点页选择。
   *
   * 无坐标进出这个边界：`keywords` 是文本，返回的 `lng`/`lat` 是高德自己的 GCJ-02，
   * 原样下发（客户端把它们原样存回，来源记为 `search`，见 §5.4）。
   * key 只在服务端 —— 硬约束：绝不能把高德的凭据交给浏览器。
   *
   * 三种结局各说各的：
   *   - `keywords` 为空 → 400。空关键词不是「搜索全部」，它是一次无法表达的搜索；
   *   - 上游没答上来（无 key、网络、超时、QPS/配额）→ 502，且**不缓存**：一次失败不该
   *     被读成「没有这个地方」；
   *   - 上游答了但没有匹配 → 200 与一个空数组。空与失败必须分得开。
   */
  app.get('/api/transit/gis/place-search', async (req, reply) => {
    const { keywords, cityCode } = req.query as Record<string, string>
    const trimmed = (keywords ?? '').trim()
    if (!trimmed) {
      return reply.status(400).send({ success: false, error: 'keywords 不能为空' })
    }

    const result = await transitService.searchPlaces(trimmed, cityCode || DEFAULT_CITY_CODE)
    if (result === null) {
      return reply.status(502).send({ success: false, error: '地点搜索暂时不可用，请稍后重试' })
    }
    return { success: true, data: result }
  })

  // origin* = 原始 WGS-84 设备定位 -> 在本边界换算。站点
  // 在服务端从线路存储的（GCJ-02）站点坐标解析，
  // 因此没有别的坐标穿过这个边界。
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

  // 站点到站（有时刻表则精确时刻表覆盖，否则模拟）
  app.get('/api/transit/lines/:lineId/stations/:stationName/arrivals', async (req, reply) => {
    const { lineId, stationName } = req.params as { lineId: string, stationName: string }
    const q = req.query as Record<string, string>
    const direction = directionQueryOf(q?.direction)
    if (direction === null) {
      return reply.status(400).send({ success: false, error: DIRECTION_QUERY_ERROR })
    }
    // `order` 必须是站点序号或缺省 —— 与实时路由同一条规则。
    const order = targetOrderQueryOf(q?.order)
    if (order === null) {
      return reply.status(400).send({ success: false, error: TARGET_ORDER_QUERY_ERROR })
    }
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
   * F11：立刻重读屏幕上的实时数据。
   *
   * 冷却时间是每个用户一个窗口，而不是每屏一个：F11 的两个入口都走这里。
   * 刷新只覆盖实时这一类，长 TTL 的线路数据不重读。
   *
   * 取到读数 200；窗口拒绝 429（`Retry-After` 说明何时可再试）；读取已发出而上游没答 502。
   * 失败的刷新报告为失败，绝不报告为新的。
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

  // 收藏

  /**
   * 把一次已被覆盖的关注折进覆盖它的那一行：该行已有的东西都不被替换，
   * reverse lineId 只在原来缺失的地方写入。
   *
   * 返回的是存储下来的，不是打算写入的 —— 被拒的写会让该行保持原样。
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
    // 对「线路作为整体被关注之前存下的行」做一次性自愈：解析每条线路的反方向并落库。
    const enriched = await transitService.resolveFavoriteDirections(list)
    return { success: true, data: enriched }
  })

  app.post('/api/transit/favorites', async (req, reply) => {
    const body = UserFavoriteLineSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ success: false, error: body.error.message })
    }

    // 一条线路对两个方向只关注一次：重复添加它（或添加已关注线路的反方向）
    // 不会在首页产生第二张卡片。
    //
    // 已存的 `reverseLineId` 自己判不了这件事（该列可能仍是 NULL），因此两侧都在这里、
    // 在守卫处解析，用的是列表用的同一个调用；解析出来的结果会落库，窗口对下一个请求也关着。

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
      // 唯一索引是后备：被拒的 INSERT 仍然是「已关注」，不是失败 —— 用持有这条线路的那一行
      // 作答，绝不用本服务端没有存储的行（`addFavorite` 的内存回退是针对不可达数据库的）。
      if (!isUniqueViolation(err)) throw err
      const held = findFollowedRoute(
        await transitService.resolveFavoriteDirections(await db.getFavorites(userId)),
        body.data,
      )
      // 没有可称为持有者的行：拒绝成立，
      // 而不是粉饰成一次本服务端指不出来的关注。
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

    // id 来自同一套解析，GET 与 POST 都是如此 ——
    // 否则一次写会落到请求从未命名过的行上。
    const userId = resolveUserId(req)
    const existing = (await db.getFavorites(userId)).find(f => f.id === id)

    if (!existing) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    // 排序与置顶在收藏行上，上车点走自己的方法：setBoardStops 报「无事可做」为 false，
    // 这不能在一次只置顶或只改顺序的 PATCH 里以 404 浮现。
    const { displayOrder, isPinned, ...stops } = body.data

    if (isPinned !== undefined && !(await db.setPinned(userId, id, isPinned))) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    if (displayOrder !== undefined) {
      await db.updateFavorite(id, { displayOrder })
    }

    // null 清空该值，undefined 不动它（见 Database.setBoardStops）；
    // 上车点以「对」（name, order）传输，schema 拒绝单独一半。

    const hasStops = Object.values(stops).some(value => value !== undefined)
    const updated = !hasStops || await db.setBoardStops(id, stops)

    if (!updated) {
      return reply.status(404).send({ success: false, error: 'favorite not found' })
    }

    const item = (await db.getFavorites(userId)).find(f => f.id === id) ?? existing

    return { success: true, data: item }
  })

  app.delete('/api/transit/favorites/:id', async (req) => {
    const { id } = req.params as { id: string }
    const removed = await db.removeFavorite(id)
    return { success: true, data: { removed } }
  })

  /**
   * 存储的设置行，或者「没有这一行」这个事实。
   *
   * 一次读有三种结果，不能互换（见 `apps/web/src/read-state.ts` 与 `docs/PRD.md` §4.1）：
   * 仍在读取、读取且失败、读取完成。本路由把第二种答成错误状态，第三种答成 `settingsState`。
   * 绝不能用没人存过的行去答第三种。
   *
   * 因此未设置的行以一个词加一个空值传输：`settingsState: 'unset'` 与 `data: null`。
   * 每个未设置的锚点在存储行上是显式 `null`，绝不是 0，也绝不是默认城市中心。
   *
   * 同一条规则管四个时刻：自 009 起时间列对「用户从未选择过这个时刻」持 NULL，
   * 四个时刻都为 null 的行就按那样返回 —— 一行 `stored` 的 null，绝不是一行内置时段。
   * 有没有可身处其中的时段随 profile 走（`windowState`），那只关于时段本身。
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

    // 请求带的每个锚点都在写入前在这里换算一次；
    // 返回的 patch 命名全部四个字段，因此没有原始定位能穿过去。
    const anchors = anchorPatchToGcj02(body.data)
    if ('error' in anchors) {
      return reply.status(400).send({ success: false, error: anchors.error })
    }

    // 时段按原样，锚点按 GCJ-02 —— 存储的行是同一个系统；答复与 GET 一样携带状态。
    // 写入与 GET 解析的是同一个用户，走同一个函数：命名了用户的请求写那个用户的行，
    // 没命名的写默认用户。
    //
    // 请求没带的字段保持存储的样子，用户从未选择过的字段保持 NULL。

    const saved = await db.saveUserSettings(resolveUserId(req), { ...body.data, ...anchors.patch })
    // 刷新间隔改了就即时生效：不断服务，不断 WS —— 只重启轮询节拍。
    // schema 已把取值钳在 10~120（UpdateSettingsSchema），这里只处理"带了该字段"的情况；
    // 传 null 表示清掉选择，回退默认 18s。
    if (body.data.refreshIntervalSec !== undefined) {
      transitService.setPollIntervalSec(body.data.refreshIntervalSec ?? undefined)
    }
    return { success: true, settingsState: 'stored', data: saved }
  })

  // F10：通勤链路。一条链路是命名的、有序的乘车腿序列 —— 每条腿是一条线路加上车站与下车站 ——
  // 起点由它的通勤目的决定：上班从家出发、下班从公司出发（`anchorForPurpose`），故起点不是录入项。
  // 腿之间的步行/骑行衔接不存储：两端的坐标都在线路详情里，
  // 时长按真实距离算。腿作为一个值写入，腿的站点可以未设置 —— 作为 null，绝不是空名字。
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

    // 请求没带的字段保持存储的样子；`legs` 存在即整段替换。
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
   * F10：某一个通勤目的下的全部链路，各自对着此刻的实时读数走一遍。
   *
   * 一次响应回答整页，而不是每链路一个请求：分次请求会由不同轮询窗口服务，
   * 等于比较不同新鲜度读数算出的余量。
   *
   * 引擎得不出结论的链路不是请求失败：答复是 200，其 deduction 为
   * `{ status: 'no-conclusion', reason }`。只有没命名我们某个目的的请求才被拒（400）。
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
   * 通勤档案：用户身处两个已配置时段中的哪一个，以及有没有可身处其中的时段
   * （`windowState`，三个值而非两个）。
   *
   * 它故意不带 `activeDirection`：本端点没有线路可断言，该字段能持有的值只有常量。
   *
   * 没有存储行时是 `unset`；行存在但四个时刻从未被选择过（自 009 起它们是 NULL）是 `unchosen`，
   * 文案两者都是「未设置通勤时段」。`auto` 只意味着「不在任何已配置时段内」，包括没有配置的情况。
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

    // 只有两端都被选过时段才算数：一端不是时段，它不含任何时间，写契约也拒绝存储。
    // 这里绝不把 NULL 读成时间。

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

    // 时段就是全部事实：文案命名它，不加别的。方向与服务时段由正在看的
    // 那条线路（F3）回答，不是时钟。
    const description = mode === 'work' ? '早通勤时段' : mode === 'home' ? '晚通勤时段' : '非通勤时段'

    const profile: CommuteProfile = {
      mode,
      description,
      windowState: 'stored',
    }
    return { success: true, data: profile }
  })

  // WebSocket 端点
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
