import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommuteProfileSchema, OperatingStatusSchema } from '@real-time-transport/shared'
import { buildApp } from '../app.js'

/**
 * F3：营运状态，五个冻结的时钟。
 *
 * 这个状态用线路自己的首末班时刻回答「今天还有没有车」—— 不看墙上时钟，也不用内置的
 * 05:30/23:00 规则 —— 而首末班是哪两个取决于作答的分支。这个站有登记的分钟级时刻表，
 * 所以作答的是精确时刻表分支，这里每条断言都由表自己的时刻决定；夹具的上游
 * `start_time` / `end_time` 在这条路径上从不被查。实时分支由下面自己的块覆盖。
 *
 * 五个时刻都是边界：两个在服务日内，两个过了午夜，还有 04:00 —— 营运日自身在那里翻页。
 */

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'

/** 该站在登记表里的时刻，状态就是从那里来的。 */
const FIRST_DEPARTURE = '05:16'
const LAST_DEPARTURE = '23:06'

/**
 * 两站的 GCJ-02 地铁线路，引擎才能从替身建出详情。
 *
 * 下面五个时钟查询的那个站有登记的分钟级时刻表，所以这个夹具上的 `start_time` /
 * `end_time` 只是带着、从不被读：状态来自那张表。真正会被读的时刻声明在下面那个没有
 * 表的线路夹具上。
 */
const subwayLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: STATION_NAME,
  end_stop: '乙站',
  start_time: '0516',
  end_time: '2306',
  busstops: [
    { id: 's1', name: STATION_NAME, sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
  ],
}

/**
 * 实时分支的情形：时刻表注册表里没有条目的线路，于是状态由它自己静态详情携带的首末班
 * 推导。
 *
 * `LIVE_FIRST` / `LIVE_LAST` 故意不等于登记表的 05:16 / 23:06，这样针对它们的断言不可能
 * 靠读那张表通过 —— 而查询的站也是任何表都没有覆盖的。
 */
const LIVE_LINE_ID = 'subway_027_88'
const LIVE_STATION_NAME = '丙站'
const LIVE_FIRST = '06:00'
const LIVE_LAST = '22:00'

const upstreamHoursLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: LIVE_STATION_NAME,
  start_time: '0600',
  end_time: '2200',
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: LIVE_STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
  ],
}

/** 同一条线路，但完全没有时刻：详情没带的，它就说没有。 */
const upstreamWithoutHours = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: LIVE_STATION_NAME,
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: LIVE_STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
  ],
}

function ok(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * 服务端能触达的每个上游的带计数替身：这里没有测试花真实配额，状态读的营运时刻都是
 * 夹具的。`line` 是任何线路搜索会答的东西，所以用例可以声明自己的时刻。
 */
function stubUpstream(line: Record<string, unknown> = subwayLine): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/v3/bus/linename')) return ok({ buslines: [line] })
    if (href.includes('/v3/place/around')) return ok({ pois: [] })
    return ok({})
  }))
}

/**
 * 冻结墙上时钟。只伪造 `Date`：定时器保持真实，因为被测应用在轮询、provider 也用请求
 * 超时。
 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type App = Awaited<ReturnType<typeof buildApp>>

async function arrivals(app: App, lineId = LINE_ID, stationName = STATION_NAME) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/transit/lines/${lineId}/stations/${encodeURIComponent(stationName)}/arrivals`
      + '?direction=0&count=3&cityCode=027',
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().data as {
    arrivals: Array<{ etaSeconds: number }>
    operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
  }
}

async function statusAt(localIso: string) {
  stubUpstream()
  freezeAt(localIso)
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    return (await arrivals(app)).operatingStatus
  }
  finally {
    await app.close()
  }
}

async function liveStatusAt(localIso: string, line: Record<string, unknown> = upstreamHoursLine) {
  stubUpstream(line)
  freezeAt(localIso)
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    return (await arrivals(app, LIVE_LINE_ID, LIVE_STATION_NAME)).operatingStatus
  }
  finally {
    await app.close()
  }
}

describe('F3: the operating state is stated, not implied, at every hour that matters', () => {
  it('is 运营中 at 08:30, mid-morning on a running line', async () => {
    expect(await statusAt('2026-09-24T08:30:00'))
      .toEqual({ state: 'operating', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 运营中 at 22:00, inside the evening window', async () => {
    expect(await statusAt('2026-09-24T22:00:00'))
      .toEqual({ state: 'operating', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 已过末班 at 23:59, naming the last departure that has gone', async () => {
    expect(await statusAt('2026-09-24T23:59:00'))
      .toEqual({ state: 'after_last', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 已过末班 at 01:00 — after midnight belongs to the previous operating day', async () => {
    expect(await statusAt('2026-09-24T01:00:00'))
      .toEqual({ state: 'after_last', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })

  it('is 首班前 at 04:00, where the operating day rolls over', async () => {
    expect(await statusAt('2026-09-24T04:00:00'))
      .toEqual({ state: 'before_first', firstDeparture: FIRST_DEPARTURE, lastDeparture: LAST_DEPARTURE })
  })
})

/**
 * F3 的实时分支 —— `transit.service.ts` 里另外两处 `operatingStatus`，每当查询的站没有
 * 登记表时就会走到。那里状态报的首末班就是线路自己静态详情携带的，而详情一个都没带时
 * 必须答 未知，而不是借用某个窗口。
 *
 * 每条断言都按值点名时刻，所以把登记表的 05:16 / 23:06 从同一条路由传过来也无法满足
 * 它们。
 */
