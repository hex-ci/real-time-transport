import type { LineDetail } from './schemas/transit.js'
import type { LineSummary } from './schemas/api.js'
import { haversineMeters } from './geo.js'

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

/**
 * Read the board stop for a commute purpose.
 *
 * Board stops are keyed by PURPOSE, not direction: `morningStopName` is where
 * the user boards for the AM commute and `eveningStopName` for the PM leg
 * (backed by pinned_station_name / reverse_pinned_station_name). Returns
 * undefined when that purpose has no stop set — callers must show an explicit
 * "not set" state rather than guessing a stop.
 */
export function resolveBoardStop(
  fav: {
    morningStopName?: string
    eveningStopName?: string
  },
  purpose: 'morning' | 'evening',
): string | undefined {
  return purpose === 'morning' ? fav.morningStopName : fav.eveningStopName
}

/**
 * Derive which direction serves each commute purpose for one route.
 *
 * Uses BOTH directions' stop lists (same stop carries a different order per
 * direction). Direction d is the morning direction iff the morning board stop
 * precedes the evening one in d's stop order; the two directions must reach
 * opposite verdicts, otherwise the route's geometry defeats the ordering
 * heuristic (loop lines, S-shaped routes) and null is returned — callers fall
 * back to preferredDirection instead of guessing.
 */
export function deriveCommuteDirections(
  fav: { morningStopName?: string, eveningStopName?: string },
  details: { 0: LineDetail, 1: LineDetail },
): { morning: 0 | 1, evening: 0 | 1 } | null {
  const morning = fav.morningStopName
  const evening = fav.eveningStopName
  // Exact-name matching only: a substring hit can hijack a later station
  // sharing a prefix (e.g. 东石东三路南口 vs 东石东三路).
  if (!morning || !evening) return null
  if (morning === evening) return null

  const orderOf = (d: LineDetail, name: string): number | undefined =>
    d.stops.find(s => s.name === name)?.order

  const m0 = orderOf(details[0], morning)
  const e0 = orderOf(details[0], evening)
  const m1 = orderOf(details[1], morning)
  const e1 = orderOf(details[1], evening)
  if (m0 === undefined || e0 === undefined || m1 === undefined || e1 === undefined) return null

  // dir0 verdict: morning-before-evening in dir0's own stop order...
  const dir0IsMorning = m0 < e0
  // ...dir1 must agree the other way (same physical order, reversed sequence).
  const dir1IsMorning = m1 > e1
  if (dir0IsMorning !== dir1IsMorning) return null

  return dir0IsMorning ? { morning: 0, evening: 1 } : { morning: 1, evening: 0 }
}

/** Which commute purpose (if any) a concrete direction serves on this route. */
export function purposeOfDirection(
  derived: { morning: 0 | 1, evening: 0 | 1 } | null,
  direction: 0 | 1,
): 'morning' | 'evening' | null {
  if (!derived) return null
  return derived.morning === direction ? 'morning' : 'evening'
}

/**
 * Which commute leg ONE direction serves, judged from that direction's own stop
 * order alone: if the morning board stop comes before the evening one, travelling
 * that way takes the user to work.
 *
 * The home view derives both directions together so the two verdicts can
 * cross-check each other; a view that only ever holds one direction (the route
 * detail) can still label it with this. Returns null when either stop is unset,
 * they are the same stop, or a name is absent from this direction's stop list —
 * all cases where the label would be a guess.
 */
export function purposeFromDirection(
  fav: { morningStopName?: string, eveningStopName?: string },
  detail: { stops: Array<{ name: string, order: number }> } | null | undefined,
): 'morning' | 'evening' | null {
  const morning = fav.morningStopName
  const evening = fav.eveningStopName
  if (!morning || !evening || morning === evening || !detail) return null
  const m = detail.stops.find(s => s.name === morning)?.order
  const e = detail.stops.find(s => s.name === evening)?.order
  if (m === undefined || e === undefined) return null
  return m < e ? 'morning' : 'evening'
}

/**
 * GPS-nearest stop WITHIN one line's own stop list.
 *
 * The candidate set is strictly this line's stops — never an external POI
 * radar, whose nearest platform is routinely a different route's stop. Returns
 * null when the fix is missing or no stop carries coordinates; callers must
 * not default to the first stop, which would present an arbitrary stop as
 * "nearest".
 */
export function nearestStopOnLine(
  stops: Array<{ name: string, order: number, lat?: number, lng?: number }>,
  coords: { lat: number, lng: number } | null,
): { name: string, order: number, distanceMeters: number } | null {
  if (!coords || stops.length === 0) return null
  let best: { name: string, order: number, distanceMeters: number } | null = null
  for (const s of stops) {
    if (!s.lat || !s.lng) continue
    const d = haversineMeters(coords.lat, coords.lng, s.lat, s.lng)
    if (best === null || d < best.distanceMeters) {
      best = { name: s.name, order: s.order, distanceMeters: d }
    }
  }
  return best
}

/**
 * Locate the platform the user is standing at, then resolve it per direction.
 *
 * A bus route's two directions call at the SAME named stop but on opposite
 * sides of the road: the upstream gives each direction its own coordinates and
 * its own order, and the two stop lists need not even share every name. So
 * neither "one nearest stop for the whole line" (its order is meaningless in
 * the other direction — the server matches by order first and would silently
 * return a different station's arrivals) nor "one nearest stop per direction"
 * (the two rows would name different platforms, and the farther one is not
 * where the user is) is right.
 *
 * The model that matches reality: pick the nearest stop NAME, then let each
 * direction contribute its own order for that name. A direction without that
 * name genuinely has no platform here, and reports null rather than borrowing
 * the other direction's timings.
 */
export function resolveNearbyStop(
  stopsByDirection: {
    0?: Array<{ name: string, order: number, lat?: number, lng?: number }>
    1?: Array<{ name: string, order: number, lat?: number, lng?: number }>
  },
  coords: { lat: number, lng: number } | null,
): {
  name: string
  distanceMeters: number
  perDirection: { 0: { order: number } | null, 1: { order: number } | null }
} | null {
  if (!coords) return null

  // Nearest name across both directions: a name may exist in either list, and
  // the two lists are not guaranteed to match. Names present in both still
  // carry nearly the same coordinates (~tens of metres apart), so whichever
  // entry we measure the distance from picks the same platform.
  const candidate = nearestStopOnLine(
    ([] as Array<{ name: string, order: number, lat?: number, lng?: number }>)
      .concat(stopsByDirection[0] ?? [], stopsByDirection[1] ?? []),
    coords,
  )
  if (!candidate) return null

  const orderIn = (
    stops: Array<{ name: string, order: number }> | undefined,
  ): { order: number } | null => {
    // Exact name match only: a substring hit can bind to a later station that
    // merely shares a prefix (东石东三路南口 vs 东石东三路).
    const hit = stops?.find(s => s.name === candidate.name)
    return hit ? { order: hit.order } : null
  }

  return {
    name: candidate.name,
    distanceMeters: Math.round(candidate.distanceMeters),
    perDirection: { 0: orderIn(stopsByDirection[0]), 1: orderIn(stopsByDirection[1]) },
  }
}
