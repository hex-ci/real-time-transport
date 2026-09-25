import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import type { Database, StoredCommuteChain, StoredCommuteChainLeg, StoredUserSettings } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'

/**
 * F10's server half: a RECORDED chain fed real data.
 *
 * The pure engine (shared: `commute-chain.ts`) decides the margin, the band and
 * every 「不给结论」 reason; this suite is about the half that cannot be pure —
 * what the server reads to fill the engine's inputs, and what it does when a
 * reading is missing, stale, degraded or about a different vehicle.
 *
 * Two things are load-bearing here and both are asserted rather than described:
 *
 *  1. One read answers for ONE target station, so each leg is read TWICE (board
 *     order, alight order) and the two are matched by `LiveBusSchema.id`. A
 *     vehicle the other read does not carry has no pair and is not offered.
 *  2. Nothing is invented to fill a gap: an unsaved anchor, a station this
 *     direction's stop list does not carry, a line that was not read, an old
 *     reading, a fallback source — each of those leaves the engine's own code in
 *     place. The reads a leg cannot be concluded FROM are not spent — but a
 *     stale or degraded reading is only discoverable BY reading, so those reads
 *     are necessarily spent before the engine can refuse on them. What the
 *     assembly must not do is keep reading the legs AFTER a refusal, which no
 *     later read could change.
 *
 * 101 / 202 / 甲路 / 乙路 are placeholders: no real route, station or upstream id
 * appears in this file, and no upstream is reachable — every read is either the
 * stub db or a spy, and the only fetch allowed is the walking route.
 */

/** Frozen clock: the engine judges the AGE of a reading, never the wall clock. */
const NOW_MS = 1_700_000_000_000
/** The walking duration the path-service stub prices every connection at. */
const WALK_SECONDS = 300

/**
 * F3's state for every line in this suite: `detailFor` gives each of them
 * 05:00–23:00, and `NOW_MS` is 06:13:20 Beijing on that operating day — so the
 * state is 运营中 for every leg, and the two times are the line's own.
 */
const STATE = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' } as const

const LINE_A = '101'
const LINE_B = '202'
/** A long line, so one leg's board read can carry more than the display board's own six rows. */
const LINE_C = '303'
/** A subway id: the `subway_` prefix is what the live read is routed by. */
const LINE_S = 'subway_101'
/**
 * A second subway line whose stations are deliberately NOT evenly spaced, so its
 * two directions have DIFFERENT cumulative geometry. A direction-1 read priced
 * with direction 0's distances would then see a different platform, which is what
 * makes 「the pricing context matches the read」 observable. Like the real subway
 * provider, direction 1 is direction 0's stop list reversed and renumbered.
 */
const LINE_R = 'subway_202'

const STOPS: Record<string, string[]> = {
  [LINE_A]: ['甲路', '乙路', '丙路'],
  [LINE_B]: ['丙路', '丁路', '戊路', '己路'],
  [LINE_C]: ['一站', '二站', '三站', '四站', '五站', '六站', '七站', '八站', '九站', '十站'],
  [LINE_S]: ['甲路', '乙路', '丙路'],
  [LINE_R]: ['一号站', '二号站', '三号站', '四号站'],
}

/** Real inter-station segment lengths per line; unset means evenly 1000 m apart. */
const SEGMENTS: Record<string, number[]> = {
  [LINE_R]: [100, 200, 400],
}

/** Each line's own ground: `lat` offset so two lines never share a coordinate. */
const LAT_BASE: Record<string, number> = { [LINE_A]: 39.9, [LINE_B]: 39.95, [LINE_C]: 40.0, [LINE_S]: 39.9, [LINE_R]: 39.9 }

/**
 * The leg booked against each line, and what the upstream reports for each
 * requested target order, in seconds.
 */
const LEG_SPEC: Record<string, { board: number, alight: number, travel: Record<number, number> }> = {
  [LINE_A]: { board: 2, alight: 3, travel: { 2: 900, 3: 1200 } },
  [LINE_B]: { board: 3, alight: 4, travel: { 3: 2100, 4: 2400 } },
  [LINE_C]: { board: 4, alight: 6, travel: { 4: 3600, 6: 3900 } },
  [LINE_S]: { board: 2, alight: 3, travel: { 2: 900, 3: 1200 } },
}

function freezeAt(epochMs: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(epochMs))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function station(lineId: string, name: string, order: number, unplaced: readonly string[] = []) {
  const placed = !unplaced.includes(name)
  return {
    id: `s${order}`,
    name,
    order,
    // A stop the direction's list carries without a position: the record is
    // intact, and the coordinate is what upstream never gave.
    ...(placed
      ? { lat: (LAT_BASE[lineId] ?? 39.9) + order / 100, lng: 116.4 + order / 100 }
      : {}),
    interchanges: [],
  }
}

/** Cumulative metres from the origin, from the segment lengths between stops. */
function cumulative(segments: readonly number[]): number[] {
  const out = [0]
  for (const segment of segments) out.push(out[out.length - 1]! + segment)
  return out
}

