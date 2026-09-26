import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F13 精确时刻表与推演的分工，走在站牌的路由上：`GET /lines/:lineId/stations/:stationName/arrivals`。
 *
 * 三件事：已转录的车站由注册表作答、同一线路的其余车站仍按「每站 135 秒」推演、两者同时可得时
 * 以精确为准。
 *
 * 「以精确为准」只能靠答复自身的形状钉住：`isExact` 为真、每行标 `exact_timetable`、没有车辆 id，
 * 而**同一刻同一条线路**的未转录车站在同一份夹具下确实给出引擎产出的车（下面的对照）——
 * 因此转录站那份答复不是「这条线路没有实时数据」，是这一站选择了注册表。
 * 上计数器在这里不是检测者：地铁的实时路径经引擎解析已缓存的线路详情，一次上游请求都不发，
 * 所以「有没有读上游」分不出这两个分支（这一点写在代码里，免得下一个人以为它在看）。
 *
 * 地铁7号线 / 群芳是注册表里唯一有官方时刻表的站点（`subway-timetables.data.ts`，不得手改），
 * 因此这里用它；其余站名是占位。上游一律桩掉。
 */

const LINE_ID = 'subway_027_7'
/** 注册表覆盖的站：它的方向 1 工作日表带着备注。 */
const TRANSCRIBED = '群芳'
/** 表里方向 1 的备注原文。 */
const NOTE = '0:16 半程至高楼金'
/** 同一条线路上没被转录的站，按站序定位（方向 0 的站序 4）。 */
const UNTRANSCRIBED = '丁占位'

/** 六个站的一条地铁线：表里只有第 1 站在注册表里。 */
const STOPS = ['群芳', '乙占位', '丙占位', UNTRANSCRIBED, '戊占位', '己占位']

/** 一份载有该站的线路夹具，站台才能解析出来。 */
const line = {
  id: 'BJ_7',
  name: '地铁7号线',
  type: '地铁线路',
  start_stop: STOPS[0],
  end_stop: STOPS[STOPS.length - 1],
  // 不写 start_time / end_time：精确那条路径用表自己的时刻。
  busstops: STOPS.map((name, i) => ({
    id: `s${i + 1}`,
    name,
    sequence: i + 1,
    location: `${116.39254 + i / 1000},${39.924299 + i / 1000}`,
  })),
}

