import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmapGisService } from '../index.js'
import { WALK_ETA_MAX_ENTRIES } from '../services/amap-gis.service.js'

/**
 * GCJ-02 坐标 —— 应用的归一化坐标系，也是本服务发给上游的坐标系
 * （转换在 HTTP 边界完成，见 `amap-gis-coordinate-contract.test.ts`）。
 */
const ANCHOR = { lng: 116.403640, lat: 39.910710 }
const STOP = { lng: 116.392540, lat: 39.924299 }

const PRICED = { distanceMeters: 540, durationSeconds: 420 }

type Upstream = 'route' | 'network-error' | 'qps-limit' | 'no-route'

let reply: Upstream = 'route'

/** 服务读取的墙上时钟：每次轮询推进它，因此可以跨过 TTL。 */
let clock = 0

/**
 * 计数版的高德上游替身。测试断言调用次数，而不只是返回值相等，
 * 使缓存无法侥幸通过。
 */
function stubUpstream(): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    urls.push(String(url))
    if (reply === 'network-error') throw new Error('socket hang up')
    if (reply === 'qps-limit') {
      return { ok: true, status: 200, json: async () => ({ status: '0', infocode: '10014', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }) }
    }
    if (reply === 'no-route') {
      return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [{ distance: '540', duration: '420' }] } }) }
  }))
  return urls
}

function poll(amap: AmapGisService, anchor = ANCHOR, stop = STOP) {
  clock += 1000
  return amap.getWalkingEta(anchor.lng, anchor.lat, stop.lng, stop.lat)
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

describe('AmapGisService.getWalkingEta caching', () => {
  it('prices a repeated (anchor, stop) leg upstream once', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const first = await poll(amap)
    const second = await poll(amap)
    const third = await poll(amap)

    expect(first).toEqual(PRICED)
    expect(second).toEqual(PRICED)
    expect(third).toEqual(PRICED)
    expect(urls).toHaveLength(1)
  })

  it('sends the given GCJ-02 pair upstream unchanged', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)

    const params = new URL(urls[0]!).searchParams
    expect(params.get('origin')).toBe(`${ANCHOR.lng.toFixed(6)},${ANCHOR.lat.toFixed(6)}`)
    expect(params.get('destination')).toBe(`${STOP.lng.toFixed(6)},${STOP.lat.toFixed(6)}`)
  })

  it('shares one entry for anchors inside the same ~1 m upstream cell', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    // 向东约 0.4 m：两个锚点落在同一个 5 位小数格子里，所以格内漂移的
    // 定位会被直接供给而不是重新定价。（5 位小数格约 1 m 宽，同样小
    // 的变化也可能跨格并花掉一次新定价。）
    await poll(amap, { lng: ANCHOR.lng + 0.000004, lat: ANCHOR.lat })
    expect(urls).toHaveLength(1)

    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    await poll(amap, ANCHOR, { lng: STOP.lng + 0.0001, lat: STOP.lat })
    expect(urls).toHaveLength(3)

    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    await poll(amap, ANCHOR, { lng: STOP.lng + 0.0001, lat: STOP.lat })
    expect(urls).toHaveLength(3)
  })

  it('serves the last known good leg when upstream fails after the entry expires', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'network-error'
    const afterFailure = await poll(amap)

    // 它确实重试了上游，所以这是兜底而不是一次新命中。
    expect(urls).toHaveLength(2)
    expect(afterFailure).toEqual(good)
  })

  it('serves the last known good leg when upstream refuses on QPS or quota', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    const good = await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'qps-limit'
    const afterThrottle = await poll(amap)

    expect(urls).toHaveLength(2)
    expect(afterThrottle).toEqual(good)
  })

  it('reports no leg rather than a guessed one when upstream fails with nothing cached', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')
    reply = 'network-error'

    await expect(poll(amap)).resolves.toBeNull()
    expect(urls).toHaveLength(1)
  })

  it('reports no leg when upstream answers that no route exists, even with a stale entry', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    clock += 24 * 3600 * 1000
    reply = 'no-route'

    // 合法的「无步行路线」回答就是当下的事实：一条已不存在的路线
    // 不该被一天前的腿顶替。
    await expect(poll(amap)).resolves.toBeNull()
    expect(urls).toHaveLength(2)
  })

  it('drops expired entries on demand', async () => {
    stubUpstream()
    const amap = new AmapGisService('test-key')

    await poll(amap)
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + 0.0001 })
    expect(amap.clearExpired()).toBe(0)

    clock += 24 * 3600 * 1000
    expect(amap.clearExpired()).toBe(2)
    expect(amap.clearExpired()).toBe(0)
  })

  it('caps the cache so a drifting fix cannot grow it without bound', async () => {
    const urls = stubUpstream()
    const amap = new AmapGisService('test-key')

    // 相隔 110 m，就像移动中用户的定位：每次轮询都是一个新键。
    for (let i = 0; i <= WALK_ETA_MAX_ENTRIES; i++) {
      await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + i * 0.001 })
    }
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 1)

    // 最早的锚点已被淘汰腾位，所以它会被再次定价……
    await poll(amap, ANCHOR)
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 2)

    // ……而最新的那一个仍从缓存供给。
    await poll(amap, { lng: ANCHOR.lng, lat: ANCHOR.lat + WALK_ETA_MAX_ENTRIES * 0.001 })
    expect(urls).toHaveLength(WALK_ETA_MAX_ENTRIES + 2)
  })
})

