import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { UpdateSettingsSchema } from '@real-time-transport/shared'

/**
 * 边界浏览器侧的锚点抓取。
 *
 * 存储的锚点是 GCJ-02，唯一的坐标转换在服务端 `/settings` PATCH；因此本侧对
 * `navigator.geolocation` 的 WGS-84 定位只能原样交出，不做任何转换。抓取是一次性的：
 * 用户点击时取一次，绝不当作实时位置流跟随。
 */

/** 测试设备上报的原始 WGS-84 定位。 */
const BROWSER_FIX = { latitude: 39.90931, longitude: 116.3974, accuracy: 12 }

/**
 * 同一点的 GCJ-02 值，取自本仓库的 `wgs84ToGcj02`。浏览器侧转换会产出它，
 * 因此本路径绝不能返回它。
 */
const GCJ02_OF_BROWSER_FIX = { lat: 39.910714, lng: 116.403644 }

/** 形如 `GeolocationPositionError` 的拒绝值。 */
function positionError(code: number) {
  return { code, message: 'test', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }
}

/**
 * 安装假的 `navigator.geolocation`，两个入口都记录下来，测试可据此断定抓取用了哪一个。
 */
function stubGeolocation(outcome: { position: unknown } | { error: { code: number } } | 'none') {
  const getCurrentPosition = vi.fn((success: (p: unknown) => void, failure: (e: unknown) => void) => {
    if (outcome === 'none') return
    if ('position' in outcome) success(outcome.position)
    else failure(outcome.error)
  })
  const watchPosition = vi.fn()
  vi.stubGlobal('navigator', outcome === 'none' ? {} : { geolocation: { getCurrentPosition, watchPosition } })
  return { getCurrentPosition, watchPosition }
}

/**
 * 在固定 GPS 覆写环境下加载 store 模块。
 *
 * 模块在 import 时决定 `VITE_GPS_SIMULATION` 是否顶替设备，`.env` 可能已把它开着，
 * 因此需要设备路径的测试必须显式关掉、需要覆写的必须设置，不能继承 shell 的当前值。
 */
async function freshStore(env: Record<string, string> = {}) {
  vi.stubEnv('VITE_GPS_SIMULATION', 'false')
  vi.stubEnv('VITE_GPS_SIM_LAT', '')
  vi.stubEnv('VITE_GPS_SIM_LNG', '')
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  const { useLocationStore } = await import('../stores/location.store')
  return useLocationStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the anchor grab hands the server a raw WGS-84 fix', () => {
  it('returns the fix exactly as the browser reported it, converted by nobody', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX, timestamp: Date.now() } })
    const store = await freshStore()

    const fix = await store.captureAnchorFix()

    expect(fix).toEqual({ lat: BROWSER_FIX.latitude, lng: BROWSER_FIX.longitude, accuracyM: BROWSER_FIX.accuracy })
    // 本侧若转换，服务端会再转一次：双重偏移使出门结论反转。
    expect(fix.lat).not.toBe(GCJ02_OF_BROWSER_FIX.lat)
    expect(fix.lng).not.toBe(GCJ02_OF_BROWSER_FIX.lng)
  })

  it('asks for one position and never opens a stream', async () => {
    const { getCurrentPosition, watchPosition } = stubGeolocation({
      position: { coords: BROWSER_FIX, timestamp: Date.now() },
    })
    const store = await freshStore()

    await store.captureAnchorFix()

    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    // 实时位置归实时位置：`watchPosition` 是 store 的另一项职责，本路径不得启动或停止它。
    expect(watchPosition).not.toHaveBeenCalled()
  })

  it('reports no accuracy rather than a fabricated one when the device omits it', async () => {
    stubGeolocation({ position: { coords: { latitude: BROWSER_FIX.latitude, longitude: BROWSER_FIX.longitude } } })
    const store = await freshStore()

    expect((await store.captureAnchorFix()).accuracyM).toBeNull()
  })

  it('is not a simulated fix while the override is off', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX, timestamp: Date.now() } })
    const store = await freshStore()

    expect(store.isSimulated).toBe(false)
  })
})

