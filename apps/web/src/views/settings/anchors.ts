/**
 * 家 / 公司，按 `GET /api/transit/settings` 回答它们的方式。
 *
 * 一次读取放在一处，因为「设置」现在有两块界面读它：位置锚点页（显示并重新抓取它们）与索引行
 * （陈述每一个是否已设置）。对同一个应答的第二份解析，就是第二次对「未设置」是什么意思产生分歧
 * 的机会。
 *
 * 写的一侧刻意不在这里：PATCH 携带的线上字段名留在 `components/anchor-picker.vue`，紧挨着
 * 构建请求体的 `ANCHORS` 表。
 */

/** 四个存储的坐标，正是 `GET /settings` 回答它们的形状。 */
export interface StoredAnchors {
  homeLat: number | null
  homeLng: number | null
  workLat: number | null
  workLng: number | null
}

/** 应用存储的锚点，按 F1 参考行称呼它们的方式。 */
export type AnchorId = 'home' | 'work'

/** 服务端持有的坐标，或 null。绝不强制成 0。 */
export function coord(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从 `/settings` 应答里取出这四个锚点，未设置的为 null。 */
export function pickAnchors(data: Record<string, unknown> | null | undefined): StoredAnchors {
  return {
    homeLat: coord(data?.homeLat),
    homeLng: coord(data?.homeLng),
    workLat: coord(data?.workLat),
    workLng: coord(data?.workLng),
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
