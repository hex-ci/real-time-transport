import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useDebounceFn, useGeolocation, usePermission } from '@vueuse/core'
import type { Station } from '@real-time-transport/shared'
import { haversineMeters } from '@real-time-transport/shared/geo'

/**
 * Reactive geolocation built on vueuse's `useGeolocation`, which wraps
 * `watchPosition` — a single fix goes stale as soon as the user walks to another
 * stop, so the nearest-stop computation must follow a live position stream.
 */
export const useLocationStore = defineStore('location', () => {
  const geo = useGeolocation({
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 30000,
    // Do not prompt on store creation: permission is requested only once a view
    // actually needs a position, or the user taps the locate button.
    immediate: false,
  })

  /** Reactive browser permission state, so the UI can explain a denial. */
  const permissionState = usePermission('geolocation')

  /** True once tracking has been requested and not yet stopped. */
  const tracking = shallowRef(false)

  /**
   * The current fix, or null. `useGeolocation` seeds its coords with
   * `POSITIVE_INFINITY` sentinels until the first position arrives — treating
   * those as real would poison every haversine result with NaN.
   */
  const userCoords = computed<{ lat: number, lng: number } | null>(() => {
    const { latitude, longitude } = geo.coords.value
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    return { lat: latitude, lng: longitude }
  })

  /** Horizontal accuracy of the current fix in metres, when reported. */
  const accuracyM = computed<number | null>(() => {
    const acc = geo.coords.value.accuracy
    return Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null
  })

  /** Acquiring a position (tracking requested, no fix yet). */
  const isLocating = computed(() => tracking.value && userCoords.value === null)

  const locationError = computed<string | null>(() => {
    if (!geo.isSupported.value) return '当前浏览器不支持定位'
    if (permissionState.value === 'denied') return '定位权限被拒绝，无法确定您的位置'
    const err = geo.error.value
    if (!err) return null
    if (err.code === err.PERMISSION_DENIED) return '定位权限被拒绝，无法确定您的位置'
    if (err.code === err.TIMEOUT) return '定位超时，请检查设备定位服务后重试'
    return '定位失败，请检查设备定位服务后重试'
  })

  const landmark = shallowRef('')

  /**
   * Start continuous tracking.
   *
   * A denied permission stays denied — re-requesting only spams the console (and
   * on iOS cannot re-open the prompt anyway), so automatic callers are ignored
   * once denied and only an explicit user tap retries.
   */
  function requestLocation(options?: { userInitiated?: boolean }): void {
    if (!geo.isSupported.value) return
    if (permissionState.value === 'denied' && !options?.userInitiated) return
    tracking.value = true
    geo.resume()
  }

  function stopLocation(): void {
    tracking.value = false
    geo.pause()
  }

  /** Reverse-geocode the current fix into a human landmark via the backend. */
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
      // Silent: landmark is decorative
    }
  }

  /**
   * Landmark lookups hit a rate-limited upstream, and continuous tracking emits
   * a fix per second while moving — debounce so a walk does not fire a request
   * per GPS tick.
   */
  const refreshLandmark = useDebounceFn(resolveLandmark, 2000)

  watch(userCoords, (coords) => {
    if (coords) void refreshLandmark()
  })

  /**
   * Stops of the line currently on screen. Kept as state so `nearestStation`
   * recomputes whenever either the stop list or the GPS fix changes — the
   * previous imperative version only recalculated when a view happened to call
   * it, so a moved user kept seeing the stale nearest stop.
   */
  const stationPool = shallowRef<Station[]>([])

  function updateNearestStation(stations: Station[]): void {
    stationPool.value = stations
  }

  const nearestStation = computed<Station | null>(() => {
    const coords = userCoords.value
    const stations = stationPool.value
    if (!coords || stations.length === 0) return null

    let minD = Infinity
    let closest: Station | null = null
    for (const st of stations) {
      if (!st.lat || !st.lng) continue
      const d = haversineMeters(coords.lat, coords.lng, st.lat, st.lng)
      if (d < minD) {
        minD = d
        closest = st
      }
    }
    // No stop carries coordinates: report none rather than defaulting to the
    // first stop, which would present an arbitrary stop as "nearest".
    return closest
  })

  const nearestDistanceM = computed<number | null>(() => {
    const coords = userCoords.value
    const nearest = nearestStation.value
    if (!coords || !nearest?.lat || !nearest.lng) return null
    return Math.round(haversineMeters(coords.lat, coords.lng, nearest.lat, nearest.lng))
  })

  return {
    userCoords,
    isSupported: geo.isSupported,
    isLocating,
    tracking,
    accuracyM,
    permissionState,
    locationError,
    nearestStation,
    nearestDistanceM,
    landmark,
    requestLocation,
    stopLocation,
    resolveLandmark,
    updateNearestStation,
  }
})