/**
 * One line's detail for ONE direction, built the way the provider builds it.
 *
 * Direction 1 is direction 0's station list REVERSED and renumbered from 1
 * (`universal-subway.ts` `getLineDetail`: `direction === 1 ? [...stations].reverse()
 * : [...stations]`, then `order: idx + 1`), with the cumulative distances
 * recomputed from the new origin. For an evenly spaced list the geometry is the
 * same both ways; `LINE_R` is uneven on purpose, so a direction-1 read priced with
 * direction 0's distances would see a different platform.
 */
function detailFor(lineId: string, direction = 0, unplaced: readonly string[] = []): LineDetail {
  const natural = STOPS[lineId] ?? []
  const names = direction === 1 ? [...natural].reverse() : natural
  const segments = SEGMENTS[lineId] ?? natural.slice(1).map(() => 1000)
  const ordered = direction === 1 ? [...segments].reverse() : segments
  const stationDistances = cumulative(ordered)
  return {
    lineId,
    lineName: lineId,
    direction,
    directionName: `开往 ${names[names.length - 1] ?? ''}`,
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    // Geometry present, so the static read is served from the db row and no
    // geometry backfill ever reaches the upstream.
    routeLengthMeters: stationDistances[stationDistances.length - 1] ?? 0,
    stationDistances,
    stops: names.map((name, i) => station(lineId, name, i + 1, unplaced)),
  }
}

const LEG_A: StoredCommuteChainLeg = {
  seq: 0,
  lineId: LINE_A,
  lineName: '101路',
  cityCode: '027',
  boardStationName: '乙路',
  boardStationOrder: 2,
  alightStationName: '丙路',
  alightStationOrder: 3,
  transferExtraMinutes: null,
}

const LEG_B: StoredCommuteChainLeg = {
  seq: 1,
  lineId: LINE_B,
  lineName: '202路',
  cityCode: '027',
  boardStationName: '戊路',
  boardStationOrder: 3,
  alightStationName: '己路',
  alightStationOrder: 4,
  transferExtraMinutes: null,
}

/** A leg on the long line, so its board read can carry more rows than the display board keeps. */
const LEG_C: StoredCommuteChainLeg = {
  seq: 2,
  lineId: LINE_C,
  lineName: '303路',
  cityCode: '027',
  boardStationName: '二站',
  boardStationOrder: 2,
  alightStationName: '十站',
  alightStationOrder: 10,
  transferExtraMinutes: null,
}

/** A leg whose lineId carries the prefix the live read is routed by, to a subway line. */
const LEG_S: StoredCommuteChainLeg = {
  seq: 0,
  lineId: LINE_S,
  lineName: '地铁101',
  cityCode: '027',
  boardStationName: '乙路',
  boardStationOrder: 2,
  alightStationName: '丙路',
  alightStationOrder: 3,
  transferExtraMinutes: null,
}

/** The stored row of a user who saved 家 and nothing else. */
const SETTINGS: StoredUserSettings = {
  ...DEFAULT_COMMUTE_HOURS,
  homeLat: 39.9,
  homeLng: 116.4,
  workLat: null,
  workLng: null,
}

function storedChain(legs: StoredCommuteChainLeg[], over: Partial<StoredCommuteChain> = {}): StoredCommuteChain {
  return {
    id: '3f1c2f9e-0000-4000-8000-000000000001',
    userId: 'default_user',
    name: '上班链路',
    originAnchor: 'home',
    purpose: 'morning',
    displayOrder: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    legs,
    ...over,
  }
}

/** One live reading as the wire carries it. */
function liveStatus(buses: Array<Record<string, unknown>>, over: Partial<LiveLineStatus> = {}): LiveLineStatus {
  return {
    lineId: 'x',
    direction: 0,
    buses: buses as LiveLineStatus['buses'],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: NOW_MS,
    ...over,
  }
}

/**
 * A vehicle heading to `nextOrder`. No `distanceFromStart`, so no row can be
 * read as 「正在进站」 by accident — every minute below is the upstream's own.
 */
function bus(id: string, nextOrder: number, travelTimeSec: number): Record<string, unknown> {
  return { id, order: nextOrder - 1, nextOrder, travelTimeSec, congestion: 'unknown', updatedAt: NOW_MS }
}

/**
 * Answers every read the way the real chain targets it: the bus's upstream
 * arrival time at the order the request named, and nothing else.
 */
function targetedReads(lineId: string, targetOrder: number | undefined): LiveLineStatus {
  const spec = LEG_SPEC[lineId]!
  const eta = spec.travel[targetOrder ?? 0]
  return liveStatus([bus('v1', spec.board, eta ?? 0)])
}

