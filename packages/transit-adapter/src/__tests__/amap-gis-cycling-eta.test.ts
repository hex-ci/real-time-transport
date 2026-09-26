import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmapGisService } from '../index.js'

/**
 * 接驳定价的第二条路由：骑行。
 *
 * 步行在 v3、骑行在 v4，两个信封不同（v3 带 `status`/`infocode` 成功码与
 * `route.paths[]`；v4 成功时只有 `data.paths[]`，失败以 `errcode` 陈述），
 * 而缓存、TTL、串行限流与降级规则是同一份 —— 故本文件钉住两件事：
 *
 * 1. 方式决定**端点**：骑行请求 v4，步行请求 v3，谁也不冒充谁；
 * 2. 方式决定**缓存键**：同一对端点的步行价与骑行价是两个条目，
 *    先定价的那个不得被另一个供出去。
 *
 * 坐标与步行那份契约相同：两端都是 GCJ-02，原样发给上游。
 */

const ANCHOR = { lng: 116.403640, lat: 39.910710 }
const STOP = { lng: 116.392540, lat: 39.924299 }

/** 上游对同一对端点给出的两条真实路线：骑行更短也更快，正是两种方式各自的答案。 */
const WALK_PRICED = { distanceMeters: 540, durationSeconds: 420 }
const CYCLE_PRICED = { distanceMeters: 480, durationSeconds: 300 }

type Upstream = 'route' | 'network-error' | 'qps-limit' | 'empty'

let reply: Upstream = 'route'

/** 服务读取的墙上时钟：每次轮询推进它，因此可以跨过 TTL。 */
let clock = 0

/**
 * 计数版的高德上游替身，按 v4 / v3 分别作答。
 *
 * 两个信封都按上游真实的样子写：v4 的 `distance`/`duration` 是**数字**，v3 的是**字符串**
 * （实测），而应用读的是「载荷声明的数」，故两条路由各钉一次。
 */
function stubUpstream(): { urls: string[], cycling: number, walking: number } {
  const state = { urls: [] as string[], cycling: 0, walking: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    state.urls.push(href)

    if (href.includes('/v4/direction/bicycling')) {
      state.cycling += 1
      if (reply === 'network-error') throw new Error('socket hang up')
      // v4 的瞬时失败以 `errcode` 陈述，没有 v3 的那对成功码。
      if (reply === 'qps-limit') {
        return { ok: true, status: 200, json: async () => ({ errcode: 10014, errmsg: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }) }
      }
      if (reply === 'empty') {
        return { ok: true, status: 200, json: async () => ({ data: { paths: [] } }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { paths: [{ distance: CYCLE_PRICED.distanceMeters, duration: CYCLE_PRICED.durationSeconds }] } }),
      }
    }

    if (!href.includes('/v3/direction/walking')) throw new Error(`unexpected upstream call: ${href}`)
    state.walking += 1
    if (reply === 'network-error') throw new Error('socket hang up')
    if (reply === 'qps-limit') {
      return { ok: true, status: 200, json: async () => ({ status: '0', infocode: '10014', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }) }
    }
    if (reply === 'empty') {
      return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [] } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        route: { paths: [{ distance: String(WALK_PRICED.distanceMeters), duration: String(WALK_PRICED.durationSeconds) }] },
      }),
    }
  }))
  return state
}

function poll(amap: AmapGisService, mode: 'walk' | 'cycle', anchor = ANCHOR, stop = STOP) {
  clock += 1000
  return amap.getConnectionEta(mode, anchor.lng, anchor.lat, stop.lng, stop.lat)
}

