import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMMUTE_HOURS } from '@real-time-transport/shared'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import type { Database, StoredCommuteChain, StoredCommuteChainLeg, StoredUserSettings } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'

/**
 * 标成 (0, 0) 的存量站与没有位置的站一样，都无法定位。
 *
 * 线路详情行可以对上游从未定位过的站携带 `{lat: 0, lng: 0}`。在本应用的 GCJ-02 基准上
 * 没有任何已定位的站在 0 点，所以这一行对那个站就没有给出位置，而每条需要点位的路径都
 * 必须把它读成「没有」这件事本身：向 (0, 0) 定价的步行是一条通往大西洋某点的真实路径，
 * 建立在它之上的推演带着一条谁都行动不了的区间。这与 `line-group.ts` 对「被标成 0」的站
 * 说的规则相同，只是应用在链路为换乘定价的地方。
 *
 * 101 / 甲路 / 乙路 / 丙路 都是占位：这里不出现任何真实线路、车站或上游 id，也触不到
 * 上游 —— 站表是替身行，唯一允许的请求是步行路径。
 */

/** 冻结时钟：引擎判的是读数的「年龄」，从不是墙上时钟。 */
const NOW_MS = 1_700_000_000_000
/** 路径服务替身为每个换乘定价的步行时长。 */
const WALK_SECONDS = 300

const LINE_A = '101'
const STOPS = ['甲路', '乙路', '丙路']

/** 一个只存了 家 的用户的那一行。 */
const SETTINGS: StoredUserSettings = {
  ...DEFAULT_COMMUTE_HOURS,
  homeLat: 39.9,
  homeLng: 116.4,
  workLat: null,
  workLng: null,
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

function freezeAt(epochMs: number): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(epochMs))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function storedChain(legs: StoredCommuteChainLeg[]): StoredCommuteChain {
  return {
    id: '3f1c2f9e-0000-4000-8000-00000000000a',
    userId: 'default_user',
    name: '上班链路',
    originAnchor: 'home',
    purpose: 'morning',
    displayOrder: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    legs,
  }
}

/**
 * 一条线路的存量详情，`zeroed` 点名这一行按 (0, 0) 携带、而不是声明没有坐标的那些站
 * —— 也就是「没有」在还被允许缺失之前被写进行里的那种形状。
 */
function detailFor(zeroed: readonly string[] = []): LineDetail {
  const stationDistances = STOPS.map((_, i) => i * 1000)
  return {
    lineId: LINE_A,
    lineName: LINE_A,
    direction: 0,
    directionName: `开往 ${STOPS[STOPS.length - 1]}`,
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    // 几何齐全，所以静态读取由 db 行作答，
    // 几何回填永远不会到达上游。
    routeLengthMeters: stationDistances[stationDistances.length - 1] ?? 0,
    stationDistances,
    stops: STOPS.map((name, i) => ({
      id: `s${i + 1}`,
      name,
      order: i + 1,
      ...(zeroed.includes(name)
        ? { lat: 0, lng: 0 }
        : { lat: 39.9 + (i + 1) / 100, lng: 116.4 + (i + 1) / 100 }),
      interchanges: [],
    })),
  }
}

/**
 * 一辆车正开向请求点名的站序，带上游自己的到达分钟 —— 没有 `distanceFromStart`，
 * 所以没有一行会被误读成「正在进站」。
 */
function targetedReads(): LiveLineStatus {
  return {
    lineId: LINE_A,
    direction: 0,
    buses: [{ id: 'v1', order: 1, nextOrder: 2, travelTimeSec: 900, congestion: 'unknown', updatedAt: NOW_MS }],
    dataSource: 'chelaile',
    isDegraded: false,
    updatedAt: NOW_MS,
  }
}

function serviceFor(options: { zeroedStops?: readonly string[] }): { service: TransitService, walking: string[] } {
  const db = {
    getCachedLine: async () => detailFor(options.zeroedStops),
    upsertCachedLine: async () => {},
    getUserSettings: async () => SETTINGS,
    getCommuteChains: async () => [storedChain([LEG_A])],
  } as unknown as Database

  const walking: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    // 这里的每个测试按构造都离网：逃出去的调用会抛错，
    // 而不是花掉真实配额。
    if (!href.includes('/v3/direction/walking')) throw new Error(`unexpected upstream call: ${href}`)
    walking.push(href)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        route: { paths: [{ distance: 400, duration: WALK_SECONDS }] },
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

describe('F10 server: a stored stop marked (0, 0) is not walked to', () => {
  it('refuses the leg and prices no walk when its BOARD stop is marked (0, 0)', async () => {
    freezeAt(NOW_MS)
    const { service, walking } = serviceFor({ zeroedStops: ['乙路'] })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads()
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        // 引擎自己的 `station-without-coordinate` 原因，按线上形式：
        // 锚点确实存过，存下来的那一对在这个方向上也确实定位到了，
        // 所以缺的是站台自己的位置 —— 这让使用者无计可施，
        // 因而给出通用的换乘码而不是 设置。
        // than 设置.
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 什么也不定价、什么也不读：行里标成 0 的站没有点可走，
      // 所以既不请求路径也不读站台 —— 走到 (0, 0) 会是一条通往
      // 无人指定之处的真实路径，并让这一段显得足够可定位，
      // 从而可以据它下结论。
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })

  it('refuses the leg whose ALIGHT stop is marked (0, 0), at that leg', async () => {
    freezeAt(NOW_MS)
    // 一段乘车留下的点是它下车站的点，所以把一段留在行里标成 0 的站，
    // 会把一个谁也走不了的起点交给下一段，而下一段就会拿链路的锚点作答
    // —— 去怪一个其实完整的设置行。拒绝属于
    // 那段无法定位的乘车段。
    const { service, walking } = serviceFor({ zeroedStops: ['丙路'] })
    const reads: string[] = []
    vi.spyOn(service, 'getLiveStatus').mockImplementation(async (lineId, _direction, _cityCode, _force, options) => {
      reads.push(`${lineId}:${options?.targetOrder}`)
      return targetedReads()
    })

    try {
      expect((await onlyDeduction(service)).deduction).toEqual({
        status: 'no-conclusion',
        reason: 'connection-unpriced',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 站台可以定位，但这段乘车不作为结论依据：行里标成 0 的站
      // 不是可以下车离开的点，所以不定价任何路径，
      // 也不读任何站台。
      expect(walking).toEqual([])
      expect(reads).toEqual([])
    }
    finally {
      service.stop()
    }
  })
})
