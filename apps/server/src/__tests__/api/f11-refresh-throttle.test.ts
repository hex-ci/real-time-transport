import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LIVE_CACHE_TTL_MS } from '@real-time-transport/transit-adapter'
import { RefreshLiveResultSchema } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F11 手动刷新：`POST /api/transit/refresh` 的冷却、失效范围与拒绝反馈。
 *
 * 这一层要看的是「上游到底被读了几次」—— 缓存里的读数与刚取得的读数是同一个对象，从外面
 * 看不见差别，因此唯一诚实的观测是 `api.upstream` 被调用的次数：窗口内的按下必须是 0 次，
 * 一次刷新对同一条线路必须只花 1 次。
 *
 * 冷却就是实时缓存自己的 TTL（`LIVE_CACHE_TTL_MS`）：能比数据变化更快按下的按钮就是关于
 * 新鲜度的谎言，故边界按毫秒钉住 —— `TTL-1` 拒、`TTL` 放行，且两边都对着聚合器导出的那个常量。
 *
 * 101 / 202 / 甲站 / 乙站 是占位：本文件不出现真实线路、站点或上游 id。
 */

const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

/** 设计点名的节奏：实时缓存的 TTL。下面与聚合器自己导出的常量比对，只调一边过不了本文件。 */
const LIVE_CADENCE_MS = 18_000

