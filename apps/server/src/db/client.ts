import pg from 'pg'
import type { LineDetail, UserFavoriteLine } from '@real-time-transport/shared'

const { Pool } = pg

export class Database {
  private pool: pg.Pool | null = null
  private inMemoryFavorites = new Map<string, any>()
  private inMemoryLineCache = new Map<string, { detail: LineDetail, fetchedAt: number }>()

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
          pinnedStationName: row.pinned_station_name ?? undefined,
          reversePinnedStationName: row.reverse_pinned_station_name ?? undefined,
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
        pinnedStationName: f.pinnedStationName ?? undefined,
        reversePinnedStationName: f.reversePinnedStationName ?? undefined,
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
    pinnedStationName?: string
    reversePinnedStationName?: string
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
            item.pinnedStationName || null,
            item.reversePinnedStationName || null,
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
          pinnedStationName: row.pinned_station_name ?? undefined,
          reversePinnedStationName: row.reverse_pinned_station_name ?? undefined,
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
      pinnedStationName: item.pinnedStationName,
      reversePinnedStationName: item.reversePinnedStationName,
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
    pinnedStationName?: string
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
            item.pinnedStationName ?? null,
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
   * Set or clear a favourite's pinned stations.
   *
   * Kept separate from `updateFavorite` because that method wraps every column
   * in COALESCE, which can never write NULL — clearing a pin is exactly a NULL
   * write. Here `undefined` leaves a field untouched and `null` clears it.
   */
  async setPinnedStations(id: string, pins: {
    pinnedStationName?: string | null
    reversePinnedStationName?: string | null
  }): Promise<boolean> {
    const sets: string[] = []
    const values: (string | null)[] = [id]
    const push = (column: string, value: string | null | undefined) => {
      if (value === undefined) return
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    push('pinned_station_name', pins.pinnedStationName)
    push('reverse_pinned_station_name', pins.reversePinnedStationName)

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
      if (pins.pinnedStationName !== undefined) rec.pinnedStationName = pins.pinnedStationName
      if (pins.reversePinnedStationName !== undefined) {
        rec.reversePinnedStationName = pins.reversePinnedStationName
      }
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
