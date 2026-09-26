import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE_CACHE_TTL_MS, TransitAggregator } from '@real-time-transport/transit-adapter'
import type { ITransitProvider } from '@real-time-transport/transit-adapter'
import { RefreshLiveResultSchema } from '@real-time-transport/shared'
import type { LiveLineStatus } from '@real-time-transport/shared'
import type { Database } from '../db/client.js'
import { TransitService } from '../services/transit.service.js'
import { buildApp } from '../app.js'

/**
 * F11 的服务端部分：`POST /api/transit/refresh`。
 *
 * 刷新只为一件事存在：现在就要一个确定的读数，并附上取得它的时刻。两个危险塑造了这个文件。
 *
 * 1. 它是唯一能绕过共享实时缓存的入口，因此也是用户能按需花掉上游配额的地方。于是有了按
 *    （用户, 数据类别）的冷却 —— 所有屏幕共享它，两块屏幕各刷一次不等于绕过 —— 以及一次
 *    不花任何上游调用的拒绝。
 * 2. 够不到上游的刷新必须说出来。为一个谁都没取得的读数报一个新鲜的 `lastUpdatedAt`，
 *    是本项目视为比报错更糟的失败模式。
 *
 * 18 秒的节奏就是实时缓存的 TTL：每块屏幕都经它读，所以它限定了读数能有多新 —— 窗口内的
 * 刷新按不出缓存本来就会给出的读数，所以 17 999 ms 拒绝、18 000 ms 放行。
 *
 * 101 / 202 / 甲路 / 乙路 是占位：本文件不出现真实线路、站点或上游 id。
 */

const LINE_ID = '101'
const OTHER_LINE_ID = '202'
const STATION_NAME = '乙路'

/** 下面每个时限都以它为起点计量的冻结时钟，本地时间。 */
const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

/**
 * 设计点名的节奏：实时缓存的 TTL。这里写成设计值，并在下面与缓存自己导出的常量比对，
 * 所以只调一边而另一边不动，过不了这个文件。
 */
const LIVE_CADENCE_MS = 18_000

/** 冻结墙上时钟。只伪造 `Date`：应用自己的定时器保持真实。 */
function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * 线上形式的实时读数：两站一车，没有轨迹，所以提供方从站表解出几何，恰好只花一次请求。
 */
const liveBody = JSON.stringify({
  jsonr: {
    data: {
      line: { name: LINE_ID, direction: 0, firstTime: '05:00', lastTime: '23:00' },
      stations: [
        { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
        { sId: 's2', sn: STATION_NAME, order: 2, lat: 39.91, lng: 116.41 },
      ],
      buses: [{ busId: 'v1', order: 2, distanceToWaitStn: 900, mileage: 300, speed: 6 }],
    },
  },
})

/**
 * 服务端能触到的每个上游的计数替身。所有提供方都经 `fetch` 发 HTTP，所以这里没有测试花真实配额。
 *
 * `unavailable` 给出提供方读不了的主体（没有 `jsonr.data`），不可达的上游就是这样到达服务的：
 * 提供方自己的 `try`/`catch` 把解析失败变成 null。中途翻转 `mode` 就是「上游消失了」的表达方式。
 */
function stubUpstream(): { urls: string[], mode: 'ok' | 'unavailable' } {
  const state: { urls: string[], mode: 'ok' | 'unavailable' } = { urls: [], mode: 'ok' }

  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    state.urls.push(href)

    if (!href.includes('encryptedLineDetail')) return body(JSON.stringify({ jsonr: { data: {} } }))
    return state.mode === 'ok' ? body(liveBody) : body(JSON.stringify({ jsonr: {} }))
  }))

  return state
}

/** 提供方按文本读的响应，它对这个上游就是这么读的。 */
function body(text: string) {
  return { ok: true, status: 200, text: async () => text }
}

