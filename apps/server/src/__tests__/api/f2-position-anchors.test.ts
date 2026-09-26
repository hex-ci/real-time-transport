import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream } from './support/upstream-mock.js'

/**
 * F2：位置锚点。
 *
 * 锚点写路径是这个系统里唯一做坐标换算的地方，因此也是唯一能把「换算几次」钉住的地方：
 * 提交的是原始 WGS-84 设备定位，落库与下发的一律是 GCJ-02，此后每一处读它都按 GCJ-02 用。
 * 换算是非线性的，换算两次会落在另一个坐标上 —— 断言落到具体数值上，才区分得开一次与两次。
 *
 * 高德客户端只在构造时读一次 key（见 F1 文件同一处说明）：补一个占位 key，真实网络由上游桩拦住。
 */
if (!process.env.AMAP_MAPS_API_KEY) process.env.AMAP_MAPS_API_KEY = 'test-amap-key'

/** 一个北京境内的原始 WGS-84 设备定位。 */
const WGS_DEVICE_FIX = { lng: 116.40, lat: 39.90 }

interface SettingsView {
  settingsState: string
  data: null | {
    homeLat: number | null
    homeLng: number | null
    workLat: number | null
    workLng: number | null
  }
}

describeEachStore('F2 · 位置锚点', (store) => {
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

  it('成对提交的锚点写成一行，读回来是同一对', async () => {
    const res = await patchSettings({ homeLat: WGS_DEVICE_FIX.lat, homeLng: WGS_DEVICE_FIX.lng })
    expect(res.statusCode, res.body).toBe(200)

    const body = await readSettings()
    expect(body.settingsState).toBe('stored')
    const [lng, lat] = wgs84ToGcj02(WGS_DEVICE_FIX.lng, WGS_DEVICE_FIX.lat)
    expect([body.data?.homeLng, body.data?.homeLat]).toEqual([lng, lat])

    const rows = await api.rows(
      'SELECT home_lat, home_lng FROM user_settings WHERE user_id = $1',
      [DEFAULT_USER_ID],
    )
    expect(rows, store === 'sql' ? '锚点没有落到库里' : '内存路径不该在库里留下行')
      .toHaveLength(store === 'sql' ? 1 : 0)
  })

  it('成对的 (0, 0) 被拒，且一个字段都没有写', async () => {
    const before = await api.inject({ method: 'GET', url: '/api/transit/settings' })
    expect((before.json() as SettingsView).settingsState).toBe('unset')

    // 同一次提交里还带了通勤时段：拒绝必须是整体的，不能留下被「顺便」写进去的那一段。
    const rejected = await patchSettings({
      homeLat: 0,
      homeLng: 0,
      morningStart: '07:00',
      morningEnd: '09:00',
    })
    expect(rejected.statusCode, rejected.body).toBe(400)
    expect((rejected.json() as { error: string }).error).toContain('(0, 0)')

    // 逐字相同：读起来与提交前完全一样，行也仍然不存在。
    const after = await api.inject({ method: 'GET', url: '/api/transit/settings' })
    expect(after.body).toBe(before.body)
    expect(await api.rows('SELECT user_id FROM user_settings')).toHaveLength(0)
  })

  it('单轴为 0 是真实坐标，照常写下来', async () => {
    expect((await patchSettings({ homeLat: 0, homeLng: 116.4 })).statusCode).toBe(200)
    expect((await patchSettings({ workLat: 39.9, workLng: 0 })).statusCode).toBe(200)

    const body = await readSettings()
    // 两个点都落在基准面之外，换算原样返回；断言的是「被写下来了」，不是换算结果。
    expect([body.data?.homeLat, body.data?.homeLng]).toEqual([0, 116.4])
    expect([body.data?.workLat, body.data?.workLng]).toEqual([39.9, 0])

    const rows = await api.rows('SELECT user_id FROM user_settings')
    expect(rows).toHaveLength(store === 'sql' ? 1 : 0)
  })

  it('只给一个轴（或只清一个轴）被拒', async () => {
    for (const payload of [{ homeLat: 39.9 }, { homeLng: 116.4 }, { homeLng: null }]) {
      const res = await patchSettings(payload)
      expect(res.statusCode, `${JSON.stringify(payload)} → ${res.body}`).toBe(400)
    }
    expect(await api.rows('SELECT user_id FROM user_settings')).toHaveLength(0)
  })

  it('成对的 null 清空锚点', async () => {
    await patchSettings({ homeLat: WGS_DEVICE_FIX.lat, homeLng: WGS_DEVICE_FIX.lng })

    const cleared = await patchSettings({ homeLat: null, homeLng: null })
    expect(cleared.statusCode, cleared.body).toBe(200)

    const body = await readSettings()
    expect([body.data?.homeLat, body.data?.homeLng]).toEqual([null, null])
  })

  it('原始 WGS-84 只换算一次', async () => {
    await patchSettings({ homeLat: WGS_DEVICE_FIX.lat, homeLng: WGS_DEVICE_FIX.lng })

    const [lng, lat] = wgs84ToGcj02(WGS_DEVICE_FIX.lng, WGS_DEVICE_FIX.lat)
    const body = await readSettings()
    expect([body.data?.homeLng, body.data?.homeLat]).toEqual([lng, lat])

    // 换算是非线性的：换算两次落在别的坐标上，这两条断言正是本用例能区分一次与两次的地方。
    const twice = wgs84ToGcj02(lng, lat)
    expect(body.data?.homeLng).not.toBe(twice[0])
    expect(body.data?.homeLat).not.toBe(twice[1])
  })

  it('GIS 边界：设备定位换算一次，站点坐标原样转发', async () => {
    const called: string[] = []
    installUpstream(api.upstream, {
      amap: (url) => {
        called.push(url.toString())
        return url.pathname.endsWith('/v3/direction/walking')
          ? { status: '1', infocode: '10000', route: { paths: [{ distance: '480', duration: '300' }] } }
          : undefined
      },
    })

    const res = await api.inject({
      method: 'GET',
      url: `/api/transit/gis/walk-eta?originLng=${WGS_DEVICE_FIX.lng}&originLat=${WGS_DEVICE_FIX.lat}`
        + '&destLng=116.404000&destLat=39.904000',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { data: unknown }).data).toEqual({ distanceMeters: 480, durationSeconds: 300 })

    const [gjLng, gjLat] = wgs84ToGcj02(WGS_DEVICE_FIX.lng, WGS_DEVICE_FIX.lat)
    const walk = new URL(called.find(url => url.includes('direction/walking'))!)
    expect(walk.searchParams.get('origin')).toBe(`${gjLng.toFixed(6)},${gjLat.toFixed(6)}`)
    // 站点坐标本身就是 GCJ-02：穿过这个边界时不得再换算一次。
    expect(walk.searchParams.get('destination')).toBe('116.404000,39.904000')
  })
})
