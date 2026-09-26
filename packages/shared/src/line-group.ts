import type { LineDetail } from './schemas/transit.js'
import type { LineSummary } from './schemas/api.js'
import { haversineMeters } from './geo.js'

/** 某条线路的一个方向，按搜索命中的解析结果。 */
export interface RouteDirectionEntry {
  direction: 0 | 1
  lineId: string
  startStop: string
  endStop: string
  /** 终点牌标签（「开往 X」），由提供方合成。 */
  directionName: string
}

/**
 * 一条搜索命中，代表**一条**线路并带上它的两个方向。
 * 用户关注的是线路而非方向 —— 他要两个方向，并在首页切换方向。
 * 公交是两个不同的上游 lineId（每方向一个），地铁则是同一 lineId 加方向参数，
 * 故这里每个方向各自携带 lineId。
 */
export interface LineGroup {
  /** 线路的稳定身份：为其见到的第一个 lineId。 */
  groupKey: string
  lineName: string
  cityCode: string
  /** 方向 0 条目，仅当上游确实返回了它。 */
  up: RouteDirectionEntry | null
  /** 方向 1 条目，仅当上游确实返回了它。 */
  down: RouteDirectionEntry | null
}

function toEntry(s: LineSummary): RouteDirectionEntry {
  return {
    direction: s.direction === 1 ? 1 : 0,
    lineId: s.lineId,
    startStop: s.startStop,
    endStop: s.endStop,
    directionName: s.directionName,
  }
}

/**
 * 把逐方向的平铺搜索命中并成每条线路一个结果。
 * 分组规则：同一城市内 lineName 相同的条目算一条线路。
 * 方向只从真实的上游命中填充，绝不合成 —— 只报了一个方向的线路，
 * 另一个方向保持 null，UI 对它隐藏切换，而不是造一个解析不了的 lineId。
 */
export function groupLineSummaries(summaries: LineSummary[]): LineGroup[] {
  const byName = new Map<string, LineGroup>()
  const groups: LineGroup[] = []

  for (const s of summaries) {
    if (!s.lineId) continue

    const name = (s.lineName || '').trim()
    const city = s.cityCode || '027'
    const key = `${city}::${name}`
    const entry = toEntry(s)

    let group = byName.get(key)
    if (!group) {
      group = {
        groupKey: s.lineId,
        lineName: name || s.lineId,
        cityCode: city,
        up: null,
        down: null,
      }
      groups.push(group)
      byName.set(key, group)
    }

    if (entry.direction === 0) {
      if (!group.up) group.up = entry
    }
    else if (!group.down) {
      group.down = entry
    }
  }

  return groups
}

/**
 * 解析某线路要加载的具体 (lineId, direction) 对。
 * 请求的方向未被上游报告过时返回 null —— 调用方不得回落到反方向，
 * 那会让公交在错误的方向标下悄悄显示反方向的车辆。
 */
export function resolveRouteTarget(
  group: Pick<LineGroup, 'up' | 'down'>,
  direction: 0 | 1,
): RouteDirectionEntry | null {
  return direction === 0 ? group.up : group.down
}

/** 两个方向都可用于在 UI 中切换时为 true。 */
export function isBidirectional(group: Pick<LineGroup, 'up' | 'down'>): boolean {
  return group.up !== null && group.down !== null
}

/**
 * 解析某收藏线路在给定方向上具体的上游 lineId。
 * 收藏存 `lineId` 加它所属的方向（`preferredDirection`），以及反方向的 `reverseLineId`。
 * 公交需要它，因为每个方向是一个不同的上游 lineId；地铁两个方向共用一个，
 * 故同一 id 存两次（或省略反向 id）。
 * 该方向不可用时返回 null —— 调用方**不得**回落到反方向，那会显示错方向的车辆。
 */
export function resolveFavoriteLineId(
  fav: { lineId: string, preferredDirection?: number, reverseLineId?: string },
  direction: 0 | 1,
): string | null {
  const primary = fav.preferredDirection === 1 ? 1 : 0
  if (direction === primary) return fav.lineId
  return fav.reverseLineId || null
}

