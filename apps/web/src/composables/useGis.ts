import { ref } from 'vue'
import type { WalkDecision, NearbyStation } from '@real-time-transport/shared'

/**
 * GIS composable wrapping the backend Amap endpoints.
 * All calls go through the Node layer (Amap Web-Service key never touches the browser).
 */
export function useGis() {
  const walkDecision = ref<WalkDecision | null>(null)
  const nearbyStations = ref<NearbyStation[]>([])
  const isLoadingDecision = ref(false)
  const isLoadingNearby = ref(false)

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