function freezeAt(localIso: string): void {
  // 只伪造 `Date`：应用自己的定时器保持真实。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

describeEachStore('F11 刷新节流', (store) => {
  let api: ApiHarness
  let LINE_A: string
  let LINE_B: string

  beforeEach(async () => {
    // 生成车辆（TRANSIT_SIMULATION）是另一条产数据的路径，这里关掉 —— 否则「上游没答」
    // 会被它悄悄补上，读数不再来自那个被桩掉的上游。
    vi.stubEnv('TRANSIT_SIMULATION', 'false')
    vi.stubEnv('DEMO_MODE', 'false')
    api = await createApiHarness({ store })
    LINE_A = api.fixtureId('line-a')
    LINE_B = api.fixtureId('line-b')
  })

  afterEach(async () => {
    await api?.close()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  /** 线上形式的实时读数：两站一车，没有轨迹，所以提供方从站表解出几何，恰好只花一次请求。 */
  const liveBody = () => JSON.stringify({
    jsonr: {
      data: {
        line: { name: LINE_A, direction: 0, firstTime: '05:00', lastTime: '23:00' },
        stations: [
          { sId: 's1', sn: '甲站', order: 1, lat: 39.9, lng: 116.4 },
          { sId: 's2', sn: '乙站', order: 2, lat: 39.91, lng: 116.41 },
        ],
        buses: [{ busId: 'fixture-v1', order: 2, distanceToWaitStn: 900, mileage: 300, speed: 6 }],
      },
    },
  })

  /**
   * 上游替身。`unavailable` 给出提供方读不了的主体（没有 `jsonr.data`）—— 中途翻转它就是
   * 「上游消失了」的表达方式。所有提供方都经 `fetch` 发 HTTP，因此没有测试花真实配额。
   */
  function stubUpstream() {
    const state = { mode: 'ok' as 'ok' | 'unavailable' }
    api.upstream.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => (state.mode === 'ok' ? liveBody() : JSON.stringify({ jsonr: {} })),
    }))
    return state
  }

  const calls = () => api.upstream.mock.calls.length

  const refresh = (lines: Array<{ lineId: string }>, userId?: string) => api.inject({
    method: 'POST',
    url: '/api/transit/refresh',
    payload: { lines: lines.map(line => ({ direction: 0, cityCode: '027', ...line })), ...(userId ? { userId } : {}) },
  })

  const target = (lineId: string) => [{ lineId }]

  /** 站牌读自己的按站条目；首页概览走的就是它。 */
  const board = () => api.inject({
    method: 'GET',
    url: `/api/transit/lines/${LINE_A}/stations/${encodeURIComponent('乙站')}/arrivals`
      + '?direction=0&count=3&cityCode=027&order=2',
  })

  const lineDetail = () => api.inject({ url: `/api/transit/lines/${LINE_A}?direction=0&cityCode=027` })

  it('冷却就是实时缓存的 TTL，且一次刷新成功后窗口立刻关上', async () => {
    expect(LIVE_CACHE_TTL_MS).toBe(LIVE_CADENCE_MS)

    freezeAt(T0)
    stubUpstream()
    const first = await refresh(target(LINE_A))
    expect(first.statusCode, first.body).toBe(200)

    const data = first.json().data
    expect(data.throttled).toBe(false)
    expect(data.dataClass).toBe('live')
    expect(RefreshLiveResultSchema.safeParse(data).success, first.body).toBe(true)
    // 读数是在冻结时刻取得的，于是报出的时刻就是那个时刻，不是写出这个回答的时刻。
    expect(data.lastUpdatedAt).toBe(T0_MS)
    expect(data.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    // 成功路径处在它刚刚花掉的窗口之内，等待时长因此是整个节拍 —— 报 0 会让倒计时说
    // 「可以刷新」，而按下去会被拒。
    expect(data.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)
    expect(data.lines).toEqual([
      { lineId: LINE_A, direction: 0, lastUpdatedAt: T0_MS, dataSource: 'chelaile', isDegraded: false },
    ])
    const spent = calls()
    expect(spent).toBeGreaterThan(0)
  })

  it('窗口之内（TTL−1）拒绝：429 与 Retry-After 同源，且一次上游都不读', async () => {
    freezeAt(T0)
    stubUpstream()
    await refresh(target(LINE_A))
    const spent = calls()

    vi.setSystemTime(T0_MS + LIVE_CADENCE_MS - 1)
    const refused = await refresh(target(LINE_A))

    expect(refused.statusCode, refused.body).toBe(429)
    expect(refused.headers['retry-after']).toBe('1')
    const data = refused.json().data
    expect(RefreshLiveResultSchema.safeParse(data).success, refused.body).toBe(true)
    expect(data.throttled).toBe(true)
    expect(data.retryAfterSeconds).toBe(1)
    // 拒绝不是读取：第二次按下不能碰到上游。
    expect(calls(), '窗口内的按下读了一次上游').toBe(spent)
    // 拒绝不等于失忆：仍带上次取到的时刻与同一个截止时刻，别的什么都没有。
    expect(data.lastUpdatedAt).toBe(T0_MS)
    expect(data.nextAllowedAt).toBe(T0_MS + LIVE_CADENCE_MS)
    expect(data.lines).toEqual([])
  })

  it('窗口之外（TTL）放行，并重读上游', async () => {
    freezeAt(T0)
    stubUpstream()
    await refresh(target(LINE_A))
    const spent = calls()

    vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
    const again = await refresh(target(LINE_A))

    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().data.throttled).toBe(false)
    expect(calls(), '窗口打开后没有重读上游').toBeGreaterThan(spent)
    // 报出的时刻是新读数的，取自冷却到期的那一刻 —— 时钟走了 18 秒，读数就是那一刻的。
    expect(again.json().data.lines[0].lastUpdatedAt).toBe(T0_MS + LIVE_CADENCE_MS)
  })

  it('两块屏幕共用同一个窗口：命名另一条线路也在这一个冷却之内', async () => {
    freezeAt(T0)
    stubUpstream()
    expect((await refresh(target(LINE_A))).statusCode).toBe(200)
    const spent = calls()

    // 按线路给窗口设键，两块屏幕就能各刷一次，按需的上游读取随之翻倍。
    vi.setSystemTime(T0_MS + 1_000)
    const other = await refresh(target(LINE_B))

    expect(other.statusCode, other.body).toBe(429)
    expect(other.json().data.throttled).toBe(true)
    expect(calls()).toBe(spent)
  })

  it('一次刷新对同一条线路只读一次上游，重复点名不翻倍', async () => {
    freezeAt(T0)
    stubUpstream()
    const res = await refresh([{ lineId: LINE_A }, { lineId: LINE_A }])

    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.lines).toHaveLength(1)
    expect(calls(), '重复点名的线路被读了两次').toBe(1)
  })

  it('刷新丢掉两类实时键：按站读数与整线读数都真的重取', async () => {
    freezeAt(T0)
    stubUpstream()
    // 整线读数进缓存。
    expect((await refresh(target(LINE_A))).statusCode).toBe(200)
    const afterRefresh = calls()

    // 窗口允许下一次按的时刻：站牌读自己的按站条目，站表来自线路详情缓存（长 TTL 数据），
    // 因此这里恰好花掉「线路详情 + 按站实时」两次。
    vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
    expect((await board()).statusCode).toBe(200)
    const afterBoard = calls()
    expect(afterBoard).toBe(afterRefresh + 2)

    // 同一时刻再按一次：它自己的读数是整条线路的那一次。
    expect((await refresh(target(LINE_A))).statusCode).toBe(200)
    const afterSecondRefresh = calls()
    expect(afterSecondRefresh).toBe(afterBoard + 1)

    // 站牌紧接着在缓存窗口之内再问一次。只丢掉整线键的话，这次读会由刚预热的按站条目作答，
    // 一个币都不花 —— 于是下面这一句就是「按站键也被丢了」的判据。
    expect((await board()).statusCode).toBe(200)
    expect(calls(), '按站条目没被丢掉，这次读没碰上游').toBe(afterSecondRefresh + 1)
  })

  it('刷新不重读长 TTL 的线路数据', async () => {
    freezeAt(T0)
    stubUpstream()

    expect((await lineDetail()).statusCode).toBe(200)
    const afterDetail = calls()
    expect(afterDetail).toBe(1)
    // 线路详情按存储缓存：SQL 路径下就是 cached_transit_lines 里的那一行。
    expect(await api.rows('SELECT line_id FROM cached_transit_lines'))
      .toHaveLength(store === 'sql' ? 1 : 0)

    expect((await refresh(target(LINE_A))).statusCode).toBe(200)
    // 刷新只为实时数据花钱：线路站序与几何不在刷新范围内。
    expect(calls(), '刷新连线路详情一起重读了').toBe(afterDetail + 1)

    expect((await lineDetail()).statusCode).toBe(200)
    expect(calls(), '线路详情没有由缓存作答').toBe(afterDetail + 1)
    expect(await api.rows('SELECT line_id FROM cached_transit_lines'))
      .toHaveLength(store === 'sql' ? 1 : 0)
  })

  it('上游答不出来时是 502，且绝不把作答时刻当成读数时刻', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    expect((await refresh(target(LINE_A))).statusCode).toBe(200)

    vi.setSystemTime(T0_MS + LIVE_CADENCE_MS)
    upstream.mode = 'unavailable'
    const failed = await refresh(target(LINE_A))

    expect(failed.statusCode, failed.body).toBe(502)
    expect(failed.json().success).toBe(false)
    const data = failed.json().data
    expect(RefreshLiveResultSchema.safeParse(data).success, failed.body).toBe(true)
    expect(data.throttled).toBe(false)
    expect(data.lines).toEqual([
      { lineId: LINE_A, direction: 0, lastUpdatedAt: null, dataSource: null, isDegraded: null },
    ])
    // 实际持有的那个读数的时刻：时钟又走了 18 秒，载荷不能跟着走。
    expect(data.lastUpdatedAt).toBe(T0_MS)
    expect(data.lastUpdatedAt).not.toBe(T0_MS + LIVE_CADENCE_MS)
    // 失败的读取与成功的一样花掉窗口，因此等待时长是整个节拍，不是 0。
    expect(data.retryAfterSeconds).toBe(LIVE_CADENCE_MS / 1000)
    expect(data.nextAllowedAt).toBe(T0_MS + 2 * LIVE_CADENCE_MS)
  })
})
