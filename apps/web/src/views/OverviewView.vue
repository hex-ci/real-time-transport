<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ArrowLeftRight, ChevronRight, LocateFixed } from '@lucide/vue'
import { useIntervalFn } from '@vueuse/core'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import LineMiniCard from '@/components/LineMiniCard.vue'
import type { LineDetail, LiveBus } from '@real-time-transport/shared'
import { haversineMeters } from '@real-time-transport/shared/geo'
import {
  favoriteIsBidirectional,
  resolveFavoriteLineId,
  resolvePinnedStation,
} from '@real-time-transport/shared/line-group'

const router = useRouter()
const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()

const { commuteProfile, favorites } = storeToRefs(transitStore)

const currentTimeStr = shallowRef('')

function updateTime(): void {
  const now = new Date()
  currentTimeStr.value = now.toLocaleTimeString('zh-CN', { hour12: false })
}

useIntervalFn(updateTime, 1000)
useIntervalFn(refreshAllLive, 10000)

const currentGlobalDir = shallowRef(0)

function toggleGlobalDirection(): void {
  currentGlobalDir.value = currentGlobalDir.value === 0 ? 1 : 0
}

interface MiniCardConfig {
  /** Resolved upstream lineId for the direction being displayed. */
  lineId: string
  lineName: string
  direction: number
  directionName: string
  startStop: string
  endStop: string
  targetOrder: number
  totalStops: number
  detailLoaded: boolean
  /** Whether this route can switch direction at all (bus routes need both ids). */
  canSwitch: boolean
  /** Subway routes get the amber accent, buses cyan — same rule as KioskView. */
  isSubway: boolean
}

/** Cached line details keyed by lineId_direction (for stop counts + target order). */
const detailCache = shallowRef<Record<string, LineDetail>>({})

const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

/** At least one favourite supports switching -> show the global toggle. */
const canSwitchAny = computed(() => cityFavorites.value.some(f => favoriteIsBidirectional(f)))

/**
 * One card per followed ROUTE. The global up/down toggle picks which direction
 * of every switchable route is shown; routes that only reported one direction
 * keep showing it.
 */
const cardsData = computed<MiniCardConfig[]>(() => {
  const dir = currentGlobalDir.value
  const cards: MiniCardConfig[] = []

  for (const f of cityFavorites.value) {
    const primary = f.preferredDirection === 1 ? 1 : 0
    const wanted = dir === 0 ? primary : (1 - primary) as 0 | 1
    const bidirectional = favoriteIsBidirectional(f)

    // Only use the wanted direction when it actually resolves to a lineId.
    const resolved = bidirectional ? resolveFavoriteLineId(f, wanted) : f.lineId
    const direction = resolved ? wanted : primary
    const lineId = resolved ?? f.lineId

    const detail = detailCache.value[`${lineId}_${direction}`]
    // Same rule as KioskView: the loaded detail's type wins, with the
    // `subway_` lineId prefix as a fallback before the detail has loaded.
    const isSubway = detail?.type === 'subway' || lineId.startsWith('subway_')
    cards.push({
      lineId,
      lineName: f.lineName,
      direction,
      directionName: detail?.directionName || '',
      startStop: detail?.stops[0]?.name || '',
      endStop: detail?.stops[detail.stops.length - 1]?.name || '',
      targetOrder: resolveTargetOrder(detail, resolvePinnedStation(f, direction)),
      totalStops: detail?.stops.length || 0,
      detailLoaded: Boolean(detail),
      canSwitch: bidirectional,
      isSubway,
    })
  }
  return cards
})