/** 该收藏可在两个方向之间切换时为 true。 */
export function favoriteIsBidirectional(fav: {
  lineId: string
  reverseLineId?: string
}): boolean {
  return Boolean(fav.reverseLineId)
}

/**
 * 一条上游线路的 payload 所描述的方向，换成收藏行自己的方向编号。
 * 一个方向在这套应用里有两个编号体系，混用会让同一屏说一个号、写另一个号：
 *
 *  - payload 自己的号（`detail.direction`）：上游对某条具体线路给出的号。详情页显示的就是它，
 *    页面上的实时 / 到站 / 步行读取也都按它走 —— 地铁两个方向共用一条 lineId，方向参数正是用它选方向；
 *  - 收藏行自己的号（`preferredDirection` 锚定的那一套）：`morningDirection` / `eveningDirection`
 *    用它，设置页的方向单选、首页卡片、`resolveFavoriteLineId`、回填脚本都按它读。
 *
 * 两者对同一条真实线路可以相反，故详情页写入 `morningDirection` 时必须换算，
 * 否则写下的号指的是反方向 —— 而站序是那个方向的站序。
 *
 * 规则：
 *  - 两个方向是两条不同的上游 lineId（公交）：线路本身已定住方向 —— `fav.lineId` 是
 *    `preferredDirection` 那个方向，`reverseLineId` 是另一个；不属于这两条则返回 null（绝不猜）；
 *  - 两个方向共用一条 lineId（地铁，或只有一个方向的单向行）：lineId 分不出方向，
 *    此时 payload 自己的号即收藏行的号 —— 收录时 `preferredDirection` 记的正是上游对这条 lineId
 *    给出的号，故两者是同一套编号。
 */
export function favoriteDirectionOfLine(
  fav: { lineId: string, reverseLineId?: string, preferredDirection?: number },
  lineId: string,
  payloadDirection: number,
): 0 | 1 | null {
  const primary = (fav.preferredDirection === 1 ? 1 : 0) as 0 | 1
  // 两条不同的上游线路：线路就是方向本身。
  if (fav.reverseLineId && fav.reverseLineId !== fav.lineId) {
    if (lineId === fav.lineId) return primary
    if (lineId === fav.reverseLineId) return (1 - primary) as 0 | 1
    return null
  }
  // 一条上游线路服务两个方向（地铁），或这一行只有一个方向：payload 的号即收藏行的号。
  if (lineId !== fav.lineId) return null
  return payloadDirection === 1 ? 1 : 0
}

/**
 * 某收藏实际拥有的方向，各自带着服务它的 lineId。
 * 单向线路一条，双向线路两条。要枚举**这个**而不是 `[0, 1]`：
 * 单向收藏没有第二个方向，拿硬编码的配对加 `?? f.lineId` 兜底会造出一个 ——
 * 于是同一个上游 lineId 为两个方向作答，站台看板出现两行完全相同的内容。
 * 地铁收藏两个方向共用一个 lineId，那仍然是两个真实方向，故给出两条同一 lineId 的条目。
 */
export function favoriteDirections(fav: {
  lineId: string
  preferredDirection?: number
  reverseLineId?: string
}): Array<{ direction: 0 | 1, lineId: string }> {
  const primary = (fav.preferredDirection === 1 ? 1 : 0) as 0 | 1
  const out: Array<{ direction: 0 | 1, lineId: string }> = [
    { direction: primary, lineId: fav.lineId },
  ]
  if (fav.reverseLineId) {
    out.push({ direction: (1 - primary) as 0 | 1, lineId: fav.reverseLineId })
  }
  return out
}

/**
 * 收藏已存的上车站：站名，以及该行携带时的站序。
 * 一站在线路上的身份是 (站名, 站序) 配对，与换乘链路段的站同一规则（007：站名与站序同生同灭）：
 * 同一站名可以出现在多个站序上，故只有站名无法定位回停靠列表。
 * 站序列存在之前写入的行只留站名，其站序确实未知：本类型以 `null` 表示，且此处不猜。
 */
export interface BoardStopRef {
  name: string
  /** 该行已存的站序；只留了站名时为 null。 */
  order: number | null
}