describe('AmapGisService.getWalkingEta: a path the payload does not price is no route', () => {
  /**
   * 用一条 `route.paths[0]` 回答步行请求，写法与上游一致 —— 两个数
   * 都是字符串。真实路线在两个轴上都带价；缺任一个的路径没有本应用
   * 可用的价格，而 `0`（上游确实能写出的数：两个重合的点定价为一秒）
   * 不是它的替身。
   */
  function pathReply(path: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: '1', infocode: '10000', info: 'OK', route: { paths: [path] } }),
    })))
  }

  /** 对全新服务实例的一次定价请求，使任何缓存条目都无法替它作答。 */
  function pollOnce(): Promise<Awaited<ReturnType<AmapGisService['getWalkingEta']>>> {
    clock += 1000
    return new AmapGisService('test-key').getWalkingEta(ANCHOR.lng, ANCHOR.lat, STOP.lng, STOP.lat)
  }

  it('reads a price the payload states on both axes, including zero', async () => {
    pathReply({ distance: '0', duration: '1' })
    await expect(pollOnce()).resolves.toEqual({ distanceMeters: 0, durationSeconds: 1 })
  })

  it('keeps a zero DURATION priced: two coincident points are a legal 0-second walk', async () => {
    // 「0 是载荷能写出的数」的另一半：距离 0 与时长 0 都是两点真实
    // 重合，所以零价分支在两个轴上都钉住。把写出的 0 读作「无价格」
    // 会丢掉一次合法的步行，正如同为缺值凭空造一个价格一样。
    pathReply({ distance: '540', duration: '0' })
    await expect(pollOnce()).resolves.toEqual({ distanceMeters: 540, durationSeconds: 0 })
  })

  it('reports no route when the payload states no duration', async () => {
    pathReply({ distance: '540' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states an empty duration', async () => {
    pathReply({ distance: '540', duration: '' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states a non-numeric duration', async () => {
    // 载荷「带了」但没有写成数字的字段仍不是价格：`Number('abc')` 是
    // NaN，而把 NaN 当作步行时间印出来比没有路线更糟。
    pathReply({ distance: '540', duration: 'abc' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states no distance', async () => {
    pathReply({ duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states an empty distance', async () => {
    pathReply({ distance: '', duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })

  it('reports no route when the payload states a non-numeric distance', async () => {
    pathReply({ distance: 'abc', duration: '420' })
    await expect(pollOnce()).resolves.toBeNull()
  })
})
