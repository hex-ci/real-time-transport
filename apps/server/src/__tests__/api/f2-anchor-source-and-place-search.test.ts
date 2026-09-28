import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream } from './support/upstream-mock.js'

/**
 * F2 · 地点搜索与「按来源决定换算」（`docs/PRD.md` §5.4）。
 *
 * 本轮唯一有风险的地方就在这里，故两条契约各钉一个文件：
 *
 *  1. **来源决定换不换算**：设备定位（`device`）过 `deviceFixToGcj02` 一次；地点搜索拿到的
 *     坐标（`search`）本身就是 GCJ-02，原样落库。换算是非线性的，故断言落到具体数值上 ——
 *     一次与两次在数值上分得开，而界面上看不出来（差约 500 m）。
 *  2. **地点搜索接口**：空 keywords → 400；上游没答上来 → 502（不是「没有这个地方」）；
 *     城市限定走 `cities.ts` 的 `adcode`；返回的坐标原样下发，**边界上不做任何换算**。
 *
 * 高德客户端只在构造时读一次 key（见 F1 文件同一处说明）：补一个占位 key，真实网络由上游桩拦住。
 */
if (!process.env.AMAP_MAPS_API_KEY) process.env.AMAP_MAPS_API_KEY = 'test-amap-key'

/** 一个北京境内的原始 WGS-84 设备定位。 */
const WGS_DEVICE_FIX = { lng: 116.40, lat: 39.90 }

/**
 * 高德地点搜索返回的一个候选（GCJ-02）。
 *
 * 与 `WGS_DEVICE_FIX` 刻意**不同一点**：两条路径若共用同一个数，就分不出「原样落库」与
 * 「换算后落库」—— 而这正是本条契约要区分的那两件事。
 */
const AMAP_PLACE = { name: '珠江帝景B区', district: '朝阳区劲松街道', address: '西大望路珠江帝景', lng: 116.480284, lat: 39.890076 }

interface SettingsView {
  settingsState: string
  data: null | {
    homeLat: number | null
    homeLng: number | null
    homePlaceName: string | null
    homeAnchorSource: string | null
    workLat: number | null
    workLng: number | null
    workPlaceName: string | null
    workAnchorSource: string | null
  }
}

/** 高德的 inputtips 载荷，按上游自己的口径（`location` 是字符串「lng,lat」）。 */
function inputtipsPayload(tips: unknown[]): unknown {
  return { status: '1', infocode: '10000', info: 'OK', count: String(tips.length), tips }
}

