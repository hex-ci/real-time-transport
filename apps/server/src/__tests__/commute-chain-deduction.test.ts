import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import type { Database, StoredCommuteChain, StoredCommuteChainLeg, StoredUserSettings } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'

/**
 * F10 服务端的一半：把真实数据喂给一条「记录下来的」链路。
 *
 * 纯引擎（shared 的 `commute-chain.ts`）决定余量、区间和每一个「不给结论」的原因；本套件管的
 * 是不能纯的那一半 —— 服务端读什么来填引擎的输入，以及当读数缺失、陈旧、降级或属于另一辆车时
 * 它怎么做。
 *
 * 1. 一次读数只答一个目标站，所以每段读两次（上车站序、下车站序），两次结果按
 *    `LiveBusSchema.id` 配对；另一次读数没有带的车不成对，不会被交给推演。
 * 2. 不编造任何东西填空：未保存的锚点、这个方向的站表没有的站、没读到的线路、过旧的读数、
 *    备用数据源 —— 每一种都原样留下引擎自己的码。读不出结论的那些读不该花 —— 但陈旧或降级的
 *    读数只有读了才知道，所以这些读必然先花掉；装配不许做的是在拒绝之后还继续读。
 *
 * 101 / 202 / 甲路 / 乙路 是占位：本文件不出现真实线路、站点或上游 id，唯一的 fetch 是步行路径。
 */

/** 冻结时钟：引擎判的是读数的年龄，从不是墙上时钟。 */
const NOW_MS = 1_700_000_000_000
/** 路径服务替身为每个换乘定价的步行时长。 */
const WALK_SECONDS = 300

/**
 * 本套件里每条线路的 F3 状态：`detailFor` 每条都给 05:00–23:00，而 `NOW_MS` 是那一天的北京
 * 06:13:20，所以每段都是 运营中，两个时刻都是线路自己的。
 */
const STATE = { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' } as const

const LINE_A = '101'
const LINE_B = '202'
/** 一条长线，好让一段的上车读数能带上比站牌自己那六行更多的行。 */
const LINE_C = '303'
/** 一个地铁 id：实时读取按 `subway_` 这个前缀路由。 */
const LINE_S = 'subway_101'
/**
 * 第二条地铁线，站与站刻意不等距，所以它的两个方向累计几何不同：用方向 0 的距离给方向 1 的
 * 读数定价，会看到一个不同的站台 —— 「定价上下文与读数相符」因此可观测。像真实地铁提供方一样，
 * 方向 1 是方向 0 的站表反序后重新编号。
 */
const LINE_R = 'subway_202'

const STOPS: Record<string, string[]> = {
  [LINE_A]: ['甲路', '乙路', '丙路'],
  [LINE_B]: ['丙路', '丁路', '戊路', '己路'],
  [LINE_C]: ['一站', '二站', '三站', '四站', '五站', '六站', '七站', '八站', '九站', '十站'],
  [LINE_S]: ['甲路', '乙路', '丙路'],
  [LINE_R]: ['一号站', '二号站', '三号站', '四号站'],
}

/** 每条线路真实的站间段长；不设就是等距 1000 m。 */
const SEGMENTS: Record<string, number[]> = {
  [LINE_R]: [100, 200, 400],
}

/** 每条线路自己的地面：`lat` 偏移，使两条线路不共用坐标。 */
const LAT_BASE: Record<string, number> = { [LINE_A]: 39.9, [LINE_B]: 39.95, [LINE_C]: 40.0, [LINE_S]: 39.9, [LINE_R]: 39.9 }

/** 挂在每条线路上的那一段，以及上游为每个被请求的目标站序报的秒数。 */
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
    // 这个方向的站表带着它却没有位置：记录本身完好，坐标是上游从未给过的那个。
    ...(placed
      ? { lat: (LAT_BASE[lineId] ?? 39.9) + order / 100, lng: 116.4 + order / 100 }
      : {}),
    interchanges: [],
  }
}

