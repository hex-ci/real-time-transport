/**
 * 家 / 公司，按 `GET /api/transit/settings` 回答它们的方式。
 *
 * 一次读取放在一处，因为「设置」有三块界面读它：位置锚点索引页（两行的摘要）、每个锚点自己的
 * 页面（当前设置那句）、以及设置索引行（陈述每一个是否已设置）。对同一个应答的第二份解析，
 * 就是第二次对「未设置」是什么意思产生分歧的机会。
 *
 * 写的一侧刻意不在这里：PATCH 携带的线上字段名留在 `anchor-place.ts` 的锚点表里，
 * 紧挨着构建请求体的地方。
 */

/**
 * 一个锚点的坐标是从哪来的 —— 与契约层 `AnchorSourceSchema` 同一套词。
 *
 * 它决定写入时换不换算（`docs/PRD.md` §5.4）：`device` 是浏览器上报的原始 WGS-84，
 * 服务端换算一次；`search` 是高德返回的 GCJ-02，原样落库。浏览器侧读它只为**显示**，
 * 不做任何换算 —— 换算是服务端 `/settings` PATCH 的事。
 */
export type AnchorSource = 'device' | 'search'

/** 八个存储的值，正是 `GET /settings` 回答它们的形状。 */
export interface StoredAnchors {
  homeLat: number | null
  homeLng: number | null
  workLat: number | null
  workLng: number | null
  homePlaceName: string | null
  workPlaceName: string | null
  homeAnchorSource: AnchorSource | null
  workAnchorSource: AnchorSource | null
}

/** 应用存储的锚点，按 F1 参考行称呼它们的方式。 */
export type AnchorId = 'home' | 'work'

/** 服务端持有的坐标，或 null。绝不强制成 0。 */
export function coord(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 一个已存的来源，或 null。**认不出的取值读成 null，绝不取整为 `device`**。
 *
 * 只有两个词是来源：认不出的值说明写它的人用的是当时还不认识的说法，而按 `device` 读它
 * 会让界面把一个搜索来的锚点说成设备抓的。此处不做换算，故读成 null 的代价只是描述不准，
 * 但「描述不准」正是这个字段唯一要做的事。
 */
function source(value: unknown): AnchorSource | null {
  return value === 'device' || value === 'search' ? value : null
}

/**
 * 一个已存的地点名，或 null。
 *
 * 空串读成 null：它不是「一个空的名字」，而是这一项没被写下。界面据此显示坐标，
 * 绝不显示一个空白的名字行。
 */
function placeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 从 `/settings` 应答里取出这些锚点，未设置的为 null。 */
export function pickAnchors(data: Record<string, unknown> | null | undefined): StoredAnchors {
  return {
    homeLat: coord(data?.homeLat),
    homeLng: coord(data?.homeLng),
    workLat: coord(data?.workLat),
    workLng: coord(data?.workLng),
    homePlaceName: placeName(data?.homePlaceName),
    workPlaceName: placeName(data?.workPlaceName),
    homeAnchorSource: source(data?.homeAnchorSource),
    workAnchorSource: source(data?.workAnchorSource),
  }
}

/**
 * 一个锚点的坐标；**两个轴都要有**才成立，任一轴缺失就是这个锚点没设置。
 *
 * 它也是「已设置」这一判定的唯一根据（`isAnchorSet` 就是它是否为空），故读坐标与报状态不会
 * 变成两条会漂移的规则。绝不强制成 0：0 是坐标上的一个真实位置，不是「没有」。
 */
export function anchorPoint(stored: StoredAnchors, id: AnchorId): { lat: number, lng: number } | null {
  const lat = coord(id === 'home' ? stored.homeLat : stored.workLat)
  const lng = coord(id === 'home' ? stored.homeLng : stored.workLng)
  return lat === null || lng === null ? null : { lat, lng }
}

/** 一个锚点是否存有位置。 */
export function isAnchorSet(stored: StoredAnchors, id: AnchorId): boolean {
  return anchorPoint(stored, id) !== null
}

/** 一个锚点的地点名，或 null（设备抓的位置没有名字）。 */
export function anchorPlaceName(stored: StoredAnchors, id: AnchorId): string | null {
  return id === 'home' ? stored.homePlaceName : stored.workPlaceName
}

/** 一个锚点的坐标来源，或 null（013 之前的行没记过）。 */
export function anchorSource(stored: StoredAnchors, id: AnchorId): AnchorSource | null {
  return id === 'home' ? stored.homeAnchorSource : stored.workAnchorSource
}

/**
 * 已存的坐标，五位小数（约 1 米）。
 *
 * 五位是本应用当作同一性的精度 —— 步行时间缓存以同一尺度为坐标建键 —— 故展示的是步行路径
 * 眼中的那个锚点，两个锚点靠各自的数字区分。
 */
export function coordsLabel(point: { lat: number, lng: number }): string {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
}

/** 未设置时那句话：没有锚点就没有步行时间，也就没有可展示的出门时间。 */
export const ANCHOR_UNSET_TEXT = '未设置 · 无法算出门时间'

/**
 * 一个锚点在界面上被认出的方式：**有名字说名字，没名字说坐标**。
 *
 * 名字是搜索来的那个地点名（设备抓的位置没有名字，故它只能是坐标）。两者都没有时说的
 * 就是「未设置」—— 一个锚点若有坐标就一定有一样东西可说，故此处不可能是空串。
 * 绝不编造一个名字：坐标本身已经是那条已存记录的事实。
 */
export function anchorSummaryOf(stored: StoredAnchors, id: AnchorId): string {
  const name = anchorPlaceName(stored, id)
  if (name !== null) return name
  const point = anchorPoint(stored, id)
  return point === null ? ANCHOR_UNSET_TEXT : coordsLabel(point)
}
