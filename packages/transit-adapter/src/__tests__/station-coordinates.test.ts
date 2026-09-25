import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineDetail } from '@real-time-transport/shared'
import { AmapGisService, ChelaileProvider, UniversalSubwayEngine } from '../index.js'

/**
 * A stop is placed only where the payload placed it.
 *
 * Each provider reads a stop's coordinates out of a payload, and a payload that
 * omits the field states no position — it does not state (0, 0), which is a real
 * point in the Atlantic and, once written, is indistinguishable from one the
 * upstream really sent. A zero on EITHER axis is that same absence rather than a
 * position, because no placed stop on this app's GCJ-02 datum sits at 0 — the
 * rule lives in `statedCoordinate`, and every read below applies it. This file
 * pins the reads that turn a stated absence into one: chelaile's encrypted line
 * detail and the jxPath road trajectory on it, Amap's static stop list, Amap's
 * nearby radar, and the subway engine's derived geometry and train positions. A
 * stop — and a road vertex — the payload marks with a zero reads as unplaced on
 * every one of them.
 *
 * The payload's own stop numbering, when it states one, is the authority a
 * stored leg is located BY; a stop's position in the list is the fallback for a
 * field the payload did not state.
 *
 * 甲路 / 乙路 / 丙路 are placeholders: no real route, station or upstream id
 * appears here, and no upstream is reachable — every read is a stub.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * Freeze the clock at a Beijing wall-clock time.
 *
 * The subway engine reads ITS time of day to place trains, so a test about where
 * a train is must fix the moment it is asked about: the same line answers
 * 「nothing in flight」 at 02:00 and a train in every segment at 08:00.
 */
function freezeAtBeijing(hhmm: string): void {
  const [hh, mm] = hhmm.split(':').map(Number)
  vi.useFakeTimers({ toFake: ['Date'] })
  // 00:00 UTC is 08:00 Beijing: the engine shifts by +8 h internally.
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, (hh ?? 0) - 8, mm ?? 0)))
}

/** An Amap v3 success envelope around one `buslines` entry. */
function stubAmapBusline(stops: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('/v3/bus/linename')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        buslines: [{
          id: 'L1',
          name: '1路',
          type: '地铁线路',
          start_stop: '甲路',
          end_stop: '丙路',
          busstops: stops,
        }],
      }),
    }
  }))
}

/** An Amap v3 success envelope around a POI radar answer. */
function stubAmapPois(pois: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('/v3/place/around')) throw new Error(`unexpected upstream call: ${href}`)
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', pois }) }
  }))
}

/** A chelaile line-detail answer, spelled the way the provider reads it. */
function stubChelaileLine(stations: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonr: {
          data: {
            line: { name: '1路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
            stations,
            // No jxPath: this line's road geometry is not what these tests read.
          },
        },
      }),
    }
  }))
}

