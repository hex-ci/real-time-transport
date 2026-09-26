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

/** 一个锚点是否存有位置。两个轴都要有，否则就是没设置。 */
export function isAnchorSet(stored: StoredAnchors, id: AnchorId): boolean {
  return id === 'home'
    ? stored.homeLat !== null && stored.homeLng !== null
    : stored.workLat !== null && stored.workLng !== null
}
