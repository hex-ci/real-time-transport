<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight } from '@lucide/vue'
import { useIntervalFn, useWakeLock } from '@vueuse/core'
import type { LineDetail } from '@real-time-transport/shared'
import {
  deriveCommuteDirections,
  resolveBoardStop,
  resolveFavoriteLineId,
} from '@real-time-transport/shared/line-group'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'

interface KioskCard {
  lineId: string
  lineName: string
  direction: number
  directionName: string
  isSubway: boolean
  targetStationName: string | null
  targetOrder: number | null
  etaMinutes: number | null
  etaTime: string | null
  arrivalCount: number
}

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
    for (const dir of [f.preferredDirection ?? 0, f.reverseLineId ? (f.preferredDirection === 1 ? 0 : 1) : null] as Array<number | null>) {
      if (dir === null) continue
      const key = detailKey(f.lineId, dir)
      if (nextDetails[key]) continue
      try {
        const qs = new URLSearchParams({ direction: String(dir), cityCode: cityStore.currentCode })
        const res = await fetch(`/api/transit/lines/${encodeURIComponent(f.lineId)}?${qs.toString()}`)
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

/**
 * Direction derivation per favourite (same rule as the overview). Null =
 * underivable — the card then rides preferredDirection.
 */
const derivedDirections = computed<Record<string, { morning: 0 | 1, evening: 0 | 1 } | null>>(() => {
  const map: Record<string, { morning: 0 | 1, evening: 0 | 1 } | null> = {}
  for (const f of cityFavorites.value) {
    const d0 = lineDetails.value[`${f.lineId}_${f.preferredDirection === 1 ? 1 : 0}`]
    const d1 = f.reverseLineId
      ? lineDetails.value[`${f.reverseLineId}_${f.preferredDirection === 1 ? 0 : 1}`]
      : undefined
    map[f.id!] = d0 && d1 ? deriveCommuteDirections(f, { 0: d0, 1: d1 }) : null
  }
  return map
})

/** The kiosk board always shows the CURRENT commute leg by configured hours. */
const activePurpose = computed<'morning' | 'evening'>(() => {
  const mode = transitStore.commuteProfile?.mode
  return mode === 'home' ? 'evening' : 'morning'
})

const kioskCards = computed<KioskCard[]>(() => {
  return cityFavorites.value.map((f) => {
    const purpose = activePurpose.value
    const derived = derivedDirections.value[f.id!]
    const dir: 0 | 1 = derived ? derived[purpose] : ((f.preferredDirection === 1 ? 1 : 0) as 0 | 1)
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

  // Arrivals for every favourite's board stop (per derived direction)
  const nextMap: Record<string, { arrivals: Array<{ time: string, etaSeconds: number, isAtStation?: boolean }> } | null> = {}
  const tasks = cityFavorites.value.map(async (f) => {
    const purpose = activePurpose.value
    const derived = derivedDirections.value[f.id!]
    const dir: 0 | 1 = derived ? derived[purpose] : ((f.preferredDirection === 1 ? 1 : 0) as 0 | 1)
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
    <!-- Header -->
    <div class="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:p-4 md:p-5 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 class="flex flex-wrap items-center gap-2 text-base font-bold text-white sm:text-lg">
          <span>玄关看板</span>
          <span class="rounded-full border border-cyan-500/30 bg-cyan-500/20 px-2 py-0.5 text-xs font-normal text-cyan-400">
            {{ isWakeLocked ? '屏幕常亮保持中' : '常亮待激活' }}
          </span>
        </h2>
        <p class="mt-0.5 text-xs text-slate-400">
          {{ cityStore.currentCityName }} · 专为副屏、平板或玄关挂载优化，低刷省电防息屏
        </p>
      </div>

      <div class="flex items-center gap-2 font-mono text-lg font-bold text-cyan-400 sm:text-xl">
        {{ clockTime }}
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="p-10 text-center text-sm text-slate-400">
      正在加载关注线路...
    </div>

    <!-- Empty -->
    <div
      v-else-if="kioskCards.length === 0"
      class="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center"
    >
      <p class="text-sm text-slate-400">
        当前城市（{{ cityStore.currentCityName }}）暂无关注线路
      </p>
      <RouterLink
        to="/settings"
        class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20"
      >
        <span>去关注线路</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </div>

    <!-- Multi-Line Stacked Route Bars: fluid grid across breakpoints -->
    <div v-else class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <div
        v-for="card in kioskCards"
        :key="`${card.lineId}_${card.direction}`"
        class="rounded-2xl border border-slate-800 bg-slate-950 p-4 shadow-xl"
        :class="{ 'md:col-span-2 xl:col-span-3 2xl:col-span-4': kioskCards.length === 1 }"
      >
        <div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div class="flex items-center gap-2">
            <span
              class="rounded-lg border px-2.5 py-1 font-mono text-sm font-bold whitespace-nowrap"
              :class="card.isSubway
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'"
            >
              {{ card.lineName }}
            </span>
            <span class="text-sm font-semibold text-slate-200">{{ card.directionName }}</span>
          </div>
          <span class="font-mono text-xs text-slate-400">
            {{ card.isSubway ? '官方排班推演' : '实时上游' }}
          </span>
        </div>

        <div class="flex items-center justify-between gap-3 py-3.5 sm:py-4">
          <div class="min-w-0 flex-1">
            <span class="block truncate text-xs text-slate-400">
              {{ card.targetStationName ? `${card.targetStationName} 进站倒计时` : '目标站（未设置上车点）' }}
            </span>
            <div
              class="truncate font-mono text-2xl font-black sm:text-3xl"
              :class="card.isSubway ? 'text-amber-400' : 'text-cyan-400'"
            >
              <template v-if="card.etaMinutes !== null">
                {{ card.etaMinutes }} <span class="text-sm font-normal text-slate-400">分钟</span>
                <span v-if="card.etaTime" class="ml-1 text-xs font-normal text-slate-500">{{ card.etaTime }}</span>
              </template>
              <template v-else-if="card.targetStationName">
                <span class="font-sans text-base font-normal text-slate-400 sm:text-lg">暂无来车 / 待发车</span>
              </template>
              <template v-else>
                <span class="font-sans text-base font-normal text-slate-400 sm:text-lg">未设置上车点</span>
              </template>
            </div>
          </div>
          <div class="shrink-0 text-right">
            <span class="block text-xs text-slate-400">前方来车</span>
            <div class="flex items-baseline justify-end gap-1 font-mono text-xl font-bold whitespace-nowrap text-emerald-400">
              <span>{{ card.arrivalCount }}</span>
              <span class="text-xs font-normal text-slate-400">班</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