/** Pinned station wins; otherwise the stop closest to current GPS. No GPS -> no target. */
function resolveTargetOrder(detail: LineDetail | undefined, pinnedName?: string): number {
  if (!detail || detail.stops.length === 0) return 0
  if (pinnedName) {
    const pinned = detail.stops.find(s => s.name === pinnedName)
    if (pinned) return pinned.order
  }
  // Per-line nearest stop computed from the real GPS fix (each line has its own stops)
  const coords = locationStore.userCoords
  if (coords) {
    let minD = Infinity
    let nearestOrder = 0
    for (const s of detail.stops) {
      if (!s.lat || !s.lng) continue
      const d = haversineMeters(coords.lat, coords.lng, s.lat, s.lng)
      if (d < minD) {
        minD = d
        nearestOrder = s.order
      }
    }
    if (nearestOrder > 0) return nearestOrder
  }
  // No real basis (no pinned station, no GPS): refuse to pick a fake midpoint target
  return 0
}

const liveBusesMap = shallowRef<Record<string, LiveBus[]>>({})

/**
 * Load static line details for ALL favorites of the current city (both
 * directions), cached client-side. Must iterate cityFavorites — not cardsData —
 * otherwise the cache would never be primed and cards would never appear.
 *
 * Each direction resolves to its OWN upstream lineId: bus routes carry a
 * distinct id per direction (reverseLineId), subway reuses one id for both.
 */
async function ensureDetails(): Promise<void> {
  const nextCache = { ...detailCache.value }
  let hasNew = false
  const tasks: Array<Promise<void>> = []

  for (const f of cityFavorites.value) {
    const bidirectional = favoriteIsBidirectional(f)
    for (const dir of [0 as const, 1 as const]) {
      // Only fetch a direction that actually resolves to a lineId. For a
      // single-direction favourite we fetch just its primary direction.
      const lineId = bidirectional
        ? resolveFavoriteLineId(f, dir)
        : (dir === (f.preferredDirection === 1 ? 1 : 0) ? f.lineId : null)
      if (!lineId) continue

      const key = `${lineId}_${dir}`
      if (nextCache[key]) continue
      tasks.push((async () => {
        try {
          const qs = new URLSearchParams({
            direction: String(dir),
            cityCode: f.cityCode || cityStore.currentCode,
          })
          const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
          const json = await res.json()
          if (json.success && json.data) {
            nextCache[key] = json.data as LineDetail
            hasNew = true
          }
        }
        catch {
          // Leave uncached: card shows honest loading/unavailable state
        }
      })())
    }
  }
  await Promise.allSettled(tasks)
  if (hasNew) {
    detailCache.value = nextCache
  }
}

function liveKey(lineId: string, direction: number): string {
  return `${lineId}_${direction}`
}

