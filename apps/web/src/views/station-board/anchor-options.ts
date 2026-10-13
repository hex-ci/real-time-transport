import {
  effectiveCommuteDirection,
  placeBoardStop,
  resolveBoardStopRef,
  resolveFollowedStopRef,
  type LineDetail,
  type UserFavoriteLine,
} from '@real-time-transport/shared'
import { statedCoordinate } from '@real-time-transport/shared/geo'
import type { AnchorRole, StationOption } from './station-options'

/**
 * 「我钉过的站台」从关注线路里解析出来：上班上车点、下班上车点，以及两个方向各一个关注站（F1）。
 *
 * 定位规则**一条都不新写**，直接复用 F1 那两条身份与安放规则：
 *  - 身份是 (站名, 站序) 一**对**（`resolveBoardStopRef` / `resolveFollowedStopRef`）；
 *  - 安放由 `placeBoardStop` 判：站名被改过成 `stale`、只留站名而同名多站成 `ambiguous`、
 *    本方向不停靠成 `absent` —— 这些都**跳过**，绝不谎报（宁可少一个站，也不给一个错的）。
 *
 * 于是这一页与首页卡片读的是同一份判断：同一个站名在两处不会解析成两个不同的实体。
 */

/** 一条关注线路，以及它两个方向的站表（没读到的那一侧为 null）。 */
export interface FavoriteDetails {
  favorite: UserFavoriteLine
  details: { 0: LineDetail | null, 1: LineDetail | null }
}

/** 解析出来的钉过的站台：就是一条选项，外加它的身份。 */
export interface AnchorOption extends StationOption {
  anchor: AnchorRole
}

/** 在某个方向的站表里把已安放的那一站取出来（要它的站 id 与坐标）。 */
function stopEntryOf(
  detail: LineDetail | null | undefined,
  placed: { name: string, order: number },
): { id: string, lat: number | null, lng: number | null } | null {
  const stop = detail?.stops.find(s => s.name === placed.name && s.order === placed.order)
  if (!stop?.id) return null
  return {
    id: stop.id,
    lat: statedCoordinate(stop.lat) ?? null,
    lng: statedCoordinate(stop.lng) ?? null,
  }
}

/** 由一对登机身份解析出选项；定位不到（站名改过 / 同名多站 / 本方向不停）时为 null。 */
function anchorOf(
  entry: { name: string, order: number | null } | null,
  detail: LineDetail | null | undefined,
  role: AnchorRole,
): AnchorOption | null {
  const placement = placeBoardStop(detail?.stops, entry)
  if (placement.state !== 'placed') return null
  const found = stopEntryOf(detail, placement)
  if (!found) return null
  return {
    name: placement.name,
    stationId: found.id,
    lat: found.lat,
    lng: found.lng,
    distanceMeters: null,
    origin: 'followed',
    anchor: role,
  }
}

/**
 * 全部钉过的站台，按「上班上车点 → 下班上车点 → 关注站」的顺序。
 *
 * 同一个站名只留一条（先遇到的角色胜出）：一个站既是上班上车点又是关注站时，说的是同一趟车
 * 的同一件事，两行会让人以为它们去的是两个地方。
 */
export function anchorStationsOf(entries: FavoriteDetails[]): AnchorOption[] {
  const found = new Map<string, AnchorOption>()

  function add(option: AnchorOption | null): void {
    if (!option || found.has(option.name)) return
    found.set(option.name, option)
  }

  for (const { favorite, details } of entries) {
    // 通勤上车点：方向是用户为这一段存下的那个（`effectiveCommuteDirection`，单向线路为它唯一的方向）。
    for (const purpose of ['morning', 'evening'] as const) {
      const direction = effectiveCommuteDirection(favorite, purpose)
      if (direction === null) continue
      add(anchorOf(resolveBoardStopRef(favorite, purpose), details[direction], purpose))
    }
    // 关注站：时间无关，两个方向各一个。
    for (const direction of [0, 1] as const) {
      add(anchorOf(resolveFollowedStopRef(favorite, direction), details[direction], 'followed'))
    }
  }

  return [...found.values()]
}
