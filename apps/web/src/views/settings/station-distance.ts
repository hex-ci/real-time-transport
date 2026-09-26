/**
 * 站点选择器里每个站到**参考点**的**直线**距离，以及最近的那一个的标记。
 *
 * 参考点不是任意的点，它由链路的目的与这一段的位置决定：
 *
 *  - 第 1 段的上车站量的是链路的起点（`anchorForPurpose`：上班从家、下班从公司）；
 *  - 末段的下车站量的是另一头的锚点；
 *  - 相邻的两段在同一个站换乘，故每一段余下的那一端量到另一段的那一站——「哪一站是我要的」
 *    在那个换乘点上问的正是离它多远。
 *
 * 参考点不可知时（锚点没存下来、没读到、还在读，或相邻段的站还没选）**一个数字都不标**，
 * 并由参考点自己带出的那句话说出是哪一种不可知：猜一个点顶上去就是替使用者作主张。
 *
 * 距离是**直线**：`haversineMeters` 量出的大圆距离，措辞里带「直线」二字，因为它不是步行或
 * 乘车路线的长度——那两种长度本屏算不出来，也不是这个问题的答案，把大圆距离印成路线距离是
 * 另一种谎话。
 *
 * **顺序一律不动**：选择器列出的先后就是线路自己的站序，而站序是「公交只能顺行」那一契约的
 * 凭据（下车站序必须大于上车站序）。按距离重排会让使用者把上车站挑到某个下车站之后，保存时
 * 才被拒绝。故这里只标注：没有排序、没有筛选、没有一个站因为远而被隐去。
 */
import { haversineMeters, statedCoordinate } from '@real-time-transport/shared/geo'
import { anchorForPurpose } from '@real-time-transport/shared'
import type { Station } from '@real-time-transport/shared'
import { readingText, unreadText, type ReadValue } from '@/read-state'
import { anchorPoint, type AnchorId, type StoredAnchors } from './anchors'
import { legPositionText, optionOfLeg, type ChainDraft, type ChainLegDraft } from './chain-draft'
import type { ChainLineOption, StationReference, StationReferences } from './types'

/** 屏上给最近的那个站的标记。 */
export const NEAREST_STATION_MARK = '最近'

/** 参考点有了、本方向的站点却一个坐标都没有时说的话。 */
export const STATIONS_WITHOUT_COORDS_SENTENCE = '这些站点没有坐标，算不出直线距离'

/** 一个站的标注：到参考点的直线距离，以及它是不是最近的那一个。 */
export interface StationDistance {
  text: string
  nearest: boolean
}

/**
 * 一个站在选择器里的身份：站序**与**站名。
 *
 * 线上同名站不止一个，故站名单独一个身份不够（两个「东大桥」会共用一个值）；而它也是本模块
 * 给标注建的键，故选项的选中状态与它下面的距离说的是同一个站。
 */
export function stationIdentity(stop: { name: string, order: number | null }): string {
  return `${stop.order}_${stop.name}`
}

/**
 * 距离的写法：不到一公里用米、一公里以上用公里，按**印出来的**那个值分档，
 * 故不会出现「1000 米」。
 */
export function distanceText(meters: number): string {
  const rounded = Math.round(meters)
  if (rounded < 1000) return `${rounded} 米`
  return `${(meters / 1000).toFixed(1)} 公里`
}

/**
 * 一个站到参考点的直线距离；参考点不可知、或该站没有坐标时为 null。
 *
 * 站点坐标是**上游**坐标，故经 `statedCoordinate` 读：任一轴为 0 即本基准面上没有这个点，
 * 而从它量出的距离会把一个不存在的站算成最近的那一个。
 */
export function stationDistanceMeters(station: Station, reference: StationReference): number | null {
  if (reference.state !== 'known') return null
  const lat = statedCoordinate(station.lat)
  const lng = statedCoordinate(station.lng)
  if (lat === undefined || lng === undefined) return null
  return haversineMeters(lat, lng, reference.lat, reference.lng)
}

/**
 * 列表里每个站的标注，按站自己的身份。参考点不可知时为一张**空表**：一个数字都不标。
 *
 * 「最近」在**整份列表**上取最小值，故它与筛选无关：最小值是这条线路自己的事实，不是使用者
 * 敲进搜索框的那几个字的。列表里没有一个站量得出距离时同样没有最近可言——空表使这一句无从
 * 落到任何一行上，而印一个 NaN 充数则是另一种谎话。
 */