function freezeAt(localIso: string): void {
  // 只伪造 `Date`：应用自己的定时器保持真实。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

describeEachStore('F13 精确时刻表优先于推演', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    // 地铁线路详情经高德解析：这条键在场才会有那次调用，而 fetch 已被 harness 桩掉。
    // 生成车辆（TRANSIT_SIMULATION）是另一条产数据的路径，这里关掉 —— 否则「引擎没产出车」
    // 会被它悄悄补上，读数不再来自被桩掉的那个上游。
    vi.stubEnv('AMAP_MAPS_API_KEY', 'test-key')
    vi.stubEnv('TRANSIT_SIMULATION', 'false')
    vi.stubEnv('DEMO_MODE', 'false')
    api = await createApiHarness({ store })

    // 地铁的静态读取：线路名是唯一的入口，其余端点（站点周边等）一律给空。
    api.upstream.mockImplementation(async (url: unknown) => {
      const href = String(url)
      if (href.includes('/v3/bus/linename')) return amapOk({ buslines: [line] })
      if (href.includes('/v3/place/around')) return amapOk({ pois: [] })
      return amapOk({})
    })
  })

  afterEach(async () => {
    await api?.close()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  /** 一个 Amap v3 成功信封。 */
  const amapOk = (payload: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  })

  /** 站台的答复形状（本文件只断言这几项）。 */
  interface Arrivals {
    isExact: boolean
    note: string | null
    arrivals: Array<{ time?: string, etaSeconds?: number, provenance?: string | null, stopsAway?: number, busId?: string }>
    operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
  }

  const arrivalsOf = async (stationName: string, direction: number, order?: number) => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(stationName)}/arrivals`
        + `?direction=${direction}&count=6&cityCode=027${order === undefined ? '' : `&order=${order}`}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as Arrivals
  }

  it('已转录的车站由注册表作答', async () => {
    // 00:05 落在该站自己的运营日尾巴里：表里剩下的两班车就是答复。
    freezeAt('2026-09-25T00:05:00')

    const data = await arrivalsOf(TRANSCRIBED, 1)

    expect(data.isExact).toBe(true)
    // 每行都是表自己的发车：没有车辆 id，也没有「还有几站」这类观测。
    expect(data.arrivals).toEqual([
      { time: '00:08', etaSeconds: 180, provenance: 'exact_timetable' },
      { time: '00:16', etaSeconds: 660, provenance: 'exact_timetable' },
    ])
    expect(data.arrivals.every(row => row.busId === undefined && row.stopsAway === undefined)).toBe(true)
    // 时刻表自己的注意事项随它所限定的发车一起走。
    expect(data.note).toBe(NOTE)
    // 运营状态取自这个站自己的首末班，不是线路的。
    expect(data.operatingStatus).toEqual({ state: 'operating', firstDeparture: '05:48', lastDeparture: '00:16' })
  })

  it('同一线路同一刻：转录的车站答精确，未转录的车站答推演', async () => {
    freezeAt('2026-09-24T12:00:00')

    // 未转录的那个站：注册表没有它，于是走实时/推演那条路径，行是引擎产出的车。
    const simulated = await arrivalsOf(UNTRANSCRIBED, 0, 4)
    expect(simulated.isExact).toBe(false)
    expect(simulated.arrivals.length).toBeGreaterThan(0)
    expect(simulated.arrivals.every(row => row.provenance === 'schedule_simulation')).toBe(true)
    expect(simulated.arrivals.every(row => typeof row.busId === 'string')).toBe(true)
    // 没被转录的站台没有自己的时刻表，因此也没有可声明的注意事项（不得借用别站的）。
    expect(simulated.note).toBeNull()

    // 同一刻、同一条线路的转录站：以精确为准 —— 上面那个站证明这一条的实时路径此刻有车可答，
    // 所以这里答的只能是这一站自己的官方表。
    const exact = await arrivalsOf(TRANSCRIBED, 1)
    expect(exact.isExact).toBe(true)
    expect(exact.arrivals.length).toBeGreaterThan(0)
    expect(exact.arrivals.every(row => row.provenance === 'exact_timetable')).toBe(true)
    expect(exact.arrivals.every(row => row.busId === undefined)).toBe(true)
    expect(exact.note).toBe(NOTE)
  })

  it('未转录的车站按每站 135 秒推演：行的分钟落在模型自己的刻度上', async () => {
    freezeAt('2026-09-24T12:00:00')

    // 先钉引擎自己的常量：整线读数（不带目标站）报的是到终点站的耗时，它是 135 的整数倍
    // （末段 0 站时兜底为 60 秒）。
    const live = await api.inject({ method: 'GET', url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027` })
    expect(live.statusCode, live.body).toBe(200)

    const buses = live.json().data.buses as Array<{ travelTimeSec: number }>
    expect(buses.length).toBeGreaterThan(0)
    for (const bus of buses) {
      expect(typeof bus.travelTimeSec).toBe('number')
      const isMultiple = bus.travelTimeSec === 60 || bus.travelTimeSec % 135 === 0
      expect(isMultiple, `整线耗时 ${bus.travelTimeSec} 不是每站 135 秒的刻度`).toBe(true)
    }

    // 再看站台那一面：引擎给每一行的是「到目标站还要几站 × 135 秒」，故分钟数严格落在
    // （剩余站数 × 135, (剩余站数 + 1) × 135] 之内 —— 两侧都紧，换个每站秒数就出界。
    const data = await arrivalsOf(UNTRANSCRIBED, 0, 4)
    expect(data.arrivals.length).toBeGreaterThan(0)

    for (const row of data.arrivals) {
      const stopsAway = row.stopsAway ?? 0
      expect(row.etaSeconds!).toBeGreaterThan(135 * stopsAway)
      expect(row.etaSeconds!).toBeLessThanOrEqual(135 * (stopsAway + 1))
    }
  })
})
