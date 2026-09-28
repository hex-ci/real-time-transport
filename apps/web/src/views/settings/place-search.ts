/**
 * 地点搜索的读侧：一次搜索请求的三个结局，以及结果行上印什么。
 *
 * 抽成模块（而不是写在页面里）是因为它正是「读不到」与「确实没有」必须分开的那一处 ——
 * 与 `read-state.ts` 同一条规则，只是这里的空数组来自上游的地点搜索：
 *
 *  - `reading`     请求在路上；
 *  - `unreadable`  上游没答上来（400/502/网络）。**绝不能**说成「没有这个地方」；
 *  - `read`        答了，`results` 就是它给的候选（可以是空数组 = 确实没有匹配）。
 *
 * 页面据此说三句不同的话，而这三种状态各有自己的断言。
 */
import type { PlaceSuggestion } from '@real-time-transport/shared'

/** 一次地点搜索的结局。 */
export type PlaceSearchState
  = | { state: 'reading' }
    | { state: 'unreadable' }
    | { state: 'read', results: PlaceSuggestion[] }

/**
 * 一条候选在结果行上的两行文本。
 *
 * 主行是地点名；次行是「区 + 地址」—— 重名靠它分辨。两者都可能缺：
 * 高德对有些候选不给区或地址，那时**只显示拿到的部分**，绝不编造地址（PRD F2）。
 * 都没有时次行是 `null`，行上就只有名字。
 */
export function suggestionLines(place: PlaceSuggestion): { title: string, subtitle: string | null } {
  const parts = [place.district, place.address].filter((part): part is string => Boolean(part))
  return { title: place.name, subtitle: parts.length > 0 ? parts.join(' ') : null }
}

/** 结果行的身份：名字 + 坐标。同名候选靠坐标区分，选中状态据此稳定。 */
export function suggestionKey(place: PlaceSuggestion): string {
  return `${place.name}@${place.lng.toFixed(6)},${place.lat.toFixed(6)}`
}

/** 空态那句：说清在哪个城市、搜的什么词，不解释成「没有这个地方」。 */
export function placeSearchEmptyText(cityName: string, keyword: string): string {
  return `在 ${cityName} 未找到匹配「${keyword}」的位置`
}