beforeEach(() => {
  reply = 'route'
  clock = Date.UTC(2026, 0, 1)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AmapGisService.getConnectionEta: the mode decides the endpoint', () => {
  it('prices a cycling connection at the v4 bicycling endpoint', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    await expect(poll(amap, 'cycle')).resolves.toEqual(CYCLE_PRICED)

    expect(upstream.cycling).toBe(1)
    expect(upstream.walking, 'a cycling leg was priced by the walking route').toBe(0)
  })

  it('prices a walking connection at the v3 walking endpoint', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    await expect(poll(amap, 'walk')).resolves.toEqual(WALK_PRICED)

    expect(upstream.walking).toBe(1)
    expect(upstream.cycling).toBe(0)
  })

  it('sends the given GCJ-02 pair unchanged on both routes', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap, 'cycle')
    await poll(amap, 'walk')

    for (const href of upstream.urls) {
      const params = new URL(href).searchParams
      expect(params.get('origin')).toBe(`${ANCHOR.lng.toFixed(6)},${ANCHOR.lat.toFixed(6)}`)
      expect(params.get('destination')).toBe(`${STOP.lng.toFixed(6)},${STOP.lat.toFixed(6)}`)
    }
  })

  it('reads both v4 numbers and v3 strings as the numbers the payload states', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')

    // v4 的骑行价是数字，v3 的步行价是字符串（均为实测）；两者都读成声明的数。
    expect(await poll(amap, 'cycle')).toEqual({ distanceMeters: 480, durationSeconds: 300 })
    expect(await poll(amap, 'walk')).toEqual({ distanceMeters: 540, durationSeconds: 420 })
  })
})

describe('AmapGisService.getConnectionEta: the mode is part of the cache key', () => {
  it('keeps one walking price and one cycling price for the same pair', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    // 同一对端点、两种方式：两个答案，各花一次上游调用。
    expect(await poll(amap, 'walk')).toEqual(WALK_PRICED)
    expect(await poll(amap, 'cycle')).toEqual(CYCLE_PRICED)
    expect(upstream.walking).toBe(1)
    expect(upstream.cycling).toBe(1)
  })

  it('never serves the price of the other mode', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    // 先定价步行，再问骑行：共享一个键的话，骑行的答案会是那条步行腿。
    await poll(amap, 'walk')
    expect(await poll(amap, 'cycle'), 'the cycling request was answered with the walking leg').toEqual(CYCLE_PRICED)

    // 反过来也一样，且第二次问各自的方式都不再花上游 —— 每个方式都有自己的条目。
    expect(await poll(amap, 'walk')).toEqual(WALK_PRICED)
    expect(await poll(amap, 'cycle')).toEqual(CYCLE_PRICED)
    expect(upstream.walking).toBe(1)
    expect(upstream.cycling).toBe(1)
  })

  it('counts the entries of both modes when pruning', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap, 'walk')
    await poll(amap, 'cycle')
    expect(amap.clearExpired()).toBe(0)

    clock += 24 * 3600 * 1000
    expect(amap.clearExpired()).toBe(2)
  })
})

describe('AmapGisService.getConnectionEta: a cycling failure follows the walking rules', () => {
  it('serves the last known good cycling leg when upstream fails after the entry expires', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap, 'cycle')
    clock += 24 * 3600 * 1000
    reply = 'network-error'

    expect(await poll(amap, 'cycle')).toEqual(good)
    // 它确实重试了上游，所以这是兜底而不是一次新命中。
    expect(upstream.cycling).toBe(2)
  })

  it('treats a v4 quota errcode as transient and serves the cached cycling leg', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap, 'cycle')
    clock += 24 * 3600 * 1000
    reply = 'qps-limit'

    expect(await poll(amap, 'cycle')).toEqual(good)
  })

  it('reports no cycling leg rather than a guessed one when upstream fails with nothing cached', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')
    reply = 'network-error'

    await expect(poll(amap, 'cycle')).resolves.toBeNull()
  })

  it('reports no cycling route when the v4 payload states no path, even with a stale entry', async () => {
    const upstream = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap, 'cycle')
    clock += 24 * 3600 * 1000
    reply = 'empty'

    // 合法的「无骑行路线」回答就是当下的事实，不该被一天前的腿顶替。
    await expect(poll(amap, 'cycle')).resolves.toBeNull()
    expect(upstream.cycling).toBe(2)
  })

  it('reports no cycling route when the v4 path states only one axis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { paths: [{ distance: 480 }] } }),
    })))
    clock += 1000

    // 两个轴缺任一就不是本应用可用的价格 —— 与步行同一条规则。
    await expect(new AmapGisService('test-key').getConnectionEta('cycle', ANCHOR.lng, ANCHOR.lat, STOP.lng, STOP.lat))
      .resolves.toBeNull()
  })
})
