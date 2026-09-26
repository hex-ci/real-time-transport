import { shallowRef } from 'vue'
import type { WalkDecision, NearbyStation } from '@real-time-transport/shared'

/** GIS 组合式：请求全部经后端转发，Web-Service key 不下发到浏览器。 */
export function useGis() {
  const walkDecision = shallowRef<WalkDecision | null>(null)
  const nearbyStations = shallowRef<NearbyStation[]>([])
  const isLoadingDecision = shallowRef(false)
  const isLoadingNearby = shallowRef(false)

  async function fetchWalkDecision(params: {
    originLng: number
    originLat: number
    lineId: string
    direction: number
    stationName: string
    cityCode?: string
  }): Promise<WalkDecision | null> {
    isLoadingDecision.value = true
    try {
      const qs = new URLSearchParams({
        originLng: String(params.originLng),
        originLat: String(params.originLat),
        lineId: params.lineId,
        direction: String(params.direction),
        stationName: params.stationName,
      })
      if (params.cityCode) qs.set('cityCode', params.cityCode)
      const res = await fetch(`/api/transit/gis/walk-decision?${qs.toString()}`)
      const json = await res.json()
      walkDecision.value = json.success ? json.data : null
      return walkDecision.value
    }
    catch {
      walkDecision.value = null
      return null
    }
    finally {
      isLoadingDecision.value = false
    }
  }

  async function fetchNearbyStations(lng: number, lat: number, radius: number = 800): Promise<NearbyStation[]> {
    isLoadingNearby.value = true
    try {
      const qs = new URLSearchParams({ lng: String(lng), lat: String(lat), radius: String(radius) })
      const res = await fetch(`/api/transit/gis/nearby-stations?${qs.toString()}`)
      const json = await res.json()
      nearbyStations.value = json.success ? json.data : []
      return nearbyStations.value
    }
    catch {
      nearbyStations.value = []
      return []
    }
    finally {
      isLoadingNearby.value = false
    }
  }

  function clearDecision(): void {
    walkDecision.value = null
  }

  return {
    walkDecision,
    nearbyStations,
    isLoadingDecision,
    isLoadingNearby,
    fetchWalkDecision,
    fetchNearbyStations,
    clearDecision,
  }
}
