import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * 按下定位之后的四种结局去哪里说。
 *
 * 三处调用点（首页、站台页、线路页）都把这件事交给 store：只有它知道浏览器支不支持、权限被不被拒、
 * 设备有没有作答、以及是不是真的取到了位置。故这里评判的是 store 自己推了什么 —— 每个点按的结局
 * 各一句，一句都不假；而**自动**那一次（页面挂载时要位置）一个字都不说：它不是一次点按，
 * 且位置一到界面自己就显示距离。
 *
 * 提示库被替换掉，故这里读的是那句话本身。
 */

const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: (message: string) => {
    pushed.push(message)
    return pushed.length
  },
}))

/** 设备报的一次定位。 */
const FIX = { latitude: 39.90931, longitude: 116.3974, accuracy: 12 }

/** 形如 `GeolocationPositionError` 的失败值。 */
function positionError(code: number) {
  return { code, message: 'test', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }
}

/**
 * 设备。**一个**对象，全文件共用。
 *
 * 定位与权限都在导入时从 `window.navigator` 被认下来，故每个用例改的是这个对象自己的成员 ——
 * 换一个对象只有第一次导入看得见，后面的用例读到的还是第一个。`document` 同理由此被读一次
 * （`isClient` 要求 `window` 与 `document` 都在），故它也要有一个最小的桩：没有它，这一侧根本
 * 读不到设备，四个结局就都测不出来。
 */
const device: {
  geolocation?: Record<string, unknown>
  permissions?: Record<string, unknown>
} = {}

/** 设备最后一次给出的两个回调：位置与失败都在**按下之后**才到达，与真机一样。 */
const callbacks: { success?: (position: unknown) => void, failure?: (error: unknown) => void } = {}

const watchPosition = vi.fn((success: (position: unknown) => void, failure: (error: unknown) => void) => {
  callbacks.success = success
  callbacks.failure = failure
  return 1
})

/** 设备交出一次位置。每一次都是一个新读数，与真机每秒推一个一样。 */
function deliver(): void {
  callbacks.success?.({ coords: { ...FIX }, timestamp: Date.now() })
}

/** 设备报一次失败。 */
function fail(code: number): void {
  callbacks.failure?.(positionError(code))
}

/** 权限查询的应答。设备没答上来时 vueuse 读作 prompt。 */
function permissionIs(state: PermissionState): void {
  device.permissions = {
    query: async () => ({ state, addEventListener: () => {}, removeEventListener: () => {} }),
  }
}

/** 浏览器没有这套 API 的那一档：`navigator.geolocation` 不存在。 */
function deviceIsMissing(): void {
  delete device.geolocation
  delete device.permissions
}

beforeAll(() => {
  // 模块在导入时读它：本文件评判的是设备那一侧，故固定坐标的开发覆写关掉。
  vi.stubEnv('VITE_GPS_SIMULATION', 'false')
  vi.stubEnv('VITE_GPS_SIM_LAT', '')
  vi.stubEnv('VITE_GPS_SIM_LNG', '')
})