/** The service under test, with a stub db and no upstream but the walking route. */
function serviceFor(options: {
  chains: StoredCommuteChain[]
  settings?: StoredUserSettings | null
  /**
   * The duration the walking stub prices every connection at. Defaults to 5 min;
   * `null` = the path service answers with no route at all, which is how a priced
   * connection fails.
   */
  walkSeconds?: number | null
  /** Lines whose stop list is not available at all: no cached row, and the upstream read fails. */
  linesWithoutDetail?: readonly string[]
  /** Stops whose list carries them WITHOUT a coordinate, by name — the absence itself. */
  stopsWithoutCoordinates?: readonly string[]
}): { service: TransitService, walking: string[] } {
  const db = {
    getCachedLine: async (lineId: string, direction: number) =>
      options.linesWithoutDetail?.includes(lineId)
        ? null
        : detailFor(lineId, direction, options.stopsWithoutCoordinates),
    upsertCachedLine: async () => {},
    getUserSettings: async () => options.settings ?? null,
    getCommuteChains: async () => options.chains,
  } as unknown as Database

  const walking: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    walking.push(href)
    // Every test here is network-free by construction: a call that escaped
    // throws rather than spending real quota.
    if (!href.includes('/v3/direction/walking')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        // A response with no route in it is the honest 「no walking route priced」
        // answer; the caller then has no duration for this connection.
        ...(options.walkSeconds === null
          ? {}
          : { route: { paths: [{ distance: 400, duration: options.walkSeconds ?? WALK_SECONDS }] } }),
      }),
    }
  }))

  return { service: new TransitService(db, { amapKey: 'test-key' }), walking }
}

/** The engine's answer for the only chain in the fixture. */
async function onlyDeduction(service: TransitService) {
  const views = await service.deduceCommuteChains({ purpose: 'morning' })
  expect(views, 'no chain was answered at all').toHaveLength(1)
  return views[0]!
}