/** 从起点累计的米数，由站间段长推出。 */
function cumulative(segments: readonly number[]): number[] {
  const out = [0]
  for (const segment of segments) out.push(out[out.length - 1]! + segment)
  return out
}

/**
 * 一条线路在一个方向上的详情，按提供方的构造方式造。
 *
 * 方向 1 是方向 0 站表反序后从 1 重新编号，累计距离按新起点重算。等距站表两个方向几何相同；
 * `LINE_R` 刻意不等距，所以用方向 0 的距离给方向 1 的读数定价，会看到另一个站台。
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
    // 几何齐全，静态读取由 db 行作答，几何回填永远不会到达上游。
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

/** 长线上的那一段，它的上车读数能带上比站牌保留的更多的行。 */
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

/** 一段，它的 lineId 带着实时读取路由用的前缀，指向一条地铁线路。 */
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

/** 一个只存了 家 的用户的那一行。 */
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

/** 线上形式的一次实时读数。 */
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
 * 一辆开向 `nextOrder` 的车。没有 `distanceFromStart`，所以没有一行会被误读成「正在进站」：
 * 下面每个分钟都是上游自己的。
 */
function bus(id: string, nextOrder: number, travelTimeSec: number): Record<string, unknown> {
  return { id, order: nextOrder - 1, nextOrder, travelTimeSec, congestion: 'unknown', updatedAt: NOW_MS }
}

/**
 * 每次读取都按真实链路的目标方式作答：公交在上游请求点名的站序处的到达时刻，别的什么都不给。
 */
function targetedReads(lineId: string, targetOrder: number | undefined): LiveLineStatus {
  const spec = LEG_SPEC[lineId]!
  const eta = spec.travel[targetOrder ?? 0]
  return liveStatus([bus('v1', spec.board, eta ?? 0)])
}