/**
 * 读取某个通勤用途的上车站，按它被存储的身份形态。
 * 上车站按**用途**而非方向键控：`morningStopName` / `morningStopOrder` 是早通勤的上车处，
 * 晚间那一对对应晚通勤（落在 pinned_station_name / pinned_station_order 与反向列上）。
 * 该用途没有设置时返回 null —— 调用方必须显示明确的「未设置」状态，而不是猜一个站。
 * 已存的空站名不是站：它读成未设置，绝不是一个名为 "" 的站。
 * 不是非负整数的站序是未知而非站号：该列是可空 INT，其他值只能是写不出来的值。
 */
export function resolveBoardStopRef(
  fav: {
    morningStopName?: string
    morningStopOrder?: number | null
    eveningStopName?: string
    eveningStopOrder?: number | null
  },
  purpose: 'morning' | 'evening',
): BoardStopRef | null {
  const name = purpose === 'morning' ? fav.morningStopName : fav.eveningStopName
  if (!name) return null
  const raw = purpose === 'morning' ? fav.morningStopOrder : fav.eveningStopOrder
  const order = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
  return { name, order }
}

/**
 * 已存的站落在某方向自己的停靠列表中的位置 —— 或者说明为何无法安放。
 * 这是读回已存站的**唯一**规则，它存在是因为站名不是身份。
 * 规则按应用顺序：
 *
 *  - 存了站序 -> 那个确切的 (站名, 站序) 就是该站，别无其他。列表把该站名放在**不同**站序上时，
 *    该行为 `stale`：上游重编了站序，回落到站名匹配会悄悄挪走用户的站台，
 *    故在用户重新选择前**不可用**；列表根本不含该站名时，该行为 `absent`
 *    （与只留站名的行同一事实：本方向不在此停靠）。
 *  - 未存站序（旧行）-> 站名**仅在该站名于本方向列表中只出现一次**时才能定位该站；
 *    出现多次时该行为 `ambiguous`：用户指的是哪一个无从得知，故该站**不可用**，
 *    每个界面都必须这么说，而不是解析到第一个匹配。
 *  - 站名完全不在本方向 -> `absent`（本方向不在此停靠；对对面站台与另一方向的站都是真的）。
 *  - 列表本身未读到（`null`/`undefined`）-> `not-loaded`。那是「未知」，
 *    与 `absent` 是不同的事实，界面不得从没人读过的列表断言不匹配。空列表是读取答案，故它什么都安放不了。
 */
export type BoardStopPlacement
  /** 该用途没有已存的站。 */
  = | { state: 'unset' }
  /** 该方向的停靠列表尚未读到，故无法判定该站。 */
    | { state: 'not-loaded' }
  /** 该方向列表中恰好一个站与已存身份吻合。 */
    | { state: 'placed', name: string, order: number }
  /** 只留站名的行，而该站名出现多次：它指哪一个无从得知。 */
    | { state: 'ambiguous', name: string, orders: number[] }
  /** 已存的站序，其站名出现在**不同**站序上（被重编过）。 */
    | { state: 'stale', name: string, order: number }
  /** 该方向的列表完全不含该站 —— 无论是否存过站序。 */
    | { state: 'absent', name: string }

export function placeBoardStop(
  stops: ReadonlyArray<{ name: string, order: number }> | null | undefined,
  stop: BoardStopRef | null,
): BoardStopPlacement {
  if (!stop) return { state: 'unset' }
  if (!stops) return { state: 'not-loaded' }

  if (stop.order !== null) {
    const hit = stops.find(s => s.name === stop.name && s.order === stop.order)
    if (hit) return { state: 'placed', name: hit.name, order: hit.order }
    // 站名存在于**另一个**站序上：上游重编了站序（或用户的站已被替换）。
    // 此时站名不是答案 —— 解析它会悄悄挪走站台 —— 故该行不可用，并说明站序已变。
    if (stops.some(s => s.name === stop.name)) {
      return { state: 'stale', name: stop.name, order: stop.order }
    }
    // 站名已从本方向彻底消失：「不在本方向停靠」恰好为真，与下面只留站名的行是同一事实。
    return { state: 'absent', name: stop.name }
  }

  // 只有站名：仅当该站名在**本**方向不二义时才能解析。
  const named = stops.filter(s => s.name === stop.name)
  if (named.length === 1) return { state: 'placed', name: named[0]!.name, order: named[0]!.order }
  if (named.length === 0) return { state: 'absent', name: stop.name }
  return { state: 'ambiguous', name: stop.name, orders: named.map(s => s.order) }
}

