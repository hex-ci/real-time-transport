import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { TransitService } from '../services/transit.service.js'
import { buildApp } from '../app.js'

/**
 * 服务端的 F4：每一行到达都声明自己那个数是什么种类。
 *
 * 带目标站序的到达查询会让上游返回该站自己的行程时间，所以这条路径上的载荷「可以」带到达
 * 分钟 —— 但不必带，也不必对同一次响应里的每辆车都带。因此来源必须挂在每个分钟产生的地方、
 * 按行挂：要么是载荷带来的值，要么是地铁引擎的模型。
 *
 * 载荷什么都没定价的行不再得到本应用自己的分钟：位置/停站外推已移除（见
 * `no-estimated-arrival-minute.test.ts`），这样的行既没有 `etaSeconds`、没有 `time`，
 * 也没有来源。这里断言的是另一半，也是 F4 存在的理由：「没有来源」与「实时」是两个不同的
 * 事实，来源未知的行不能回头告诉 UI 它是实时的。
 */

/** 冻结墙上时钟；只伪造 `Date`，别的东西都不会停摆。 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function station(name: string, order: number) {
  return { id: `s${order}`, name, order, lat: 39.9 + order / 100, lng: 116.4 + order / 100, interchanges: [] }
}

/**
 * 三站公交，被查询的是它的中间站台：产生每个分钟的分支因此由车辆决定，而不是由固定数据决定。
 */
function busDetail(geometry: boolean): LineDetail {
  return {
    lineId: '010-1-0',
    lineName: '1',
    direction: 0,
    directionName: '开往 丙站',
    firstBusTime: '05:00',
    lastBusTime: '23:00',
    cityCode: '027',
    type: 'bus',
    stops: [station('甲站', 1), station('乙站', 2), station('丙站', 3)],
    ...(geometry ? { routeLengthMeters: 3000, stationDistances: [0, 1500, 3000] } : {}),
  }
}

/** 这些站没有登记时刻表的地铁线路。 */
function subwayDetail(): LineDetail {
  return { ...busDetail(true), lineId: 'subway_027_88', type: 'subway', directionName: '开往 丙站' }
}

function vehicle(partial: Record<string, unknown>): Record<string, unknown> {
  return { id: 'b1', order: 1, nextOrder: 2, congestion: 'unknown', updatedAt: Date.now(), ...partial }
}

function liveStatus(dataSource: LiveLineStatus['dataSource'], buses: Array<Record<string, unknown>>): LiveLineStatus {
  return {
    lineId: 'x',
    direction: 0,
    buses: buses as LiveLineStatus['buses'],
    dataSource,
    isDegraded: false,
    updatedAt: Date.now(),
  }
}

function serviceFor(detail: LineDetail, status: LiveLineStatus | null) {
  const db = {
    getCachedLine: async () => detail,
    getUserSettings: async () => null,
    // 只有无几何的固定数据会走到这里：它的回填注定失败，服务随后原样给出缓存行。
    upsertCachedLine: async () => {},
  } as unknown as Database

  // 这里的每个测试按构造都离网：逃出去的调用会抛错，而不是花掉真实配额。
  forbidNetwork()

  const service = new TransitService(db, { amapKey: 'test-key' })
  vi.spyOn(service, 'getLiveStatus').mockResolvedValue(status)
  return service
}

/** 这里的每一次网络调用都是 bug：宁可响亮地失败，也不花掉配额。 */
function forbidNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))
}

async function arrivalsFor(
  service: TransitService,
  lineId: string,
  stationName: string,
  order: number,
) {
  const result = await service.getStationArrivals(lineId, stationName, 0, 6, '027', order)
  expect(result, 'no arrivals answer at all').not.toBeNull()
  return result!
}

