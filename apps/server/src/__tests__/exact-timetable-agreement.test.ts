import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F-B + F-C 走真实路由：精确时刻表的答案必须与自己一致，并且必须带上它持有的提醒。
 *
 * 这些是边界时刻，跑在应用真正调用的路由上（每个状态切换前后各一小时），所以断言问的是
 * 站牌答什么，而不是某个辅助函数的返回值。
 */

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'
/** 开往环球度假区：这个方向的记录自相矛盾。 */
const DIRECTION = 1
/** 表里方向 1 的备注原文。 */
const NOTE = '0:16 半程至高楼金'

/** 一份载有该站的 7号线 夹具，站台才能解析出来。 */
const line = {
  id: 'BJ_7',
  name: '地铁7号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '环球度假区',
  // 不写 start_time / end_time：精确这条路径用表自己的时刻。
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '环球度假区', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** Amap v3 成功响应外壳。这里不花真实配额。 */
function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/** 注册表里没有时刻表的一条线路：实时分支在这里作答。 */
const line88 = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: '丙站',
  start_time: '0600',
  end_time: '2200',
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '丙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

function stubUpstream(answered: Record<string, unknown> = line): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/v3/bus/linename')) return ok({ buslines: [answered] })
    if (href.includes('/v3/place/around')) return ok({ pois: [] })
    return ok({})
  }))
}

/** 冻结墙上时钟。只伪造 `Date`：定时器保持真实。 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function arrivalsAt(
  localIso: string,
  direction = DIRECTION,
  query: { lineId?: string, stationName?: string, answered?: Record<string, unknown> } = {},
) {
  stubUpstream(query.answered)
  freezeAt(localIso)
  const lineId = query.lineId ?? LINE_ID
  const stationName = query.stationName ?? STATION_NAME
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/${lineId}/stations/${encodeURIComponent(stationName)}/arrivals`
        + `?direction=${direction}&count=6&cityCode=027`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as {
      isExact: boolean
      arrivals: Array<{ time: string }>
      operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
      note: string | null
    }
  }
  finally {
    await app.close()
  }
}

describe('F-B: the board never says service ended while listing departures', () => {
  it('is 运营中 at 00:05, where the tail departures are still to come', async () => {
    const data = await arrivalsAt('2026-09-25T00:05:00')
    expect(data.isExact).toBe(true)
    expect(data.arrivals.map(a => a.time)).toEqual(['00:08', '00:16'])
    expect(data.operatingStatus.state).toBe('operating')
    // 报出的时刻就是列表可以对照的那一刻。
    expect(data.operatingStatus.firstDeparture).toBe('05:48')
    expect(data.operatingStatus.lastDeparture).toBe('00:16')
  })

  it('is 已过末班 at 00:20, after the last departure the list has', async () => {
    const data = await arrivalsAt('2026-09-25T00:20:00')
    expect(data.arrivals).toEqual([])
    expect(data.operatingStatus.state).toBe('after_last')
    expect(data.operatingStatus.lastDeparture).toBe('00:16')
  })
})

describe('F-B: the board never says 未到首班 beside a departure', () => {
  it('is 运营中 at 05:48, the first departure its own table lists', async () => {
    const data = await arrivalsAt('2026-09-24T05:48:00')
    expect(data.arrivals[0]!.time).toBe('05:48')
    expect(data.operatingStatus.state).toBe('operating')
    expect(data.operatingStatus.firstDeparture).toBe('05:48')
  })

  it('is 未到首班 at 05:47, before it — with nothing to list', async () => {
    const data = await arrivalsAt('2026-09-24T05:47:00')
    expect(data.arrivals).toEqual([])
    expect(data.operatingStatus.state).toBe('before_first')
  })
})

describe('F-C: the platform\'s own caveat reaches the answer', () => {
  it('carries the half-route caveat the table holds for this direction', async () => {
    const data = await arrivalsAt('2026-09-24T23:50:00')
    expect(data.note).toBe(NOTE)
  })

  it('carries it while the last departures are listed, and after they have gone', async () => {
    // 这条提醒说的是当天剩余的服务，所以两个时刻都在 ——
    // 列表空着的时候恰恰是它最要紧的时候。
    expect((await arrivalsAt('2026-09-25T00:05:00')).note).toBe(NOTE)
    expect((await arrivalsAt('2026-09-25T00:20:00')).note).toBe(NOTE)
  })

  it('states no caveat on a path that holds none', async () => {
    // 方向 0 的周末表根本没有 note（空），所以这个字段
    // 回来是 null，而不是一个让渲染层还要去判空的
    // 空串。2026-09-26 是周六。
    const weekend = await arrivalsAt('2026-09-26T12:00:00', 0)
    expect(weekend.isExact).toBe(true)
    expect(weekend.note).toBeNull()

    // 注册表里没有时刻表的线路：实时路径自己不持有备注，
    // 也不许借用另一条线路的。
    const live = await arrivalsAt('2026-09-24T12:00:00', 0, {
      lineId: 'subway_027_88',
      stationName: '丙站',
      answered: line88,
    })
    expect(live.isExact).toBe(false)
    expect(live.note).toBeNull()
  })

  it('carries the direction\'s OWN caveat, not a shared one', async () => {
    // 方向 0 的工作日备注是另一句话，讲的是另一些发车。
    // 两个方向、两条提醒、一个字段。
    const east = await arrivalsAt('2026-09-24T23:50:00', 0)
    expect(east.note).toBe('晚间两班半程至双合')
    expect(east.note).not.toBe(NOTE)
  })
})