/**
 * 推导某线路的每个通勤用途由哪个方向服务。
 *
 * 运行时**已不再使用**：方向是存在收藏上的显式用户选择（`morningDirection` / `eveningDirection`），
 * 因为本推导可能与用户选站时真正看到的方向不一致，
 * 且当某上车站只在一个方向存在时会退化为 null（长线路通常两个方向都有几个这样的站）。
 * 仅保留为把既有上车站迁移到显式方向的一次性回填工具；新代码必须读已存字段。
 *
 * 使用**两个方向**的停靠列表（同一站在不同方向站序不同）。方向 d 是早间方向，
 * 当且仅当早间上车站先于晚间上车站出现于 d 自己的站序中；两个方向必须得出相反的结论，
 * 否则该线路的几何形态（环线、S 形）压过了排序启发式，返回 null。
 */
export function deriveCommuteDirections(
  fav: { morningStopName?: string, eveningStopName?: string },
  details: { 0: LineDetail, 1: LineDetail },
): { morning: 0 | 1, evening: 0 | 1 } | null {
  const morning = fav.morningStopName
  const evening = fav.eveningStopName
  // 只做精确站名匹配：子串命中会劫持仅共享前缀的靠后车站。
  if (!morning || !evening) return null
  if (morning === evening) return null

  const orderOf = (d: LineDetail, name: string): number | undefined =>
    d.stops.find(s => s.name === name)?.order

  const m0 = orderOf(details[0], morning)
  const e0 = orderOf(details[0], evening)
  const m1 = orderOf(details[1], morning)
  const e1 = orderOf(details[1], evening)
  if (m0 === undefined || e0 === undefined || m1 === undefined || e1 === undefined) return null

  // dir0 的结论：在其自己的站序里早间先于晚间；dir1 必须以相反方式一致（同一物理顺序，序列反向）。
  const dir0IsMorning = m0 < e0
  const dir1IsMorning = m1 > e1
  if (dir0IsMorning !== dir1IsMorning) return null

  return dir0IsMorning ? { morning: 0, evening: 1 } : { morning: 1, evening: 0 }
}

/**
 * 某收藏在某个通勤用途上乘哪个方向。
 * 只读用户的显式选择。从未选择时返回 null（这是真实状态 —— 设置界面要求先选方向），
 * 调用方必须显示「未设置」，而不是默认成 0 —— 那会把一个任意的物理方向冒充成用户的通勤方向。
 * `preferredDirection` 刻意**不**在此兜底：它锚定的是哪个上游 lineId 是方向 0，
 * 属于存储问题，与用户往哪边走无关。回落到它正是旧推导与选择器刚展示过的方向产生分歧的根源。
 */
export function commuteDirectionFor(
  fav: { morningDirection?: number | null, eveningDirection?: number | null },
  purpose: 'morning' | 'evening',
): 0 | 1 | null {
  const raw = purpose === 'morning' ? fav.morningDirection : fav.eveningDirection
  if (raw !== 0 && raw !== 1) return null
  return raw
}

/**
 * 某用途实际乘坐的方向，处理单向线路的情形。
 * 双向线路上这就是 `commuteDirectionFor` —— 用户的选择，未选择前为 null。
 * 只有一个方向的线路上没有可做的选择，故要求已存值会让所有消费方永远停在「未设置」：
 * 设置面板给的是静态标签而非选择器，于是永远写不进一个值。这种线路解析为它唯一的方向。
 * 仅用于展示侧。它绝不伪造已存的用户选择，
 * 故在该行确实不可能选择时，DB 保持 NULL。
 * 消费方必须用**本函数**而不是直接用 `commuteDirectionFor`：
 * 设置选择器、首页卡片与详情角标都渲染方向，各自处理单向特例正是它们漂移的原因。
 */
