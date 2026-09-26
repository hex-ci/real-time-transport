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
   * 该方向的终点牌标签（「开往 X」）。
   * 与 `LineDetail` 是同一字段，故搜索命中的方向与方向选择器命名一致。
   * 搜索时只有提供方知道终点站，故标签在那里合成，而不是由调用方重新拼。
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

/**
 * 站名在该 API 上的出行方式：绝不能是空串。
 * `""` 既不是站也不是清除 —— 它会被存成一个名为 `""` 的站，在各处都读成未设置，
 * 却是一个没人选过的值。清空可选字段在本 API 上一律用 `null`；`min(1)` 就是边界上区分两者的方式。
 */
const StopNameSchema = z.string().min(1, { message: '站名不能是空串：要清空上车点请传 null' })

export const UserFavoriteLineSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().default(DEFAULT_USER_ID),
  cityCode: z.string().default('027'),
  lineId: z.string(),
  lineName: z.string(),
  /**
   * 该线路默认展示的方向。关注线路永远覆盖**两个**方向；这里只决定先显示哪一个。
   */
  preferredDirection: z.number().int().min(0).max(1).default(0),
  /**
   * 反方向的 lineId。公交每个方向是一个不同的上游 lineId，故切换方向必须换 lineId；
   * 地铁两个方向共用同一个。该字段存在之前保存的收藏没有它，
   * 此时该线路不支持切换方向，而不是解析到一个错的 lineId。
   */
  reverseLineId: z.string().optional(),
  /**
   * 早通勤（早上出发）段的上车站，落在 pinned_station_name 列。
   * 缺省表示未设置 —— 通勤卡片随后显示明确的「未设置早间上车点」状态。
   * 站名是站点身份的一半，`morningStopOrder` 是另一半。
   */
  morningStopName: StopNameSchema.optional(),
  /**
   * 早间上车点在其所属方向停靠列表中的位置 —— 重名时用它指明**是哪一个**站。
   * 自 migration 010 起独立成列。该列存在之前写入的行没有它：
   * 那种行的站序确实未知，绝不去猜（见 `../line-group.js` 的 `resolveBoardStopRef` / `placeBoardStop`）。
   */
  morningStopOrder: z.number().int().min(0).nullable().optional(),
  /**
   * 晚通勤（晚上出发）段的上车站，落在 reverse_pinned_station_name 列。
   */
  eveningStopName: StopNameSchema.optional(),
  /** 晚间上车点的位置，即其身份的另一半。 */
  eveningStopOrder: z.number().int().min(0).nullable().optional(),
  /**
   * 用户早间通勤的方向，是一个显式选择。
   * `null` / 缺省表示用户尚未选择 —— 设置界面要求先定方向才给选站，
   * 故「未设置」是真实状态，不得强制成 0。刻意**不**由两个上车点推导：
   * 推导可能与用户选站时看到的方向不一致，且当某站只在一个方向存在时会退化。
   */
  morningDirection: z.number().int().min(0).max(1).nullable().optional(),
  /** 用户晚间通勤的方向，独立选择。 */
  eveningDirection: z.number().int().min(0).max(1).nullable().optional(),
  displayOrder: z.number().int().default(0),
  /**
   * 该行的关注时刻，ISO-8601。排序的最终 tiebreak：`displayOrder` 相同的行按关注先后分开，
   * 即服务端 `ORDER BY is_pinned DESC, display_order ASC, created_at ASC` 的尾部。
   * 可选，因为新建请求没有自己的瞬间 —— 该列进而该值属于服务端。
   */
  createdAt: z.string().optional(),
  /**
   * 是否置顶为首页唯一的主卡片。这是一个状态而非位置：已存顺序从不改写，
   * 故取消置顶会把该行放回原处。每个用户至多一条置顶，由该列上的部分唯一索引保证。
   */
  isPinned: z.boolean().default(false),
})
  // 新建时写了上车点就必须写配对（与 PATCH 同一要求，见 `UpdateFavoriteSchema`）：
  // 只接受一个站名会写出 migration 010 存在的意义所要修的那种行 —— 一个谁都定位不了的站。
  .refine(
    f => boardStopPairGiven(f.morningStopName, f.morningStopOrder),
    { message: '上班上车点的站名与站序必须一起给出', path: ['morningStopOrder'] },
  )
  .refine(
    f => boardStopPairGiven(f.eveningStopName, f.eveningStopOrder),
    { message: '下班上车点的站名与站序必须一起给出', path: ['eveningStopOrder'] },
  )
