<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight } from '@lucide/vue'
import { useIntervalFn, useWakeLock } from '@vueuse/core'
import type { LineDetail } from '@real-time-transport/shared'
import {
  effectiveCommuteDirection,
  favoriteDirections,
  resolveBoardStop,
  resolveFavoriteLineId,
} from '@real-time-transport/shared/line-group'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import { KioskBoard, KioskHeader } from './components'
import type { KioskCard } from './types'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const clockTime = shallowRef('')
const loading = shallowRef(false)

const { isActive: isWakeLocked, request: requestWakeLock } = useWakeLock()

const lineDetails = shallowRef<Record<string, LineDetail>>({})
const arrivalsMap = shallowRef<Record<string, { arrivals: Array<{ time: string, etaSeconds: number, isAtStation?: boolean }> } | null>>({})

const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

function detailKey(lineId: string, direction: number): string {
  return `${lineId}_${direction}`
}

async function loadDetails(): Promise<void> {
  const nextDetails = { ...lineDetails.value }
  let hasNew = false
  const tasks = cityFavorites.value.map(async (f) => {
    for (const { direction: dir, lineId } of favoriteDirections(f)) {
      // Keyed by the lineId that actually serves this direction: on bus routes
      // upstream issues a DISTINCT lineId per direction, so the reverse leg
      // lives under another lineId entirely. Building the key from f.lineId
      // fetched the forward route's data twice and cached it under a key
      // nothing reads, leaving the board with no stop to show.
      const key = detailKey(lineId, dir)
      if (nextDetails[key]) continue
      try {
        const qs = new URLSearchParams({ direction: String(dir), cityCode: cityStore.currentCode })
        const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
        const json = await res.json()
        if (json.success && json.data) {
          nextDetails[key] = json.data as LineDetail
          hasNew = true
        }
      }
      catch {
        // skip
      }
    }
  })
  await Promise.allSettled(tasks)
  if (hasNew) {
    lineDetails.value = nextDetails
  }
}

/** The kiosk board always shows the CURRENT commute leg by configured hours. */
const activePurpose = computed<'morning' | 'evening'>(() => {
  const mode = transitStore.commuteProfile?.mode
  return mode === 'home' ? 'evening' : 'morning'
})

const kioskCards = computed<KioskCard[]>(() => {
  return cityFavorites.value.flatMap((f) => {
    const purpose = activePurpose.value
    const dir = effectiveCommuteDirection(f, purpose)
    // No direction chosen: the board has nothing honest to show for this route
    // (its stop order and arrivals all depend on the direction), so it is
    // omitted rather than pointing at an arbitrary direction.
    if (dir === null) return []
    const lineId = resolveFavoriteLineId(f, dir) ?? f.lineId
    const key = detailKey(lineId, dir)
    const detail = lineDetails.value[key]
    const feed = arrivalsMap.value[key] ?? null
    const next = feed?.arrivals?.[0] ?? null
    const isSubway = detail?.type === 'subway' || f.lineId.startsWith('subway_')

    // Board stop is the purpose-keyed pin; no GPS guessing on the kiosk board
    const stopName = resolveBoardStop(f, purpose)
    const stop = stopName ? detail?.stops.find(s => s.name === stopName) : undefined

    return {
      lineId,
      lineName: f.lineName,
      direction: dir,
      directionName: detail?.directionName || '',
      isSubway,
      targetStationName: stop?.name ?? null,
      targetOrder: stop?.order ?? null,
      etaMinutes: next ? (next.isAtStation ? 0 : Math.max(1, Math.round(next.etaSeconds / 60))) : null,
      etaTime: next?.time ?? null,
      arrivalCount: feed?.arrivals?.length ?? 0,
    }
  })
})

async function refreshKiosk(): Promise<void> {
  loading.value = Object.keys(lineDetails.value).length === 0
  await loadDetails()

  // Arrivals for every favourite's board stop (per its chosen direction)
  const nextMap: Record<string, { arrivals: Array<{ time: string, etaSeconds: number, isAtStation?: boolean }> } | null> = {}
  const tasks = cityFavorites.value.map(async (f) => {
    const purpose = activePurpose.value
    const dir = effectiveCommuteDirection(f, purpose)
    if (dir === null) return
    const lineId = resolveFavoriteLineId(f, dir) ?? f.lineId
    const key = detailKey(lineId, dir)
    const detail = lineDetails.value[key]
    const stopName = resolveBoardStop(f, purpose)
    const stop = stopName ? detail?.stops.find(s => s.name === stopName) : undefined
    if (!stop) {
      nextMap[key] = null
      return
    }
    try {
      const qs = new URLSearchParams({
        direction: String(dir),
        order: String(stop.order),
        count: '3',
        cityCode: cityStore.currentCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}/stations/${encodeURIComponent(stop.name)}/arrivals?${qs.toString()}`)
      const json = await res.json()
      nextMap[key] = json.success ? json.data : null
    }
    catch {
      nextMap[key] = null
    }
  })
  await Promise.allSettled(tasks)
  arrivalsMap.value = nextMap
  loading.value = false
}

function updateClock(): void {
  const now = new Date()
  clockTime.value = now.toLocaleTimeString('zh-CN', { hour12: false })
}

useIntervalFn(updateClock, 1000)
useIntervalFn(refreshKiosk, 15000)

/** Reload everything for the active city: favourites first, then the board data. */
async function reloadForCurrentCity(): Promise<void> {
  await transitStore.fetchFavorites()
  await refreshKiosk()
}

watch(
  () => cityStore.currentCode,
  () => {
    lineDetails.value = {}
    arrivalsMap.value = {}
    void reloadForCurrentCity()
  },
)

onMounted(() => {
  updateClock()
  void cityStore.fetchCities()
  void reloadForCurrentCity()
  void requestWakeLock('screen')
})
</script>

<template>
  <div class="space-y-6 pb-12">
    <KioskHeader
      :city-name="cityStore.currentCityName"
      :clock-time="clockTime"
      :is-wake-locked="isWakeLocked"
    />

    <!-- Loading -->
    <div v-if="loading" class="p-10 text-center text-sm text-slate-400 lg:p-10.5 lg:text-base">
      正在加载关注线路...
    </div>

    <!-- Empty -->
    <div
      v-else-if="kioskCards.length === 0"
      class="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center"
    >
      <p class="text-sm text-slate-400 lg:text-base">
        当前城市（{{ cityStore.currentCityName }}）暂无关注线路
      </p>
      <RouterLink
        to="/settings"
        class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 lg:px-4.5 lg:py-2.5 lg:text-base lg:gap-1.5"
      >
        <span>去关注线路</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </div>

    <!-- Multi-Line Stacked Route Bars: fluid grid across breakpoints -->
    <KioskBoard v-else :cards="kioskCards" />
  </div>
</template>