beforeEach(() => {
  setActivePinia(createPinia())
  pushed.length = 0
  callbacks.success = undefined
  callbacks.failure = undefined
  // 每个用例从「有设备、权限已授予」开始，要别的就自己改。
  device.geolocation = { watchPosition, clearWatch: () => {} }
  permissionIs('granted')
  // 桩件每一趟都重新立一次（`afterEach` 会把它们撤掉），而设备对象本身**不**换。
  vi.stubGlobal('window', { navigator: device, document: {} })
  vi.stubGlobal('navigator', device)
  vi.stubGlobal('document', {
    createElement: () => ({ innerHTML: '', content: {} }),
    querySelector: () => null,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 加载 store —— 每个用例一份新的实例，故状态不跨用例。 */
async function freshStore() {
  vi.resetModules()
  const { useLocationStore } = await import('../stores/location.store')
  return useLocationStore()
}

/** 让权限查询、fetch 与 Vue 的侦听器都落定。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

describe('一次点按的四种结局各说一句', () => {
  it('取到了：说一句已获取位置', async () => {
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    // 位置是随后才到的：按下那一刻什么都还没说。
    expect(pushed).toEqual([])
    deliver()
    await settle()

    expect(pushed).toEqual(['已获取位置'])
    expect(store.userCoords).toEqual({ lat: FIX.latitude, lng: FIX.longitude })
  })

  it('浏览器没有这套能力：说它不支持，而不是按下一个没有回声的按钮', async () => {
    deviceIsMissing()
    const store = await freshStore()

    store.requestLocation({ userInitiated: true })
    await settle()

    expect(pushed).toEqual(['此浏览器不支持定位'])
    expect(watchPosition).not.toHaveBeenCalled()
  })

  it('权限已被拒：当场说去哪里放行，而不是等一个不会来的设备错误', async () => {
    // iOS 上被拒之后浏览器不会再弹窗，故这一次点按必须自己说清楚。
    permissionIs('denied')
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    await settle()

    expect(pushed).toEqual(['定位权限被拒，请在系统设置里允许'])
    // 而它仍然把这次尝试交给了浏览器 —— 有平台会再问一次。
    expect(watchPosition).toHaveBeenCalled()
  })

  it('取不到或超时：说暂时无法定位、请稍后再试', async () => {
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    fail(3)
    await settle()

    expect(pushed).toEqual(['暂时无法定位，请稍后再试'])
  })

  it('一次点按只说一次：位置流每秒都在动，而「已经拿到」不是每秒重新成立的事', async () => {
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()
    deliver()
    deliver()
    await settle()

    expect(pushed).toEqual(['已获取位置'])
  })

  it('取到位置之后又失败：不再改口，那一次点按已经回答过了', async () => {
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()
    fail(3)
    await settle()

    expect(pushed).toEqual(['已获取位置'])
  })

  it('再按一次：又是新的一次，取得的位置带上此刻已知的地标', async () => {
    vi.useFakeTimers()
    // 地标是随后按位置解析出来的（防抖 2 秒），故它属于**下一次**按下能带上的东西。
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ success: true, data: '建国门' }),
    }))
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()
    expect(pushed).toEqual(['已获取位置'])

    vi.advanceTimersByTime(2_000)
    await settle()
    expect(store.landmark).toBe('建国门')

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()

    expect(pushed).toEqual(['已获取位置', '已获取位置 · 建国门'])
  })
})

describe('自动那一次一个字都不说', () => {
  it('页面挂载时要位置：取到了也不说，位置一到界面自己就显示距离', async () => {
    const store = await freshStore()
    await settle()

    store.requestLocation()
    deliver()
    await settle()

    expect(store.userCoords).toEqual({ lat: FIX.latitude, lng: FIX.longitude })
    expect(pushed).toEqual([])
  })

  it('没有这套能力、或权限已被拒：自动调用同样沉默', async () => {
    deviceIsMissing()
    const unsupported = await freshStore()
    unsupported.requestLocation()
    await settle()
    expect(watchPosition).not.toHaveBeenCalled()

    // 新实例，权限换一个：同一个设备对象再改一次即可。
    setActivePinia(createPinia())
    device.geolocation = { watchPosition, clearWatch: () => {} }
    permissionIs('denied')
    const refused = await freshStore()
    await settle()
    refused.requestLocation()
    await settle()

    expect(pushed).toEqual([])
  })
})

describe('装饰性的请求失败照旧沉默', () => {
  it('地标解析落空：一个字都不说，它只是装饰', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('no connection')
    })
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()
    pushed.length = 0

    // 就是那条位置流自己会触发的那一次（防抖），此处直接调用它。
    await store.resolveLandmark()

    expect(store.landmark).toBe('')
    expect(pushed).toEqual([])
  })

  it('地标解析成功：它落在那一行字上，而不是一条提示上', async () => {
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ success: true, data: '建国门' }),
    }))
    const store = await freshStore()
    await settle()

    store.requestLocation({ userInitiated: true })
    deliver()
    await settle()
    pushed.length = 0

    await store.resolveLandmark()

    expect(store.landmark).toBe('建国门')
    expect(pushed).toEqual([])
  })
})
