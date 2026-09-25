import pg from 'pg'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import type {
  CommuteChainAnchor,
  CommuteChainPurpose,
  LineDetail,
  UserFavoriteLine,
} from '@real-time-transport/shared'

const { Pool } = pg

/**
 * A user's settings row: commute hours plus the optional home/work anchors.
 *
 * The anchors are GCJ-02 by the time they are written — `/settings` PATCH
 * converts the browser's raw WGS-84 fix before calling in — and everything that
 * reads one back (the walking route's origin, first of all) takes GCJ-02 and
 * converts nothing. A missing anchor is `null`, never 0: (0, 0) is a real
 * coordinate and would be indistinguishable from an anchor the user saved.
 *
 * The four times are `null` when the user never chose them (migration 009 made the
 * columns nullable for exactly this). `null` is not a time and must never be
 * rendered as one: a row created by saving an anchor alone holds NO window, and
 * the read reports it as such rather than filling in the built-in hours.
 */
export interface StoredUserSettings {
  morningStart: string | null
  morningEnd: string | null
  eveningStart: string | null
  eveningEnd: string | null
  homeLat: number | null
  homeLng: number | null
  workLat: number | null
  workLng: number | null
}

/**
 * The row a user who has never saved anything starts from: nothing chosen.
 *
 * Every field is null, INCLUDING the four times. It used to start from the
 * built-in window (`DEFAULT_COMMUTE_HOURS`), which is what made an anchors-only
 * write store 06:30–11:30 / 17:00–22:00 as if the user had chosen them — the
 * default wearing the user's own configuration's clothes. A fresh row's starting
 * point must be 「什么都没选」, and that is what null means here.
 */
const EMPTY_USER_SETTINGS: StoredUserSettings = {
  morningStart: null,
  morningEnd: null,
  eveningStart: null,
  eveningEnd: null,
  homeLat: null,
  homeLng: null,
  workLat: null,
  workLng: null,
}

/**
 * A stored coordinate, or null when the column is unset or unusable.
 *
 * A `NaN` reached a DOUBLE PRECISION column through an earlier write (Postgres
 * stores NaN in that type), so it is reported as unset rather than handed to a
 * walking route, where it would turn every distance into NaN. Exported because
 * it IS the SQL branch's read mapping, and the offline suite cannot reach the
 * SQL branch to exercise it.
 */
