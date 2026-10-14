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

/**
 * 我钉过的站台（F1）：两个通勤上车点，或某个方向的关注站。
 *
 * 它们是这一页里唯一**不按距离排列、也不受最近 30 个名额挤压**的站 —— 人走远之后，想看的站
 * 不该从下拉里消失（实测：钉过的站在 20 公里外，而列表被最近的 30 个占满，一个都找不到）。
 */
export type AnchorRole = 'morning' | 'evening' | 'followed'

/**
 * 角色的说法，**下拉里的那个短词**：下拉是给人扫的，一行里既有站名又有距离，
 * 身份只需说清「这条是我钉的哪一类」。设置页与首页角标说全「上班上车点 / 关注站」，
 * 它们那里有地方摆。
 */
export const ANCHOR_ROLE_LABELS: Record<AnchorRole, string> = {
  morning: '上班',
  evening: '下班',
  followed: '关注',
}

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
  /** 它是用户钉过的站台时的身份；未钉过则缺省。 */
  anchor?: AnchorRole
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
 * 不标「关注线路经过的站」有两个理由：这份列表的默认本来就是那些站，标默认等于没标；
 * 而「关注」这个词在这个下拉里已经属于 F1 的「关注站」（上面那些带身份的钉过的站台），
 * 再拿它标「关注线路的站表里有它」会把两件不同的事说成一件。
 * 于是「哪些站是关注线路经过的」读作：**没有带任何标记那些**。
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
  // 一个站只带一种说法：钉过的站台说它是什么（那是它排在最前的理由），其余按来源标「附近」。
  const mark = option.anchor ? ANCHOR_ROLE_LABELS[option.anchor] : originMarkOf(option)
  return [mark, distanceTextOf(option.distanceMeters)].filter(Boolean).join(' · ') || null
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
 * 把钉过的站台的身份盖到列表上：同一个站名用**用户钉的那一个**（id 与坐标都换过来）。
 *
 * 站表里同名多站是真实存在的（马路两侧各一个站 id），而列表按站名去重 —— 不盖这一下，
 * 钉了东侧站台的人会被读到西侧那个，距离与到站都是另一个站台的。
 *
 * 钉过的站台不会因为这一下而多出来：它本来就在关注线路的站表里，故这里只管换身份。
 */
export function applyAnchors(list: StationOption[], anchors: StationOption[]): StationOption[] {
  if (anchors.length === 0) return list
  const byName = new Map(anchors.map(anchor => [anchor.name, anchor]))
  return list.map((option) => {
    const anchor = byName.get(option.name)
    if (!anchor) return option
    return {
      ...option,
      stationId: anchor.stationId,
      lat: anchor.lat,
      lng: anchor.lng,
      anchor: anchor.anchor,
    }
  })
}

/**
 * 下拉里的排列：**一张按距离排的表**，钉过的站保证不被名额截掉。
 *
 * 两步，别的不做：
 *  - 候选（附近的站台 + 关注线路的站表）取最近的 `cap` 个 —— 名额是给「我附近有哪些站」留的；
 *  - 全部钉过的站（上下班上车点、关注站）额外并入，**不占名额、也不因远而被截掉**，
 *    然后整体按距离排。
 *
 * 于是「最近的在前」对整张表成立（钉过的站也在它该在的位置上），而「我钉过的站一定找得到」
 * 也成立 —— 这两件事不再互相打架。代价是钉过的站通常比附近的站远，故它落在列表末尾；
 * 由默认选中与「记住最后看的站台」兜底（上次看过的那个会直接被选中）。
 *
 * 没有坐标的钉过的站排在有距离的之后：不知道远近就不冒充最近。
 */
export function arrangeOptions(list: StationOption[], cap: number): StationOption[] {
  const anchors = list.filter(option => option.anchor)
  const rest = sortByDistance(list.filter(option => !option.anchor)).slice(0, cap)
  return sortByDistance([...anchors, ...rest])
}

/**
 * 走开多远才算**换了地方** —— 列表要不要重排这件事的判据。
 *
 * 定位是每一下都在动的：站着不动，GPS 也会在几十米里打转，而这一页的站台彼此常只差几十米，
 * 按每一下读数重排就会出现「谁先来」在手指底下跳（实测：六次 20~40 米的抖动，顺序六次全变）。
 * 故比较的是「离**上一次取快照**的地方走了多远」，没走够就不动 —— 抖动不算换地方。
 *
 * 上一次为空（还没取过快照）时算换了地方：那时没有可留住的东西。
 */
export function movedEnough(
  previous: { lat: number, lng: number } | null,
  next: { lat: number, lng: number },
  thresholdM: number,
): boolean {
  if (!previous) return true
  return haversineMeters(previous.lat, previous.lng, next.lat, next.lng) > thresholdM
}

/**
 * 最近的站台也在 3 公里外时那句话 —— 这时「按远近排」仍然成立，但这一屏没有一个站算附近。
 * 说出来，比让使用者自己从列表里发现要诚实；都没有距离可说时返回空串。
 *
 * **钉过的站台不参与这一句**：它们排在最前靠的是「我钉过它」，不是因为它在旁边；
 * 拿一个 20 公里外的钉过的站去说「最近的也在 3 公里外」，说的是另一件事。
 */
export function outOfNearbyNoteOf(list: StationOption[]): string {
  const nearest = list.filter(option => !option.anchor).find(option => option.distanceMeters !== null)
  if (!nearest || nearest.distanceMeters === null || nearest.distanceMeters <= NEARBY_RADIUS_M) return ''
  return `最近的站台也在 ${distanceTextOf(nearest.distanceMeters)}外`
}
