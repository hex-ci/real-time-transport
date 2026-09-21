import pg from 'pg'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import type { LineDetail, UserFavoriteLine } from '@real-time-transport/shared'

const { Pool } = pg

export class Database {
  private pool: pg.Pool | null = null
  private inMemoryFavorites = new Map<string, any>()
  private inMemoryLineCache = new Map<string, { detail: LineDetail, fetchedAt: number }>()
  private inMemorySettings = new Map<string, {
    morningStart: string
    morningEnd: string
    eveningStart: string
    eveningEnd: string
  }>()

  constructor(private readonly connectionString?: string) {
    if (this.connectionString) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        connectionTimeoutMillis: 3000,
      })
      this.pool.on('error', (err) => {
        console.warn('PostgreSQL pool error:', err.message)
      })
    }
  }

  /**
   * Verify the schema is present. Table ownership belongs to migrations/
   * (run `pnpm migrate:up`); this only reports readiness so a missing migration
   * fails loudly instead of silently degrading to the in-memory store.
   */
  async init(): Promise<void> {
    if (!this.pool) return
    try {
      const client = await this.pool.connect()
      try {
        const res = await client.query(`
          SELECT to_regclass('public.user_favorite_lines') AS favorites,
                 to_regclass('public.cached_transit_lines') AS cache
        `)
        const row = res.rows[0]
        if (!row?.favorites || !row?.cache) {
          console.warn(
            'Database schema missing. Run `pnpm migrate:up` to create/upgrade tables.',
          )
        }
      }
      finally {
        client.release()
      }
    }
    catch (err: any) {
      console.warn('PostgreSQL connection skipped (using memory store):', err.message)
      this.pool = null
    }
  }

  // ---------- Favorites ----------

  async getFavorites(userId: string = 'default_user'): Promise<UserFavoriteLine[]> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT * FROM user_favorite_lines WHERE user_id = $1 ORDER BY display_order ASC, created_at ASC',
          [userId],
        )
        return res.rows.map(row => ({
          id: row.id,
          userId: row.user_id,
          cityCode: row.city_code ?? '027',
          lineId: row.line_id,
          lineName: row.line_name,
          preferredDirection: row.preferred_direction ?? 0,
          reverseLineId: row.reverse_line_id ?? undefined,
          morningStopName: row.pinned_station_name ?? undefined,
          eveningStopName: row.reverse_pinned_station_name ?? undefined,
          morningDirection: row.morning_direction ?? null,
          eveningDirection: row.evening_direction ?? null,
          displayOrder: row.display_order ?? 0,
        }))
      }
      catch {
        // Fallback to memory
      }
    }
    return Array.from(this.inMemoryFavorites.values())
      .filter(f => f.userId === userId)
      .map(f => ({
        id: f.id,
        userId: f.userId,
        cityCode: f.cityCode ?? '027',
        lineId: f.lineId,
        lineName: f.lineName,
        preferredDirection: f.preferredDirection ?? 0,
        reverseLineId: f.reverseLineId,
        morningStopName: f.morningStopName ?? undefined,
        eveningStopName: f.eveningStopName ?? undefined,
        morningDirection: f.morningDirection ?? null,
        eveningDirection: f.eveningDirection ?? null,
        displayOrder: f.displayOrder ?? 0,
      }))
  }

  async addFavorite(item: {
    userId?: string
    cityCode?: string
    lineId: string
    lineName: string
    preferredDirection?: number
    reverseLineId?: string
    morningStopName?: string
    eveningStopName?: string
    displayOrder?: number
  }): Promise<UserFavoriteLine> {
    const id = crypto.randomUUID()
    const userId = item.userId || 'default_user'
    const cityCode = item.cityCode || '027'

    if (this.pool) {
      try {
        const res = await this.pool.query(
          `INSERT INTO user_favorite_lines (id, user_id, city_code, line_id, line_name, preferred_direction, reverse_line_id, pinned_station_name, reverse_pinned_station_name, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            id,
            userId,
            cityCode,
            item.lineId,
            item.lineName,
            item.preferredDirection ?? 0,
            item.reverseLineId || null,
            item.morningStopName || null,
            item.eveningStopName || null,
            item.displayOrder ?? 0,
          ],
        )
        const row = res.rows[0]!
        return {
          id: row.id,
          userId: row.user_id,
          cityCode: row.city_code,
          lineId: row.line_id,
          lineName: row.line_name,
          preferredDirection: row.preferred_direction ?? 0,
          reverseLineId: row.reverse_line_id ?? undefined,
          morningStopName: row.pinned_station_name ?? undefined,
          eveningStopName: row.reverse_pinned_station_name ?? undefined,
          displayOrder: row.display_order ?? 0,
        }
      }
      catch {
        // Fallback to memory
      }
    }

    const record = {
      id,
      userId,
      cityCode,
      lineId: item.lineId,
      lineName: item.lineName,
      preferredDirection: item.preferredDirection ?? 0,
      reverseLineId: item.reverseLineId,
      morningStopName: item.morningStopName,
      eveningStopName: item.eveningStopName,
      displayOrder: item.displayOrder ?? 0,
    }
    this.inMemoryFavorites.set(id, record)
    return record
  }

  async updateFavorite(id: string, item: {
    cityCode?: string
    lineId?: string
    lineName?: string
    preferredDirection?: number
    reverseLineId?: string
    morningStopName?: string
    displayOrder?: number
  }): Promise<boolean> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          `UPDATE user_favorite_lines SET
             city_code = COALESCE($2, city_code),
             line_id = COALESCE($3, line_id),
             line_name = COALESCE($4, line_name),
             preferred_direction = COALESCE($5, preferred_direction),
             reverse_line_id = COALESCE($6, reverse_line_id),
             pinned_station_name = COALESCE($7, pinned_station_name),
             display_order = COALESCE($8, display_order)
           WHERE id = $1`,
          [
            id,
            item.cityCode ?? null,
            item.lineId ?? null,
            item.lineName ?? null,
            item.preferredDirection ?? null,
            item.reverseLineId ?? null,
            item.morningStopName ?? null,
            item.displayOrder ?? null,
          ],
        )
        if ((res.rowCount ?? 0) > 0) return true
      }
      catch {
        // Fall through to memory
      }
    }
    const rec = this.inMemoryFavorites.get(id)
    if (rec) {
      Object.assign(rec, item)
      return true
    }
    return false
  }

  /**
   * Set or clear a favourite's commute board stops and their directions.
   *
   * Kept separate from `updateFavorite` because that method wraps every column
   * in COALESCE, which can never write NULL — clearing a stop (or unpicking a
   * direction) is exactly a NULL write. Here `undefined` leaves a field
   * untouched and `null` clears it. Fields are keyed by PURPOSE
   * (morning/evening), mapped onto the storage columns inside this method.
   */
  async setBoardStops(id: string, stops: {
    morningStopName?: string | null
    eveningStopName?: string | null
    morningDirection?: number | null
    eveningDirection?: number | null
  }): Promise<boolean> {
    const sets: string[] = []
    const values: (string | number | null)[] = [id]
    const push = (column: string, value: string | number | null | undefined) => {
      if (value === undefined) return
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    push('pinned_station_name', stops.morningStopName)
    push('reverse_pinned_station_name', stops.eveningStopName)
    push('morning_direction', stops.morningDirection)
    push('evening_direction', stops.eveningDirection)

    if (sets.length === 0) return false

    if (this.pool) {
      try {
        const res = await this.pool.query(
          `UPDATE user_favorite_lines SET ${sets.join(', ')} WHERE id = $1`,
          values,
        )
        if ((res.rowCount ?? 0) > 0) return true
        return this.inMemoryFavorites.has(id)
      }
      catch {
        // Fall through to memory
      }
    }

    const rec = this.inMemoryFavorites.get(id)
    if (rec) {
      if (stops.morningStopName !== undefined) rec.morningStopName = stops.morningStopName
      if (stops.eveningStopName !== undefined) {
        rec.eveningStopName = stops.eveningStopName
      }
      if (stops.morningDirection !== undefined) rec.morningDirection = stops.morningDirection
      if (stops.eveningDirection !== undefined) rec.eveningDirection = stops.eveningDirection
      return true
    }
    return false
  }

  async removeFavorite(id: string): Promise<boolean> {
    if (this.pool) {
      try {
        const res = await this.pool.query('DELETE FROM user_favorite_lines WHERE id = $1', [id])
        if ((res.rowCount ?? 0) > 0) return true
        return this.inMemoryFavorites.delete(id)
      }
      catch {
        return this.inMemoryFavorites.delete(id)
      }
    }
    return this.inMemoryFavorites.delete(id)
  }

  // ---------- User settings ----------

  /** Commute hours stored in user_settings; null when never configured. */
  async getUserSettings(userId: string = 'default_user'): Promise<{
    morningStart: string
    morningEnd: string
    eveningStart: string
    eveningEnd: string
  } | null> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT morning_start, morning_end, evening_start, evening_end FROM user_settings WHERE user_id = $1',
          [userId],
        )
        const row = res.rows[0]
        if (!row) return null
        return {
          // TIME columns come back as "HH:MM:SS" — trim to HH:MM for the API.
          morningStart: String(row.morning_start).slice(0, 5),
          morningEnd: String(row.morning_end).slice(0, 5),
          eveningStart: String(row.evening_start).slice(0, 5),
          eveningEnd: String(row.evening_end).slice(0, 5),
        }
      }
      catch {
        // Table missing (migration not applied) or transient failure: defaults
        // are a safe answer, so swallow and let the caller use its fallback.
      }
    }
    return null
  }

  async saveUserSettings(userId: string, settings: {
    morningStart?: string
    morningEnd?: string
    eveningStart?: string
    eveningEnd?: string
  }): Promise<{
    morningStart: string
    morningEnd: string
    eveningStart: string
    eveningEnd: string
  }> {
    const merged = { ...DEFAULT_COMMUTE_HOURS, ...settings }
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO user_settings (user_id, morning_start, morning_end, evening_start, evening_end, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           morning_start = EXCLUDED.morning_start,
           morning_end = EXCLUDED.morning_end,
           evening_start = EXCLUDED.evening_start,
           evening_end = EXCLUDED.evening_end,
           updated_at = NOW()`,
        [userId, merged.morningStart, merged.morningEnd, merged.eveningStart, merged.eveningEnd],
      )
    }
    else {
      this.inMemorySettings.set(userId, merged)
    }
    return merged
  }

  // ---------- Static line cache ----------

  async getCachedLine(lineId: string, direction: number): Promise<LineDetail | null> {
    const key = `${lineId}_${direction}`
    if (this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT detail_json FROM cached_transit_lines WHERE line_id = $1 AND direction = $2',
          [lineId, direction],
        )
        if (res.rows.length > 0) {
          return res.rows[0]!.detail_json as LineDetail
        }
        return null
      }
      catch {
        // Fallback
      }
    }
    return this.inMemoryLineCache.get(key)?.detail ?? null
  }

  async upsertCachedLine(detail: LineDetail, source: string = 'amap'): Promise<void> {
    const key = `${detail.lineId}_${detail.direction}`
    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO cached_transit_lines (line_id, direction, city_code, detail_json, source, last_fetched_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (line_id, direction)
           DO UPDATE SET detail_json = EXCLUDED.detail_json, source = EXCLUDED.source, last_fetched_at = NOW()`,
          [detail.lineId, detail.direction, detail.cityCode, JSON.stringify(detail), source],
        )
        return
      }
      catch {
        // Fallback
      }
    }
    this.inMemoryLineCache.set(key, { detail, fetchedAt: Date.now() })
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
    }
  }
}