export function effectiveCommuteDirection(
  fav: {
    lineId: string
    reverseLineId?: string
    preferredDirection?: number
    morningDirection?: number | null
    eveningDirection?: number | null
  },
  purpose: 'morning' | 'evening',
): 0 | 1 | null {
  const chosen = commuteDirectionFor(fav, purpose)
  if (chosen !== null) return chosen
  if (favoriteIsBidirectional(fav)) return null
  // 唯一方向：`preferredDirection` 锚定的那个。
  return fav.preferredDirection === 1 ? 1 : 0
}

/**
 * 在**某条线路自己的**停靠列表内找 GPS 最近站。
 * 候选集严格限于该线路的站 —— 绝不是外部 POI 雷达，雷达的最近站往往是别条线路的站。
 * 定位缺失或没有站带坐标时返回 null；调用方不得默认取第一站，那会把一个任意的站当成「最近」。
 * 只有真正声明了位置的站才是候选。停靠列表未落点的站 —— 或以 0 标记的站，
 * 本应用 GCJ-02 基准面上没有落点站会落在 0 上 —— 一律跳过而不测量，
 * 因为从 (0, 0) 量出的距离会让未落点的站台成为离用户最近的东西，看板随后会吸附到它。
 * 判定「一个解析出来的坐标到底是什么」用的是同一条规则（`statedCoordinate`），
 * 故两处读取不会漂移。
 */
export function nearestStopOnLine(
  stops: Array<{ name: string, order: number, lat?: number, lng?: number }>,
  coords: { lat: number, lng: number } | null,
): { name: string, order: number, distanceMeters: number } | null {
  if (!coords || stops.length === 0) return null
  let best: { name: string, order: number, distanceMeters: number } | null = null
  for (const s of stops) {
    if (!s.lat || !s.lng) continue
    const d = haversineMeters(coords.lat, coords.lng, s.lat, s.lng)
    if (best === null || d < best.distanceMeters) {
      best = { name: s.name, order: s.order, distanceMeters: d }
    }
  }
  return best
}

/**
 * 定位用户所在的站台，再按方向解析它。
 * 公交一条线路的两个方向停靠**同名**站但在马路两侧：上游给每个方向自己的坐标与站序，
 * 两份停靠列表甚至不必共享每个站名。故两种做法都不对：
 * 「整条线路一个最近站」（它的站序在另一方向无意义 —— 服务端先按站序匹配，
 * 会悄悄返回另一个站的到站）与「每个方向一个最近站」（两行会指向不同站台，较远的那个不是用户所在）。
 * 符合实际的模型：先取最近的站**名**，再让每个方向为该站名贡献自己的站序。
 * 没有该站名的方向确实在此没有站台，报 null 而不是借用另一方向的时刻。
 */
export function resolveNearbyStop(
  stopsByDirection: {
    0?: Array<{ name: string, order: number, lat?: number, lng?: number }>
    1?: Array<{ name: string, order: number, lat?: number, lng?: number }>
  },
  coords: { lat: number, lng: number } | null,
): {
  name: string
  distanceMeters: number
  perDirection: { 0: { order: number } | null, 1: { order: number } | null }
} | null {
  if (!coords) return null

  // 跨两个方向取最近的站名：站名可能只存在于任一列表，且两份列表不保证一致；
  // 两处都有的同名站坐标相差不过几十米，故从哪一条量距离都会选出同一个站台。
  const candidate = nearestStopOnLine(
    ([] as Array<{ name: string, order: number, lat?: number, lng?: number }>)
      .concat(stopsByDirection[0] ?? [], stopsByDirection[1] ?? []),
    coords,
  )
  if (!candidate) return null

  const orderIn = (
    stops: Array<{ name: string, order: number }> | undefined,
  ): { order: number } | null => {
    // 只做精确站名匹配：子串命中会绑到仅共享前缀的靠后车站。
    const hit = stops?.find(s => s.name === candidate.name)
    return hit ? { order: hit.order } : null
  }

  return {
    name: candidate.name,
    distanceMeters: Math.round(candidate.distanceMeters),
    perDirection: { 0: orderIn(stopsByDirection[0]), 1: orderIn(stopsByDirection[1]) },
  }
}
