import pg from 'pg'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import type {
  CommuteChainPurpose,
  LineDetail,
  UserFavoriteLine,
} from '@real-time-transport/shared'

const { Pool } = pg

/**
 * 一个用户的设置行：通勤时段，外加可选的家/公司锚点。
 *
 * 锚点在写入时已是 GCJ-02，此后读它的每一处都按 GCJ-02 用、不做换算。缺失的锚点是 `null`，
 * 绝不是 0：(0, 0) 是真实坐标，与用户存过的锚点无法区分。
 *
 * 用户从未选择过的时刻是 `null`。`null` 不是时间，也绝不能渲染成一个时间：只存锚点而创建的
 * 行不持有任何时段，读侧就按这样报告，而不是填上内置时段。
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
 * 从未保存过任何东西的用户起步的那一行：包括四个时刻在内，每个字段都是 null。
 *
 * 内置时段不能作为起点，否则只写了锚点的写入会把它存成用户自己选的样子。
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
 * 一个存储的坐标，列未设置或不可用时为 null —— 不可用的坐标不得交给步行路线。
 * 导出是因为它就是 SQL 分支的读映射，而离线套件到不了那个分支。
 */
export function storedCoord(value: unknown): number | null {
  const n = value === null || value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 存储的 `TIME` 读成 `HH:MM`，列里没有时间时为 null。
 * Postgres 返回的 `HH:MM:SS` 裁成 API 与存储时段所用的形式。导出原因同 `storedCoord`：
 * 「null 保持 null」这条规则钉在函数上。
 */
export function storedHHMM(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length === 0 ? null : text.slice(0, 5)
}

/**
 * `null` 会保留：清空锚点与没提过锚点是两种不同的写入。
 */
export function definedOnly<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

/**
 * 一条读回的存储腿：`seq` 是它在链路中的位置（0 起）。
 * 未设置的站点在两列上都是 `null`，绝不是 `''` —— 那会读成一个名字为空串的站。
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
  /**
   * 进入本段的接驳方式。`null` 是「没选过」，不是步行 —— 步行由读侧的计价默认承担，
   * 而这里必须让两种状态可分。
   */
  connectionMode: 'walk' | 'cycle' | null
}

/** 一条存储的链路及其腿，按最早位置在前。起点不在其中：它由 `purpose` 决定。 */
export interface StoredCommuteChain {
  id: string
  userId: string
  name: string
  purpose: CommuteChainPurpose
  displayOrder: number
  createdAt: string
  legs: StoredCommuteChainLeg[]
}

/**
 * 写入时携带的腿。`seq` 在入口是可选的 —— 它就是数组的位置，由存储自己盖上。
 */
export type CommuteChainLegInput = Omit<StoredCommuteChainLeg, 'seq' | 'cityCode'> & {
  seq?: number
  cityCode?: string
}

export interface CommuteChainInput {
  userId?: string
  name: string
  purpose: CommuteChainPurpose
  displayOrder?: number
  legs: CommuteChainLegInput[]
}

/**
 * 部分更新。没有的字段保持原样；`legs` 存在即整段替换（一条链路的腿是一个值，不是合并）。
 */
export interface CommuteChainPatch {
  name?: string
  purpose?: CommuteChainPurpose
  displayOrder?: number
  legs?: CommuteChainLegInput[]
}

/**
 * 按腿在数组里的位置盖 `seq` 并填城市。
 *
 * 数组顺序就是顺序，因此序号不会出现空洞或重复 —— 调用方给的 `seq` 被忽略而不是采信。
 * 导出是因为离线套件到不了 SQL 分支，而这里是两个分支共同决定编号的唯一位置。
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
    connectionMode: leg.connectionMode,
  }))
}

/**
 * API 携带的腿行：未设置的站点列就是 `null` 并保持 `null`，默认名字或 0 序号会命名一个
 * 用户从未选过的站。导出是因为它就是 SQL 分支的读映射，而离线套件到不了那个分支。
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
    // 两个已知方式之外的取值（旧库缺列、写坏的行）读作「没选过」：
    // `?? 'walk'` 那类默认值在这里正是错的 —— 缺省的含义是「不知道」，不是步行。
    connectionMode: row.connection_mode === 'walk' || row.connection_mode === 'cycle'
      ? row.connection_mode
      : null,
  }
}

function storedCommuteChain(
  row: Record<string, unknown>,
  legs: StoredCommuteChainLeg[],
): StoredCommuteChain {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    purpose: row.purpose as CommuteChainPurpose,
    displayOrder: Number(row.display_order ?? 0),
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : '',
    legs,
  }
}

/**
 * 本服务端可以连接的数据库 URL，内存存储时为 undefined。
 *
 * 测试进程绝不连接真实数据库。显式传入的 `databaseUrl` 选项故意不在这里过滤：
 * 要用 SQL 的测试必须自己说明。
 */