describe('a stop is placed only where the payload placed it', () => {
  it('keeps a chelaile stop the payload left unplaced unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 2 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // The stop the payload placed is placed, unchanged.
    expect(detail?.stops[0]).toMatchObject({ name: '甲路', order: 1, lat: 39.9, lng: 116.4 })
    // The stop it left unplaced carries NO coordinate — and a zero on either
    // axis is that same absence, not a position (see `statedCoordinate`).
    expect(detail?.stops[1]?.lat).toBeUndefined()
    expect(detail?.stops[1]?.lng).toBeUndefined()
    // The stop itself is still answered: only its position is absent.
    expect(detail?.stops[1]).toMatchObject({ name: '乙路', order: 2 })
  })

  it('numbers a chelaile stop by its own position when the payload states no usable order', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 'x', lat: 39.91, lng: 116.41 },
      { sId: 's3', sn: '丙路', lat: 39.92, lng: 116.42 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // `order` is what a stored leg is located BY, so a field the payload did not
    // spell as a positive whole number is answered from the stop's own position
    // in the list — which IS the sequence by construction — rather than as NaN.
    expect(detail?.stops.map(s => [s.name, s.order])).toEqual([['甲路', 1], ['乙路', 2], ['丙路', 3]])
  })

  it('takes the payload\'s own numbering when it diverges from the position in the list', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 5, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 7, lat: 39.91, lng: 116.41 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // The payload's numbering is the authority when it states one — a stored leg
    // is located BY order, and this platform is the payload's stop 7 even though
    // it is the second element. Falling back to the list position here would name
    // a stop no list of the line contains.
    expect(detail?.stops.map(s => [s.name, s.order])).toEqual([['甲路', 5], ['乙路', 7]])
  })

  it('keeps a chelaile stop the payload marks with a zero unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 0, lng: 0 },
      { sId: 's2', sn: '乙路', order: 2, lat: 39.9, lng: 116.4 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // No placed stop on this app's GCJ-02 datum sits at 0, so a zero is the
    // absence written as a number and reads as the absence, not as a position
    // 19 000 km away.
    expect(detail?.stops[0]?.lat).toBeUndefined()
    expect(detail?.stops[0]?.lng).toBeUndefined()
    expect(detail?.stops[1]).toMatchObject({ lat: 39.9, lng: 116.4 })
  })

  it('keeps a chelaile stop whose coordinate is not a number unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: null, lng: '' },
      { sId: 's2', sn: '乙路', order: 2, lat: '39.9', lng: '116.4' },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // A field the payload carried but did not spell as a number states no
    // position; a numeric string is a number the payload stated.
    expect(detail?.stops[0]?.lat).toBeUndefined()
    expect(detail?.stops[0]?.lng).toBeUndefined()
    expect(detail?.stops[1]).toMatchObject({ lat: 39.9, lng: 116.4 })
  })

  it('keeps an Amap stop whose payload states no location unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 2 },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    expect(line?.stations[0]).toMatchObject({ name: '甲路', order: 1, lat: 39.9, lng: 116.4 })
    // Amap omits `location` for a stop it could not place. Absent stays absent.
    expect(line?.stations[1]?.lat).toBeUndefined()
    expect(line?.stations[1]?.lng).toBeUndefined()
    expect(line?.stations[1]).toMatchObject({ name: '乙路', order: 2 })
  })

  it('keeps an Amap stop whose location is not a pair unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000' },
      { id: 's2', name: '乙路', sequence: 2, location: 'abc,def' },
      { id: 's3', name: '丙路', sequence: 3, location: '116.5,' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // Half a pair, a non-numeric half and an empty half are all 「no position」:
    // none of them becomes a zero.
    for (const stop of line?.stations ?? []) {
      expect(stop.lat, stop.name).toBeUndefined()
      expect(stop.lng, stop.name).toBeUndefined()
    }
  })

  it('reads a location Amap states as a two-element array', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: [116.4, 39.9] },
      { id: 's2', name: '乙路', sequence: 2, location: [116.41] },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // The array spells the same pair as the string, so it is read the same way —
    // and an array with only a longitude is half a pair, like any other.
    expect(line?.stations[0]).toMatchObject({ lat: 39.9, lng: 116.4 })
    expect(line?.stations[1]?.lat).toBeUndefined()
    expect(line?.stations[1]?.lng).toBeUndefined()
  })

  it('keeps an Amap stop the payload marks with a zero on either half unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '0,0' },
      { id: 's2', name: '乙路', sequence: 2, location: '0,39.9' },
      { id: 's3', name: '丙路', sequence: 3, location: '116.4,0' },
      { id: 's4', name: '丁路', sequence: 4, location: '116.400000,39.900000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // A zero is not a position on this app's GCJ-02 datum, so a pair carrying one
    // half at 0 is the absence of a coordinate rather than the point on the
    // Greenwich meridian or the equator it would otherwise be read as.
    for (const stop of line?.stations.slice(0, 3) ?? []) {
      expect(stop.lat, stop.name).toBeUndefined()
      expect(stop.lng, stop.name).toBeUndefined()
    }
    expect(line?.stations[3]).toMatchObject({ name: '丁路', lat: 39.9, lng: 116.4 })
  })

  it('keeps an Amap POI the radar could not place unplaced', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000', distance: '120' },
      { name: '乙路(公交站)', type: '公交车站', distance: '300' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    expect(pois[0]).toMatchObject({ name: '甲路(公交站)', lat: 39.9, lng: 116.4, distanceMeters: 120 })
    expect(pois[1]?.lat).toBeUndefined()
    expect(pois[1]?.lng).toBeUndefined()
    // Still a station name at a stated distance, which is what this radar is for.
    expect(pois[1]).toMatchObject({ name: '乙路(公交站)', distanceMeters: 300 })
  })

  it('keeps an Amap POI the radar marks with a zero unplaced', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '0,0', distance: '120' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    // The radar is read for a name at a stated distance; a POI it positions at 0
    // is one it could not place, not one on the equator.
    expect(pois[0]?.lat).toBeUndefined()
    expect(pois[0]?.lng).toBeUndefined()
    expect(pois[0]).toMatchObject({ name: '甲路(公交站)', distanceMeters: 120 })
  })

  it('leaves a POI whose distance the radar never stated distance-less', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    // `Number(poi.distance || 0)` answers a real-looking `0` for a POI Amap did
    // not measure — a claim that the user is standing on the platform, rendered
    // as 「0m」 by the hint that reads it. Absence travels as absence.
    expect(pois[0]?.distanceMeters).toBeUndefined()
  })

  it('keeps a distance the radar states as 0', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000', distance: '0' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    // The other half of 「a stated number is a reading」: 0 metres is a legal
    // answer (the POI sits on the measured point), so the absence needs an
    // encoding of its own rather than a zero — one rule, read in `statedNumber`.
    expect(pois[0]?.distanceMeters).toBe(0)
  })

  it('numbers a stop by its own position when the payload states no usable sequence', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 'x', location: '116.410000,39.910000' },
      { id: 's3', name: '丙路', sequence: 0, location: '116.420000,39.920000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // `busstops` arrives in stop order, so a stop's position in it IS its real
    // position. A `sequence` that is not a positive whole number would otherwise
    // travel as NaN or 0 and name a stop no list contains.
    expect(line?.stations.map(s => [s.name, s.order])).toEqual([['甲路', 1], ['乙路', 2], ['丙路', 3]])
  })

  it('takes the payload\'s own sequence when it diverges from the position in the list', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 5, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 7, location: '116.410000,39.910000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // `sequence` is what the payload numbers its own list with, and it is what
    // travels: this platform is the payload's stop 7 even though it is the second
    // element of `busstops`. The list position answers only for a `sequence` the
    // payload did not state.
    expect(line?.stations.map(s => [s.name, s.order])).toEqual([['甲路', 5], ['乙路', 7]])
  })
})