export type UserFavoriteLine = z.infer<typeof UserFavoriteLineSchema>

/**
 * 某个用途的站名与站序是否同时给出，即站点身份的要求。
 * 已存的上车站是 (站名, 站序) 配对，与换乘链路段的站同一规则（007：站名与站序同生同灭）。
 * 站序不是冗余的：真实线路上同名站可以出现在多个站序上，
 * 故只留站名的行无法定位回停靠列表 —— 每个读取方都会按站名取首个匹配。
 * 四种情形：
 *
 *  - 两者都缺    -> 字段未被触及（不提上车点的 PATCH）；
 *  - 缺一个      -> 拒绝：半个配对定位不了任何东西；
 *  - 站名为 null -> 除非站序也 null，否则拒绝：清空上车点必须同时清掉两半，否则留下孤儿站序；
 *  - 给了站名    -> 站序必须是数字（站点只能是配对）。
 */
function boardStopPairGiven(name: unknown, order: unknown): boolean {
  if (name === undefined && order === undefined) return true
  if (name === undefined || order === undefined) return false
  if (name === null) return order === null
  return order !== null
}

/**
 * 更新某收藏的上车站及其通勤方向的 payload。
 * `null` 清除该值（上车点：没有上车站，两半都清；方向：尚未选择）；`undefined` 保持不动。
 * 必须显式传 null，因为只有可选字段的普通 PATCH 无法表达「移除上车点」。
 * `Database.setBoardStops` 写 `column = $n`，故缺省=保留、`null`=清除
 * （COALESCE 规则属于 `updateFavorite`，它在该路由上只管 `displayOrder`）。
 * 上车点按配对写入：下面两个 refine 拒绝没有站序的站名（无法定位的上车点）与只清一半。
 * 做成 refine 而非路由检查，故 POST、PATCH 与任何直接写入都受同一条规则约束。
 */
export const UpdateFavoriteSchema = z.object({
  morningStopName: StopNameSchema.nullable().optional(),
  morningStopOrder: z.number().int().min(0).nullable().optional(),
  eveningStopName: StopNameSchema.nullable().optional(),
  eveningStopOrder: z.number().int().min(0).nullable().optional(),
  morningDirection: z.number().int().min(0).max(1).nullable().optional(),
  eveningDirection: z.number().int().min(0).max(1).nullable().optional(),
  /** 在用户自己的排序中的位置（0 基），以整份列表写入。 */
  displayOrder: z.number().int().min(0).optional(),
  /** 置顶状态。不可空：置顶不会被清成第三种状态。 */
  isPinned: z.boolean().optional(),
})
  .refine(
    f => boardStopPairGiven(f.morningStopName, f.morningStopOrder),
    { message: '上班上车点的站名与站序必须一起给出（清空请两列都传 null）', path: ['morningStopOrder'] },
  )
  .refine(
    f => boardStopPairGiven(f.eveningStopName, f.eveningStopOrder),
    { message: '下班上车点的站名与站序必须一起给出（清空请两列都传 null）', path: ['eveningStopOrder'] },
  )
export type UpdateFavorite = z.infer<typeof UpdateFavoriteSchema>

