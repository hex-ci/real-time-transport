import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  WsClientMessageSchema,
  SearchLineQuerySchema,
  UserFavoriteLineSchema,
  UpdateFavoriteSchema,
  DEFAULT_COMMUTE_HOURS,
  groupLineSummaries,
  type CommuteProfile,
  type UserFavoriteLine,
} from '@real-time-transport/shared'
import { TransitService } from './services/transit.service.js'
import { Database } from './db/client.js'

export interface AppOptions {
  databaseUrl?: string
  apizeroKey?: string
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

  const db = new Database(options.databaseUrl || process.env.DATABASE_URL)
  await db.init()

  const transitService = new TransitService(db, {
    apizeroKey: options.apizeroKey || process.env.APIZERO_KEY,
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
   * A user follows a ROUTE, not a direction: 913 上行 / 913 下行 are one entry
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
    const direction = Number(q?.direction ?? 0)
    const cityCode = q?.cityCode

    const detail = await transitService.getLineDetail(lineId, direction, cityCode)
    if (!detail) {
      return reply.status(404).send({ success: false, error: 'Line not found' })
    }
    return { success: true, data: detail }
  })

  // Live status
  app.get('/api/transit/lines/:lineId/live', async (req, reply) => {
    const { lineId } = req.params as { lineId: string }
    const q = req.query as Record<string, string>
    const direction = Number(q?.direction ?? 0)
    const cityCode = q?.cityCode
    const simulate = q?.simulate === 'true'

    const status = await transitService.getLiveStatus(lineId, direction, cityCode, simulate)
    if (!status) {
      return reply.status(404).send({ success: false, error: 'Live status not available' })
    }
    return { success: true, data: status }
  })

  // GIS: Walking ETA (Amap real-road walking route planning)
  app.get('/api/transit/gis/walk-eta', async (req, reply) => {
    const { originLng, originLat, destLng, destLat } = req.query as Record<string, string>
    if (!originLng || !originLat || !destLng || !destLat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const result = await transitService.getWalkingEta(
      Number(originLng),
      Number(originLat),
      Number(destLng),
      Number(destLat),
    )
    if (!result) {
      return reply.status(404).send({ success: false, error: 'Walking route not available' })
    }
    return { success: true, data: result }
  })

  // GIS: Nearby stations radar (bus + subway within radius)
  app.get('/api/transit/gis/nearby-stations', async (req, reply) => {
    const { lng, lat, radius } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const result = await transitService.getNearbyStations(Number(lng), Number(lat), Number(radius || 800))
    return { success: true, data: result }
  })

  // GIS: Reverse geocoding (GPS -> landmark)
  app.get('/api/transit/gis/regeo', async (req, reply) => {
    const { lng, lat } = req.query as Record<string, string>
    if (!lng || !lat) {
      return reply.status(400).send({ success: false, error: 'Missing coordinate parameters' })
    }

    const result = await transitService.reverseGeocode(Number(lng), Number(lat))
    return { success: true, data: result }
  })

  // GIS: Catch-the-bus decision (walk ETA vs vehicle ETA for a target station)
  app.get('/api/transit/gis/walk-decision', async (req, reply) => {
    const { originLng, originLat, lineId, direction, stationName, cityCode } = req.query as Record<string, string>
    if (!originLng || !originLat || !lineId || !stationName) {
      return reply.status(400).send({ success: false, error: 'Missing required parameters' })
    }

    const result = await transitService.getWalkDecision({
      originLng: Number(originLng),
      originLat: Number(originLat),
      lineId,
      direction: Number(direction ?? 0),
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
    const direction = Number(q?.direction ?? 0)
    const count = Math.min(Number(q?.count ?? 6), 20)

    const order = q?.order ? Number(q.order) : undefined

    const result = await transitService.getStationArrivals(
      decodeURIComponent(lineId),
      decodeURIComponent(stationName),
      direction,
      count,
      q?.cityCode || undefined,
      order,
    )
    if (!result) {
      return reply.status(404).send({ success: false, error: 'Station not found on this line' })
    }
    return { success: true, data: result }
  })

  // Favorites
  app.get('/api/transit/favorites', async (req) => {
    const userId = (req.query as any)?.userId || 'default_user'
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
    // opposite direction of an already-followed route) updates the existing row
    // instead of creating a duplicate card on the home screen.
    const existing = await db.getFavorites(body.data.userId)
    const duplicate = existing.find(f =>
      f.cityCode === body.data.cityCode
      && (f.lineId === body.data.lineId || f.reverseLineId === body.data.lineId),
    )
    if (duplicate) {
      const merged: UserFavoriteLine = {
        ...duplicate,
        // Fill in the reverse lineId if it was missing, so direction switching
        // works for favourites saved before this field existed.
        reverseLineId: duplicate.reverseLineId
          ?? (body.data.lineId !== duplicate.lineId ? body.data.lineId : undefined),
        preferredDirection: body.data.preferredDirection ?? duplicate.preferredDirection,
      }
      await db.updateFavorite(merged.id!, merged).catch(() => {})
      return { success: true, data: merged }
    }

    const item = await db.addFavorite(body.data)
    return { success: true, data: item }
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

    // null clears the pin, undefined leaves it alone — see Database.setPinnedStations.
    const updated = await db.setPinnedStations(id, {
      pinnedStationName: body.data.pinnedStationName,
      reversePinnedStationName: body.data.reversePinnedStationName,
    })

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

  // Commute profile & smart context
  app.get('/api/transit/commute-profile', async () => {
    const now = new Date()
    const hours = now.getHours()
    const minutes = now.getMinutes()
    const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`

    let mode: CommuteProfile['mode'] = 'auto'
    let activeDirection = 0
    let description = '常规出行监测模式'

    if (timeStr >= DEFAULT_COMMUTE_HOURS.morningStart && timeStr <= DEFAULT_COMMUTE_HOURS.morningEnd) {
      mode = 'work'
      activeDirection = 1 // 上班方向
      description = '早高峰通勤 · 开往工作地'
    }
    else if (timeStr >= DEFAULT_COMMUTE_HOURS.eveningStart && timeStr <= DEFAULT_COMMUTE_HOURS.eveningEnd) {
      mode = 'home'
      activeDirection = 0 // 下班方向
      description = '晚高峰通勤 · 踏上归途'
    }

    const profile: CommuteProfile = {
      mode,
      activeDirection,
      description,
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
