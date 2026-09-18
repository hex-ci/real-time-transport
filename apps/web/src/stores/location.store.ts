import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { Station } from '@real-time-transport/shared'
import { haversineMeters } from '@real-time-transport/shared'

export const useLocationStore = defineStore('location', () => {
  const userCoords = shallowRef<{ lat: number, lng: number } | null>(null)
  const isLocating = shallowRef(false)
  const locationError = shallowRef<string | null>(null)
  const nearestStation = shallowRef<Station | null>(null)
  const nearestDistanceM = shallowRef<number | null>(null)
  const landmark = shallowRef<string>('')

  /**
   * True once the user (or the browser) has denied geolocation in this session.
   * Repeated permission prompts / console warnings on every page load are noise;
   * after a denial we only retry when the user explicitly taps the locate button.
   */
  let permissionDenied = false

  function requestLocation(options?: { userInitiated?: boolean }): void {
    if (!('geolocation' in navigator)) {
      locationError.value = '当前浏览器不支持定位'
      return
    }
    // A denied session stays denied: auto-retries would just spam the console
    // warning (and on iOS cannot re-open the prompt anyway). Only an explicit
    // user tap gets another attempt.
    if (permissionDenied && !options?.userInitiated) {
      return
    }

    isLocating.value = true
    locationError.value = null
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        permissionDenied = false
        userCoords.value = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }
        isLocating.value = false
        void resolveLandmark()
      },
      (err) => {
        // No fabricated fallback: stay honestly un-located
        userCoords.value = null
        isLocating.value = false
        if (err.code === err.PERMISSION_DENIED) {
          permissionDenied = true
          locationError.value = '定位权限被拒绝，无法确定您的位置'
        }
        else {
          locationError.value = '定位失败，请检查设备定位服务后重试'
        }
      },
      { timeout: 8000, enableHighAccuracy: true },
    )
  }

  /** Reverse-geocode current GPS into a human landmark via backend (Amap). */
  async function resolveLandmark(): Promise<void> {
    if (!userCoords.value) return
    try {
      const qs = new URLSearchParams({
        lng: String(userCoords.value.lng),
        lat: String(userCoords.value.lat),
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

  function updateNearestStation(stations: Station[]): void {
    if (!stations || stations.length === 0) {
      nearestStation.value = null
      nearestDistanceM.value = null
      return
    }

    // No GPS -> no distance-based nearest station; leave unset rather than guess
    if (!userCoords.value) {
      nearestStation.value = null
      nearestDistanceM.value = null
      return
    }

    let minD = Infinity
    let closest: Station | null = null

    for (const st of stations) {
      if (st.lat && st.lng) {
        const d = haversineMeters(userCoords.value.lat, userCoords.value.lng, st.lat, st.lng)
        if (d < minD) {
          minD = d
          closest = st
        }
      }
    }

    nearestStation.value = closest || stations[0] || null
    nearestDistanceM.value = closest ? Math.round(minD) : null
  }

  return {
    userCoords,
    isLocating,
    locationError,
    nearestStation,
    nearestDistanceM,
    landmark,
    requestLocation,
    resolveLandmark,
    updateNearestStation,
  }
})