function serviceFor(options: {
  chains: StoredCommuteChain[]
  settings?: StoredUserSettings | null
  /**
   * 步行替身为每个换乘定价的时长。默认 5 分钟；`null` 表示路径服务答「没有路线」，
   * 有价换乘就是这样失败的。
   */
  walkSeconds?: number | null
  /** 完全拿不到站表的线路：没有缓存行，且上游读取失败。 */
  linesWithoutDetail?: readonly string[]
  /** 站表带着它们却没有坐标的站，按名字 —— 「没有」这件事本身。 */
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
    // 这里的每个测试按构造都离网：逃出去的调用会抛错，而不是花掉真实配额。
    if (!href.includes('/v3/direction/walking')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        // 没有路线的响应就是诚实的「没定价出步行」，调用方因此拿不到这个换乘的时长。
        ...(options.walkSeconds === null
          ? {}
          : { route: { paths: [{ distance: 400, duration: options.walkSeconds ?? WALK_SECONDS }] } }),
      }),
    }
  }))

  return { service: new TransitService(db, { amapKey: 'test-key' }), walking }
}

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

      // 每个站、每段各一次读数：适配器一次只答一个目标站序，所以同一辆车的上车分钟与下车分钟只能
      // 来自两次读数。
      expect(reads).toEqual([`${LINE_A}:2`, `${LINE_A}:3`, `${LINE_B}:3`, `${LINE_B}:4`])

      expect(view.chainId).toBe('3f1c2f9e-0000-4000-8000-000000000001')
      expect(view.name).toBe('上班链路')
      expect(view.originAnchor).toBe('home')
      expect(view.purpose).toBe('morning')

      // 这些数是引擎的，取自两次读数：A 段在车距 900 s（15 分钟）时上车、1200 s（20 分钟）时下车 ——
      // 5 分钟步行之后等 10 分钟，车程 5 分钟。
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
    // 上车读数带 v1（更早）与 v2；下车读数只带 v2，因为 v1 此时已过了下车站。按位置配对，会把
    // v2 的下车分钟放到 v1 的上车分钟旁边，印出一趟没有车跑过的行程。
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
      // v2：1200 s 上车、1800 s 下车。
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
      // 上车读数带了车，而两次读数没有共同的 id：码如实说明这一点，而不是报「没有可乘的车」——
      // 那是关于服务的句子，而事实是关于我们比较的这两份快照。拒绝点名它说的是哪一段，并带上那次
      // 读数自己的年龄与运营状态，页面才能指着这个换乘点并给它标上时间。
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
    // 上游真正发来的嵌套读形状，在它要紧的那个规模上：上游只在车尚未越过所请求站序时才为该站序
    // 作答，该过滤对站序单调，所以上车读数的行是下车读数行的子集，多出来的行是已经在两站之间的车，
    // 它们最早到达下车站 —— 任何一侧的截断（站牌自己那六行）都会让两个被截断的集合不相交、用户
    // 被告知没有车。按 id 在整份上车集合上配对，才让长段的答案讲的是我们真正读到的那个服务。
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_C])], settings: SETTINGS })

    // 还有八辆车没到上车站（`nextOrder <= 2`），按上游自己的分钟：还差 1..8 分钟。
    const approaching = Array.from({ length: 8 }, (_, i) => bus(`v${i + 1}`, 2, 60 * (i + 1)))
    // 六辆已过上车站、尚未过下车站（`nextOrder` 3..8）：上车读数不含它们，下车读数含。
    const between = Array.from({ length: 6 }, (_, i) => bus(`w${i + 1}`, 3 + i, 30 * (i + 1)))

    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, options) =>
      options?.targetOrder === LEG_C.boardStationOrder
        ? liveStatus(approaching)
        // 同样这八辆车，带上它们各自的下车分钟，按下车读数自己的到达顺序：六辆站间车在前。
        : liveStatus([...between, ...approaching.map((_, i) => bus(`v${i + 1}`, 2, 1200 + 60 * (i + 1)))]),
    )

    try {
      const view = await onlyDeduction(service)
      expect(view.deduction.status).toBe('deduced')
      const [leg] = view.deduction.status === 'deduced' ? view.deduction.legs : []
      // 5 分钟步行：v1 还差 1 分钟、已经赶不上；v5 还差 5 分钟，就是它。两者都是完整上车读数的行，
      // 配对因此留住了它。
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
    // 记录是反的：下车序 2、上车序 3。两个站都定位得到，两次读数因此都发生 —— 而上游那个单调过滤
    // 让它们不相交。报「两个读数没有对上的车」等于把关于用户记录的事实怪到本应用的读数上；
    // 诚实的答案点名记录，用户能改。
    const backwards = { ...LEG_A, boardStationName: '丙路', boardStationOrder: 3, alightStationName: '乙路', alightStationOrder: 2 }
    const { service } = serviceFor({ chains: [storedChain([backwards])], settings: SETTINGS })
    // 一辆车，车头已在站序 3：上车读数（站序 3）含它，下车读数（站序 2）丢掉它 —— 两者没有共同 id。
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, _options) =>
      liveStatus([bus('v1', 3, 900)]),
    )

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'leg-recorded-backwards',
        // 没有读任何数据：站序是关于存下来的那一段的事实。
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
    }
    finally {
      service.stop()
    }
  })

  it('counts the board read\'s own priced rows, not every bus the payload carried', async () => {
    freezeAt(NOW_MS)
    // 复核发现有两处改动能活过这里的每一个测试：从下车读数取数量，以及直接用 `board.buses.length`。
    //
    // LINE_A 上车序 2、下车序 3。车头已在站序 3 的车过了上车站，所以 `vehicleArrivals` 给上车读数
    // 一行都不定价 —— 而载荷仍然带着这辆车，下车读数（站序 3）给它定价。三种候选定义、三个数量：
    // 上车读数的有价行是 0，载荷的车是 1，下车读数的行是 1。只有 0 是「没有可乘的车」；另外两个会把
    // 一个由服务造成的空集怪到本应用的读数上。
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
    // 第 0 段有答案；第 1 段的两次读数答：路上根本没有车。
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) =>
      lineId === LINE_A ? targetedReads(lineId, options?.targetOrder) : liveStatus([]),
    )

    try {
      // 状态管辖这个空答案：06:13 处在 05:00–23:00 之内即 运营中，所以这里的「没有可乘的车」是
      // 运营中的空档，不是一天已经结束。
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
        // 未保存的锚点是「换乘无价」里唯一一种用户能动手的成因，所以它走自己的码 —— F1 的空状态为
        // 同一件事用的也是这个词 —— 页面因此可以把用户送到 设置，而不是只说这个换乘定不了价。
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 引擎在看任何读数之前就在换乘上拒了，所以没有读数能改变这个答案，也没有为此付费。
      expect(reads).toEqual([])
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('names an unsaved anchor even when the leg\'s line could not be read at all', async () => {
    freezeAt(NOW_MS)
    // 两个毛病同时出现：链路的锚点从未保存，而且本次构建读不到这一段的线路，它存下来的站因此没有
    // 站表可定位。锚点是用户唯一能动手的成因，而页面被告知哪个成因，不能取决于一次上游读取的结果 ——
    // 所以锚点胜出，本可发现另一个毛病的那次读取不花。
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
      // 在这一段的线路被问到之前就定了。
      expect(reads).toEqual([])
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('names an unsaved anchor even when a stored station is not in the direction we read', async () => {
    freezeAt(NOW_MS)
    // 另一处共存：锚点从未保存，且存下来的那一对在它的站序上定位不到。这条路找不到的站，是用户
    // 修不了的站表的毛病；未保存的锚点是能修的，所以点名后者。
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
    // 站序才是在站表里定位一个站的东西，而地铁在不同方向给同一个站不同的编号 —— 存下来的 NAME
    // 不在它存下来的站序上，就说明那一对属于另一份站表，关于它的任何东西都不能当作这一段的印出来。
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
        // 锚点确实存过、换乘也确实试过：缺的是存下来那一对在这个方向站表里的位置，所以拒绝保留通用的
        // 换乘码 —— 页面不能为一件与锚点无关的事实把用户送到 设置。
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 不定价也不读取：通往一个用户没有点名的站的步行路线、以及它那里的下车分钟，都会是些关于
      // 错误站台的、看起来合理的数字。
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('keeps a line whose stop list could not be read in the generic connection code', async () => {
    freezeAt(NOW_MS)
    // 锚点已保存，所以进入第 0 段的换乘会被尝试 —— 它在线路上而不是在设置行上失败：没有站表，
    // 就既没有东西可用来定位存下来的那一对，也没有东西可走。这件事实没有给用户留下任何动作，
    // 所以码是通用的那个。
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
      // 既没问站台也没问路线：这一段的站还不清楚，所以走到其中一个站的步行时长会是关于一个本次构建
      // 叫不出名字的站台的。
      expect(reads).toEqual([])
      expect(walking.filter(url => url.includes('/v3/direction/walking'))).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('keeps a connection the path service priced no route for in the generic code', async () => {
    freezeAt(NOW_MS)
    // 锚点已保存、两个存下来的站都定位到了，所以换乘确实被尝试 —— 而路径服务答「没有路线」。
    // 那是上游的失败而不是用户的，所以拒绝保留通用的换乘码，而不是去报一行完整的设置行的锚点。
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
      // 问了路线而它什么都没答，所以没有读任何站台：没有换乘就没有东西可以拿上车来比较。
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
    // 第 0 段的读数陈旧，所以引擎在第 0 段上拒了整条链路，无论第 1 段会说什么。与上面「站未设置」
    // 那例不同，这次拒绝不会把位置置空 —— 第 1 段可定位、可定价 —— 所以唯一能阻止装配去读它的，
    // 就是这次拒绝已经定下了。
    const stale = { ...LEG_A }
    const { service } = serviceFor({ chains: [storedChain([stale, LEG_B])], settings: SETTINGS })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return lineId === LINE_A
        ? liveStatus([bus('v1', 2, 900)], { updatedAt: NOW_MS - 200_000 })
        : targetedReads(lineId, options?.targetOrder)
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'stale',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        // 年龄是读数自己的，取该段两次读数中较旧的那个。
        updatedAt: NOW_MS - 200_000,
        operatingStatus: STATE,
      })
      // 第 1 段零次读取：陈旧的读数只有读了第 0 段才知道，但第 1 段的读取改变不了答案，因此不花。
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
    // 两次定向读数有一次什么都没答：这一段没有读数。
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
    // 两次定向读数在同一辆车上互相矛盾：下车读数说它到下车站的时刻，早于上车读数说它到上车站的
    // 时刻。这两个数不描述同一趟行程，所以从它们没有行程可定价 —— 也没有更小的答案可言。
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
      // 比 F1 的新鲜度上限更旧：这个读数撑不起一个结论。
      ['stale', liveStatus([bus('v1', 2, 900)], { updatedAt: NOW_MS - 200_000 })],
      // 一个备用数据源作答了。
      ['degraded', liveStatus([bus('v1', 2, 900)], { isDegraded: true })],
      // 一个本次构建不认识的数据源：它的行没有标记可说。
      ['provenance-unknown', liveStatus([bus('v1', 2, 900)], { dataSource: 'unknown_source' as LiveLineStatus['dataSource'] })],
    ]

    for (const [reason, status] of codes) {
      const { service } = serviceFor({ chains: [storedChain([LEG_A])], settings: SETTINGS })
      vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
      try {
        // 三者各自是关于数据的不同事实，且各自点名它说的是哪一段，带上那次读数自己的年龄与运营状态。
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
    // 存下来的站确实在它存下来的站序上处于这个方向的站表里 —— 记录完好 —— 而站表没有给它位置。
    // 走进这一段的步行因此没有目的地，关于这一段的东西都放不下来；而缺坐标绝不能被一个替代点补上：
    // (0, 0) 是大西洋上的真实位置，会被当成一个位置读。
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
        // 锚点确实存过、存下来的那一对在这个方向上也确实定位到了：缺的是站台自己的位置，这让用户
        // 无计可施，所以拒绝保留通用的换乘码，而不是为一行完整的设置把用户送到 设置。
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 没问路线、没读站台：这一段在换乘被定价之前就被拒了，与它的站根本不在表里时一模一样。
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses the leg whose ALIGHT stop carries no coordinate, at that leg', async () => {
    freezeAt(NOW_MS)
    // 一段结束时留在的点是它下车站的点，所以一段停在一个没有位置的站上，会把一个谁都走不出去的
    // 起点交给下一段 —— 而下一段随后会用链路的锚点作答，怪到一行完整的设置上。拒绝属于那段无法
    // 被放下的。
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
      // 什么都不定价，连第一段走向一个可定位上车站的步行也不：一段放不下来的，就不是可以走进去的一段。
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
      // 第 0 段从存下来的 家 锚点起步，它已是 GCJ-02，原样送出 —— 再换算一次会把起点挪动。
      expect(path[0]!.get('origin')).toBe('116.400000,39.900000')
      expect(path[0]!.get('destination')).toBe('116.420000,39.920000')
      // 第 1 段从第 0 段的下车站起步 —— 不是又从锚点，也不是从它自己的上车站。
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
      // 每段一个换乘，仅此而已：链路记录的是一个起点锚点、没有目的地，而产品需要的是每个换乘处的
      // 余量，所以最后一个下车站之后没有步行，也没有总计。
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
      // 15 分钟到达，减去 5 分钟步行和用户自己的 4 分钟 = 6。链路不存交通方式，所以装配传 walking；
      // 用户的那个数照样加在它上面，而骑行的 DEFAULT 不算。
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
      // 什么都没问，什么都没读。
      expect(walking).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a chain of more than two ride legs', () => {
  it('walks every leg of a three-leg chain and marks the binding one', async () => {
    // 引擎的模型是 N 段，而此前只有引擎有第三段的测试。这里必须由装配持续喂它：三条线路，每条读
    // 两次，每个换乘都从前一段的下车站定价。
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
      // 每段两次读取，按存下来的站序，逐段进行。
      expect(reads).toEqual([
        `${LINE_A}:2`, `${LINE_A}:3`,
        `${LINE_B}:3`, `${LINE_B}:4`,
        `${LINE_C}:4`, `${LINE_C}:6`,
      ])
      // 每段一个换乘：第三个从第 1 段的下车站起步。
      expect(walking).toHaveLength(3)
    }
    finally {
      service.stop()
    }
  })
})

describe('F10 server: a subway leg through the assembly', () => {
  it('marks a leg whose reading comes from the subway path 排班推演', async () => {
    // 标记落在读数自己的 `dataSource` 上，而数据源落在 `subway_` 这个 lineId 前缀上：提供方按
    // 前缀把实时读取路由到地铁引擎（`subway-router.ts:104`），而不是按强制过的类型 —— 这里这一段
    // 存下来的详情甚至是公交 `type`，标记仍是 排班推演，因为读数声明了它的地铁来源。本测试钉的是
    // 装配这一半：读数声明 `subway_schedule` 的一段标 排班推演、绝不标 实时。
    freezeAt(NOW_MS)
    const { service } = serviceFor({ chains: [storedChain([LEG_S])], settings: SETTINGS })
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (_lineId, _direction, _cityCode, _force, _options) =>
      // 地铁路径用生成的车作答，并给自己服务的每个读数盖上自己的来源。
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
   * 存下来的两端用的是方向 0 的站表编号，所以 三号站 是序 3、一号站 是序 1：这一程是反着走的
   * （下车 1 < 上车 3）。在地铁上这不是记录错误 —— 同一个 lineId 服务两个方向 —— 所以装配读
   * 方向 1，把两个站序都翻译成那个方向的编号（`order_1 = totalStops + 1 - order_0`）：3 -> 2，1 -> 4。
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
    // 一个零长度换乘，所以此刻就在上车站台上的车仍可乘，它自己的（零）分钟就是这一行显示的数。
    const { service, walking } = serviceFor({ chains: [storedChain([REVERSE])], settings: SETTINGS, walkSeconds: 0 })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${direction}:${options?.targetOrder}`)
      // 一列生成的车。在翻译后的下车站序（序 4）它距站 600 s，是上游自己的分钟；在翻译后的上车站序
      // （序 2）它就在站台上：`distanceFromStart` 是 400 m，即方向 1 在它序 2 处的累计距离 —— 方向 0
      // 在它自己序 2 处是 100 m，所以用方向 0 的几何定价的读取根本看不到这列车在这个站台上。
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

      // 方向 1，用翻译后的站序 —— 绝不是 3 和 1，那是方向 0 的编号，在方向 1 里指的是另外两个站台。
      expect(reads).toEqual([`${LINE_R}:1:2`, `${LINE_R}:1:4`])
      // 进入所读那一段的换乘仍从存下来的锚点定价，到记录点名的那个上车站（两个方向坐标相同）。
      expect(walking).toHaveLength(1)

      // 在站台上给出 0 的上车分钟；下车分钟是上游的 600 s。1 分钟换乘上 0 的余量是 `uncertain`，
      // 车程 10 分钟 —— 这几个数用错误方向的几何都产生不出来。
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
        // 0 的余量与 0.5 分钟分不开，所以这一行给出两个读数而不是一个 —— 与公交段走的是同一条码路。
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
    // 方向 1 的读取需要方向 1 的编号，而定价它的正是方向 1 的几何。那个方向没有站表就两样都没有，
    // 所以一次读取都不花、一个分钟都不给：改读方向 0 的站台，会答成这一程根本不经过的站。引擎自己
    // 的码点名缺失的读数（`no-live`），而不是给一个替代数字。
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
    // 存下来的两端在方向 0 的站表里都定位得到，所以换乘被定价 —— 随后这一段仅凭记录就被定为
    // `leg-recorded-backwards`。引擎在任何读数之前就定了它，所以读它会为改变不了的答案花掉两次上游
    // 读取。公交没有反向的行程可读：它的两个方向是两个 lineId，所以这里 下车 < 上车 是用户填反了。
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
      // 换乘被定价了（两端都定位到），且一次读取都没花：这个拒绝是记录的，不是读数的。
      expect(walking).toHaveLength(1)
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})