export function storedCoord(value: unknown): number | null {
  const n = value === null || value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * A stored `TIME` as `HH:MM`, or null when the column holds no time.
 *
 * `null` is 「从未选择」 (migration 009 dropped the NOT NULL DEFAULT that used to
 * make an unchosen column read as the built-in hour). The `HH:MM:SS` Postgres
 * returns is trimmed to the form the API and the stored windows are written in.
 * Exported for the same reason `storedCoord` is: it IS the SQL branch's read
 * mapping, and the offline suite cannot reach the SQL branch to exercise it — so
 * the rule that a null stays null is pinned on the function itself.
 */
export function storedHHMM(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length === 0 ? null : text.slice(0, 5)
}

/**
 * Drop the fields the caller never sent, so an absent one is left untouched.
 *
 * `null` survives: clearing an anchor and forgetting one are different writes.
 */
export function definedOnly<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

/**
 * One ride leg of a stored chain, as it is read back.
 *
 * `seq` is the leg's position in the chain, 0-based. An unset station is `null`
 * in BOTH of its columns — never `''`, which would read as a station named "".
 */
export interface StoredCommuteChainLeg {
  seq: number
  lineId: string
  lineName: string
  cityCode: string
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  transferExtraMinutes: number | null
}

/** A stored chain with its legs, oldest-position first. */
export interface StoredCommuteChain {
  id: string
  userId: string
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  displayOrder: number
  createdAt: string
  legs: StoredCommuteChainLeg[]
}

/**
 * A leg as a write carries it. `seq` is optional on the way in — it is the
 * array's position, which the store stamps itself.
 */
export type CommuteChainLegInput = Omit<StoredCommuteChainLeg, 'seq' | 'cityCode'> & {
  seq?: number
  cityCode?: string
}

/** The fields a chain is created from. `id` and `createdAt` belong to the store. */
export interface CommuteChainInput {
  userId?: string
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  displayOrder?: number
  legs: CommuteChainLegInput[]
}

/**
 * A partial update. An absent field is left as it is; `legs` present means the
 * whole sequence is replaced (a chain's legs are one value, not a merge).
 */
export interface CommuteChainPatch {
  name?: string
  originAnchor?: CommuteChainAnchor
  purpose?: CommuteChainPurpose
  displayOrder?: number
  legs?: CommuteChainLegInput[]
}

/**
 * Stamp each leg's `seq` from its position in the array and fill the city.
 *
 * The array order IS the order, so the sequence can never come out with a gap
 * or a duplicate — a caller-supplied `seq` is ignored rather than trusted.
 * Exported because the offline suite cannot reach the SQL branch, and this is
 * the one place the numbering is decided for both branches.
 */
export function normalizeCommuteChainLegs(legs: CommuteChainLegInput[]): StoredCommuteChainLeg[] {
  return legs.map((leg, seq) => ({
    seq,
    lineId: leg.lineId,
    lineName: leg.lineName,
    cityCode: leg.cityCode || '027',
    boardStationName: leg.boardStationName,
    boardStationOrder: leg.boardStationOrder,
    alightStationName: leg.alightStationName,
    alightStationOrder: leg.alightStationOrder,
    transferExtraMinutes: leg.transferExtraMinutes,
  }))
}

/**
 * A leg row as the API carries it.
 *
 * An unset station column is `null` and stays `null` — a default name or a 0
 * order would name a station the user never chose. Exported because it IS the
 * SQL branch's read mapping, and the offline suite cannot reach that branch.
 */
export function storedCommuteChainLeg(row: Record<string, unknown>): StoredCommuteChainLeg {
  const order = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value)
  const stationName = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

  return {
    seq: Number(row.seq),
    lineId: String(row.line_id),
    lineName: String(row.line_name),
    cityCode: row.city_code ? String(row.city_code) : '027',
    boardStationName: stationName(row.board_station_name),
    boardStationOrder: order(row.board_station_order),
    alightStationName: stationName(row.alight_station_name),
    alightStationOrder: order(row.alight_station_order),
    transferExtraMinutes: order(row.transfer_extra_minutes),
  }
}

/** A chain row plus its already-mapped legs. */
function storedCommuteChain(
  row: Record<string, unknown>,
  legs: StoredCommuteChainLeg[],
): StoredCommuteChain {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    originAnchor: row.origin_anchor as CommuteChainAnchor,
    purpose: row.purpose as CommuteChainPurpose,
    displayOrder: Number(row.display_order ?? 0),
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : '',
    legs,
  }
}

/**
 * The database URL this server may connect to, or undefined for the in-memory store.
 *
 * A test process NEVER connects to a real database. The suite is written to run
 * offline, but a shell that exports `DATABASE_URL` for migrations and ad-hoc
 * probes hands it to `buildApp()` through the environment, and the suite then
 * reads and writes the development store — where the rows it leaves behind fail
 * tests that never touch the same tables. An explicit `databaseUrl` option is
 * deliberately NOT filtered here: a test that means to exercise SQL must say so
 * itself, and only the ambient variable is the accident this guards against.
 */
export function databaseUrlFor(env: Record<string, string | undefined>): string | undefined {
  if (env.VITEST || env.NODE_ENV === 'test') return undefined
  return env.DATABASE_URL || undefined
}

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505'

