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

/**
 * A number the payload stated, or `undefined` when it stated none.
 *
 * THE RULE FOR A STATED NUMBER lives here, written once so that the reads which
 * price a value by it read ONE rule rather than several copies that can drift.
 * It accepts what a JSON payload can spell a number as — a number, or a string
 * holding one — and answers `undefined` for everything else: a field the payload
 * left out, an empty or whitespace-only string, a non-numeric one, a non-finite
 * number, `false`, and every other non-number.
 *
 * A `0` is NOT absence here: it is a number the payload stated, and for both
 * fields read below a stated zero is a legal measurement (two coincident points
 * are a 0-metre walk; a POI on the measured point is genuinely 0 m away). 「No
 * value」 therefore needs an encoding of its own, and `undefined` is it — which is
 * why this is not `value || 0`, the expression that turns absence into a
 * real-looking zero.
 *
 * WHICH READS APPLY IT:
 *
 *  - Amap's walking-route price, on both axes (`distanceMeters` /
 *    `durationSeconds` of a priced leg): a path stating one axis and not the
 *    other states no price this app can use;
 *  - Amap's nearby POI radar, per POI: the distance to the platform the landmark
 *    hint prints, absent for a POI the radar did not measure.
 *
 * WHICH READS DELIBERATELY DO NOT — the fields where a zero means the opposite
 * thing, so that this rule must never be applied to them:
 *
 *  - any COORDINATE: a zero on either axis is a position nobody stated, not a
 *    position whose value is zero. Those reads go through `statedCoordinate`,
 *    which is this function plus the zero-is-absence rule;
 *  - any stop ORDINAL: `0` is not an order a line's stop list contains, and the
 *    reader is `statedStopOrder`, which falls back to the stop's list position;
 *  - the user's own point — the stored anchor and the device fix. It is not
 *    upstream station data, and its absence already has an encoding of its own (a
 *    NULL column on the settings row, an infinite seed from `watchPosition`
 *    before the first fix), so reading a zero there as 未设置 would invent a
 *    second spelling of absence for a row the user never cleared.
 */
export function statedNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * A coordinate the payload stated that sits on this app's datum, or `undefined`
 * when it stated none.
 *
 * THE RULE FOR A POSITION lives here, stated once so that the reads that apply
 * it apply ONE rule rather than several copies of one that can drift: a zero on
 * EITHER axis is no position at all. Everything this app places is GCJ-02, and
 * no placed stop on that datum sits at 0 on either axis — a latitude of 0 is the
 * equator, a longitude of 0 the Greenwich meridian, and the nearest stop to
 * either is thousands of kilometres away. A zero is therefore the ABSENCE of a
 * coordinate rather than a coordinate whose value is zero: it is what a row
 * carries for a stop nobody placed, and reading it as a position prices a
 * walking route to a point in the Atlantic and makes an unplaced platform look
 * located enough to conclude from.
 *
 * WHICH READS APPLY IT — every coordinate this app reads out of UPSTREAM data:
 *
 *  - chelaile's line detail and its live vehicles (`getLiveStatus`, which applies
 *    the same rule in place rather than through this helper);
 *  - chelaile's jxPath road trajectory, vertex by vertex: the arc-length of a
 *    road through a point nobody placed is not this line's road;
 *  - Amap's static stop list and its nearby POI radar;
 *  - the subway engine's stop list (`stopPositions`) and each train's position,
 *    which is the position of the stop that train is at;
 *  - `nearestStopOnLine`'s stop list, likewise in place, so a stop nobody placed
 *    can never be the nearest thing to the user;
 *  - the server's read of a STORED station (`stationPoint`) — the same upstream
 *    datum written down, so a stored row reads no differently from a freshly
 *    parsed payload.
 *
 * WHICH READS DELIBERATELY DO NOT — the user's OWN point, on every path it
 * travels: `storedCoord`'s read of the settings row and the two anchor reads fed
 * by it (`anchorPoint`, and `departureReference`'s walk origin), plus the device
 * fix a caller compares stops against (`nearestStopOnLine`'s `coords`). This is
 * the user/device datum against upstream station data: an anchor is the fix the
 * user's own device reported, saved from the settings screen and brought into
 * this datum once at the HTTP boundary — not a row that upstream left blank. And
 * its absence already has an encoding of its own: a NULL column, which the read
 * reports as unset and the deduction answers as `anchor-unset`. A zero there is
 * therefore not the sentinel it is in upstream data, and reading it as 未设置
 * would invent a second spelling of absence for a row the user never cleared.
 *
 * An absent field must stay absent rather than become a number, and the two are
 * ONE answer here — a payload that stated no coordinate and a payload that stated
 * a zero both yield `undefined`. The rule covers every spelling a payload can use
 * (a number, or a string holding one); a malformed, empty or non-finite value is
 * the same absence.
 */
export function statedCoordinate(value: unknown): number | undefined {
  const stated = statedNumber(value)
  return stated === undefined || stated === 0 ? undefined : stated
}

/**
 * A stop's ordinal along its line, as the payload states it or as the stop's own
 * position in the list.
 *
 * The list IS the sequence by construction — every provider here reads its stops
 * in stop order — so a stop's position in it is its real position and not a
 * substitute for one. The payload's own numbering is preferred when it is a
 * positive whole number, because upstream's numbering is the authority when it
 * exists; anything else (a missing field, a non-numeric one, 0) would otherwise
 * travel as NaN or 0 and name an order no stop of the line occupies, which is
 * what a caller locating a station BY order reads.
 */
export function statedStopOrder(value: unknown, position: number): number {
  const stated = statedNumber(value)
  return stated !== undefined && Number.isInteger(stated) && stated > 0 ? stated : position
}
