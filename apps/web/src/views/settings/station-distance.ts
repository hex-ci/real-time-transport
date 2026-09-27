/**
 * 站点选择器里每个站到参考点的直线距离，以及最近那个的标记。
 *
 * 参考点由链路目的与段的位置决定：第 1 段的上车站量起点锚点（上班从家、下班从公司），
 * 末段的下车站量另一端锚点，其余各端量到相邻段的那一站。参考点不可知时不标任何数字，
 * 由各句如实说出是哪一种不可知 —— 猜一个点顶上去就是替使用者作主张。
 *
 * 距离是 haversine 量出的大圆距离（措辞里带「直线」）：它不等于步行或乘车路线的长度，
 * 把大圆距离印成路线距离是另一种谎话。
 *
 * 顺序一律不动：选择器列出的先后就是线路站序，而站序是「公交只能顺行」的凭据（下车站序
 * 必须大于上车站序）。按距离重排会让人把上车站挑到下车站之后，保存时才被拒 ——
 * 故这里只标注，不排序、不筛选、不因远而隐去任何一个站。
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

/** 一个站在选择器里的身份：站序与站名两者 —— 线上同名站不止一个，站名单独作身份不够。 */
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
 * 列表里每个站的标注，按站自己的身份。参考点不可知时为空表：一个数字都不标。
 * 「最近」取整份列表的最小值，与筛选无关；没有一个站量得出距离时同样没有最近可言。
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
 * 相邻段已选好的那一站作为参考点。四种不可知各说各的（还没选 / 列表还没读到 /
 * 那一对里没有这一站 / 那一站没有坐标），都不标数字，也都不拿别的点顶替。
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
 * 各段的上下车站各自量到哪个点：第 1 段的上车站量起点锚点、末段的下车站量另一端锚点，
 * 其余各端量到相邻段的那一站 —— 哪一端是起点由段的位置决定，不是每个选择器有固定答案。
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