/**
 * Whether an error is the database REFUSING a write because a row with those key
 * columns already exists.
 *
 * This has to be told apart from every other failure, because every write below
 * falls back to the in-memory store when the pool throws: that fallback is for a
 * database this process cannot reach, and a refused INSERT is not that. Falling
 * back there would hand the caller a row that exists only inside this process
 * while the stored one stays exactly as it was — a follow reported as made that
 * the database never made. The unique index (`008_unique-favorite-per-line.sql`)
 * makes this the one refusal the caller must hear about.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
}

export class Database {
  private pool: pg.Pool | null = null
  private inMemoryFavorites = new Map<string, any>()
  /**
   * Last instant handed to an in-memory row. Kept here rather than read from
   * the clock on each insert so `createdAt` is strictly increasing even for two
   * rows added in the same millisecond — the memory store has no database
   * sequence to fall back on, and `createdAt` is the order's final tiebreak.
   */
  private inMemoryCreatedAt = 0
  private inMemoryLineCache = new Map<string, { detail: LineDetail, fetchedAt: number }>()
  private inMemorySettings = new Map<string, StoredUserSettings>()
  /**
   * Chains, keyed by id, with their legs held inside the chain. The legs are
   * the chain's substance and are always written as one value, so nesting them
   * here mirrors what the SQL schema does with `ON DELETE CASCADE` — dropping
   * the chain drops its legs, with no second map to keep in step.
   */
  private inMemoryChains = new Map<string, StoredCommuteChain>()

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
                 to_regclass('public.cached_transit_lines') AS cache,
                 to_regclass('public.commute_chains') AS chains,
                 to_regclass('public.commute_chain_legs') AS chain_legs
        `)
        const row = res.rows[0]
        // The commute-chain tables are checked here too: without them every
        // chain route would answer an empty list, which reads exactly like a
        // user who has recorded no chains.
        if (!row?.favorites || !row?.cache || !row?.chains || !row?.chain_legs) {
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

  async getFavorites(userId: string = DEFAULT_USER_ID): Promise<UserFavoriteLine[]> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          'SELECT * FROM user_favorite_lines WHERE user_id = $1 ORDER BY is_pinned DESC, display_order ASC, created_at ASC',
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
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
          isPinned: row.is_pinned ?? false,
        }))
      }
      catch {
        // Fallback to memory
      }
    }
    return Array.from(this.inMemoryFavorites.values())
      .filter(f => f.userId === userId)
      // Same precedence as the SQL above: the pin, then the stored position,
      // then the creation instant this store stamped on the row.
      .sort((x, y) => Number(y.isPinned ?? false) - Number(x.isPinned ?? false)
        || (x.displayOrder ?? 0) - (y.displayOrder ?? 0)
        || String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? '')))
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
        createdAt: f.createdAt,
        isPinned: f.isPinned ?? false,
      }))
  }

  /**
   * The creation instant to stamp on the next in-memory row, strictly after the
   * previous one. This store has no database clock: without it, two rows added
   * in the same millisecond would share an instant and their relative order
   * would silently fall back to Map insertion order — the implicit tiebreak
   * this field exists to make explicit.
   */
  private nextInMemoryCreatedAt(): string {
    this.inMemoryCreatedAt = Math.max(this.inMemoryCreatedAt + 1, Date.now())
    return new Date(this.inMemoryCreatedAt).toISOString()
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
    const userId = item.userId || DEFAULT_USER_ID
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
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
          // Pinning is an explicit single-target action (see setPinned). A create
          // path that could violate the one-pin-per-user index is not offered.
          isPinned: false,
        }
      }
      catch (err) {
        // An answered refusal is not an unreachable database: the unique index
        // (one row per user/city/line) refused this INSERT, and reporting the row
        // from memory would report a follow that was never stored.
        if (isUniqueViolation(err)) throw err
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
      createdAt: this.nextInMemoryCreatedAt(),
      isPinned: false,
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
    isPinned?: boolean
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
             display_order = COALESCE($8, display_order),
             is_pinned = COALESCE($9, is_pinned)
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
            item.isPinned ?? null,
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
   * Pin one favourite as the home screen's single hero card.
   *
   * Only one row per user may be pinned (partial unique index on is_pinned), so
   * the previous pin is cleared first. The stored ordering is never rewritten:
   * un-pinning drops the row back to the position display_order always meant.
   */
  async setPinned(userId: string, id: string, pinned: boolean): Promise<boolean> {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        if (pinned) {
          await client.query(
            'UPDATE user_favorite_lines SET is_pinned = FALSE WHERE user_id = $1 AND is_pinned',
            [userId],
          )
        }
        const res = await client.query(
          'UPDATE user_favorite_lines SET is_pinned = $3 WHERE id = $1 AND user_id = $2',
          [id, userId, pinned],
        )
        await client.query('COMMIT')
        if ((res.rowCount ?? 0) > 0) return true
        return this.inMemoryFavorites.has(id)
      }
      catch {
        await client.query('ROLLBACK')
        // Fall through to memory
      }
      finally {
        client.release()
      }
    }

    const rec = this.inMemoryFavorites.get(id)
    if (!rec) return false
    if (pinned) {
      // Same scope as the SQL branch's `WHERE user_id = $1`: only the pin of
      // THIS user's other rows is cleared, never another user's.
      for (const f of this.inMemoryFavorites.values()) {
        if (f.userId === userId) f.isPinned = false
      }
    }
    rec.isPinned = pinned
    return true
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

  /**
   * Commute hours and anchors stored in user_settings; null when never configured.
   *
   * The four times read as `null` when the user never chose them — the column
   * holds no time (009) and a null is NOT a time. Nothing here fills one in: a
   * built-in window handed out on this path is a window the user never set,
   * indistinguishable from one he did. The engine that genuinely needs a usable
   * span names its own parameter instead (`UNCONFIGURED_COMMUTE_WINDOW`).
   */
  async getUserSettings(userId: string = DEFAULT_USER_ID): Promise<StoredUserSettings | null> {
    if (this.pool) {
      try {
        const res = await this.pool.query(
          `SELECT morning_start, morning_end, evening_start, evening_end,
                  home_lat, home_lng, work_lat, work_lng
             FROM user_settings WHERE user_id = $1`,
          [userId],
        )
        const row = res.rows[0]
        if (!row) return null
        return {
          // TIME columns come back as "HH:MM:SS" — trimmed to HH:MM for the API,
          // and an unset column comes back as null and STAYS null.
          morningStart: storedHHMM(row.morning_start),
          morningEnd: storedHHMM(row.morning_end),
          eveningStart: storedHHMM(row.evening_start),
          eveningEnd: storedHHMM(row.evening_end),
          // An unset anchor column is null, and it stays null: falling back to a
          // coordinate (0, or a city centre) would invent an anchor.
          homeLat: storedCoord(row.home_lat),
          homeLng: storedCoord(row.home_lng),
          workLat: storedCoord(row.work_lat),
          workLng: storedCoord(row.work_lng),
        }
      }
      catch {
        // Table missing (migration not applied) or transient failure: the caller
        // uses its own fallback rather than reading half a row.
      }
    }
    // The fallback answers with the SAME row shape as the SQL branch — it is what
    // the offline suite exercises, so the two may not disagree on scope.
    return this.inMemorySettings.get(userId) ?? null
  }

  async saveUserSettings(
    userId: string,
    settings: Partial<StoredUserSettings>,
  ): Promise<StoredUserSettings> {
    // Read-then-write, because every field is written INDEPENDENTLY: a PATCH that
    // carries only the anchors must not reissue the commute hours, and one that
    // carries only the hours must not erase a saved anchor. A user with no row yet
    // starts from NOTHING chosen — the four times stay null until the request
    // actually names them, which is what stops an anchors-only write from storing
    // the built-in window as the user's own configuration.
    const stored = await this.getUserSettings(userId)
    const merged: StoredUserSettings = { ...(stored ?? EMPTY_USER_SETTINGS), ...definedOnly(settings) }

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO user_settings
           (user_id, morning_start, morning_end, evening_start, evening_end,
            home_lat, home_lng, work_lat, work_lng, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           morning_start = EXCLUDED.morning_start,
           morning_end = EXCLUDED.morning_end,
           evening_start = EXCLUDED.evening_start,
           evening_end = EXCLUDED.evening_end,
           home_lat = EXCLUDED.home_lat,
           home_lng = EXCLUDED.home_lng,
           work_lat = EXCLUDED.work_lat,
           work_lng = EXCLUDED.work_lng,
           updated_at = NOW()`,
        [
          userId,
          merged.morningStart,
          merged.morningEnd,
          merged.eveningStart,
          merged.eveningEnd,
          merged.homeLat,
          merged.homeLng,
          merged.workLat,
          merged.workLng,
        ],
      )
    }
    else {
      this.inMemorySettings.set(userId, merged)
    }
    return merged
  }

  // ---------- Commute chains (F10) ----------

  /** A defensive copy: the in-memory store must not be reachable by reference. */
  private cloneChain(chain: StoredCommuteChain): StoredCommuteChain {
    return { ...chain, legs: chain.legs.map(leg => ({ ...leg })) }
  }

  /**
   * A user's chains, in their stored order, each with its legs in sequence.
   *
   * Ordered like the favourites' list: `display_order` first, `created_at` only
   * breaking a tie — so moving one chain never rewrites another's position.
   */
  async getCommuteChains(userId: string = DEFAULT_USER_ID): Promise<StoredCommuteChain[]> {
    if (this.pool) {
      try {
        const chainRes = await this.pool.query(
          'SELECT * FROM commute_chains WHERE user_id = $1 ORDER BY display_order ASC, created_at ASC',
          [userId],
        )
        if (chainRes.rows.length === 0) return []
        // Legs are read in one query for the whole page rather than one per
        // chain: the number of round trips must not scale with the list.
        const legRes = await this.pool.query(
          'SELECT * FROM commute_chain_legs WHERE chain_id = ANY($1::uuid[]) ORDER BY chain_id, seq ASC',
          [chainRes.rows.map(row => row.id)],
        )
        const legsByChain = new Map<string, StoredCommuteChainLeg[]>()
        for (const legRow of legRes.rows) {
          const legs = legsByChain.get(legRow.chain_id) ?? []
          legs.push(storedCommuteChainLeg(legRow))
          legsByChain.set(legRow.chain_id, legs)
        }
        return chainRes.rows.map(row => storedCommuteChain(row, legsByChain.get(row.id) ?? []))
      }
      catch {
        // Fall through to memory
      }
    }
    return [...this.inMemoryChains.values()]
      .filter(chain => chain.userId === userId)
      .sort((x, y) => x.displayOrder - y.displayOrder || x.createdAt.localeCompare(y.createdAt))
      .map(chain => this.cloneChain(chain))
  }

  /** One chain with its legs, or null when no such chain exists. */
  async getCommuteChain(id: string): Promise<StoredCommuteChain | null> {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        return await this.readChain(client, id)
      }
      catch {
        // Fall through to memory
      }
      finally {
        client.release()
      }
    }
    const chain = this.inMemoryChains.get(id)
    return chain ? this.cloneChain(chain) : null
  }

  /**
   * Write a new chain with its legs.
   *
   * Both rows land in one transaction: a chain whose legs failed to write would
   * answer every later question with an empty walk.
   */
  async createCommuteChain(input: CommuteChainInput): Promise<StoredCommuteChain> {
    const id = crypto.randomUUID()
    const userId = input.userId || DEFAULT_USER_ID
    const displayOrder = input.displayOrder ?? 0
    const legs = normalizeCommuteChainLegs(input.legs)

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO commute_chains (id, user_id, name, origin_anchor, purpose, display_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, userId, input.name, input.originAnchor, input.purpose, displayOrder],
        )
        await this.insertLegs(client, id, legs)
        const stored = await this.readChain(client, id)
        await client.query('COMMIT')
        if (stored) return stored
      }
      catch {
        await client.query('ROLLBACK').catch(() => {})
        // Fall through to memory
      }
      finally {
        client.release()
      }
    }

    const record: StoredCommuteChain = {
      id,
      userId,
      name: input.name,
      originAnchor: input.originAnchor,
      purpose: input.purpose,
      displayOrder,
      createdAt: this.nextInMemoryCreatedAt(),
      legs,
    }
    this.inMemoryChains.set(id, record)
    return this.cloneChain(record)
  }

  /**
   * Update a chain, replacing its legs when the patch carries any.
   *
   * `legs` present means the whole sequence is written in place of the old one
   * — a chain's legs are one value, so a leg is never edited in isolation and
   * the `seq` numbers cannot drift out of step with the order. Any other field
   * absent from the patch is left exactly as stored.
   */
  async updateCommuteChain(id: string, patch: CommuteChainPatch): Promise<StoredCommuteChain | null> {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        const existing = await this.readChain(client, id)
        if (!existing) {
          await client.query('ROLLBACK')
          return null
        }

        const sets: string[] = []
        const values: (string | number | null)[] = [id]
        const push = (column: string, value: string | number | null | undefined) => {
          if (value === undefined) return
          values.push(value)
          sets.push(`${column} = $${values.length}`)
        }
        push('name', patch.name)
        push('origin_anchor', patch.originAnchor)
        push('purpose', patch.purpose)
        push('display_order', patch.displayOrder)

        if (sets.length > 0) {
          await client.query(`UPDATE commute_chains SET ${sets.join(', ')} WHERE id = $1`, values)
        }
        if (patch.legs !== undefined) {
          await client.query('DELETE FROM commute_chain_legs WHERE chain_id = $1', [id])
          await this.insertLegs(client, id, normalizeCommuteChainLegs(patch.legs))
        }

        const stored = await this.readChain(client, id)
        await client.query('COMMIT')
        return stored
      }
      catch {
        await client.query('ROLLBACK').catch(() => {})
        // Fall through to memory
      }
      finally {
        client.release()
      }
    }

    const record = this.inMemoryChains.get(id)
    if (!record) return null
    if (patch.name !== undefined) record.name = patch.name
    if (patch.originAnchor !== undefined) record.originAnchor = patch.originAnchor
    if (patch.purpose !== undefined) record.purpose = patch.purpose
    if (patch.displayOrder !== undefined) record.displayOrder = patch.displayOrder
    if (patch.legs !== undefined) record.legs = normalizeCommuteChainLegs(patch.legs)
    return this.cloneChain(record)
  }

  /** Delete a chain; its legs go with it (the foreign key cascades). */
  async removeCommuteChain(id: string): Promise<boolean> {
    if (this.pool) {
      try {
        const res = await this.pool.query('DELETE FROM commute_chains WHERE id = $1', [id])
        if ((res.rowCount ?? 0) > 0) return true
        return this.inMemoryChains.delete(id)
      }
      catch {
        return this.inMemoryChains.delete(id)
      }
    }
    return this.inMemoryChains.delete(id)
  }

  /** Read one chain and its legs through an already-open client. */
  private async readChain(client: pg.PoolClient, id: string): Promise<StoredCommuteChain | null> {
    const chainRes = await client.query('SELECT * FROM commute_chains WHERE id = $1', [id])
    const row = chainRes.rows[0]
    if (!row) return null
    const legRes = await client.query(
      'SELECT * FROM commute_chain_legs WHERE chain_id = $1 ORDER BY seq ASC',
      [id],
    )
    return storedCommuteChain(row, legRes.rows.map(storedCommuteChainLeg))
  }

  /** Write a chain's legs in one statement, seq included. */
  private async insertLegs(
    client: pg.PoolClient,
    chainId: string,
    legs: StoredCommuteChainLeg[],
  ): Promise<void> {
    if (legs.length === 0) return
    const values: (string | number | null)[] = []
    const tuples = legs.map((leg) => {
      const at = values.length
      values.push(
        chainId,
        leg.seq,
        leg.lineId,
        leg.lineName,
        leg.cityCode,
        leg.boardStationName,
        leg.boardStationOrder,
        leg.alightStationName,
        leg.alightStationOrder,
        leg.transferExtraMinutes,
      )
      return `(${Array.from({ length: 10 }, (_, i) => `$${at + i + 1}`).join(', ')})`
    })

    await client.query(
      `INSERT INTO commute_chain_legs
         (chain_id, seq, line_id, line_name, city_code, board_station_name, board_station_order, alight_station_name, alight_station_order, transfer_extra_minutes)
       VALUES ${tuples.join(', ')}`,
      values,
    )
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