/**
 * 用户级全局设置（按用户 id 单行）。
 * 锚点是通过一次性 GPS 读取保存的家 / 公司坐标，用于推导到上车站的步行耗时；
 * 以原始 WGS-84 抵达并在服务端转换 —— amap key 是 Web 服务 key，绝不能进入浏览器。
 * 可空，因为「尚未保存锚点」是真实状态，首页必须在不编造默认值的前提下渲染。
 * 四个时刻同理由可空，只是更深一层：自 migration 009 起，列以 NULL 表示
 * 「用户从未选择过这个时刻」，那与「选择了 06:30」是不同的事实。NULL 才是诚实的值，
 * 且它在任何地方都不会被当作一个时刻展示。
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
 * PATCH payload：部分更新，逐字段独立校验。
 * `undefined` 保持已存值；显式 `null` 清除。`null` 是四个时刻得以被清空的唯一方式，
 * 也是本 schema 做成「可选之可空」而非「可选之必填」的原因。
 * 一个时段是一个值，故其两端要么一起给、要么都不给：只给 `morningStart` 会存下半个时段，
 * 那既不是时段（没有终点就意味着不含任何时刻）也不是「从未选择」（已有一端落在行上）。
 * 这与 007 对路段车站的规则同一条；做成 refine 而非路由检查，
 * 故 POST、PATCH 与任何直接写入都由一条规则覆盖。
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
 * 调用方所问的设置**行**是否存在。
 * `unset` 既不是失败也不是一个值：它是「读取成功但该用户没有行」的答案，
 * 故 `GET /settings` 以 `data: null` 作答，而不是给出一套用户从未配置过的时刻。
 * §4.1 要求的正是这个区分 —— 读失败与确实为空必须分得开。
 * `stored` 表示行存在且 payload 携带它，但**不**表示用户选过每个字段：
 * 锚点列可以为 null，自 009 起四个时刻也可以 —— 「行在，但通勤时段从未被选过」。
 * 那是关于行**内容**的事实，随内容本身出行；
 * 而「有没有一个可落在其中的时段」是另一个问题、另一个词（`CommuteWindowStateSchema`）。
 */
export const SettingsReadStateSchema = z.enum(['stored', 'unset'])
export type SettingsReadState = z.infer<typeof SettingsReadStateSchema>

/**
 * 是否存在已存储的**时段** —— 这是关于时段而非关于行的状态。
 * 前两个成员与 `SettingsReadStateSchema` 说法相同（`stored` / `unset`），
 * 第三个存在是因为行可以在而时刻不在：`unchosen` 即「行在，四个时刻是 NULL」，
 * 即用户保存过某样东西（锚点，或一次空 PATCH）却从未选择通勤时段。
 * 它不是更小的 `unset`：一个说没有行容纳时段，另一个说行里没有时段。
 * 在档位上必填且无默认值，理由与当初加入该字段相同：`mode: 'auto'`
 * 原本表示两件不同的事，消费方分辨不出。有了 `unchosen`，时钟就没有可比的时段，
 * 故档位以「未设置通勤时段」回答 `auto`，payload 的每个消费方说法一致。
 */
export const CommuteWindowStateSchema = z.enum(['stored', 'unchosen', 'unset'])
export type CommuteWindowState = z.infer<typeof CommuteWindowStateSchema>

export const CommuteProfileSchema = z.object({
  mode: z.enum(['work', 'home', 'auto']),
  description: z.string(),
  /** 本档位是否有可落在其中的已存储时段。 */
  windowState: CommuteWindowStateSchema,
})
export type CommuteProfile = z.infer<typeof CommuteProfileSchema>

/**
 * F10：换乘链从两个已保存锚点之一出发，服务两个通勤用途之一。
 * 两者都是封闭集：第三个值不是其中之一的更小版本，而是一条无法作答的链。
 */
export const CommuteChainAnchorSchema = z.enum(['home', 'work'])
export type CommuteChainAnchor = z.infer<typeof CommuteChainAnchorSchema>

export const CommuteChainPurposeSchema = z.enum(['morning', 'evening'])
export type CommuteChainPurpose = z.infer<typeof CommuteChainPurposeSchema>

/**
 * 链的一条**乘车**路段：一条线路，加上在该线上上车的站与下车的站。
 * 路段之间的步行 / 骑行接驳刻意不在其中 —— 站坐标已在路线详情里，
 * 其时长由真实距离算出而不是手填（存一份副本只会漂移成第二个矛盾的事实）。
 * 一个站的标识是站名**加**站序，两者同行：站序用于在停靠列表中定位它
 * （线路可以有重名，地铁还会按方向对同一站编号不同），站名则让用户认出它。
 * 配对是一个值，故只给一半会被拒绝，而不是存下半个。
 * `null` 是「尚未选择」的诚实值，绝不用 `''`：空串读回来是一个名为 "" 的、并不存在的站。
 * 路段沿线路的**一个**方向运行，已存的站序说明是哪个。公交上，下车站序必须**大于**上车站序：
 * 两个方向是两个不同的 lineId，故已存的 `lineId` 已指明其一，反过来就是用户录反了。
 * 地铁上两个方向共用一个 lineId 并对同一站反向编号，故任一顺序都是真实乘车 ——
 * 较小的下车站序表示沿另一方向运行，读取侧正是依据这两个站序解析方向。
 * 两端是**同一站**的路段在两种情形下都算错，因为它根本不是一次乘车。
 * 该规则做成 refine 而非路由检查，使 POST、PATCH 与任何直接写入在一个边界上拒绝坏记录；
 * 它是引擎 `leg-recorded-backwards`（`commute-chain.ts`）的写入端孪生，读端对已存行问同一个问题。
 * 没有方向列：公交两个方向是两个 lineId，地铁两个站序已说明路段往哪边走。
 */