export function stationDistances(
  stations: Station[],
  reference: StationReference | null,
): Map<string, StationDistance> {
  if (reference === null || reference.state !== 'known') return new Map()

  const measured: Array<{ station: Station, meters: number }> = []
  for (const station of stations) {
    const meters = stationDistanceMeters(station, reference)
    if (meters !== null) measured.push({ station, meters })
  }
  if (measured.length === 0) return new Map()

  const nearest = Math.min(...measured.map(item => item.meters))
  return new Map(measured.map(item => [stationIdentity(item.station), {
    text: `离${reference.from}直线 ${distanceText(item.meters)}`,
    nearest: item.meters === nearest,
  }]))
}

/** 一个锚点作为参考点；三种不可知各说各的事实，绝不互相冒充。 */
function anchorReference(anchors: ReadValue<StoredAnchors>, anchor: AnchorId): StationReference {
  const name = anchor === 'home' ? '家' : '公司'
  if (anchors.state === 'reading') {
    return { state: 'unknown', sentence: readingText(`${name}的位置`) }
  }
  if (anchors.state === 'unreadable') {
    return { state: 'unknown', sentence: unreadText(`${name}的位置`, '算不出直线距离') }
  }
  const point = anchorPoint(anchors.value, anchor)
  if (!point) return { state: 'unknown', sentence: `未设置${name}的位置，算不出直线距离` }
  return { state: 'known', from: name, lat: point.lat, lng: point.lng }
}

/**
 * 相邻段已经选好的那一站作为参考点。
 *
 * 四种不可知各说各的，因为它们是四个不同的事实：那一站还没选（用户还没走到那一步）、
 * 那一站的列表还没读到（无从核对）、找到的那一对里没有这一站（列表被上游重编号过）、
 * 以及那一站没有坐标（上游没给它位置）。四种都不标数字，也都不拿别的点顶替。
 */
function neighbouringReference(
  leg: ChainLegDraft,
  index: number,
  which: 'board' | 'alight',
  lines: ChainLineOption[],
): StationReference {
  const from = `${legPositionText(index)}${which === 'board' ? '上车站' : '下车站'}`
  const name = which === 'board' ? leg.boardStationName : leg.alightStationName
  const order = which === 'board' ? leg.boardStationOrder : leg.alightStationOrder
  if (name === null || order === null) {
    return { state: 'unknown', sentence: `${from}还没选，算不出直线距离` }
  }

  const option = optionOfLeg(leg, lines)
  if (!option || option.stops !== 'ready') {
    return { state: 'unknown', sentence: `${from}的站点列表还没读到，算不出直线距离` }
  }

  const station = option.stations.find(item => item.name === name && item.order === order)
  if (!station) {
    return { state: 'unknown', sentence: `${from}「${name}」不在这个方向的站序里，算不出直线距离` }
  }

  const lat = statedCoordinate(station.lat)
  const lng = statedCoordinate(station.lng)
  if (lat === undefined || lng === undefined) {
    return { state: 'unknown', sentence: `${from}「${name}」没有坐标，算不出直线距离` }
  }
  return { state: 'known', from, lat, lng }
}

/**
 * 一条链路各段的参考点：每段的上车站与下车站各自量到哪个点。
 *
 * 一段的哪一端是链路的起点、哪一端是终点由**位置**决定（第 1 段 / 末段），故单段链路的上车站
 * 量起点锚点、下车站量目的锚点；多段时余下的各端量到相邻段的那一站。参考点之间的先后因此与
 * 段的位置一致，而不是每个选择器各有一个固定答案。
 */
export function legReferencesOf(
  draft: ChainDraft,
  lines: ChainLineOption[],
  anchors: ReadValue<StoredAnchors>,
): StationReferences[] {
  const start = anchorForPurpose(draft.purpose)
  const end: AnchorId = start === 'home' ? 'work' : 'home'
  const lastIndex = draft.legs.length - 1

  return draft.legs.map((_, index) => ({
    board: index === 0
      ? anchorReference(anchors, start)
      : neighbouringReference(draft.legs[index - 1]!, index - 1, 'alight', lines),
    alight: index === lastIndex
      ? anchorReference(anchors, end)
      : neighbouringReference(draft.legs[index + 1]!, index + 1, 'board', lines),
  }))
}