export function databaseUrlFor(env: Record<string, string | undefined>): string | undefined {
  if (env.VITEST || env.NODE_ENV === 'test') return undefined
  return env.DATABASE_URL || undefined
}

const UNIQUE_VIOLATION = '23505'

/**
 * 一个错误是否是数据库因为关键列上已有同键行而拒绝写入。
 *
 * 回退到内存存储是给本进程到不了的数据库用的，被拒的 INSERT 不是那种情况 ——
 * 在那里回退会报告一次数据库从未发生过的关注。
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
}

export class Database {
  private pool: pg.Pool | null = null
  private inMemoryFavorites = new Map<string, any>()
  /**
   * 交给内存行的最后一个时刻，严格递增：内存存储没有数据库时钟，同一毫秒的两行否则会共享
   * 一个时刻、相对顺序退回 Map 的插入顺序 —— 本字段就是那个隐含决胜档的显式形式。
   */
  private inMemoryCreatedAt = 0
  private inMemoryLineCache = new Map<string, { detail: LineDetail, fetchedAt: number }>()
  private inMemorySettings = new Map<string, StoredUserSettings>()
  /**
   * 链路按 id 索引，腿放在链路里 —— 与 SQL schema 的 `ON DELETE CASCADE` 一致：
   * 删链路即删腿，不需要第二张表保持同步。
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
   * 核对 schema 已就位。表的归属在 migrations/（跑 `pnpm migrate:up`）；这里只报告就绪状态，
   * 让缺失的迁移大声失败，而不是悄悄降级到内存存储。
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
                 to_regclass('public.commute_chain_legs') AS chain_legs,
                 EXISTS (
                   SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'user_favorite_lines'
                     AND column_name IN ('pinned_station_order', 'reverse_pinned_station_order')
                   GROUP BY table_name
                   HAVING COUNT(*) = 2
                 ) AS stop_orders
        `)
        const row = res.rows[0]
        // 通勤链路的表也在这里检查：没有它们，每条链路路由都会答空列表，
        // 读起来与「用户没录过链路」完全一样。
        if (!row?.favorites || !row?.cache || !row?.chains || !row?.chain_legs) {
          console.warn(
            'Database schema missing. Run `pnpm migrate:up` to create/upgrade tables.',
          )
        }
        // 缺 010 比缺表安静：读仍然作答，只是每个存储的上车点都读成「顺序未知」。
        // 要说清欠哪个迁移。
        if (row?.favorites && !row?.stop_orders) {
          console.warn(
            'Board-stop order columns missing. Run `pnpm migrate:up` (010_favorite-stop-orders.sql).',
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

  // ---------- 收藏 ----------

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
          // 每个上车点身份的另一半。列是 NULL 时缺席（而不是 null），
          // 与它旁边的名字读法一致 —— 一对里只用一种约定。
          morningStopOrder: row.pinned_station_order ?? undefined,
          eveningStopOrder: row.reverse_pinned_station_order ?? undefined,
          morningDirection: row.morning_direction ?? null,
          eveningDirection: row.evening_direction ?? null,
          displayOrder: row.display_order ?? 0,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
          isPinned: row.is_pinned ?? false,
        }))
      }
      catch {
      }
    }
    return Array.from(this.inMemoryFavorites.values())
      .filter(f => f.userId === userId)
      // 与上面 SQL 同样的优先级：先置顶，再存储的位置，最后是本存储盖在该行上的创建时刻。
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
        morningStopOrder: f.morningStopOrder ?? undefined,
        eveningStopOrder: f.eveningStopOrder ?? undefined,
        morningDirection: f.morningDirection ?? null,
        eveningDirection: f.eveningDirection ?? null,
        displayOrder: f.displayOrder ?? 0,
        createdAt: f.createdAt,
        isPinned: f.isPinned ?? false,
      }))
  }

  /**
   * 盖在下一个内存行上的创建时刻，严格晚于上一个：这个存储没有数据库时钟，没有它，
   * 同一毫秒加进来的两行会共享一个时刻，相对顺序悄悄退回 Map 的插入顺序。
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
    morningStopOrder?: number | null
    eveningStopName?: string
    eveningStopOrder?: number | null
    morningDirection?: number | null
    eveningDirection?: number | null
    displayOrder?: number
  }): Promise<UserFavoriteLine> {
    const id = crypto.randomUUID()
    const userId = item.userId || DEFAULT_USER_ID
    const cityCode = item.cityCode || '027'

    if (this.pool) {
      try {
        // 上车点按它本身的样子成对写入（name + order）。两个方向列也在这里写：
        // 创建契约接受它们，而契约接受的字段必须存下来，不能悄悄丢掉。
        const res = await this.pool.query(
          `INSERT INTO user_favorite_lines (id, user_id, city_code, line_id, line_name, preferred_direction, reverse_line_id, pinned_station_name, pinned_station_order, reverse_pinned_station_name, reverse_pinned_station_order, morning_direction, evening_direction, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [
            id,
            userId,
            cityCode,
            item.lineId,
            item.lineName,
            item.preferredDirection ?? 0,
            item.reverseLineId || null,
            item.morningStopName ?? null,
            item.morningStopOrder ?? null,
            item.eveningStopName ?? null,
            item.eveningStopOrder ?? null,
            item.morningDirection ?? null,
            item.eveningDirection ?? null,
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
          morningStopOrder: row.pinned_station_order ?? undefined,
          eveningStopOrder: row.reverse_pinned_station_order ?? undefined,
          morningDirection: row.morning_direction ?? null,
          eveningDirection: row.evening_direction ?? null,
          displayOrder: row.display_order ?? 0,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
          // 置顶是显式的单目标动作（见 setPinned）：会违反「每用户一个置顶」索引的
          // 创建路径不提供。
          isPinned: false,
        }
      }
      catch (err) {
        // 得到回答的拒绝不是不可达的数据库：唯一索引（每 user/city/line 一行）拒绝了这次
        // INSERT，而从内存报告那一行会报告一次从未存储过的关注。
        if (isUniqueViolation(err)) throw err
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
      morningStopOrder: item.morningStopOrder ?? undefined,
      eveningStopName: item.eveningStopName,
      eveningStopOrder: item.eveningStopOrder ?? undefined,
      morningDirection: item.morningDirection ?? null,
      eveningDirection: item.eveningDirection ?? null,
      displayOrder: item.displayOrder ?? 0,
      createdAt: this.nextInMemoryCreatedAt(),
      isPinned: false,
    }
    this.inMemoryFavorites.set(id, record)
    return record
  }

  /**
   * 更新收藏的行级字段，每个只在调用方命名了它时才写（`COALESCE` 语义：缺席即保留）。
   * 它任何地方都写不了 NULL，因此不做上车点写者：上车点是「对」（name, order），
   * 两半都必须可清空，走 `setBoardStops`。
   */
  async updateFavorite(id: string, item: {
    cityCode?: string
    lineId?: string
    lineName?: string
    preferredDirection?: number
    reverseLineId?: string
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
             display_order = COALESCE($7, display_order),
             is_pinned = COALESCE($8, is_pinned)
           WHERE id = $1`,
          [
            id,
            item.cityCode ?? null,
            item.lineId ?? null,
            item.lineName ?? null,
            item.preferredDirection ?? null,
            item.reverseLineId ?? null,
            item.displayOrder ?? null,
            item.isPinned ?? null,
          ],
        )
        if ((res.rowCount ?? 0) > 0) return true
      }
      catch {
      }
    }
    const rec = this.inMemoryFavorites.get(id)
    if (rec) {
      // 逐字段写，与上面 SQL 同一份清单：`Object.assign(rec, item)` 会复制调用方恰好传进来的
      // 任何东西（关注守卫折叠时传的是整行），两个分支于是对同一次调用写了不同的列集合。
      if (item.cityCode !== undefined) rec.cityCode = item.cityCode
      if (item.lineId !== undefined) rec.lineId = item.lineId
      if (item.lineName !== undefined) rec.lineName = item.lineName
      if (item.preferredDirection !== undefined) rec.preferredDirection = item.preferredDirection
      if (item.reverseLineId !== undefined) rec.reverseLineId = item.reverseLineId
      if (item.displayOrder !== undefined) rec.displayOrder = item.displayOrder
      if (item.isPinned !== undefined) rec.isPinned = item.isPinned
      return true
    }
    return false
  }

  /**
   * 把一个收藏置顶为首页唯一的主卡片。
   *
   * 每个用户只允许一行置顶（is_pinned 上的部分唯一索引），因此先清掉上一个置顶。
   * 存储的排序从不重写：取消置顶会让该行回到 display_order 一直表示的位置。
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
      }
      finally {
        client.release()
      }
    }

    const rec = this.inMemoryFavorites.get(id)
    if (!rec) return false
    if (pinned) {
      // 与 SQL 分支的 `WHERE user_id = $1` 同域：只清本用户其它行的置顶，绝不清别人的。
      for (const f of this.inMemoryFavorites.values()) {
        if (f.userId === userId) f.isPinned = false
      }
    }
    rec.isPinned = pinned
    return true
  }

  /**
   * 设置或清空一个收藏的通勤上车点及其方向。
   *
   * 与 `updateFavorite` 分开，是因为那个方法把每一列都包在 COALESCE 里、永远写不了 NULL，
   * 而清空上车点正好就是一次 NULL 写入。这里 `undefined` 不动字段，`null` 清空它；
   * 字段按目的（morning/evening）作键，在本方法内映射到存储列。
   *
   * 上车点是「对」（name, order）：一个目的的两列在同一次调用里写入，契约也拒绝单独一半
   * （`UpdateFavoriteSchema`）。站名重复出现时，序号才说明是哪一个站。
   */
  async setBoardStops(id: string, stops: {
    morningStopName?: string | null
    morningStopOrder?: number | null
    eveningStopName?: string | null
    eveningStopOrder?: number | null
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
    push('pinned_station_order', stops.morningStopOrder)
    push('reverse_pinned_station_name', stops.eveningStopName)
    push('reverse_pinned_station_order', stops.eveningStopOrder)
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
      }
    }

    const rec = this.inMemoryFavorites.get(id)
    if (rec) {
      if (stops.morningStopName !== undefined) rec.morningStopName = stops.morningStopName ?? undefined
      if (stops.morningStopOrder !== undefined) rec.morningStopOrder = stops.morningStopOrder ?? undefined
      if (stops.eveningStopName !== undefined) {
        rec.eveningStopName = stops.eveningStopName ?? undefined
      }
      if (stops.eveningStopOrder !== undefined) rec.eveningStopOrder = stops.eveningStopOrder ?? undefined
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

  // ---------- 用户设置 ----------

  /**
   * user_settings 里存的通勤时段与锚点；从未配置时为 null。
   *
   * 用户从未选择过的四个时刻读成 `null` —— 列里没有时间，而 null 不是时间。这里任何地方都
   * 不填内置值：在这条路径上发出去的时段是用户从未设置过的时段，与他设过的无法区分。
   * 真正需要一个可用跨度的那套逻辑自己命名参数（`UNCONFIGURED_COMMUTE_WINDOW`）。
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
          morningStart: storedHHMM(row.morning_start),
          morningEnd: storedHHMM(row.morning_end),
          eveningStart: storedHHMM(row.evening_start),
          eveningEnd: storedHHMM(row.evening_end),
          // 未设置的锚点列是 null 并保持 null：回退到一个坐标（0，或某个城市中心）
          // 等于凭空造出一个锚点。
          homeLat: storedCoord(row.home_lat),
          homeLng: storedCoord(row.home_lng),
          workLat: storedCoord(row.work_lat),
          workLng: storedCoord(row.work_lng),
        }
      }
      catch {
        // 表缺失（迁移没跑）或瞬时故障：调用方用自己的回退，而不是读到半行。
      }
    }
    // 回退回答的行形状与 SQL 分支完全相同 —— 离线套件练的正是它，
    // 两者不能在范围上各说各话。
    return this.inMemorySettings.get(userId) ?? null
  }

  async saveUserSettings(
    userId: string,
    settings: Partial<StoredUserSettings>,
  ): Promise<StoredUserSettings> {
    // 先读后写，因为每个字段都是独立写入的：只带锚点的 PATCH 不得重发通勤时段，
    // 只带时段的 PATCH 不得抹掉已存的锚点。还没有行的用户从「什么都没选」起步 ——
    // 四个时刻保持 null，直到请求真的命名了它们。

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

  // ---------- 通勤链路（F10） ----------

  /** 防御性拷贝：内存存储不能被按引用拿到。 */
  private cloneChain(chain: StoredCommuteChain): StoredCommuteChain {
    return { ...chain, legs: chain.legs.map(leg => ({ ...leg })) }
  }

  /**
   * 一个用户的链路，按存储顺序，每条带按序列排好的腿。
   *
   * 排序与收藏列表相同：先 `display_order`，`created_at` 只用来破平局 ——
   * 因此移动一条链路从不重写另一条的位置。
   */
  async getCommuteChains(userId: string = DEFAULT_USER_ID): Promise<StoredCommuteChain[]> {
    if (this.pool) {
      try {
        const chainRes = await this.pool.query(
          'SELECT * FROM commute_chains WHERE user_id = $1 ORDER BY display_order ASC, created_at ASC',
          [userId],
        )
        if (chainRes.rows.length === 0) return []
        // 整页的腿一次查询读完，而不是每条链路一次：往返次数不得随列表规模增长。
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
      }
    }
    return [...this.inMemoryChains.values()]
      .filter(chain => chain.userId === userId)
      .sort((x, y) => x.displayOrder - y.displayOrder || x.createdAt.localeCompare(y.createdAt))
      .map(chain => this.cloneChain(chain))
  }

  async getCommuteChain(id: string): Promise<StoredCommuteChain | null> {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        return await this.readChain(client, id)
      }
      catch {
      }
      finally {
        client.release()
      }
    }
    const chain = this.inMemoryChains.get(id)
    return chain ? this.cloneChain(chain) : null
  }

  /**
   * 写入一条新链路及其腿。两行落在同一个事务里：腿写失败的链路会对此后每个问题都答一次空走。
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
          `INSERT INTO commute_chains (id, user_id, name, purpose, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, userId, input.name, input.purpose, displayOrder],
        )
        await this.insertLegs(client, id, legs)
        const stored = await this.readChain(client, id)
        await client.query('COMMIT')
        if (stored) return stored
      }
      catch {
        await client.query('ROLLBACK').catch(() => {})
      }
      finally {
        client.release()
      }
    }

    const record: StoredCommuteChain = {
      id,
      userId,
      name: input.name,
      purpose: input.purpose,
      displayOrder,
      createdAt: this.nextInMemoryCreatedAt(),
      legs,
    }
    this.inMemoryChains.set(id, record)
    return this.cloneChain(record)
  }

  /**
   * 更新一条链路，补丁带腿时替换它的腿。
   *
   * `legs` 存在即整段写入以替换旧的 —— 一条链路的腿是一个值，因此腿从不被单独编辑，
   * `seq` 也不会与顺序脱节。补丁里没有的其它字段保持存储的样子。
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
      }
      finally {
        client.release()
      }
    }

    const record = this.inMemoryChains.get(id)
    if (!record) return null
    if (patch.name !== undefined) record.name = patch.name
    if (patch.purpose !== undefined) record.purpose = patch.purpose
    if (patch.displayOrder !== undefined) record.displayOrder = patch.displayOrder
    if (patch.legs !== undefined) record.legs = normalizeCommuteChainLegs(patch.legs)
    return this.cloneChain(record)
  }

  /** 删除一条链路；它的腿随之而去（外键级联）。 */
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
        leg.connectionMode,
      )
      return `(${Array.from({ length: 11 }, (_, i) => `$${at + i + 1}`).join(', ')})`
    })

    await client.query(
      `INSERT INTO commute_chain_legs
         (chain_id, seq, line_id, line_name, city_code, board_station_name, board_station_order, alight_station_name, alight_station_order, transfer_extra_minutes, connection_mode)
       VALUES ${tuples.join(', ')}`,
      values,
    )
  }

  // ---------- 静态线路缓存 ----------

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