export const CommuteChainLegSchema = z.object({
  /**
   * 在链中的位置（0 基）。由服务端按收到的数组顺序写入 —— 请求可以省略它
   * （它发来的顺序就是顺序），而携带的值不被信任：空档或重复会让路段序列无法读取。
   */
  seq: z.number().int().min(0).optional(),
  lineId: z.string().min(1),
  /** 录入时的线路名，使链无需读上游即可阅读。 */
  lineName: z.string().min(1),
  cityCode: z.string().default('027'),
  boardStationName: z.string().nullable(),
  boardStationOrder: z.number().int().positive().nullable(),
  alightStationName: z.string().nullable(),
  alightStationOrder: z.number().int().positive().nullable(),
  /**
   * 加在**进入**本路段的接驳之上的分钟数，是路径服务自身时长之外的额外时间（骑行：找车与停车）。
   * `null` 表示用户什么都没配置 —— 扣减层随后用自己的默认值；它不是 0，0 意为「完全没有额外时间」。
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
    // 路段必须沿线路的**一个**方向运行，只有 lineId 说明哪个方向是下游（理由见
    // CommuteChainLegSchema 的说明）。坏记录在边界上拒绝，而不是存下来再解释成我们读数的问题；
    // 做成 refine 而非路由检查，故 POST、PATCH 与任何直接写入都由一条规则覆盖。
    // 未选择的站没有站序可比，保持放行，由配对 refine 管辖。
    // 地铁判定用的是项目自身的约定而非第二个谓词：`subway_` 前缀正是把读取路由到地铁引擎的那个约定，
    // 引擎在读端对同一字段问同一个问题，故两层不会对同一条线路产生分歧。
    leg => leg.boardStationOrder === null || leg.alightStationOrder === null
      || leg.alightStationOrder > leg.boardStationOrder
      || (leg.lineId.startsWith('subway_') && leg.alightStationOrder < leg.boardStationOrder),
    { message: '下车站的站序必须大于上车站的站序；只有地铁可以反向（下车站站序小于上车站站序），同一站不是乘车段' },
  )
export type CommuteChainLeg = z.infer<typeof CommuteChainLegSchema>

/**
 * F10：一条具名的通勤链 —— 从哪里出发、服务哪个用途、由哪些有序的乘车路段组成。
 * `legs` 是整段序列，作为一个值写入：链就是它的路段，故替换路段是替换链的实质而非并入。
 * 至少需要一条乘车路段 —— 一条都没有的链不携带任何结论。
 * `id` 与 `createdAt` 属于服务端，与收藏一样在入口处可选。
 */
export const CommuteChainSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().default(DEFAULT_USER_ID),
  name: z.string().min(1),
  originAnchor: CommuteChainAnchorSchema,
  purpose: CommuteChainPurposeSchema,
  /** 在用户自己的排序中的位置（0 基）。 */
  displayOrder: z.number().int().min(0).default(0),
  createdAt: z.string().optional(),
  legs: z.array(CommuteChainLegSchema).min(1, { message: '换乘链至少需要一段乘车段' }),
})
export type CommuteChain = z.infer<typeof CommuteChainSchema>