/** 一个 Amap v3 成功信封，给地铁路径用的那些静态读取。 */
function amapOk(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * 记录自己被怎么读的提供方。
 *
 * 缓存从聚合器外面看不见 —— 缓存里的读数与刚取得的读数是同一个对象 —— 所以缓存做了什么，
 * 只能通过「提供方到底有没有被问」来观测。
 */
class CountingProvider implements ITransitProvider {
  readonly name = 'chelaile' as const
  readonly reads: string[] = []

  async searchLines(): Promise<never[]> {
    return []
  }

  async getLineDetail(): Promise<null> {
    return null
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    _cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus> {
    this.reads.push(options?.targetOrder ? `station ${options.targetOrder}` : 'whole-line')
    return {
      lineId,
      direction,
      buses: [],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: Date.now(),
    }
  }

  async isAvailable(): Promise<boolean> {
    return true
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

/** 按一次屏幕上的刷新入口。 */
function refresh(app: App, lines: unknown[], userId?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/transit/refresh',
    payload: userId ? { userId, lines } : { lines },
  })
}

function target(lineId: string) {
  return { lineId, direction: 0, cityCode: '027' }
}

describe('F11: one refresh per cooldown per user, shared by every screen', () => {
  it('refuses the second press inside the window, and spends no upstream call refusing', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const first = await refresh(app, [target(LINE_ID)])
      expect(first.statusCode, first.body).toBe(200)

      const firstData = first.json().data
      expect(firstData.throttled).toBe(false)
      expect(firstData.dataClass).toBe('live')
      expect(RefreshLiveResultSchema.safeParse(firstData).success, first.body).toBe(true)
      // 读数是在冻结时刻取得的，所以报出的时刻就是那个时刻，不是写出这个回答的时刻。
      expect(firstData.lastUpdatedAt).toBe(T0_MS)
      expect(firstData.lines).toEqual([
        { lineId: LINE_ID, direction: 0, lastUpdatedAt: T0_MS, dataSource: 'chelaile', isDegraded: false },
      ])
      expect(firstData.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      // 成功路径处在它刚刚花掉的窗口之内，所以等待时长是整个节奏：这里报 0，倒计时会说「可以刷新」，
      // 而按下去会被拒。
      expect(firstData.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)

      const spentByFirst = upstream.urls.length
      expect(spentByFirst).toBeGreaterThan(0)

      vi.setSystemTime(T0_MS + 5_000)
      const second = await refresh(app, [target(LINE_ID)])

      expect(second.statusCode, second.body).toBe(429)
      const data = second.json().data
      expect(data.throttled).toBe(true)
      expect(RefreshLiveResultSchema.safeParse(data).success, second.body).toBe(true)
      // 拒绝说明何时可以再试，既给时间点也给等待时长 —— 与响应头带的是同一个数。
      expect(second.headers['retry-after']).toBe('13')
      // 拒绝不是读取：第二次按不能碰到上游。
      expect(upstream.urls.length).toBe(spentByFirst)
      // 持有的读数时刻不变 —— 载荷从不宣称一个它并没有取得的「新鲜」。
      expect(data.lastUpdatedAt).toBe(T0_MS)
      expect(data.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      expect(data.retryAfterSeconds).toBe(13)
      expect(data.lines).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('shares one window between the home screen and the line page', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)

      // 一秒之后，另一块屏幕问另一条线路。
      // 按线路给窗口设键，两块屏幕就能各刷一次，按需的上游读取随之翻倍。
      vi.setSystemTime(T0_MS + 1_000)
      const second = await refresh(app, [target(OTHER_LINE_ID)])

      expect(second.statusCode, second.body).toBe(429)
      expect(second.json().data.throttled).toBe(true)
      expect(upstream.urls.length).toBe(1)
    }
    finally {
      await app.close()
    }
  })

  it('keeps a separate window per user', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)], 'user-a')).statusCode).toBe(200)
      const spentByFirst = upstream.urls.length

      vi.setSystemTime(T0_MS + 1_000)
      const second = await refresh(app, [target(LINE_ID)], 'user-b')

      expect(second.statusCode, second.body).toBe(200)
      expect(second.json().data.throttled).toBe(false)
      expect(upstream.urls.length).toBeGreaterThan(spentByFirst)
    }
    finally {
      await app.close()
    }
  })

  it('opens the window again at the cadence, and reports the NEW instant it obtained', async () => {
    // 节奏就是实时缓存自己的 TTL、也就是设计里的 18 秒：缓存与冷却是一个数，所以按钮永远按不了
    // 比每块屏幕所读数据变化得更快。
    expect(LIVE_CACHE_TTL_MS).toBe(LIVE_CADENCE_MS)

    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)
      const spentByFirst = upstream.urls.length

      // 比节奏早一毫秒：还是同一个窗口。
      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS - 1)
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(429)

      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      const third = await refresh(app, [target(LINE_ID)])

      expect(third.statusCode, third.body).toBe(200)
      expect(upstream.urls.length).toBeGreaterThan(spentByFirst)
      // 这里证明的是「窗口打开」：报出的时刻是新读数的，取自冷却到期的那一刻。它不证明失效 ——
      // 把 `invalidateLive` 换成空操作，这个测试照样通过；失效由数提供方读取次数的那些测试来测。
      expect(third.json().data.lines[0].lastUpdatedAt).toBe(T0_MS + LIVE_CADENCE_MS)
      expect(third.json().data.lastUpdatedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    }
    finally {
      await app.close()
    }
  })

  it('drops the per-station readings the home overview uses, not only the whole-line one', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const board = () => app.inject({
        method: 'GET',
        url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION_NAME)}/arrivals`
          + '?direction=0&count=3&cityCode=027&order=2',
      })

      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)

      // 站牌在窗口允许下一次按的时刻打开：它读自己的按站条目，站表来自线路详情缓存（长 TTL 数据），
      // 所以这里恰好花掉一次上游读取。
      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      expect((await board()).statusCode).toBe(200)
      const afterBoard = upstream.urls.length

      // 同一时刻，第二次按：它自己的读数是整条线路的那一次。
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(200)
      const afterRefresh = upstream.urls.length
      expect(afterRefresh).toBeGreaterThan(afterBoard)

      // 站牌紧接着在缓存窗口之内再问一次：它的条目刚被预热过；只丢掉整线键的那一次按下，会让这次
      // 读由那个条目作答，一个币都不花。
      expect((await board()).statusCode).toBe(200)
      expect(upstream.urls.length).toBe(afterRefresh + 1)
    }
    finally {
      await app.close()
    }
  })

  it('reads a line once even when the request names it twice', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      // 重复的线路是一个读数而不是两个：请求点名的是线路，重复不能把冷却所约束的上游读取翻倍。
      const res = await refresh(app, [target(LINE_ID), target(LINE_ID)])

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.lines).toHaveLength(1)
      expect(upstream.urls.length).toBe(1)
    }
    finally {
      await app.close()
    }
  })

  it('validates the request instead of guessing what to refresh', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp()
    try {
      const empty = await refresh(app, [])
      expect(empty.statusCode, empty.body).toBe(400)
      expect(empty.json().success).toBe(false)

      const tooMany = await refresh(app, Array.from({ length: 9 }, (_, i) => target(`10${i}`)))
      expect(tooMany.statusCode, tooMany.body).toBe(400)
    }
    finally {
      await app.close()
    }
  })
})

describe('F11: a refresh that obtained nothing says exactly that', () => {
  it('reports the previous instant — never the instant it answered — when the upstream cannot answer', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp()
    try {
      const good = await refresh(app, [target(LINE_ID)])
      expect(good.statusCode, good.body).toBe(200)
      expect(good.json().data.lastUpdatedAt).toBe(T0_MS)

      vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
      upstream.mode = 'unavailable'
      const failed = await refresh(app, [target(LINE_ID)])

      expect(failed.statusCode, failed.body).toBe(502)
      expect(failed.json().success).toBe(false)
      const data = failed.json().data
      expect(RefreshLiveResultSchema.safeParse(data).success, failed.body).toBe(true)
      expect(data.throttled).toBe(false)
      expect(data.lines).toEqual([
        { lineId: LINE_ID, direction: 0, lastUpdatedAt: null, dataSource: null, isDegraded: null },
      ])
      // 实际持有的那个读数的时刻：时钟又走了 18 秒，载荷不能跟着走。
      expect(data.lastUpdatedAt).toBe(T0_MS)
      expect(data.lastUpdatedAt).not.toBe(T0_MS + LIVE_CADENCE_MS)
      expect(data.nextAllowedAt).toBe(T0_MS + 2 * LIVE_CADENCE_MS)
      // 失败的读取与成功的一样花掉窗口，所以等待时长是整个节奏 —— 不是 0；否则这个 502 的响应体
      // 会报 0，而上面的时限在 18 秒之外。
      expect(data.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)
    }
    finally {
      await app.close()
    }
  })

  it('answers null — never the clock — when no refresh has ever obtained anything', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    upstream.mode = 'unavailable'
    const app = await buildApp()
    try {
      const failed = await refresh(app, [target(LINE_ID)])

      expect(failed.statusCode, failed.body).toBe(502)
      expect(failed.json().data.lastUpdatedAt).toBeNull()
      expect(failed.json().data.lines[0].lastUpdatedAt).toBeNull()
      expect(failed.json().data.lastUpdatedAt).not.toBe(T0_MS)
    }
    finally {
      await app.close()
    }
  })

  it('spends the window on a failed attempt, so a failure cannot become a retry loop', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    upstream.mode = 'unavailable'
    const app = await buildApp()
    try {
      expect((await refresh(app, [target(LINE_ID)])).statusCode).toBe(502)
      const spentByFailure = upstream.urls.length

      vi.setSystemTime(T0_MS + 500)
      const again = await refresh(app, [target(LINE_ID)])

      expect(again.statusCode, again.body).toBe(429)
      expect(upstream.urls.length).toBe(spentByFailure)
    }
    finally {
      await app.close()
    }
  })
})

/**
 * 刷新必须丢掉的缓存键，在拥有它们的那个层测。
 *
 * 首页概览经按站键读、整线读数经另一个键读，所以两个都得丢：只丢一个，按下按钮的那块屏幕会
 * 继续显示它正想替换掉的那个读数。缓存项与新鲜项从外面看是同一个对象，所以提供方读取次数是
 * 「键有没有被丢掉」唯一诚实的观测。
 */
describe('F11: a refresh drops both live cache key shapes', () => {
  it('re-reads the whole-line reading and the per-station reading', async () => {
    // 冻结时钟，条目就不会在测试中途过期：唯一能让下面这些读碰到提供方的，只有失效本身。
    freezeAt(T0)

    const provider = new CountingProvider()
    const aggregator = new TransitAggregator([provider])

    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toEqual(['whole-line', 'station 2'])

    // 窗口之内两次读数都来自缓存，什么都不花。
    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toHaveLength(2)

    aggregator.invalidateLive(LINE_ID, 0)

    // 两者都被再读一次：只丢掉整线键，最后一次读会命中缓存，这个列表就只有三项。
    await aggregator.getLiveStatus(LINE_ID, 0, '027')
    await aggregator.getLiveStatus(LINE_ID, 0, '027', { targetOrder: 2 })
    expect(provider.reads).toEqual(['whole-line', 'station 2', 'whole-line', 'station 2'])
  })
})

/**
 * 地铁实时路径的长 TTL 读取次数。
 *
 * 地铁实时路径经 `getLineDetail` 解出静态几何，所以丢掉那个缓存的刷新会重新从上游读线路 ——
 * 为不会变的数据花配额，F11 不允许。
 *
 * 替身 db 不返回任何缓存行，所以本套件证明的是：冻结时钟下刷新一次上游读取都不花。它并不证明
 * 哪一层缓存在作答 —— Amap 层有自己的 24 小时线路缓存，重读不经上游，所以即便
 * `invalidateLive` 连聚合器的 `detailCache` 一起丢，本套件仍然是绿的。那个性质的探测者是
 * 数读取次数的公交路径测试。
 */
describe('F11: a refresh never re-reads long-TTL line data', () => {
  const SUBWAY_LINE_ID = 'subway_027_88'

  const subwayLine = {
    id: 'BJ_88',
    name: '地铁88号线',
    type: '地铁线路',
    start_stop: '甲路',
    end_stop: STATION_NAME,
    start_time: '0600',
    end_time: '2200',
    busstops: [
      { id: 's1', name: '甲路', sequence: 1, location: '116.392540,39.924299' },
      { id: 's2', name: STATION_NAME, sequence: 2, location: '116.399999,39.930001' },
    ],
  }

  function stubStaticUpstream(): { urls: string[] } {
    const state = { urls: [] as string[] }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      state.urls.push(String(url))
      // 本套件计数的静态读取。在这里出现别的都是 bug。
      if (String(url).includes('/v3/bus/linename')) return amapOk({ buslines: [subwayLine] })
      return amapOk({})
    }))
    return state
  }

  it('leaves the static line cache intact while dropping the live readings', async () => {
    freezeAt(T0)
    const upstream = stubStaticUpstream()

    const db = {
      getCachedLine: async () => null,
      upsertCachedLine: async () => {},
      getUserSettings: async () => null,
    } as unknown as Database

    const service = new TransitService(db, { amapKey: 'test-key' })
    try {
      const detail = await service.getLineDetail(SUBWAY_LINE_ID, 0, '027')
      expect(detail?.stops.length).toBe(2)
      const staticReads = upstream.urls.length
      expect(staticReads).toBe(1)

      // 第二次读确实由缓存作答。
      await service.getLineDetail(SUBWAY_LINE_ID, 0, '027')
      expect(upstream.urls.length).toBe(staticReads)

      const outcome = await service.refreshLive({ userId: 'user-a', lines: [target(SUBWAY_LINE_ID)] })

      expect(outcome.outcome).toBe('ok')
      expect(upstream.urls.length).toBe(staticReads)

      // 刷新产生的读数就是实时路径从同一份缓存详情推出的那个，没有为此重读任何东西。
      // 它的来源跟着它走：这份读数是引擎自己的产出而非某个源取得的，`dataSource` 点名引擎，F4 据此
      // 标 排班推演。`isDegraded` 不是表示这件事的字段 —— 它说的是作答提供方替别的源顶了班。
      expect(outcome.result.lines).toEqual([
        {
          lineId: SUBWAY_LINE_ID,
          direction: 0,
          lastUpdatedAt: T0_MS,
          dataSource: 'subway_schedule',
          isDegraded: false,
        },
      ])
      expect(outcome.result.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    }
    finally {
      service.stop()
    }
  })
})
