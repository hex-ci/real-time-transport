/**
 * Shared geodesic helpers. Pure functions, no I/O — safe for both the Node
 * providers and the browser client.
 */

const EARTH_RADIUS_M = 6371000

/** Great-circle distance between two WGS-84 points, in meters. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLng = (lng2 - lng1) * rad
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Cumulative distance (meters) from the first point to each point of a
 * polyline given as [lat, lng] pairs. Result starts at 0.
 */
export function cumulativeDistances(points: Array<[number, number]>): number[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    cum.push(cum[i - 1]! + haversineMeters(a[0], a[1], b[0], b[1]))
  }
  return cum
}

/** Total length of a polyline given as [lat, lng] pairs, in meters. */
export function polylineLengthMeters(points: Array<[number, number]>): number {
  const cum = cumulativeDistances(points)
  return cum[cum.length - 1] ?? 0
}

/**
 * Locate a distance-from-start (meters) on a route described by per-station
 * cumulative distances, returning the SCREEN-SPACE segment primitive:
 *   - index: 0-indexed station the vehicle is LEAVING (clamped to [0, n-2])
 *   - progress: 0..1 along the segment toward station index+1
 *
 * Feed straight into getInterpolatedPosition(index + 1, progress), which treats
 * its first argument as the 1-indexed leaving station. At/past the terminal the
 * result is { index: n-2, progress: 1 } so the vehicle rests on the last stop.
 */
export function distanceToSegment(
  distanceFromStart: number,
  stationDistances: number[],
): { index: number, progress: number } | null {
  const n = stationDistances.length
  if (n < 2) return null
  const total = stationDistances[n - 1]!
  if (!(total > 0)) return null

  const d = Math.max(0, Math.min(distanceFromStart, total))
  // Last station whose cumulative distance <= d
  let i = 0
  for (let k = 0; k < n; k++) {
    if (stationDistances[k]! <= d) i = k
    else break
  }
  // Clamp the leaving index into a real segment [i, i+1]
  if (i > n - 2) i = n - 2
  const segStart = stationDistances[i]!
  const segEnd = stationDistances[i + 1]!
  const segLen = segEnd - segStart
  const progress = segLen > 0 ? (d - segStart) / segLen : 1
  return { index: i, progress: Math.max(0, Math.min(progress, 1)) }
}

/**
 * Cumulative distance (meters) for a vehicle given its `order` and `progress`.
 *
 * Convention: `order` is the 1-indexed station the vehicle is AT / has just
 * left (matches LiveBusSchema "last passed / is serving"); the vehicle travels
 * from station order-1 toward station order (0-indexed order-1 -> order).
 * Returns null for degenerate geometry.
 */
export function stationProgressToDistance(
  order: number,
  progress: number,
  stationDistances: number[],
): number | null {
  const n = stationDistances.length
  if (n < 2) return null
  const total = stationDistances[n - 1]!
  if (!(total > 0)) return null

  // leaving station 0-indexed = order-1, clamped to a real segment start
  const fromIdx = Math.max(0, Math.min(order - 1, n - 2))
  const segStart = stationDistances[fromIdx]!
  const segEnd = stationDistances[fromIdx + 1]!
  const p = Math.max(0, Math.min(progress, 1))
  return segStart + (segEnd - segStart) * p
}