/**
 * PATCH payload：部分更新，逐字段独立校验。
 * 省略 `legs` 保持链的路段不动；给出则替换整段序列。
 * 没有逐路段的 PATCH —— seq 编号是位置，编辑「某一条」本来也会把其余重新编号。
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
 * F11：手动刷新在线上协议中的形状。
 * 刷新只覆盖**实时**类数据：逐分钟变化的读数（车辆位置、到站分钟）。
 * 长 TTL 的线路数据（站序、路线几何）不在其中 —— 那些并不是「再问一次就会更新」的东西，
 * 重读它们只会为不可能变化的值为上游配额付费。
 * `REFRESH_MAX_LINES` 界定一次刷新可触发的上游读取：每个条目至少一次请求，且由调用方指定线路。
 */
export const REFRESH_MAX_LINES = 8

/**
 * 某个界面希望重读的一条线路。
 * 由调用方给出，而不是服务端从用户关注的线路解析：只有界面知道自己正在展示什么，
 * 且首页与线路页展示的集合并不相同。
 */
export const RefreshLiveTargetSchema = z.object({
  lineId: z.string().min(1),
  direction: z.number().int().min(0).max(1).default(0),
  cityCode: z.string().optional(),
})
export type RefreshLiveTarget = z.infer<typeof RefreshLiveTargetSchema>

export const RefreshLiveRequestSchema = z.object({
  /**
   * 该冷却窗口属于谁。由调用方给出：本端点没有鉴权，故该 id 是标签而非身份 ——
   * 传另一个 id 就能买到新窗口，且由于窗口映射按最近使用有界，调用方也能把别人的窗口挤出去。
   * 如实说明而不做防护：窗口的存在是为了约束上游读取，且它不暴露任何人的数据。
   */
  userId: z.string().min(1).default(DEFAULT_USER_ID),
  lines: z.array(RefreshLiveTargetSchema).min(1).max(REFRESH_MAX_LINES),
})
export type RefreshLiveRequest = z.infer<typeof RefreshLiveRequestSchema>

/**
 * 一次尝试中一条线路的结果。
 * `lastUpdatedAt` 是本线路读数从产生它的源取得的瞬间；本次未取得时为 null。
 * 对失败的读取，null 才是诚实的答案：当前时间不是一个读数。
 * `dataSource` / `isDegraded` 是该读数的来源，从产生它的状态带过来，且恰好在没有读数时为 null。
 * 它们随行是因为仅有瞬间说不出这是哪一种读数：模拟开启时，生成的车辆读数也盖着当前时间，
 * 只持有瞬间的调用方会把它报成取得过的读数。F4 的标记由这两个字段推出，绝不来自时钟。
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
 * 刷新的答复。
 * `lastUpdatedAt` 是通过本端点为该用户取得的最新实时读数从源取得的瞬间；
 * 刷新尚未取得任何读数前为 null。它绝不是服务端作答的瞬间：
 * 那个值对每个响应都为真，会在根本没取得读数的时刻声称有读数。
 * 它也不是屏上已有数据的年龄 —— 屏上的读数自带瞬间，并在被刷新后的读数替换前一直沿用。
 * `nextAllowedAt` 与 `retryAfterSeconds` 即便请求被拒也会给出，
 * 因为被拒正是界面需要一个截止时刻来倒数的场景，而它已经在展示的数据的瞬间也仍值得回报。
 * 两者描述同一个截止时刻，故在任何结果中都一致 —— 包括没有任何拒绝的那些。
 */
export const RefreshLiveResultSchema = z.object({
  /** 本次刷新覆盖的数据类别：实时，且仅实时。 */
  dataClass: z.literal('live'),
  /** 冷却拒绝了本次请求时为 true：没有为它读取任何数据。 */
  throttled: z.boolean(),
  lastUpdatedAt: z.number().nullable(),
  nextAllowedAt: z.number(),
  /**
   * 到 `nextAllowedAt` 的秒数 —— 倒计时渲染的等待，在任何结果下都由该截止时刻推出。
   * 成功与失败的读取都会用满整个冷却，故两者都报剩余等待而非 0：
   * 只有确实打开的窗口才称得上「现在」。
   */
  retryAfterSeconds: z.number().min(0),
  /**
   * 本次尝试的逐线路结果，每个请求到的不同线路一条。
   * 尝试被拒时为空 —— 为没人读过的线路报一条 null 读数，等于声称它被读过却什么都没答。
   */
  lines: z.array(RefreshLiveLineSchema),
})
export type RefreshLiveResult = z.infer<typeof RefreshLiveResultSchema>