/**
 * A two-stop line whose FIRST stop the upstream could not place. Every train the
 * model generates is in the one segment, so the position it reports is always
 * that stop's own.
 */
function lineWithUnplacedFirstStop(): LineDetail {
  return {
    lineId: 'subway_027_88',
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 乙路',
    // The window covers the engine's whole normalized day, so the answer below
    // does not depend on when the suite runs.
    firstBusTime: '01:00',
    lastBusTime: '30:00',
    cityCode: '027',
    type: 'subway',
    stops: [
      { id: 's1', name: '甲路', order: 1, interchanges: [] },
      { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
    ],
  }
}

describe('a subway line whose stop list has an unplaced stop states no geometry', () => {
  it('leaves the cumulative profile and the route length unstated', async () => {
    // Frozen inside a peak window, where the headway (210 s) is shorter than the
    // trip (2 × 135 s) — so a train is always in flight and the assertions below
    // cannot pass by finding an empty fleet.
    freezeAtBeijing('08:00')
    // The profile is index-aligned with the stop list, so one unplaced stop
    // leaves the whole line's geometry unstateable: a distance measured through a
    // stand-in point would be a number about a track the line does not run on.
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => lineWithUnplacedFirstStop())
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    // A train the model could place somewhere is the case this pins: an empty
    // fleet would make the position assertions below vacuous.
    expect(live!.buses.length).toBeGreaterThan(0)
    // Every train's position is the unplaced stop's, so every train is unplaced —
    // and none of them sits at (0, 0).
    for (const bus of live!.buses) {
      expect(bus.lat).toBeUndefined()
      expect(bus.lng).toBeUndefined()
    }
    // The model still runs: order, progress and the timetable are unaffected by a
    // missing coordinate.
    for (const bus of live!.buses) {
      expect(typeof bus.order).toBe('number')
      expect(typeof bus.travelTimeSec).toBe('number')
      expect(bus.distanceFromStart).toBeUndefined()
    }
  })

  it('states geometry only when the payload placed every stop', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1 },
      { id: 's2', name: '乙路', sequence: 2, location: '116.410000,39.910000' },
    ])
    const unplaced = await new UniversalSubwayEngine(new AmapGisService('test-key'))
      .getLineDetail('subway_027_88', 0, '027')

    // The stop is answered and the geometry is not: one unplaced stop leaves the
    // whole index-aligned profile unstateable.
    expect(unplaced?.stops).toHaveLength(2)
    expect(unplaced?.stationDistances).toBeUndefined()
    expect(unplaced?.routeLengthMeters).toBeUndefined()

    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 2, location: '116.410000,39.910000' },
    ])
    const placed = await new UniversalSubwayEngine(new AmapGisService('test-key'))
      .getLineDetail('subway_027_88', 0, '027')

    expect(placed?.stationDistances).toHaveLength(2)
    expect(placed?.routeLengthMeters).toBeGreaterThan(0)
  })

  it('states no geometry for a stop the list marks with a zero', async () => {
    freezeAtBeijing('08:00')
    // A stored row may carry (0, 0) for a stop the upstream never placed. No
    // placed stop on this app's GCJ-02 datum sits at 0, so the row states no
    // position for it, and the index-aligned profile is unstateable for exactly
    // that reason.
    const zeroed: LineDetail = {
      ...lineWithUnplacedFirstStop(),
      stops: [
        { id: 's1', name: '甲路', order: 1, lat: 0, lng: 0, interchanges: [] },
        { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
      ],
    }
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => zeroed)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    // A train the model could place somewhere is the case this pins: an empty
    // fleet would make the assertions below vacuous.
    expect(live!.buses.length).toBeGreaterThan(0)
    // A train's position is its stop's own, so a stop the row marks at 0 leaves
    // the train with no position rather than one on the equator — and no
    // distance measured through a point the line does not run on.
    for (const bus of live!.buses) {
      expect(bus.lat).toBeUndefined()
      expect(bus.lng).toBeUndefined()
      expect(bus.distanceFromStart).toBeUndefined()
    }
  })
})