describe('F10 server: each leg is read twice, and the two reads are matched by id', () => {
  it('targets the board order and the alight order of every leg, and pairs by vehicle id', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A, LEG_B])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      const view = await onlyDeduction(service)

      // One read per station, per leg: the adapter answers for one target order,
      // so the board minute and the alight minute of the same vehicle can only
      // come from two reads.
      expect(reads).toEqual([`${LINE_A}:2`, `${LINE_A}:3`, `${LINE_B}:3`, `${LINE_B}:4`])

      expect(view.chainId).toBe('3f1c2f9e-0000-4000-8000-000000000001')
      expect(view.name).toBe('上班链路')
      expect(view.originAnchor).toBe('home')
      expect(view.purpose).toBe('morning')

      // The numbers are the engine's, drawn from BOTH reads: leg A boards the
      // vehicle 900 s out (15 min) and leaves it at 1200 s (20 min) — a 10-minute
      // platform wait after a 5-minute walk, and a 5-minute ride.
      expect(view.deduction).toEqual({
        status: 'deduced',
        band: 'comfortable',
        marginMinutes: 10,
        bindingSeq: 0,
        legs: [
          {
            seq: 0,
            lineId: LINE_A,
            lineName: '101路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 20,
            rideMinutes: 5,
            marginMinutes: 10,
            operatingStatus: STATE,
          },
          {
            seq: 1,
            lineId: LINE_B,
            lineName: '202路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 40,
            rideMinutes: 5,
            marginMinutes: 10,
            operatingStatus: STATE,
          },
        ],
        provenance: 'live',
        lastUpdatedAt: NOW_MS,
      })
    }
    finally {
      service.stop()
    }
  })

  it('takes the vehicle the ALIGHT read names, not the one at the same position', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    // The board read carries v1 (earlier) and v2; the alight read carries v2
    // alone, because v1 has already passed the alight station by then. Pairing by
    // position would put v2's alight minute beside v1's board minute and print a
    // ride no vehicle made.
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      options?.targetOrder === 2
        ? liveStatus([bus('v1', 2, 900), bus('v2', 2, 1200)])
        : liveStatus([bus('v2', 2, 1800)]),
    )

    try {
      const view = await onlyDeduction(service)
      expect(view.deduction.status).toBe('deduced')
      const [leg] = view.deduction.status === 'deduced' ? view.deduction.legs : []
      expect(leg?.vehicleId).toBe('v2')
      // v2: boards at 1200 s (20 min) and leaves at 1800 s (30 min).
      expect(leg?.waitMinutes).toBe(15)
      expect(leg?.alightMinutes).toBe(30)
      expect(leg?.rideMinutes).toBe(10)
    }
    finally {
      service.stop()
    }
  })

  it('refuses a leg whose vehicle is in one read and not the other, as OUR reading', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      options?.targetOrder === 2 ? liveStatus([bus('v1', 2, 900)]) : liveStatus([bus('v9', 2, 1800)]),
    )

    try {
      // The board read carried a vehicle and the two reads share no id: the code
      // says so, rather than reporting 「没有可乘的车」 — a sentence about the
      // service — when the truth is about the two snapshots we compared. The
      // refusal names the leg it is about and carries that reading's own age and
      // service state, so a page can point at THIS transfer point and date it.
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-shared-vehicle',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        updatedAt: NOW_MS,
        operatingStatus: STATE,
      })
    }
    finally {
      service.stop()
    }
  })

  it('pairs the board read\'s WHOLE set against the strict superset upstream sends', async () => {
    // The nested-read shape upstream really sends, at the size where it matters.
    // Upstream answers for a requested order iff the vehicle has not passed it, and
    // that filter is monotone in the order — so the board read's rows are a subset
    // of the alight read's, and the extra rows are the vehicles already BETWEEN the
    // two stations (past the board one, not past the alight one). Those extra rows
    // reach the alight station soonest, so any cap on either read — the display
    // board's own six, e.g. `.slice(0, 6)` — would leave the two truncated sets
    // disjoint and the user told there is no vehicle. Pairing by id, over the whole
    // board set, is what keeps a long leg's answer about the service we actually read.
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_C])], settings: SETTINGS })

    // Eight vehicles still to reach the board station (`nextOrder <= 2`), with the
    // upstream's own minutes there: 1..8 minutes out.
    const approaching = Array.from({ length: 8 }, (_, i) => bus(`v${i + 1}`, 2, 60 * (i + 1)))
    // Six already past the board station and not yet past the alight one
    // (`nextOrder` 3..8): the board read excludes them, the alight read carries them.
    const between = Array.from({ length: 6 }, (_, i) => bus(`w${i + 1}`, 3 + i, 30 * (i + 1)))

    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      options?.targetOrder === LEG_C.boardStationOrder
        ? liveStatus(approaching)
        // The same eight again with THEIR alight minutes, in the alight read's own
        // arrival order: the six between-station vehicles first.
        : liveStatus([...between, ...approaching.map((_, i) => bus(`v${i + 1}`, 2, 1200 + 60 * (i + 1)))]),
    )

    try {
      const view = await onlyDeduction(service)
      expect(view.deduction.status).toBe('deduced')
      const [leg] = view.deduction.status === 'deduced' ? view.deduction.legs : []
      // A 5-minute walk: v1 is 1 minute out and gone, v5 is 5 minutes out and is
      // the one boarded. Both are rows of the FULL board read, so pairing kept it.
      expect(leg?.vehicleId).toBe('v5')
      expect(leg?.waitMinutes).toBe(0)
      expect(leg?.alightMinutes).toBe(25)
      expect(leg?.referenceVehicleId).toBe('v1')
      expect(leg?.marginMinutes).toBe(-4)
    }
    finally {
      service.stop()
    }
  })

  it('names a leg recorded the wrong way round, instead of blaming the two reads', async () => {
    freezeAt(NOW_MS)
    // The record runs backwards: alight order 2, board order 3. Both stations
    // locate (LINE_A's stop list carries 乙路 at 2 and 丙路 at 3), so both reads
    // happen — and upstream's monotone filter then makes them disjoint. Reporting
    // 「两个读数没有对上的车」 would blame THIS APP's reading for a fact about the
    // user's record; the honest answer names the record, which the user can fix.
    const backwards = { ...LEG_A, boardStationName: '丙路', boardStationOrder: 3, alightStationName: '乙路', alightStationOrder: 2 }
    const { service } = serviceFor({ chains: [storedChain([backwards])], settings: SETTINGS })
    // One vehicle, whose nose is already at order 3: the board read (order 3)
    // carries it, the alight read (order 2) drops it — so the two share no id.
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, _options) =>
      liveStatus([bus('v1', 3, 900)]),
    )

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'leg-recorded-backwards',
        // No reading was consulted: the order is a fact about the stored leg.
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
    }
    finally {
      service.stop()
    }
  })

  it('counts the board read\'s own priced rows, not every bus the payload carried', async () => {
    freezeAt(NOW_MS)
    // Two mutations the review showed survive every other test here: reading the
    // count from the ALIGHT read, and using raw `board.buses.length`.
    //
    // LINE_A's board order is 2 and its alight order is 3. A bus whose nose is
    // already at order 3 has passed the board station, so `vehicleArrivals` prices
    // NO row for the board read — while the payload still CARRIES the bus, and the
    // alight read (order 3) prices it because it has not passed that one. Three
    // candidate definitions, three counts: the board read's priced rows are 0, the
    // payload's buses are 1, the alight read's rows are 1. Only 0 is 「没有可乘的
    // 车」; the other two would blame this app's reading for an empty set the
    // SERVICE produced.
    const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, _options) =>
      liveStatus([bus('v1', 3, 900)]),
    )

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-vehicle',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        updatedAt: NOW_MS,
        operatingStatus: STATE,
      })
    }
    finally {
      service.stop()
    }
  })

  it('states each leg\'s service state, and the refusing leg\'s when it refuses', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A, LEG_B])], settings: SETTINGS })
    // Leg 0 answers; leg 1's two reads answer with nothing on the way at all.
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      lineId === LINE_A ? targetedReads(lineId, options?.targetOrder) : liveStatus([]),
    )

    try {
      // The state governs the empty answer: 05:00–23:00 at 06:13 is 运营中, so
      // 「没有可乘的车」 here is a gap in a RUNNING service, not a day that ended.
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-vehicle',
        leg: { seq: 1, lineId: '202', lineName: '202路' },
        updatedAt: NOW_MS,
        operatingStatus: STATE,
      })
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a gap in the data keeps the engine\'s own code', () => {
  it('prices no connection — and spends no read — when the chain\'s anchor was never saved', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ chains: [storedChain([LEG_A])], settings: null })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        // An unsaved anchor is the one cause of an unpriced connection the user
        // can act on, so it travels under its own code — the same word F1's empty
        // state already uses for the same fact — and the page can send the user
        // to 设置 instead of telling them a connection could not be priced.
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // The engine refuses on the connection before it ever looks at a reading,
      // so no reading can change this answer — and none is paid for.
      expect(reads).toEqual([])
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('names an unsaved anchor even when the leg\'s line could not be read at all', async () => {
    freezeAt(NOW_MS)
    // Both faults at once: the chain's anchor was never saved AND this build
    // cannot read the leg's line, so its stored stations have no stop list to be
    // located in. The anchor is the one cause the user can act on, and WHICH
    // cause the page is told must not depend on the outcome of an upstream read —
    // so the anchor wins, and the read that would have learned the other fault is
    // not spent.
    const { service, walking } = serviceFor({
      chains: [storedChain([LEG_A])],
      settings: null,
      linesWithoutDetail: [LINE_A],
    })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Settled before the leg's line was even asked for.
      expect(reads).toEqual([])
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('names an unsaved anchor even when a stored station is not in the direction we read', async () => {
    freezeAt(NOW_MS)
    // The other coexistence: the anchor was never saved AND the stored pair does
    // not locate at its orders. A station this path cannot find is a fact about a
    // stop list the user cannot repair; an unsaved anchor is a fact they can, so
    // that is the one named.
    const wrongName = { ...LEG_A, alightStationName: '另一个站' }
    const { service } = serviceFor({ chains: [storedChain([wrongName])], settings: null })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('prices no connection when the stored station is not in the direction we read', async () => {
    freezeAt(NOW_MS)
    // The order is what locates a station in the stop list, and a subway numbers
    // the same station differently in each direction — so a pair whose stored
    // NAME is not at its stored order belongs to another stop list, and nothing
    // about it may be printed as if it were this leg's.
    const wrongName = { ...LEG_A, alightStationName: '另一个站' }
    const { service, walking } = serviceFor({ chains: [storedChain([wrongName])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        // The anchor WAS saved and the connection was attempted: what is missing
        // is the stored pair's location in this direction's stop list, so the
        // refusal keeps the generic connection code — the page must not send the
        // user to 设置 for a fact that is not about the anchor.
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Not priced and not read: a walking route to a station the user did not
      // name, and an alight minute at it, would both be plausible numbers about
      // the wrong platform.
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('keeps a line whose stop list could not be read in the generic connection code', async () => {
    freezeAt(NOW_MS)
    // The anchor is saved, so a connection into leg 0 is attempted — and it fails
    // at the line rather than at the settings row: with no stop list there is
    // nothing to locate the stored pair in and nothing to walk TO. The user has
    // no action this fact leaves them, which is why the code is the generic one.
    const { service, walking } = serviceFor({
      chains: [storedChain([LEG_A])],
      settings: SETTINGS,
      linesWithoutDetail: [LINE_A],
    })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Neither a platform nor a route was asked for: the leg's stops are not
      // known, so a walking duration to one of them would be about a platform
      // this build cannot name.
      expect(reads).toEqual([])
      expect(walking.filter(url => url.includes('/v3/direction/walking'))).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('keeps a connection the path service priced no route for in the generic code', async () => {
    freezeAt(NOW_MS)
    // The anchor is saved and both stored stations located, so the connection IS
    // attempted — and the path service answers with no route. That failure is
    // upstream's, not the user's, so the refusal must keep the generic connection
    // code rather than report the anchor of a settings row that is complete.
    const { service, walking } = serviceFor({
      chains: [storedChain([LEG_A])],
      settings: SETTINGS,
      walkSeconds: null,
    })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // The route was asked for and answered nothing, so no platform was read:
      // without a connection there is nothing to compare a boarding against.
      expect(walking).toHaveLength(1)
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses without spending a read when a leg\'s stations were never chosen', async () => {
    freezeAt(NOW_MS)
    const unset = { ...LEG_A, boardStationName: null, boardStationOrder: null }
    const { service } = serviceFor({ chains: [storedChain([unset, LEG_B])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'station-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses without spending a read on any leg after a refusal is settled', async () => {
    freezeAt(NOW_MS)
    // Leg 0's reading is stale, so the engine refuses the chain on leg 0 whatever
    // leg 1 would say. Unlike the station-unset case above, this refusal does NOT
    // null the position — leg 1 is locatable and priceable — so the only thing
    // that can stop the assembly reading it is the refusal already being settled.
    const stale = { ...LEG_A }
    const { service } = serviceFor({ chains: [storedChain([stale, LEG_B])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      // Leg 0 answers, but too old to be concluded from.
      return lineId === LINE_A
        ? liveStatus([bus('v1', 2, 900)], { updatedAt: NOW_MS - 200_000 })
        : targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'stale',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        // The age is the reading's own, collapsed to the older of the leg's two.
        updatedAt: NOW_MS - 200_000,
        operatingStatus: STATE,
      })
      // Zero reads for leg 1: the stale reading is only discoverable BY reading
      // leg 0, but leg 1's reads could not change the answer and are not spent.
      expect(reads).toEqual([`${LINE_A}:2`, `${LINE_A}:3`])
      expect(reads.filter(r => r.startsWith(`${LINE_B}:`))).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('keeps 没有实时数据 as its own code, separate from 没有可乘的车', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    // One of the two targeted reads answers nothing: the leg has no reading.
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      options?.targetOrder === 2 ? liveStatus([bus('v1', 2, 900)]) : null,
    )

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-live',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
    }
    finally {
      service.stop()
    }
  })

  it('keeps 两个读数的先后矛盾 as its own code', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    // The two targeted reads contradict each other about ONE vehicle: the alight
    // read says it reaches the alight station BEFORE the board read says it
    // reaches the board station. Those two numbers do not describe one journey, so
    // there is no ride to price from them — and no smaller version of the answer
    // either.
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      liveStatus([bus('v1', 2, options?.targetOrder === 2 ? 900 : 300)]),
    )

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'inconsistent-live',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        updatedAt: NOW_MS,
        operatingStatus: STATE,
      })
    }
    finally {
      service.stop()
    }
  })

  it('keeps 数据过期, 降级数据 and 来源不明 as three different codes', async () => {
    freezeAt(NOW_MS)

    const codes: Array<[string, LiveLineStatus]> = [
      // Older than F1's freshness limit: the reading cannot support a conclusion.
      ['stale', liveStatus([bus('v1', 2, 900)], { updatedAt: NOW_MS - 200_000 })],
      // A fallback source answered.
      ['degraded', liveStatus([bus('v1', 2, 900)], { isDegraded: true })],
      // A source this build does not know: no mark can be stated for its rows.
      ['provenance-unknown', liveStatus([bus('v1', 2, 900)], { dataSource: 'unknown_source' as LiveLineStatus['dataSource'] })],
    ]

    for (const [reason, status] of codes) {
      const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
      vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
      try {
        // Each of the three is a different fact about the data and each names the
        // leg it is about, with that reading's own age and service state.
        expect((await onlyDeduction(service)).deduction, reason).toEqual({
          status: 'no-conclusion',
          reason,
          leg: { seq: 0, lineId: '101', lineName: '101路' },
          updatedAt: status.updatedAt,
          operatingStatus: STATE,
        })
      }
      finally {
        service.stop()
      }
    }
  })
})

describe('F10 server: a station with no coordinate is not walked to', () => {
  it('refuses the leg and prices no walk when its BOARD stop carries no coordinate', async () => {
    freezeAt(NOW_MS)
    // The stored station IS in this direction's stop list at its stored order —
    // the record is intact — and the list states no position for it. The walk
    // into the leg then has no destination, so nothing about the leg can be
    // placed: a route priced to a stand-in point would be a real route to a place
    // nobody named, and it would make the leg look located enough to conclude
    // from. A missing coordinate must never be replaced by a stand-in point:
    // (0, 0) is a real position in the Atlantic and would be read as one.
    const { service, walking } = serviceFor({
      chains: [storedChain([LEG_A])],
      settings: SETTINGS,
      stopsWithoutCoordinates: ['乙路'],
    })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        // The anchor WAS saved and the stored pair DID locate in this direction:
        // what is missing is the platform's own position, which leaves the user
        // no action, so the refusal keeps the generic connection code rather than
        // sending them to 设置 for a settings row that is complete.
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // No route was asked for and no platform was read: the leg is refused
      // before the connection is priced, exactly as it is when its stop is not in
      // the list at all.
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses the leg whose ALIGHT stop carries no coordinate, at that leg', async () => {
    freezeAt(NOW_MS)
    // The point a leg is left at is its ALIGHT station's, so a leg left at an
    // unplaced stop would hand the next leg an origin nobody can walk from — and
    // that next leg would then answer with the chain's anchor, blaming a settings
    // row that is complete. The refusal belongs to the leg that cannot be placed.
    const { service, walking } = serviceFor({
      chains: [storedChain([LEG_A, LEG_B])],
      settings: SETTINGS,
      stopsWithoutCoordinates: ['丙路'],
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // Nothing is priced at all, not even the first leg's walk to a locatable
      // board station: a leg that cannot be placed is not a leg to walk into.
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: the connection comes from the path service, and only where it exists', () => {
  it('prices each leg from where the previous one left off, with the stored anchor as its origin', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ chains: [storedChain([LEG_A, LEG_B])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      targetedReads(lineId, options?.targetOrder),
    )

    try {
      await onlyDeduction(service)

      const path = walking.map(href => new URL(href).searchParams)
      expect(path).toHaveLength(2)
      // Leg 0 walks from the stored 家 anchor, which is already GCJ-02 and is
      // sent as held — a second conversion would move the origin ~500 m.
      expect(path[0]!.get('origin')).toBe('116.400000,39.900000')
      expect(path[0]!.get('destination')).toBe('116.420000,39.920000')
      // Leg 1 walks from leg 0's ALIGHT station — not from the anchor again, and
      // not from its own board station.
      expect(path[1]!.get('origin')).toBe('116.430000,39.930000')
      expect(path[1]!.get('destination')).toBe('116.430000,39.980000')
    }
    finally {
      service.stop()
    }
  })

  it('prices nothing past the last leg: the chain ends at its last alight station', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      targetedReads(lineId, options?.targetOrder),
    )

    try {
      const view = await onlyDeduction(service)
      // One connection per leg and nothing more: a chain records an origin
      // anchor and no destination, and the product need is the per-transfer
      // margin, so there is no walk past the last alight station and no total.
      expect(walking).toHaveLength(1)
      expect(view.deduction.status).toBe('deduced')
      expect('arriveInMinutes' in view.deduction).toBe(false)
    }
    finally {
      service.stop()
    }
  })

  it('adds a leg\'s own extra to the walking connection the assembly passes', async () => {
    freezeAt(NOW_MS)
    const withExtra = { ...LEG_A, transferExtraMinutes: 4 }
    const { service } = serviceFor({ chains: [storedChain([withExtra])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      targetedReads(lineId, options?.targetOrder),
    )

    try {
      const view = await onlyDeduction(service)
      // 15 minutes of arrival minus a 5-minute walk and the user's own 4 minutes
      // = 6. The chain stores no mode, so the assembly passes walking; the user's
      // number is applied to it all the same, and the cycling DEFAULT is not.
      expect(view.deduction.status).toBe('deduced')
      expect(view.deduction.status === 'deduced' ? view.deduction.marginMinutes : 'x').toBe(6)
      expect(view.deduction.status === 'deduced' ? view.deduction.legs[0]?.waitMinutes : 'x').toBe(6)
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: which chains are answered', () => {
  it('answers only the chains that serve the requested purpose', async () => {
    freezeAt(NOW_MS)
    const { service } = serviceFor({
      chains: [
        storedChain([LEG_A]),
        storedChain([LEG_A], { id: '3f1c2f9e-0000-4000-8000-000000000002', name: '下班链路', purpose: 'evening' }),
      ],
      settings: SETTINGS,
    })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      targetedReads(lineId, options?.targetOrder),
    )

    try {
      expect((await service.deduceCommuteChains({ purpose: 'morning' })).map(v => v.name)).toEqual(['上班链路'])
      expect((await service.deduceCommuteChains({ purpose: 'evening' })).map(v => v.name)).toEqual(['下班链路'])
    }
    finally {
      service.stop()
    }
  })

  it('answers an empty list for a purpose the user has no chain for', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ chains: [], settings: SETTINGS })
    try {
      expect(await service.deduceCommuteChains({ purpose: 'morning' })).toEqual([])
      // Nothing asked for, nothing read.
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a chain of more than two ride legs', () => {
  it('walks every leg of a three-leg chain and marks the binding one', async () => {
    // The engine's model is N legs and only the engine had a third-leg test. Here
    // the ASSEMBLY has to keep feeding it: three lines, each read twice, each
    // connection priced from the previous leg's alight station.
    freezeAt(NOW_MS)
    const third: StoredCommuteChainLeg = {
      seq: 2,
      lineId: LINE_C,
      lineName: '303路',
      cityCode: '027',
      boardStationName: '四站',
      boardStationOrder: 4,
      alightStationName: '六站',
      alightStationOrder: 6,
      transferExtraMinutes: null,
    }
    const { service, walking } = serviceFor({ chains: [storedChain([LEG_A, LEG_B, third])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      const view = await onlyDeduction(service)
      expect(view.deduction.status).toBe('deduced')
      expect(view.deduction.status === 'deduced' ? view.deduction.legs.map(l => l.seq) : []).toEqual([0, 1, 2])
      // Two reads per leg, at the stored orders, leg by leg.
      expect(reads).toEqual([
        `${LINE_A}:2`, `${LINE_A}:3`,
        `${LINE_B}:3`, `${LINE_B}:4`,
        `${LINE_C}:4`, `${LINE_C}:6`,
      ])
      // One connection per leg: the third walks from leg 1's alight station.
      expect(walking).toHaveLength(3)
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a subway leg through the assembly', () => {
  it('marks a leg whose reading comes from the subway path 排班推演', async () => {
    // The mark rests on the reading's own `dataSource`, and the DATA SOURCE rests
    // on the `subway_` lineId prefix: the provider routes a live read to the
    // subway engine by that prefix (`subway-router.ts:104`), not by an enforced
    // type — the leg's own stored detail here is even a bus `type`, and the mark
    // is still 排班推演 because the reading declared its subway source. So this
    // test pins the assembly's half — a leg whose reading declares
    // `subway_schedule` is marked 排班推演 and never 实时 — and it is honest that
    // the prefix is a convention: the adapter's own tests cover the routing, and
    // this one covers what the chain does with the reading it produced.
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_S])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, _options) =>
      // The subway path answers with generated trains, and stamps every reading
      // it serves with its own source.
      liveStatus([bus('train_1', 2, 900)], { dataSource: 'subway_schedule' }),
    )

    try {
      const view = await onlyDeduction(service)
      expect(view.deduction.status).toBe('deduced')
      const [leg] = view.deduction.status === 'deduced' ? view.deduction.legs : []
      expect(leg?.provenance).toBe('schedule_simulation')
      expect(leg?.provenance).not.toBe('live')
      expect(view.deduction.status === 'deduced' ? view.deduction.provenance : null).toBe('schedule_simulation')
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a subway leg recorded the other way round', () => {
  /**
   * The stored ends number direction 0's stop list, so 三号站 is order 3 and 一号站
   * is order 1: the RIDE runs the other way (alight 1 < board 3). On a subway that
   * is not a recording error — the one lineId serves both ways — so the assembly
   * reads direction 1, translating BOTH orders into that direction's numbering
   * (`order_1 = totalStops + 1 - order_0`): 3 -> 2, 1 -> 4.
   */
  const REVERSE: StoredCommuteChainLeg = {
    seq: 0,
    lineId: LINE_R,
    lineName: '地铁202',
    cityCode: '027',
    boardStationName: '三号站',
    boardStationOrder: 3,
    alightStationName: '一号站',
    alightStationOrder: 1,
    transferExtraMinutes: null,
  }

  it('reads direction 1 with both orders translated, and prices it with direction 1 geometry', async () => {
    freezeAt(NOW_MS)
    // A zero-length connection, so the vehicle that is AT the board platform right
    // now is still boardable and its own (zero) minute is what the row shows.
    const { service, walking } = serviceFor({ chains: [storedChain([REVERSE])], settings: SETTINGS, walkSeconds: 0 })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${direction}:${options?.targetOrder}`)
      // One generated train. At the translated ALIGHT target (order 4) it is 600 s
      // out, the upstream's own minute. At the translated BOARD target (order 2)
      // it is AT the platform: `distanceFromStart` is 400 m, which is DIRECTION 1's
      // cumulative distance at its order 2 — direction 0's distance at its own
      // order 2 is 100 m, so a read priced with direction 0's geometry would not
      // see the train at this platform at all.
      const status = options?.targetOrder === 2
        ? liveStatus(
            [{ id: 'train_1', order: 1, nextOrder: 2, travelTimeSec: 900, distanceFromStart: 400, congestion: 'unknown', updatedAt: NOW_MS }],
            { dataSource: 'subway_schedule', direction },
          )
        : liveStatus(
            [{ id: 'train_1', order: 1, nextOrder: 2, travelTimeSec: 600, congestion: 'unknown', updatedAt: NOW_MS }],
            { dataSource: 'subway_schedule', direction },
          )
      return status
    })

    try {
      const view = await onlyDeduction(service)

      // Direction 1, at the TRANSLATED orders — never 3 and 1, which are direction
      // 0's numbering and name two other platforms in direction 1.
      expect(reads).toEqual([`${LINE_R}:1:2`, `${LINE_R}:1:4`])
      // The connection into the read leg is still priced from the stored anchor,
      // to the board station the record names (the same coordinates in either
      // direction).
      expect(walking).toHaveLength(1)

      // Being at the board platform gives a board minute of 0; the alight minute is
      // the upstream's 600 s. A margin of 0 over a 1-minute connection is
      // `uncertain`, and a ride of 10 minutes — none of which the wrong direction's
      // geometry could produce.
      expect(view.deduction).toEqual({
        status: 'deduced',
        band: 'uncertain',
        marginMinutes: 0,
        bindingSeq: 0,
        legs: [{
          seq: 0,
          lineId: LINE_R,
          lineName: '地铁202',
          vehicleId: 'train_1',
          referenceVehicleId: 'train_1',
          provenance: 'schedule_simulation',
          waitMinutes: 0,
          alightMinutes: 10,
          rideMinutes: 10,
          marginMinutes: 0,
          operatingStatus: STATE,
        }],
        provenance: 'schedule_simulation',
        lastUpdatedAt: NOW_MS,
        // A margin of 0 cannot be told from 0.5 minutes, so the row states both
        // readings instead of one — the same code path a bus leg takes.
        branches: {
          asPlanned: { vehicleId: 'train_1', alightMinutes: 10 },
          nextVehicle: { vehicleId: null, alightMinutes: null },
        },
      })
    }
    finally {
      service.stop()
    }
  })

  it('spends no read and states no minute when the direction it runs in has no stop list', async () => {
    freezeAt(NOW_MS)
    // A direction-1 read needs direction 1's numbering, and direction 1's geometry
    // is what prices it. With no stop list for that direction there is neither, so
    // no read is spent and no minute is stated: reading direction 0's platforms
    // instead would answer about stations this ride never touches. The engine's own
    // code names the missing reading (`no-live`) rather than a substitute number.
    const { service } = serviceFor({ chains: [storedChain([REVERSE])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${direction}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })
    const realDetail = service.getLineDetail.bind(service)
    vi.spyOn(service, 'getLineDetail').mockImplementation(async (lineId, direction, cityCode) =>
      direction === 1 ? null : realDetail(lineId, direction, cityCode))

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-live',
        leg: { seq: 0, lineId: LINE_R, lineName: '地铁202' },
      })
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('settles a BUS leg recorded backwards from the record and spends no read on it', async () => {
    freezeAt(NOW_MS)
    // Both stored ends locate in direction 0's list, so the connection is priced —
    // and the leg is then settled as `leg-recorded-backwards` by the record alone.
    // The engine decides it before any reading, so reading it would spend two
    // upstream reads on an answer no reading can change. A bus has no reverse ride
    // to read for: its two directions are two lineIds, so alight < board here is the
    // user's entry the wrong way round.
    const backwards = {
      ...LEG_A,
      boardStationName: '丙路',
      boardStationOrder: 3,
      alightStationName: '乙路',
      alightStationOrder: 2,
    }
    const { service, walking } = serviceFor({ chains: [storedChain([backwards])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${direction}:${options?.targetOrder}`)
      return targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'leg-recorded-backwards',
        leg: { seq: 0, lineId: LINE_A, lineName: '101路' },
      })
      // The connection was priced (both ends located) and NO read was spent: the
      // refusal is the record's, not the reading's.
      expect(walking).toHaveLength(1)
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})