describe('a failed grab says the departure time is unavailable', () => {
  it('names the permission and the departure time when location access is denied', async () => {
    stubGeolocation({ error: positionError(1) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('权限')
    expect((err as Error).message).toContain('出门时间')
  })

  it('names the timeout and the departure time when no fix arrives in time', async () => {
    stubGeolocation({ error: positionError(3) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('超时')
    expect((err as Error).message).toContain('出门时间')
  })

  it('reports an unavailable position instead of resolving a stale one', async () => {
    stubGeolocation({ error: positionError(2) })
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('出门时间')
  })

  it('reports an unsupported browser instead of failing silently', async () => {
    stubGeolocation('none')
    const store = await freshStore()

    const err = await store.captureAnchorFix().catch((e: Error) => e)

    expect((err as Error).message).toContain('出门时间')
  })

  it('clears the in-flight flag after a failure, so the button is usable again', async () => {
    stubGeolocation({ error: positionError(2) })
    const store = await freshStore()

    await store.captureAnchorFix().catch(() => null)

    expect(store.isCapturingAnchor).toBe(false)
  })
})

describe('VITE_GPS_SIMULATION stands in for the device fix', () => {
  it('returns the fixed development position, touches no device, and says so', async () => {
    const { getCurrentPosition } = stubGeolocation({ position: { coords: BROWSER_FIX } })
    const store = await freshStore({
      VITE_GPS_SIMULATION: 'true',
      VITE_GPS_SIM_LAT: '39.90931',
      VITE_GPS_SIM_LNG: '116.3974',
    })

    const fix = await store.captureAnchorFix()

    expect(fix).toEqual({ lat: 39.90931, lng: 116.3974, accuracyM: null })
    expect(getCurrentPosition).not.toHaveBeenCalled()
    // 模拟定位绝不被装扮成真实定位。
    expect(store.isSimulated).toBe(true)
  })

  it('requires both simulated coordinates, so a half-configured pair is not a fix', async () => {
    const { getCurrentPosition } = stubGeolocation({ position: { coords: BROWSER_FIX } })
    // 空经度是半配置情形：`Number('')` 为 0，会被当成长度存下来。
    const store = await freshStore({ VITE_GPS_SIMULATION: 'true', VITE_GPS_SIM_LAT: '39.90931', VITE_GPS_SIM_LNG: '' })

    const fix = await store.captureAnchorFix()

    expect(store.isSimulated).toBe(false)
    expect(fix.lat).toBe(BROWSER_FIX.latitude)
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
  })

  it('stays off entirely when the flag is not set', async () => {
    stubGeolocation({ position: { coords: BROWSER_FIX } })
    const store = await freshStore({ VITE_GPS_SIM_LAT: '39.90931', VITE_GPS_SIM_LNG: '116.3974' })

    expect(store.isSimulated).toBe(false)
    expect((await store.captureAnchorFix()).lat).toBe(BROWSER_FIX.latitude)
  })
})

describe('the browser side of the anchor path converts nothing', () => {
  /**
   * 去掉注释的源码，使注释可以陈述规则而不触发针对可执行代码的守卫。
   */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  function source(file: string): string {
    return stripComments(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'))
  }

  /** 锚点这一域的浏览器侧：抓取、索引页、每个锚点自己的页面，以及共用的表。 */
  const ANCHOR_SOURCES = [
    'stores/location.store.ts',
    'views/settings/anchors.vue',
    'views/settings/anchor-detail.vue',
    'views/settings/anchor-catalog.ts',
  ]

  it('carries no coordinate conversion in any file on the anchor path', () => {
    // 唯一转换在服务端 `/settings` PATCH；本侧可达的转换器会与之重复偏移。
    // 搜索来的坐标更是**绝不能**在浏览器里转：它本来就是 GCJ-02（见 PRD §5.4）。
    for (const file of ANCHOR_SOURCES) {
      expect(source(file), `${file} can convert a coordinate in the browser`)
        .not.toMatch(/wgs84ToGcj02|gcj02ToWgs84|transit-adapter/)
    }
  })

  it('sends each anchor under the contract\'s own field names', () => {
    // 锚点表以 `latKey`/`lngKey`/`placeNameKey`/`sourceKey` 命名线上字段，这些名字就是请求体：
    // 契约改名而这张表没跟上，就会 PATCH 端点不收的字段并静默不存。
    const catalog = source('views/settings/anchor-catalog.ts')
    for (const key of [
      'homeLat', 'homeLng', 'workLat', 'workLng',
      'homePlaceName', 'workPlaceName', 'homeAnchorSource', 'workAnchorSource',
    ]) {
      expect(catalog, `${key} is missing from the anchor catalog`).toContain(key)
    }
    // 逐字段过一遍契约：改名的字段会被 `safeParse` 当场拒掉。
    for (const key of ['homeLat', 'workLat']) {
      expect(UpdateSettingsSchema.safeParse({ [key]: 39.90931 }).success, key).toBe(true)
    }
    for (const key of ['homePlaceName', 'workPlaceName']) {
      expect(UpdateSettingsSchema.safeParse({ [key]: '珠江帝景B区' }).success, key).toBe(true)
    }
    for (const key of ['homeAnchorSource', 'workAnchorSource']) {
      expect(UpdateSettingsSchema.safeParse({ [key]: 'search' }).success, key).toBe(true)
    }
    // 而页面自己提交的是它拿到的那一个锚点的字段：表是唯一一处知道字段名的地方。
    expect(source('views/settings/anchor-detail.vue')).toContain('target.sourceKey')
    expect(source('views/settings/anchor-detail.vue')).toContain('target.placeNameKey')
  })

  it('页面不再自带模拟定位说明：横幅删了，别让它悄悄长回来', () => {
    const page = source('views/settings/anchor-detail.vue')
    // 用户明确不要这一句。抓到的坐标是不是被模拟的，由别处（页面头部的模拟横幅）承担，
    // 不在这张表单里再说一遍；两类模拟仍不得互相冒充。
    expect(page).not.toMatch(/data-anchor-gps-simulation/)
    expect(page).not.toMatch(/data-simulation-banner/)
    expect(page).not.toContain('模拟定位')
  })
})