/**
 * A three-stop line, every stop placed, to read a train's position against.
 *
 * The window covers the engine's whole normalized day and the minute is frozen
 * inside a peak headway window, so the fleet and the segment each train occupies
 * do not depend on when the suite runs.
 */
function lineWithThreePlacedStops(): LineDetail {
  return {
    lineId: 'subway_027_88',
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 丙路',
    firstBusTime: '01:00',
    lastBusTime: '30:00',
    cityCode: '027',
    type: 'subway',
    stops: [
      { id: 's1', name: '甲路', order: 1, lat: 39.9, lng: 116.4, interchanges: [] },
      { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
      { id: 's3', name: '丙路', order: 3, lat: 39.92, lng: 116.42, interchanges: [] },
    ],
  }
}

/**
 * A placed train states a position; that is the half of the rule this pins.
 *
 * The engine answers a train that is AT a stop with that stop's own coordinate —
 * the same stop its `order` names — so an unplaced train can only ever be a train
 * at an unplaced stop (the case the geometry suite above pins). Without the case
 * below, an engine that never reported a position at all would still satisfy
 * every assertion in that suite: 「undefined for everything」 passes a test that
 * only ever asks for undefined.
 */
describe('a train states the position of the stop it is at', () => {
  it('carries the stop\'s own coordinate for every train the model places', async () => {
    freezeAtBeijing('08:00')
    const line = lineWithThreePlacedStops()
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => line)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(live!.buses.length).toBeGreaterThan(0)
    // Both segments of the line are occupied at this minute, so the loop below
    // reads a train at a stop other than 甲路 rather than one that happens to sit
    // at the origin.
    expect(new Set(live!.buses.map(b => b.order))).toEqual(new Set([1, 2]))
    for (const bus of live!.buses) {
      const stop = line.stops[bus.order! - 1]!
      expect(bus.lat, `train at order ${bus.order}`).toBe(stop.lat)
      expect(bus.lng, `train at order ${bus.order}`).toBe(stop.lng)
    }
  })

  it('carries a placed stop\'s coordinate even when another stop is unplaced', async () => {
    freezeAtBeijing('08:00')
    // The unplaced stop is the LAST one, so the trains above are still at placed
    // stops: one unplaced stop removes no position from another stop's train, and
    // it leaves the line's geometry unstateable for the reason `stopPositions`
    // states — the two answers are about different things.
    const line: LineDetail = {
      ...lineWithThreePlacedStops(),
      stops: [
        { id: 's1', name: '甲路', order: 1, lat: 39.9, lng: 116.4, interchanges: [] },
        { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
        { id: 's3', name: '丙路', order: 3, interchanges: [] },
      ],
    }
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => line)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(new Set(live!.buses.map(b => b.order))).toEqual(new Set([1, 2]))
    for (const bus of live!.buses) {
      const stop = line.stops[bus.order! - 1]!
      expect(bus.lat, `train at order ${bus.order}`).toBe(stop.lat)
      expect(bus.lng, `train at order ${bus.order}`).toBe(stop.lng)
    }
  })
})

