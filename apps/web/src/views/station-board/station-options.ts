import { NEARBY_RADIUS_M, haversineMeters } from '@real-time-transport/shared/geo'
import { distanceTextOf } from '@/distance-copy'

/**
 * 电子站牌页的选项：名字给人认，id 给数据源认，距离给人排。
 *
 * 这些规则刻意放在 SFC 之外：**顺序**、**距离**与**来源标记**是这一页最容易被改错的三件事
 * （排错一个位置，使用者读到的就是「另一站先到」；标错来源，他会以为某个站是被关注的），
 * 故它们要能被直接测。
 */

/** 这个选项凭什么出现在列表里：数据源说它在我附近，或只是关注线路的站表里有它。 */
export type StationOrigin = 'nearby' | 'followed'

export interface StationOption {
  name: string
  stationId: string
  /** 站表给的坐标（GCJ-02）；站表没落点的站为 null，那时它没有距离。 */
  lat: number | null
  lng: number | null
  /** 到当前定位的直线距离（米）；没有定位或没有坐标时为 null。 */
  distanceMeters: number | null
  /** 来源：数据源的附近站台，还是只有关注线路的站表里有它。 */
  origin: StationOrigin
}

/**
 * 把两个来源并成一张列表。
 *
 * 去重按**站名**：站名是给人认的键，一个名字一行 —— 同名多站是真实存在的（马路两侧各一个
 * 站 id），而它们对「我去哪儿等」是同一个答案。站 id 取先遇到的那一份（关注线路的站表，
 * 它是应用别处已经在用的身份）。
 *
 * 两个来源都有的名字算 `nearby`：两个理由都成立时，标记说的是更当下的那个 —— 人此刻就站在跟前。
 * 「它也在关注线路的站表里」不再是一个输出状态：默认那份不需要标，屏上只标例外（见 `originMarkOf`）。
 */
export function mergeStationSources(
  followed: StationOption[],
  nearby: StationOption[],
): StationOption[] {
  const byName = new Map<string, { option: StationOption, nearby: boolean }>()

  /** 同一个来源里同名只留先遇到的那一条；两个来源各自贡献时合并成一个名字。 */
  function add(option: StationOption, source: 'followed' | 'nearby'): void {
    const existing = byName.get(option.name)
    if (!existing) {
      byName.set(option.name, { option: { ...option }, nearby: source === 'nearby' })
      return
    }
    if (source === 'nearby') existing.nearby = true
    // 没有坐标就没有距离，而距离是这一页的排序键：哪一份带了坐标就用哪一份。
    existing.option = {
      ...existing.option,
      lat: existing.option.lat ?? option.lat,
      lng: existing.option.lng ?? option.lng,
    }
  }

  for (const option of followed) add(option, 'followed')
  for (const option of nearby) add(option, 'nearby')

  return [...byName.values()].map(({ option, nearby }) => ({
    ...option,
    origin: nearby ? 'nearby' : 'followed',
  }))
}

/**
 * 这一行为什么在这儿：**只标例外** —— 数据源的附近站台里有它，就说「附近」；其余不标。
 *
 * 不标「关注」有两个理由：这份列表的默认本来就是「关注线路经过的站」，标默认等于没标；
 * 而且「关注」在本仓已被 F1 的「关注站」（按方向钉一个站，设置里配的）占着，同形异义会打架。
 * 于是「哪些站是关注线路经过的」读作：**没有带「附近」那些**。
 */
export function originMarkOf(option: StationOption): string | null {
  return option.origin === 'nearby' ? '附近' : null
}

/**
 * 一个站台的次级文字：**它凭什么在这儿**（只有例外才带标记）与离我多远。
 *
 * 下拉里的每一行与触发器上选中的那个用同一套 —— 同一个站在两处长得不一样，读的人会以为
 * 它们是两回事。没有距离时只说来源（不知道远近就不说远近）。
 */
export function stationSecondaryTextOf(option: StationOption): string | null {
  return [originMarkOf(option), distanceTextOf(option.distanceMeters)].filter(Boolean).join(' · ') || null
}

/**
 * 按当前定位给一批选项量一遍距离；没有定位时所有距离都是 null —— 不知道就说不知道。
 *
 * 距离用项目里既有的那一条直线距离（`haversineMeters`）：line-detail 的「最近站」与
 * F1 附近模式的锚点链用的是同一条，故这一页的「最近」与别处不会给出两个答案。
 */
export function withDistances(
  list: StationOption[],
  coords: { lat: number, lng: number } | null,
): StationOption[] {
  return list.map((option) => {
    if (!coords || option.lat === null || option.lng === null) return { ...option, distanceMeters: null }
    return { ...option, distanceMeters: haversineMeters(coords.lat, coords.lng, option.lat, option.lng) }
  })
}

/**
 * 站台的顺序：**离我最近的在前**。
 *
 * 3 公里那个约定（`NEARBY_RADIUS_M`）只用来判「这算不算附近」，**列表与排序都不因它过滤**：
 * 定位与所选城市脱钩时（跨城看线），站台列表照样要能用，量出来的距离照说。
 *
 * 没有定位、或站表没给坐标的站排在有距离的之后，按站名稳定排 —— 绝不替它编一个距离，
 * 也绝不把它顶到「最近」的位置上。
 */
export function sortByDistance(list: StationOption[]): StationOption[] {
  return [...list].sort((a, b) => {
    if (a.distanceMeters === null && b.distanceMeters === null) return a.name.localeCompare(b.name)
    if (a.distanceMeters === null) return 1
    if (b.distanceMeters === null) return -1
    if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters
    return a.name.localeCompare(b.name)
  })
}

/**
 * 最近的站台也在 3 公里外时那句话 —— 这时「按远近排」仍然成立，但这一屏没有一个站算附近。
 * 说出来，比让使用者自己从列表里发现要诚实；都没有距离可说时返回空串。
 */
export function outOfNearbyNoteOf(list: StationOption[]): string {
  const nearest = list.find(option => option.distanceMeters !== null)
  if (!nearest || nearest.distanceMeters === null || nearest.distanceMeters <= NEARBY_RADIUS_M) return ''
  return `最近的站台也在 ${distanceTextOf(nearest.distanceMeters)}外`
}
