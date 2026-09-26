import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useDebounceFn, useGeolocation, usePermission } from '@vueuse/core'
import type { Station } from '@real-time-transport/shared'
import { haversineMeters, statedCoordinate } from '@real-time-transport/shared/geo'

/**
 * 开发用的 GPS 覆写：`VITE_GPS_SIMULATION=true` 时把位置钉在固定坐标，以便不移动、不授权
 * 就能验证位置相关的界面。
 *
 * 坐标在 `import.meta.env.DEV` 分支里读取：Vite 在构建期把该标志替换成字面量，生产包会整块
 * 丢掉（含那两个数字），而不是带上一个休眠的覆写。
 */
const SIMULATION_ENABLED = import.meta.env.DEV
  && import.meta.env.VITE_GPS_SIMULATION === 'true'

const SIMULATION_COORDS: { lat: number, lng: number } | null = (() => {
  if (!SIMULATION_ENABLED) return null
  const rawLat = import.meta.env.VITE_GPS_SIM_LAT
  const rawLng = import.meta.env.VITE_GPS_SIM_LNG
  // 空值不是坐标：`Number('')` 是 0，缺一半就会读成合法的 0 并把用户放到 (lat, 0)。
  // 先拒空再做数值检查，并要求两半都是有限数。
  if (!rawLat?.trim() || !rawLng?.trim()) return null
  const lat = Number(rawLat)
  const lng = Number(rawLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
})()

/**
 * 一次性的定位，原样保留浏览器的报告。
 *
 * WGS-84，不做转换：服务端的 `/settings` PATCH 是唯一的 WGS-84 → GCJ-02 转换点 ——
 * 存下的锚点会成为之后每条步行路线的起点，转换两次会把坐标放到几百米之外。
 */
export interface AnchorFix {
  lat: number
  lng: number
  accuracyM: number | null
}

/**
 * 一次性抓取失败时的文案，按失败种类分。
 *
 * 每一行都说出这次失败让用户失去了什么：没有位置就没有锚点，算不出步行时间，也就说不出
 * 什么时候出发。
 */
export const ANCHOR_CAPTURE_ERRORS = {
  unsupported: '当前浏览器不支持定位，无法抓取位置锚点，因此算不出出门时间。请换用支持定位的浏览器后重试。',
  denied: '定位权限被拒绝，无法抓取位置锚点，因此算不出出门时间。请在浏览器设置中允许本网站获取位置后重试。',
  unavailable: '没有取到当前位置，暂时算不出出门时间。请开启设备的定位服务后重试。',
  timeout: '定位超时，没有取到当前位置，暂时算不出出门时间。请到窗口或空旷处后重试。',
  failed: '定位失败，没有取到当前位置，暂时算不出出门时间。请检查设备的定位服务后重试。',
} as const

/**
 * 把浏览器的定位读成锚点存下的形状。
 *
 * `latitude`/`longitude` 原样通过：它们就是设备报告的 WGS-84，浏览器无权转换。精度只在设备
 * 测到时携带，没测到就报为缺席 —— 绝不臆造。
 */
export function anchorFixFromPosition(position: GeolocationPosition): AnchorFix {
  const { latitude, longitude, accuracy } = position.coords
  return {
    lat: latitude,
    lng: longitude,
    accuracyM: Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null,
  }
}

export function anchorCaptureMessage(error: { code?: number } | null | undefined): string {
  if (!error) return ANCHOR_CAPTURE_ERRORS.failed
  if (error.code === 1) return ANCHOR_CAPTURE_ERRORS.denied
  if (error.code === 2) return ANCHOR_CAPTURE_ERRORS.unavailable
  if (error.code === 3) return ANCHOR_CAPTURE_ERRORS.timeout
  return ANCHOR_CAPTURE_ERRORS.failed
}

/**
 * 建在 vueuse 的 `useGeolocation` 上的响应式定位，它包的是 `watchPosition`：一次定位在用户
 * 走到下一站时就已经过期，所以最近站的计算必须跟着一条活的位置流走。
 */
export const useLocationStore = defineStore('location', () => {
  const geo = useGeolocation({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 30000,
    // 创建 store 时不弹权限：只有界面真的需要位置、或用户点了定位按钮才请求。
    immediate: false,
  })

  const permissionState = usePermission('geolocation')

  const tracking = shallowRef(false)

  const isSimulated = computed(() => SIMULATION_COORDS !== null)

  /**
   * 当前定位，或 null。`useGeolocation` 在第一个位置到达前用 `POSITIVE_INFINITY` 哨兵值
   * 填充坐标 —— 把它们当成真值会让每个 haversine 结果都变成 NaN。
   */
  const userCoords = computed<{ lat: number, lng: number } | null>(() => {
    if (SIMULATION_COORDS) return SIMULATION_COORDS
    const { latitude, longitude } = geo.coords.value
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    return { lat: latitude, lng: longitude }
  })

  const accuracyM = computed<number | null>(() => {
    // 固定位置没有测得的精度可报。
    if (SIMULATION_COORDS) return null
    const acc = geo.coords.value.accuracy
    return Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null
  })

  const isLocating = computed(() => tracking.value && userCoords.value === null)

  const locationError = computed<string | null>(() => {
    // 固定位置不会失败，权限与设备错误都不适用。
    if (SIMULATION_COORDS) return null
    if (!geo.isSupported.value) return '当前浏览器不支持定位'
    if (permissionState.value === 'denied') return '定位权限被拒绝，无法确定您的位置'
    const err = geo.error.value
    if (!err) return null
    if (err.code === err.PERMISSION_DENIED) return '定位权限被拒绝，无法确定您的位置'
    if (err.code === err.TIMEOUT) return '定位超时，请检查设备定位服务后重试'
    return '定位失败，请检查设备定位服务后重试'
  })

  const landmark = shallowRef('')

  const isCapturingAnchor = shallowRef(false)

  /**
   * 抓取「当前」位置一次，用于存下的锚点。
   *
   * 刻意不用本 store 的 `geo`/`watchPosition`：锚点是一次选定的点，不是跟着用户走的定位，
   * 用活的位置流会让存下的锚点随着走动漂移。`getCurrentPosition` 只解出一次定位就停。
   *
   * 定位值原样离开这个函数 —— WGS-84，未转换。
   */
  async function captureAnchorFix(): Promise<AnchorFix> {
    if (SIMULATION_COORDS) {
      // 与实时流所用的同一个固定位置，好让选择器不必真的移动就能用；页面会把它标出来。
      return { lat: SIMULATION_COORDS.lat, lng: SIMULATION_COORDS.lng, accuracyM: null }
    }

    // 在调用时取能力而不是经 `geo`：这是一次性 API 而非活的定位流，所以要当场问，并把
    // 「浏览器没有这个能力」报出来，而不是让按钮点了没反应。
    const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation
    if (!geolocation) {
      throw new Error(ANCHOR_CAPTURE_ERRORS.unsupported)
    }

    isCapturingAnchor.value = true
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        geolocation.getCurrentPosition(
          resolve,
          err => reject(new Error(anchorCaptureMessage(err))),
          {
            enableHighAccuracy: true,
            timeout: 15000,
            // 存下的锚点必须是用户此刻站的位置：别处的缓存定位正是这个功能承受不了的错误。
            maximumAge: 0,
          },
        )
      })
      return anchorFixFromPosition(position)
    }
    finally {
      isCapturingAnchor.value = false
    }
  }

  /**
   * 开始连续跟踪。
   *
   * 被拒绝的权限保持被拒绝：重复请求只是刷控制台（iOS 上也开不出第二次弹窗），所以一旦被拒
   * 就忽略自动调用方，只有用户显式点按才会重试。
   */
  function requestLocation(options?: { userInitiated?: boolean }): void {
    if (SIMULATION_COORDS) return
    if (!geo.isSupported.value) return
    if (permissionState.value === 'denied' && !options?.userInitiated) return
    tracking.value = true
    geo.resume()
  }

  function stopLocation(): void {
    tracking.value = false
    geo.pause()
  }

  async function resolveLandmark(): Promise<void> {
    const coords = userCoords.value
    if (!coords) return
    try {
      const qs = new URLSearchParams({
        lng: String(coords.lng),
        lat: String(coords.lat),
      })
      const res = await fetch(`/api/transit/gis/regeo?${qs.toString()}`)
      const json = await res.json()
      if (json.success && json.data) {
        landmark.value = String(json.data)
      }
    }
    catch {
      // 静默：地标只是装饰。
    }
  }

  /**
   * 持续跟踪在移动中每秒产生一次定位，防抖 2 秒：走一段路不应该按定位次数发请求。
   */
  const refreshLandmark = useDebounceFn(resolveLandmark, 2000)

  watch(userCoords, (coords) => {
    if (coords) void refreshLandmark()
  })

  /**
   * 当前在屏线路的停靠站。放在 state 里，使停靠站表或定位任一变都会重算 `nearestStation` ——
   * 命令式的写法只在某个界面恰好调用它时才重算，用户移动后就一直看着过期的最近站。
   */
  const stationPool = shallowRef<Station[]>([])

  function updateNearestStation(stations: Station[]): void {
    stationPool.value = stations
  }

  /**
   * `stationPool` 里离当前定位最近的一站，或 null。
   *
   * 只有说出了位置的站才参与测量：缺坐标，以及任一轴上的 0（在本应用的 GCJ-02 基准上那是同
   * 一种缺席，而不是 (0, 0) 这个点），一律经 `statedCoordinate` 读取 —— 那是这条规则唯一的
   * 所在，不在这里重述。正是这次读取，挡住了一个没有位置的站台被当成离用户最近的东西；也
   * 正因为它刻意是共享的助手，本 store 不会与服务端那几处同样的读取漂移。
   */
  const nearestStation = computed<Station | null>(() => {
    const coords = userCoords.value
    const stations = stationPool.value
    if (!coords || stations.length === 0) return null

    let minD = Infinity
    let closest: Station | null = null
    for (const st of stations) {
      const lat = statedCoordinate(st.lat)
      const lng = statedCoordinate(st.lng)
      if (lat === undefined || lng === undefined) continue
      const d = haversineMeters(coords.lat, coords.lng, lat, lng)
      if (d < minD) {
        minD = d
        closest = st
      }
    }
    // 没有任何一站带位置：报「没有」，而不是退回到第一站 —— 那会把一个任意的站呈现成「最近」。
    return closest
  })

  const nearestDistanceM = computed<number | null>(() => {
    const coords = userCoords.value
    const nearest = nearestStation.value
    if (!coords || !nearest) return null
    // 同一规则、同一次读取：被测距的候选就是 `nearestStation` 接受的那个，它没接受的坐标
    // 这里也不能测。
    const lat = statedCoordinate(nearest.lat)
    const lng = statedCoordinate(nearest.lng)
    if (lat === undefined || lng === undefined) return null
    return Math.round(haversineMeters(coords.lat, coords.lng, lat, lng))
  })

  return {
    userCoords,
    isSupported: geo.isSupported,
    isLocating,
    tracking,
    accuracyM,
    permissionState,
    locationError,
    isSimulated,
    nearestStation,
    nearestDistanceM,
    landmark,
    requestLocation,
    stopLocation,
    resolveLandmark,
    updateNearestStation,
    isCapturingAnchor,
    captureAnchorFix,
  }
})