/** The trajectory URL the stub detail advertises, and no other host is reachable. */
const JXPATH_URL = 'https://traj.example/road'

/**
 * A chelaile line detail carrying a jxPath trajectory, and the raw trajectory it
 * points at — both served by ONE stub, because both are reads of the same line.
 */
function stubChelaileTrajectory(tra: string): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('encryptedLineDetail')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonr: {
            data: {
              line: { name: '1路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
              stations: [
                { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
                { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
                { sId: 's3', sn: '丙路', order: 3, lat: 39.92, lng: 116.42 },
              ],
              jxPath: JXPATH_URL,
            },
          },
        }),
      }
    }
    if (href === JXPATH_URL) {
      // Answered as raw text, wrapped in the upstream's own delimiters.
      return {
        ok: true,
        status: 200,
        text: async () => `**YGKJ${JSON.stringify({ jsonr: { data: { tra } } })}YGKJ##`,
      }
    }
    throw new Error(`unexpected upstream call: ${href}`)
  }))
}

/**
 * A road polyline is placed only where its vertices are.
 *
 * `tra` spells its vertices `lng,lat[,tag]`, and their cumulative arc-length is
 * what locates every station on the road. ONE vertex the payload never placed is
 * therefore enough to make the stretch meaningless — an arc-length measured
 * through it is a distance along a road the line does not run on, and the tagged
 * station markers would be spread along that imaginary leg — so the geometry is
 * answered as unstateable and the caller keeps its even-spacing fallback, exactly
 * as it does when the trajectory cannot be fetched at all.
 *
 * The placed-everywhere case is the positive control: 「no geometry, ever」 is as
 * wrong as 「a zero is a position」, and the three unplaceable fixtures below pin
 * each axis and a missing half separately, because a rule applied to one half of
 * the pair would still leave the other half unread.
 */
describe('a road polyline is placed only where its vertices are', () => {
  it('states a geometry the trajectory placed on every vertex', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000,39.905000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.routeLengthMeters).toBeGreaterThan(0)
    expect(detail?.stationDistances).toHaveLength(3)
  })

  it('states no geometry when a vertex puts its longitude at 0', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;0,39.905000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // A longitude of 0 is the Greenwich meridian, thousands of kilometres from
    // any vertex of this line's road, so the vertex states no position — the same
    // absence a stop carries when nobody placed it.
    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })

  it('states no geometry when a vertex puts its latitude at 0', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000,0;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // A latitude of 0 is the equator, which this app's datum never places a
    // vertex on either.
    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })

  it('states no geometry when a vertex states only half of its pair', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // Half a pair is no position, and it must not be completed with a zero: a
    // vertex the payload left half-stated leaves the whole road unstateable for
    // the same reason a zero does.
    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })
})