describe('F3: with no published table, the state comes from the detail\'s own hours', () => {
  it('is 首班前 at 04:00, before the first departure the detail declares', async () => {
    expect(await liveStatusAt('2026-09-24T04:00:00'))
      .toEqual({ state: 'before_first', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('is 运营中 at 08:30, inside those declared hours', async () => {
    expect(await liveStatusAt('2026-09-24T08:30:00'))
      .toEqual({ state: 'operating', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('is 已过末班 at 23:59, after the last departure the detail declares', async () => {
    expect(await liveStatusAt('2026-09-24T23:59:00'))
      .toEqual({ state: 'after_last', firstDeparture: LIVE_FIRST, lastDeparture: LIVE_LAST })
  })

  it('states 运营时间未知 — never 运营中 — when the detail declares no hours', async () => {
    // 与上面「运营中」那例同一个时钟：唯一的差别是详情
    // 不带时刻，而这个差别正是答案必须体现的。
    expect(await liveStatusAt('2026-09-24T08:30:00', upstreamWithoutHours))
      .toEqual({ state: 'unknown', firstDeparture: null, lastDeparture: null })
  })
})

describe('F3: every arrivals answer carries a well-formed operating status', () => {
  it('states a schema-valid status even when no vehicle is in the list', async () => {
    // 01:00：什么都没在跑，答案把它作为一个状态说出来 ——
    // 这一行绝不留给客户端从空数组里去猜。
    stubUpstream()
    freezeAt('2026-09-24T01:00:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = await arrivals(app)
      expect(OperatingStatusSchema.safeParse(data.operatingStatus).success).toBe(true)
    }
    finally {
      await app.close()
    }
  })
})

describe('F3: the commute profile states facts and carries no dead field', () => {
  it('answers with a mode and a factual slot, and no 恒为 0 的 activeDirection', async () => {
    stubUpstream()
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const data = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data
      // `activeDirection` 曾被硬编码为 0，是个没有含义的字段；
      // 网页端没有任何地方读它，于是它从载荷
      // 和契约里都消失了。
      expect(data).not.toHaveProperty('activeDirection')
      expect(CommuteProfileSchema.safeParse(data).success).toBe(true)
    }
    finally {
      await app.close()
    }
  })

  it('names the window it is in, without advertising it', async () => {
    stubUpstream()
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // 这个用户没保存过任何设置，而 08:30 正落在内置早高峰
      // 窗口内 —— 这恰恰是他不能被告知「早通勤时段」的原因：
      // 那个会包含他的窗口并不存在。读取把这件事说出来。
      const unset = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data
      expect(unset.windowState).toBe('unset')
      expect(unset.mode).not.toBe('work')
      expect(unset.description).toBe('未设置通勤时段')

      // 真的存了窗口时，文案点名这个窗口，别的什么都不加：
      // 不是模式、不是目的地、不是情绪。
      await app.inject({
        method: 'PATCH',
        url: '/api/transit/settings',
        payload: { morningStart: '08:00', morningEnd: '09:00' },
      })
      const data = (await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })).json().data as {
        mode: string
        description: string
        windowState: string
      }
      expect(data.windowState).toBe('stored')
      expect(data.mode).toBe('work')
      expect(data.description).toBe('早通勤时段')
    }
    finally {
      await app.close()
    }
  })
})
