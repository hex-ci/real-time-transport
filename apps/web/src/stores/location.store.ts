import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useDebounceFn, useGeolocation, usePermission } from '@vueuse/core'
import type { Station } from '@real-time-transport/shared'
import { haversineMeters, statedCoordinate } from '@real-time-transport/shared/geo'

/**
 * Development-only GPS override.
 *
 * `VITE_GPS_SIMULATION=true` pins the position to fixed coordinates so the
 * location-driven views (nearby mode, nearest-stop anchor, walk decisions) can
 * be exercised without physically moving or granting a browser permission.
 *
 * The coordinates are read inside a `import.meta.env.DEV` branch: Vite replaces
 * that flag with a literal at build time, so a production bundle drops the whole
 * block — including the numbers — instead of shipping a dormant override.
 */
const SIMULATION_ENABLED = import.meta.env.DEV
  && import.meta.env.VITE_GPS_SIMULATION === 'true'

const SIMULATION_COORDS: { lat: number, lng: number } | null = (() => {
  if (!SIMULATION_ENABLED) return null
  const rawLat = import.meta.env.VITE_GPS_SIM_LAT
  const rawLng = import.meta.env.VITE_GPS_SIM_LNG
  // An empty value is not a coordinate: `Number('')` is 0, so a missing half
  // would otherwise read as a valid 0 and place the user at (lat, 0). Reject the
  // blank before the numeric check, then require both halves to be finite.
  if (!rawLat?.trim() || !rawLng?.trim()) return null
  const lat = Number(rawLat)
  const lng = Number(rawLng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
})()

/**
 * A one-shot fix, exactly as the browser reported it.
 *
 * WGS-84, unconverted: the server's `/settings` PATCH owns the single
 * WGS-84 → GCJ-02 conversion, because a stored anchor becomes the origin of
 * every later walking route and a coordinate converted twice lands ~500 m away.
 */
export interface AnchorFix {
  lat: number
  lng: number
  accuracyM: number | null
}

/**
 * Copy for a failed one-shot grab, keyed by failure kind.
 *
 * Each line names what the failure costs the user: without a position there is
 * no anchor, so the app cannot compute the walking time and therefore cannot
 * say when to leave. A bare 「定位失败」 reads as a hiccup and leaves the anchor
 * silently unset, which is the failure mode this copy exists to prevent.
 */
export const ANCHOR_CAPTURE_ERRORS = {
  unsupported: '当前浏览器不支持定位，无法抓取位置锚点，因此算不出出门时间。请换用支持定位的浏览器后重试。',
  denied: '定位权限被拒绝，无法抓取位置锚点，因此算不出出门时间。请在浏览器设置中允许本网站获取位置后重试。',
  unavailable: '没有取到当前位置，暂时算不出出门时间。请开启设备的定位服务后重试。',
  timeout: '定位超时，没有取到当前位置，暂时算不出出门时间。请到窗口或空旷处后重试。',
  failed: '定位失败，没有取到当前位置，暂时算不出出门时间。请检查设备的定位服务后重试。',
} as const

/**
 * Read a browser position into the fix an anchor is stored from.
 *
 * `latitude`/`longitude` are passed through untouched — they are WGS-84 as the
 * device reports them, and the browser may not convert them. Accuracy is
 * carried when the device measured one and reported as absent when it did not:
 * never invented.
 */
export function anchorFixFromPosition(position: GeolocationPosition): AnchorFix {
  const { latitude, longitude, accuracy } = position.coords
  return {
    lat: latitude,
    lng: longitude,
    accuracyM: Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null,
  }
}

/** The copy for a failed grab, from the browser's own error code. */
export function anchorCaptureMessage(error: { code?: number } | null | undefined): string {
  if (!error) return ANCHOR_CAPTURE_ERRORS.failed
  if (error.code === 1) return ANCHOR_CAPTURE_ERRORS.denied
  if (error.code === 2) return ANCHOR_CAPTURE_ERRORS.unavailable
  if (error.code === 3) return ANCHOR_CAPTURE_ERRORS.timeout
  return ANCHOR_CAPTURE_ERRORS.failed
}

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

  /** True while the fixed development position stands in for a real fix. */
  const isSimulated = computed(() => SIMULATION_COORDS !== null)

  /**
   * The current fix, or null. `useGeolocation` seeds its coords with
   * `POSITIVE_INFINITY` sentinels until the first position arrives — treating
   * those as real would poison every haversine result with NaN.
   */
  const userCoords = computed<{ lat: number, lng: number } | null>(() => {
    if (SIMULATION_COORDS) return SIMULATION_COORDS
    const { latitude, longitude } = geo.coords.value
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    return { lat: latitude, lng: longitude }
  })

  /** Horizontal accuracy of the current fix in metres, when reported. */
  const accuracyM = computed<number | null>(() => {
    // The fixed development position has no measured accuracy to report.
    if (SIMULATION_COORDS) return null
    const acc = geo.coords.value.accuracy
    return Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null
  })

  /** Acquiring a position (tracking requested, no fix yet). */
  const isLocating = computed(() => tracking.value && userCoords.value === null)

  const locationError = computed<string | null>(() => {
    // A fixed position cannot fail, so no permission or device error applies.
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

  /** True while a one-shot anchor grab is in flight. */
  const isCapturingAnchor = shallowRef(false)

  /**
   * Grab the CURRENT position once, for a stored anchor.
   *
   * Deliberately not the store's `geo`/`watchPosition` pair: an anchor is a
   * point chosen once, not a position that follows the user, and a live stream
   * here would let a saved anchor drift as they walk. `getCurrentPosition`
   * resolves a single fix and stops.
   *
   * The fix leaves this function exactly as the browser reported it — WGS-84,
   * unconverted. The server converts it once at the `/settings` PATCH boundary;
   * converting here too would move the stored anchor ~500 m and invert the
   * 出门结论 against its 3-minute wait tolerance.
   */
  async function captureAnchorFix(): Promise<AnchorFix> {
    if (SIMULATION_COORDS) {
      // The same fixed development position the live stream stands in with, so
      // the picker is usable without physically moving. The page marks it.
      return { lat: SIMULATION_COORDS.lat, lng: SIMULATION_COORDS.lng, accuracyM: null }
    }

    // Resolved at call time rather than through `geo`: this is the one-shot API
    // and not the live stream, so it asks for the capability now and reports a
    // browser that has none instead of leaving the button dead.
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
            // A stored anchor must be where the user stands NOW: a cached fix
            // from another place is exactly the error this feature cannot take.
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
   * Start continuous tracking.
   *
   * A denied permission stays denied — re-requesting only spams the console (and
   * on iOS cannot re-open the prompt anyway), so automatic callers are ignored
   * once denied and only an explicit user tap retries.
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

  /**
   * The stop of `stationPool` nearest the current fix, or null.
   *
   * A stop is measured only where it states a position: a missing coordinate —
   * and a zero on either axis, which on this app's GCJ-02 datum is the same
   * absence rather than a point at (0, 0) — is read through `statedCoordinate`,
   * the ONE place that rule lives, rather than restated here. That read is what
   * keeps an unplaced platform from being presented as the nearest thing to the
   * user, and it is deliberately the shared helper so this store cannot drift
   * from the server-side reads that apply the same rule.
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
    // No stop carries a position: report none rather than defaulting to the
    // first stop, which would present an arbitrary stop as "nearest".
    return closest
  })

  const nearestDistanceM = computed<number | null>(() => {
    const coords = userCoords.value
    const nearest = nearestStation.value
    if (!coords || !nearest) return null
    // Same rule, same read: the candidate this distance is measured to is the one
    // `nearestStation` accepted, and a coordinate it did not accept cannot be
    // measured from here either.
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