describeEachStore('F2 · 地点搜索与按来源换算', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  function patchSettings(payload: Record<string, unknown>) {
    return api.inject({ method: 'PATCH', url: '/api/transit/settings', payload })
  }

  async function readSettings(): Promise<SettingsView> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/settings' })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as SettingsView
  }

  /** 装一个回答固定候选的 inputtips，并记下收到的每个 URL。 */
  function answerPlaceSearch(tips: unknown[] = [{ name: AMAP_PLACE.name, district: AMAP_PLACE.district, address: AMAP_PLACE.address, location: `${AMAP_PLACE.lng},${AMAP_PLACE.lat}` }]): string[] {
    const called: string[] = []
    installUpstream(api.upstream, {
      amap: (url) => {
        called.push(url.toString())
        return url.pathname.endsWith('/v3/assistant/inputtips') ? inputtipsPayload(tips) : undefined
      },
    })
    return called
  }

  it('搜索来的坐标原样落库：一次换算都不做', async () => {
    await patchSettings({
      homeLat: AMAP_PLACE.lat,
      homeLng: AMAP_PLACE.lng,
      homePlaceName: AMAP_PLACE.name,
      homeAnchorSource: 'search',
    })

    const body = await readSettings()
    expect(body.settingsState).toBe('stored')
    // 逐字相同：高德返回的就是 GCJ-02，正是存储基准。
    expect([body.data?.homeLng, body.data?.homeLat]).toEqual([AMAP_PLACE.lng, AMAP_PLACE.lat])
    // 而换算一次会落在另一个坐标上 —— 这就是「原样」与「被换算」的区别，且它看起来同样合理。
    const [convertedLng, convertedLat] = wgs84ToGcj02(AMAP_PLACE.lng, AMAP_PLACE.lat)
    expect(body.data?.homeLng).not.toBe(convertedLng)
    expect(body.data?.homeLat).not.toBe(convertedLat)

    // 名字与来源随坐标一起存：名字供界面认人，来源是这条判据的凭据。
    expect(body.data?.homePlaceName).toBe(AMAP_PLACE.name)
    expect(body.data?.homeAnchorSource).toBe('search')

    const rows = await api.rows<{ home_lat: number, home_lng: number, home_place_name: string, home_anchor_source: string }>(
      'SELECT home_lat, home_lng, home_place_name, home_anchor_source FROM user_settings WHERE user_id = $1',
      [DEFAULT_USER_ID],
    )
    if (store === 'sql') {
      expect(rows, '搜索来的锚点没有落到库里').toHaveLength(1)
      expect([Number(rows[0]!.home_lng), Number(rows[0]!.home_lat)]).toEqual([AMAP_PLACE.lng, AMAP_PLACE.lat])
      expect(rows[0]!.home_place_name).toBe(AMAP_PLACE.name)
      expect(rows[0]!.home_anchor_source).toBe('search')
    }
    else {
      expect(rows, '内存路径不该在库里留下行').toHaveLength(0)
    }
  })

  it('来源缺省按设备定位处理：换算一次，且把来源写成 device', async () => {
    // 013 之前的调用方（与任何未跟上的客户端）提交的都是原始设备定位。缺省必须仍然可用，
    // 且要留下「这次的坐标是怎么来的」的记录 —— 不写就等于下一次读的人只能猜。
    await patchSettings({ homeLat: WGS_DEVICE_FIX.lat, homeLng: WGS_DEVICE_FIX.lng })

    const [lng, lat] = wgs84ToGcj02(WGS_DEVICE_FIX.lng, WGS_DEVICE_FIX.lat)
    const body = await readSettings()
    expect([body.data?.homeLng, body.data?.homeLat]).toEqual([lng, lat])
    expect(body.data?.homeAnchorSource).toBe('device')
    // 设备抓来的位置没有名字，且它不得凭空有一个。
    expect(body.data?.homePlaceName).toBeNull()
  })

  it('设备路径把上一个搜索来的名字清掉：旧名字会说出一个已被覆盖的坐标', async () => {
    await patchSettings({
      homeLat: AMAP_PLACE.lat,
      homeLng: AMAP_PLACE.lng,
      homePlaceName: AMAP_PLACE.name,
      homeAnchorSource: 'search',
    })
    await patchSettings({ homeLat: WGS_DEVICE_FIX.lat, homeLng: WGS_DEVICE_FIX.lng, homeAnchorSource: 'device' })

    const body = await readSettings()
    expect(body.data?.homePlaceName, '一个已被覆盖的坐标仍带着旧名字').toBeNull()
    expect(body.data?.homeAnchorSource).toBe('device')
  })

  it('两个锚点各自记自己的来源：家是搜索来的，公司是设备抓的', async () => {
    await patchSettings({
      homeLat: AMAP_PLACE.lat,
      homeLng: AMAP_PLACE.lng,
      homePlaceName: AMAP_PLACE.name,
      homeAnchorSource: 'search',
    })
    await patchSettings({ workLat: WGS_DEVICE_FIX.lat, workLng: WGS_DEVICE_FIX.lng, workAnchorSource: 'device' })

    const [lng, lat] = wgs84ToGcj02(WGS_DEVICE_FIX.lng, WGS_DEVICE_FIX.lat)
    const body = await readSettings()
    expect([body.data?.homeLng, body.data?.homeLat]).toEqual([AMAP_PLACE.lng, AMAP_PLACE.lat])
    expect(body.data?.homeAnchorSource).toBe('search')
    expect([body.data?.workLng, body.data?.workLat]).toEqual([lng, lat])
    expect(body.data?.workAnchorSource).toBe('device')
    // 一个锚点的来源绝不套到另一个上。
    expect(body.data?.workLng).not.toBe(AMAP_PLACE.lng)
  })

  it('成对清空把名字与来源一并清掉', async () => {
    await patchSettings({
      homeLat: AMAP_PLACE.lat,
      homeLng: AMAP_PLACE.lng,
      homePlaceName: AMAP_PLACE.name,
      homeAnchorSource: 'search',
    })

    const cleared = await patchSettings({ homeLat: null, homeLng: null })
    expect(cleared.statusCode, cleared.body).toBe(200)

    const body = await readSettings()
    expect([body.data?.homeLat, body.data?.homeLng]).toEqual([null, null])
    expect(body.data?.homePlaceName, '一个已删坐标的名字留在了行上').toBeNull()
    expect(body.data?.homeAnchorSource).toBeNull()
  })

  it('地点名与来源必须随一对经纬度一起提交：单独提交被拒', async () => {
    // 无声接受会写进一个「名字存下来了」的错觉 —— 没有坐标，名字无处可落。
    for (const payload of [
      { homePlaceName: AMAP_PLACE.name },
      { homeAnchorSource: 'search' },
    ]) {
      const res = await patchSettings(payload)
      expect(res.statusCode, `${JSON.stringify(payload)} → ${res.body}`).toBe(400)
    }
    expect((await readSettings()).settingsState, 'a refused write created a row').toBe('unset')
  })

  it('上游的 inputtips 按城市限定，城市码换成 adcode', async () => {
    const called = answerPlaceSearch()

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    expect(res.statusCode, res.body).toBe(200)

    const tips = new URL(called.find(url => url.includes('inputtips'))!)
    // `027` 是 chelaile 的城市码，高德要的是 adcode：两者由 `getCityAdcode` 换算，
    // 调用方不必知道这件事。
    expect(tips.searchParams.get('city')).toBe('110000')
    expect(tips.searchParams.get('keywords')).toBe('珠江帝景')
    // 不限定城市会搜出全国同名的地方，而锚点是通勤起点。
    expect(tips.searchParams.get('citylimit')).toBe('true')
  })

  it('返回的候选带名字、区、地址与坐标，且坐标原样（GCJ-02 不做换算）', async () => {
    answerPlaceSearch()

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data).toEqual([AMAP_PLACE])
  })

  it('候选没有地址时不编造：缺省字段就不出现在载荷里', async () => {
    answerPlaceSearch([{ name: '珠江帝景', district: '北京市朝阳区', location: `${AMAP_PLACE.lng},${AMAP_PLACE.lat}` }])

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    expect(res.statusCode, res.body).toBe(200)
    const [first] = res.json().data as Array<Record<string, unknown>>
    expect(first!.name).toBe('珠江帝景')
    expect(first, 'an address nobody stated was invented').not.toHaveProperty('address')
  })

  it('没有坐标的候选不进结果：它无法成为一个锚点', async () => {
    // 高德对「放不下」的泛化词条（省 / 市 / 地铁站 这类）给出的是一对空数组。
    answerPlaceSearch([
      { name: '北京市', district: '北京市', address: '东城区', location: [] },
      { name: AMAP_PLACE.name, location: `${AMAP_PLACE.lng},${AMAP_PLACE.lat}` },
    ])

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=北京&cityCode=027' })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json().data as unknown[]).map((item: any) => item.name)).toEqual([AMAP_PLACE.name])
  })

  it('空 keywords → 400：空词不是「搜索全部」，是一次无法表达的搜索', async () => {
    const called = answerPlaceSearch()

    for (const raw of ['', '   ', '%20']) {
      const res = await api.inject({ method: 'GET', url: `/api/transit/gis/place-search?keywords=${raw}&cityCode=027` })
      expect(res.statusCode, `keywords=${JSON.stringify(raw)} → ${res.body}`).toBe(400)
    }
    // 缺失参数同样是无法表达的搜索。
    expect((await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?cityCode=027' })).statusCode).toBe(400)
    // 而且拒绝发生在花掉上游配额之前。
    expect(called, 'a refused search still spent an upstream call').toEqual([])
  })

  it('上游失败 → 502，不是「没有这个地方」', async () => {
    // 没有桩任何高德端点：harness 的默认桩拒绝一切调用，这正是「上游没答上来」。
    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json().success).toBe(false)
    // 与「答了但没有匹配」是两回事：后者是 200 与一个空数组。
    expect(res.statusCode).not.toBe(200)
  })

  it('上游答了但没有匹配 → 200 与空数组（空与失败分得开）', async () => {
    answerPlaceSearch([])

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=不存在的地方&cityCode=027' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ success: true, data: [] })
  })

  it('上游的 QPS / 配额类 infocode 也走 502，不当作空结果', async () => {
    installUpstream(api.upstream, {
      amap: url => (url.pathname.endsWith('/v3/assistant/inputtips')
        ? { status: '0', infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' }
        : undefined),
    })

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    expect(res.statusCode, res.body).toBe(502)
  })

  it('key 只在服务端：响应里没有任何凭据', async () => {
    const called = answerPlaceSearch()

    const res = await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景&cityCode=027' })
    // key 确实被发给了上游（那是它唯一该去的地方）……
    expect(new URL(called.find(url => url.includes('inputtips'))!).searchParams.get('key')).toBeTruthy()
    // ……而它绝不随应答回到浏览器（硬约束：key 只在服务端）。
    expect(res.body).not.toContain('test-amap-key')
    expect(res.body.toLowerCase()).not.toContain('key')
  })

  it('未命名城市时用默认城市（与其它路由同一条规则）', async () => {
    const called = answerPlaceSearch()

    await api.inject({ method: 'GET', url: '/api/transit/gis/place-search?keywords=珠江帝景' })

    const tips = new URL(called.find(url => url.includes('inputtips'))!)
    expect(tips.searchParams.get('city')).toBe('110000')
  })
})
