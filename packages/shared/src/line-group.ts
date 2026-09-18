import type { LineSummary } from './schemas/api.js'

/** One direction of a route, as resolved for a search hit. */
export interface RouteDirectionEntry {
  direction: 0 | 1
  lineId: string
  startStop: string
  endStop: string
}

/**
 * A single search result representing ONE route with both directions bundled.
 *
 * Users follow a route, not a direction — they want both ways and switch
 * direction on the home screen. Bus routes are two distinct upstream lineIds
 * (chelaile issues one per direction), while subway routes reuse one lineId
 * with a direction parameter, so each direction carries its own lineId here.
 */
export interface LineGroup {
  /** Stable identity for the route: the first lineId seen for it. */
  groupKey: string
  lineName: string
  cityCode: string
  /** Direction 0 entry, only when the upstream actually returned it. */
  up: RouteDirectionEntry | null
  /** Direction 1 entry, only when the upstream actually returned it. */
  down: RouteDirectionEntry | null
}

function toEntry(s: LineSummary): RouteDirectionEntry {
  return {
    direction: s.direction === 1 ? 1 : 0,
    lineId: s.lineId,
    startStop: s.startStop,
    endStop: s.endStop,
  }
}

/**
 * Merge flat per-direction search hits into one result per route.
 *
 * Grouping rule: entries sharing a lineName within the same city are one route.
 * This is what makes "913 上行" and "913 下行" (two different chelaile lineIds)
 * collapse into a single search result, and keeps subway's two same-lineId
 * directions together as well.
 *
 * Directions are only populated from real upstream hits — never synthesized.
 * A route that only reported one direction keeps the other as null, and the UI
 * hides switching for it rather than inventing a lineId that cannot resolve.
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
 * Resolve the concrete (lineId, direction) pair to load for a route.
 *
 * Returns null when the requested direction was never reported by the upstream
 * — callers must not fall back to the opposite direction, since for bus routes
 * that would silently show the other way's vehicles under the wrong heading.
 */
export function resolveRouteTarget(
  group: Pick<LineGroup, 'up' | 'down'>,
  direction: 0 | 1,
): RouteDirectionEntry | null {
  return direction === 0 ? group.up : group.down
}

/** True when both directions are available for switching in the UI. */
export function isBidirectional(group: Pick<LineGroup, 'up' | 'down'>): boolean {
  return group.up !== null && group.down !== null
}

/**
 * Resolve the concrete upstream lineId for a favourited route in a given
 * direction.
 *
 * A favourite stores `lineId` plus the direction it belongs to
 * (`preferredDirection`), and `reverseLineId` for the opposite direction. Bus
 * routes need this because chelaile issues a distinct lineId per direction;
 * subway routes store the same id twice (or omit the reverse id) because one
 * lineId serves both.
 *
 * Returns null when that direction is not available — callers must NOT fall back
 * to the other direction, which would show the wrong way's vehicles.
 */
export function resolveFavoriteLineId(
  fav: { lineId: string, preferredDirection?: number, reverseLineId?: string },
  direction: 0 | 1,
): string | null {
  const primary = fav.preferredDirection === 1 ? 1 : 0
  if (direction === primary) return fav.lineId
  return fav.reverseLineId || null
}

/** True when this favourite can switch between both directions. */
export function favoriteIsBidirectional(fav: {
  lineId: string
  reverseLineId?: string
}): boolean {
  return Boolean(fav.reverseLineId)
}