async function refreshAllLive(): Promise<void> {
  const nextMap: Record<string, LiveBus[]> = {}
  const promises = cardsData.value.map(async (card) => {
    const key = liveKey(card.lineId, card.direction)
    try {
      const qs = new URLSearchParams({
        direction: String(card.direction),
        cityCode: cityStore.currentCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(card.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      nextMap[key] = (json.success && json.data?.buses) ? json.data.buses : []
    }
    catch {
      nextMap[key] = []
    }
  })
  await Promise.allSettled(promises)
  liveBusesMap.value = nextMap
}

function goToDetail(lineId: string, direction: number): void {
  router.push({
    path: `/line/${encodeURIComponent(lineId)}`,
    query: { direction: String(direction), cityCode: cityStore.currentCode },
  })
}

/** Reload everything for the active city: favourites, then static detail, then live. */
async function reloadForCurrentCity(): Promise<void> {
  await transitStore.fetchFavorites()
  await ensureDetails()
  await refreshAllLive()
}

// City changed -> drop caches and reload for the new city
watch(
  () => cityStore.currentCode,
  () => {
    detailCache.value = {}
    liveBusesMap.value = {}
    void reloadForCurrentCity()
  },
)

// Direction toggled -> refresh live data for the newly displayed direction
watch(
  () => currentGlobalDir.value,
  () => {
    void refreshAllLive()
  },
)

// Favorites changed (added/removed in settings) -> prime details for new lines
watch(
  () => cityFavorites.value.map(f => `${f.lineId}_${f.cityCode}`).join('|'),
  async () => {
    await ensureDetails()
    await refreshAllLive()
  },
)

onMounted(() => {
  updateTime()
  void cityStore.fetchCities()
  transitStore.fetchCommuteProfile()
  void reloadForCurrentCity()
  locationStore.requestLocation()
})
</script>

<template>
  <div class="space-y-5 pb-12">
    <!-- Smart Context Hero Banner -->
    <div class="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 p-3.5 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5 md:p-6">
      <div class="flex items-center justify-between gap-3 md:gap-4">
        <!-- Left Column: Mode badge, Time, Title -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-400">
              <span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
              {{ commuteProfile?.mode === 'work' ? '早高峰模式' : commuteProfile?.mode === 'home' ? '晚高峰模式' : '智能情境' }}
            </span>
            <span class="font-mono text-xs text-slate-400">{{ currentTimeStr }}</span>
            <span class="text-xs text-slate-400">· {{ cityStore.currentCityName }}</span>
          </div>
          <h2 class="mt-1.5 text-xl font-bold tracking-tight text-white sm:mt-2 md:text-2xl">
            {{ commuteProfile?.description || `${cityStore.currentCityName}通勤实时态势监控` }}
          </h2>
          <p class="mt-1 hidden text-xs text-slate-400 md:block">
            真实上游秒级推演，点击卡片进入拓扑长轴报站大屏
          </p>
        </div>

        <!-- Right Column: Buttons (stacked vertically on mobile, horizontal row on tablet/desktop) -->
        <div class="flex shrink-0 flex-col gap-1.5 md:flex-row md:items-center md:gap-2">
          <button
            v-if="canSwitchAny"
            class="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 text-xs font-medium whitespace-nowrap text-slate-200 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95 md:w-auto md:px-3"
            @click="toggleGlobalDirection"
          >
            <ArrowLeftRight class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span>{{ currentGlobalDir === 0 ? '去程（上行）' : '返程（下行）' }}</span>
          </button>
          <button
            class="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-2.5 text-xs font-medium whitespace-nowrap text-cyan-400 shadow-sm transition hover:bg-cyan-500/20 active:scale-95 md:w-auto md:px-3"
            @click="locationStore.requestLocation({ userInitiated: true })"
          >
            <LocateFixed class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span>定位最近站</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Section Title -->
    <div class="flex items-center justify-between px-1">
      <h3 class="text-sm font-semibold tracking-wider text-slate-400 uppercase">
        关注线路监控 ({{ cardsData.length }})
      </h3>
      <RouterLink
        to="/settings"
        class="inline-flex min-h-[44px] items-center gap-0.5 px-2 text-xs font-medium text-cyan-400 hover:underline active:scale-95"
      >
        <span>管理关注</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </div>

    <!-- Cards Grid: fluid responsive grid from 1 col on mobile to 4 cols on ultrawide -->
    <div v-if="cardsData.length > 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <LineMiniCard
        v-for="line in cardsData"
        :key="`${line.lineId}_${line.direction}`"
        :line-name="line.lineName"
        :direction-name="line.directionName"
        :start-stop="line.startStop"
        :end-stop="line.endStop"
        :buses="liveBusesMap[`${line.lineId}_${line.direction}`] || []"
        :target-order="line.targetOrder"
        :total-stops="line.totalStops"
        :detail-loaded="line.detailLoaded"
        :is-subway="line.isSubway"
        @click="goToDetail(line.lineId, line.direction)"
      />
    </div>

    <!-- Empty state -->
    <div
      v-else
      class="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center"
    >
      <p class="text-sm text-slate-400">
        当前城市（{{ cityStore.currentCityName }}）还没有关注线路
      </p>
      <RouterLink
        to="/settings"
        class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20"
      >
        <span>去搜索并关注线路</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </div>
  </div>
</template>