describe('F4: a bus minute is 实时 only when the payload carried it', () => {
  it('keeps the upstream travel time as 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    const service = serviceFor(detail, liveStatus('chelaile', [vehicle({ travelTimeSec: 300 })]))
    try {
      for (const row of (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals) {
        expect(row.provenance).toBe('live')
      }
    }
    finally {
      service.stop()
    }
  })

  it('serves no minute and no mark when the reading published none for the vehicle', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    // 真实车辆、真实里程、真实速度，但没有上游到达时间 —— 实时公交站牌就是这个形状，
    // 而它给出的这一行不给分钟；标记修饰的是一个数字，所以这一行也没有标记。
    const service = serviceFor(detail, liveStatus('chelaile', [
      vehicle({ distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.etaSeconds, 'an extrapolated minute was served').toBeUndefined()
        expect(row.provenance, 'a mark rode on a row with no number').toBeNull()
        expect(row.busId).toBeTypeOf('string')
      }
    }
    finally {
      service.stop()
    }
  })

  it('serves no minute without geometry either, rather than a per-stop constant', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(false)
    const service = serviceFor(detail, liveStatus('chelaile', [vehicle({})]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.etaSeconds).toBeUndefined()
        expect(row.provenance).toBeNull()
      }
    }
    finally {
      service.stop()
    }
  })

  it('keeps a vehicle observed at the platform as 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    // 车头就在被查询站台自己的里程标上：这是对真实车辆的观测，不是算出来的结果。
    const service = serviceFor(detail, liveStatus('chelaile', [
      vehicle({ distanceFromStart: 3000 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows[0]?.isAtStation).toBe(true)
      expect(rows[0]?.provenance).toBe('live')
    }
    finally {
      service.stop()
    }
  })
})

describe('F4: the subway engine\'s trains never come back as live data', () => {
  it('marks a generated train 排班推演 however its minute was produced', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = subwayDetail()
    // 引擎给每列车都放了 travelTimeSec，所以这一行走到「上游送来了分钟」那个分支，
    // 而车本身是生成的。
    const service = serviceFor(detail, liveStatus('subway_schedule', [
      vehicle({ travelTimeSec: 300 }),
      vehicle({ id: 'b2', distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, 'subway_027_88', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.provenance).toBe('schedule_simulation')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      service.stop()
    }
  })

  it('marks a generated train seen at a platform 排班推演, not 实时', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = subwayDetail()
    const service = serviceFor(detail, liveStatus('subway_schedule', [
      vehicle({ distanceFromStart: 3000 }),
    ]))
    try {
      const rows = (await arrivalsFor(service, 'subway_027_88', '丙站', 3)).arrivals
      expect(rows[0]?.isAtStation).toBe(true)
      expect(rows[0]?.provenance).toBe('schedule_simulation')
    }
    finally {
      service.stop()
    }
  })
})

describe('F4: an unclassifiable source yields no claim', () => {
  it('leaves rows unclassified when the answering source is not one this build knows', async () => {
    freezeAt('2026-09-24T08:30:00')
    const detail = busDetail(true)
    const service = serviceFor(detail, liveStatus(
      'apizero' as LiveLineStatus['dataSource'],
      [vehicle({ distanceFromStart: 500, speed: 6 })],
    ))
    try {
      const rows = (await arrivalsFor(service, '010-1-0', '丙站', 3)).arrivals
      expect(rows.length).toBeGreaterThan(0)
      // apizero 是真实的车辆数据源，它的行会被分类；本用例的重点是下面那道闸，外来源必须触发它。
      expect(rows.every(r => r.provenance !== undefined)).toBe(true)

      const foreign = serviceFor(detail, liveStatus(
        'unknown_source' as LiveLineStatus['dataSource'],
        [vehicle({ distanceFromStart: 500, speed: 6 })],
      ))
      try {
        const rows2 = (await arrivalsFor(foreign, '010-1-0', '丙站', 3)).arrivals
        expect(rows2.length).toBeGreaterThan(0)
        for (const row of rows2) expect(row.provenance).toBeNull()
      }
      finally {
        foreign.stop()
      }
    }
    finally {
      service.stop()
    }
  })

  it('never reaches upstream while classifying', async () => {
    freezeAt('2026-09-24T08:30:00')
    forbidNetwork()
    const service = serviceFor(busDetail(true), liveStatus('chelaile', [
      vehicle({ distanceFromStart: 500, speed: 6 }),
    ]))
    try {
      await arrivalsFor(service, '010-1-0', '丙站', 3)
    }
    finally {
      service.stop()
    }
  })
})

/** 同样两种答案走真实 HTTP 路由：这里断言的正是 web 应用收到的线上形状。 */
describe('F4: the arrivals route ships a provenance on every row', () => {
  const OK = (payload: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  })

  /** 一条 amap 线路替身，站与站之间约 1.3 km。 */
  function subwayLineFixture(names: string[]) {
    return {
      id: 'BJ_88',
      name: '地铁88号线',
      type: '地铁线路',
      start_stop: names[0],
      end_stop: names[names.length - 1],
      start_time: '0516',
      end_time: '2306',
      busstops: names.map((name, i) => ({
        id: `s${i + 1}`,
        name,
        sequence: i + 1,
        location: `${(116.39 + i * 0.012).toFixed(6)},39.92`,
      })),
    }
  }

  function stubAmap(buslines: unknown[]): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      if (href.includes('/v3/bus/linename')) return OK({ buslines })
      if (href.includes('/v3/place/around')) return OK({ pois: [] })
      return OK({})
    }))
  }

  async function arrivals(app: Awaited<ReturnType<typeof buildApp>>, stationName: string, extra = '') {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/subway_027_7/stations/${encodeURIComponent(stationName)}/arrivals`
        + `?direction=0&count=3&cityCode=027${extra}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as {
      isExact: boolean
      arrivals: Array<{ time: string, etaSeconds: number, provenance?: string | null }>
    }
  }

  it('marks a registered station timetable 精确时刻表, per row', async () => {
    freezeAt('2026-09-24T08:30:00')
    stubAmap([subwayLineFixture(['群芳', '乙站'])])
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // 固定数据的首站，是本仓唯一持有已发布分钟级时刻表的站（方向 0）。
      const data = await arrivals(app, '群芳')
      expect(data.isExact).toBe(true)
      expect(data.arrivals.length).toBeGreaterThan(0)
      for (const row of data.arrivals) {
        expect(row.provenance).toBe('exact_timetable')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      await app.close()
    }
  })

  it('marks a platform with no timetable from the engine\'s trains 排班推演', async () => {
    freezeAt('2026-09-24T08:30:00')
    // 足够长，使引擎在无论什么发车间隔下都总有车在路上：两站的固定数据会留下没有任何车在途的空窗。
    stubAmap([subwayLineFixture(
      ['甲站', '乙站', '丙站', '丁站', '戊站', '己站', '庚站', '辛站', '壬站', '癸站', '子站', '丑站'],
    )])
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = await arrivals(app, '己站', '&order=6')
      expect(data.isExact).toBe(false)
      expect(data.arrivals.length).toBeGreaterThan(0)
      for (const row of data.arrivals) {
        expect(row.provenance).toBe('schedule_simulation')
        expect(row.provenance).not.toBe('live')
      }
    }
    finally {
      await app.close()
    }
  })
})
