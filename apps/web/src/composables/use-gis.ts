import { shallowRef } from 'vue'
import type { WalkDecision } from '@real-time-transport/shared'

/** GIS 组合式：请求全部经后端转发，Web-Service key 不下发到浏览器。 */
export function useGis() {
  const walkDecision = shallowRef<WalkDecision | null>(null)
  const isLoadingDecision = shallowRef(false)

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

  function clearDecision(): void {
    walkDecision.value = null
  }

  return {
    walkDecision,
    isLoadingDecision,
    fetchWalkDecision,
    clearDecision,
  }
}
