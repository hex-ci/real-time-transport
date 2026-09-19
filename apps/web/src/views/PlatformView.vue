<script setup lang="ts">
import {
  computed,
  onMounted,
  shallowRef,
  watch,
} from 'vue'
import { storeToRefs } from 'pinia'
import { LocateFixed } from '@lucide/vue'
import { useIntervalFn } from '@vueuse/core'
import type { LineDetail, LiveBus } from '@real-time-transport/shared'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { useGis } from '@/composables/use-gis'

interface PlatformLineRule {
  lineId: string
  lineName: string
  direction: number
  terminal: string
  stationOrder: number
}

interface DepartureItem {
  id: string
  lineName: string
  terminal: string
  etaMinutes: number | null
  stopsAway: number | null
  congestion: string
  statusText: string
}

const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()
const { fetchNearbyStations } = useGis()

const { favorites } = storeToRefs(transitStore)

const currentStationName = shallowRef('')
const stationOptions = shallowRef<string[]>([])
const landmarkHint = shallowRef('多线聚合')
const loading = shallowRef(false)
const detecting = shallowRef(false)
const departureItems = shallowRef<DepartureItem[]>([])

/** line details for all favorited lines in the current city (both directions resolved lazily) */
const lineDetails = shallowRef<Record<string, LineDetail>>({})

const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

useIntervalFn(loadPlatformDepartures, 12000)

function detailKey(lineId: string, direction: number): string {
  return `${lineId}_${direction}`
}

async function loadLineDetails(): Promise<void> {
  const tasks = cityFavorites.value.map(async (f) => {
    const dir = f.preferredDirection ?? 0
    const key = detailKey(f.lineId, dir)
    if (lineDetails.value[key]) return
    try {
      const qs = new URLSearchParams({ direction: String(dir), cityCode: cityStore.currentCode })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(f.lineId)}?${qs.toString()}`)
      const json = await res.json()
      if (json.success && json.data) {
        lineDetails.value[key] = json.data as LineDetail
      }
    }
    catch {
      // skip
    }
  })
  await Promise.allSettled(tasks)
}

/**
 * Build station options: rank stops by how many favorited lines serve them,
 * so the top options are genuine multi-line hubs.
 */
function buildStationOptions(): void {
  const counter = new Map<string, number>()
  for (const f of cityFavorites.value) {
    const detail = lineDetails.value[detailKey(f.lineId, f.preferredDirection ?? 0)]
    if (!detail) continue
    for (const s of detail.stops) {
      counter.set(s.name, (counter.get(s.name) || 0) + 1)
    }
  }
  const ranked = Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([name]) => name)
  stationOptions.value = ranked
  if (!currentStationName.value || !ranked.includes(currentStationName.value)) {
    currentStationName.value = ranked[0] || ''
  }
}

/** All (line, direction, order) rules passing through the selected station. */
function buildRulesForStation(stationName: string): PlatformLineRule[] {
  const rules: PlatformLineRule[] = []
  for (const f of cityFavorites.value) {
    // Include both directions of each favorited line
    for (const dir of [0, 1]) {
      const detail = lineDetails.value[detailKey(f.lineId, dir)]
      if (!detail) continue
      const stop = detail.stops.find(s => s.name === stationName)
      if (!stop) continue
      rules.push({
        lineId: f.lineId,
        lineName: f.lineName,
        direction: dir,
        terminal: detail.directionName || `开往 ${detail.stops[detail.stops.length - 1]?.name || '终点站'}`,
        stationOrder: stop.order,
      })
    }
  }
  return rules
}

async function loadPlatformDepartures(): Promise<void> {
  if (!currentStationName.value) {
    departureItems.value = []
    return
  }
  const rules = buildRulesForStation(currentStationName.value)
  if (rules.length === 0) {
    departureItems.value = []
    return
  }

  loading.value = true
  const results: DepartureItem[] = []

  const promises = rules.map(async (rule, idx) => {
    try {
      const qs = new URLSearchParams({ direction: String(rule.direction), cityCode: cityStore.currentCode })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(rule.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      const buses: LiveBus[] = (json.success && json.data?.buses) ? json.data.buses : []

      const upcoming = buses
        .filter(b => typeof b.order === 'number' && (b.order as number) <= rule.stationOrder)
        .sort((a, b) => (b.order as number) - (a.order as number))

      if (upcoming.length > 0) {
        const nextBus = upcoming[0]!
        const stopsAway = typeof nextBus.order === 'number'
          ? Math.max(1, rule.stationOrder - nextBus.order)
          : null
        // ETA only from real upstream travel time; no fabricated per-stop guesses
        const etaMinutes = nextBus.travelTimeSec
          ? Math.max(1, Math.round(nextBus.travelTimeSec / 60))
          : null

        results.push({
          id: `dep_${rule.lineId}_${rule.direction}_${idx}`,
          lineName: rule.lineName,
          terminal: rule.terminal,
          etaMinutes,

          stopsAway,
          congestion: nextBus.congestion,
          statusText: nextBus.congestion === 'high' ? '较拥挤' : '通畅',
        })
      }
      else {
        results.push({
          id: `dep_${rule.lineId}_${rule.direction}_${idx}`,
          lineName: rule.lineName,
          terminal: rule.terminal,
          etaMinutes: null,

          stopsAway: null,
          congestion: 'unknown',
          statusText: '暂无来车',
        })
      }
    }
    catch {
      results.push({
        id: `dep_${rule.lineId}_${rule.direction}_${idx}`,
        lineName: rule.lineName,
        terminal: rule.terminal,
        etaMinutes: null,
        stopsAway: null,
        congestion: 'unknown',
        statusText: '离线',
      })
    }
  })

  await Promise.allSettled(promises)

  results.sort((a, b) => {
    if (a.etaMinutes === null && b.etaMinutes === null) return 0
    if (a.etaMinutes === null) return 1
    if (b.etaMinutes === null) return -1
    return a.etaMinutes - b.etaMinutes
  })

  departureItems.value = results
  loading.value = false
}

/**
 * GPS radar: find the nearest real platform (Amap POI) and snap the board to
 * the matching stop name across favorited lines.
 */
async function detectNearbyPlatform(): Promise<void> {
  detecting.value = true
  try {
    if (!locationStore.userCoords) {
      locationStore.requestLocation()
      // wait briefly for the fallback/permission path to settle
      await new Promise(r => setTimeout(r, 1200))
    }
    const coords = locationStore.userCoords
    if (!coords) return

    const nearby = await fetchNearbyStations(coords.lng, coords.lat, 800)
    if (nearby.length === 0) {
      landmarkHint.value = '周边 800m 未检索到站台'
      return
    }

    // Strip POI suffixes like "(公交站)" and match against known stop names
    const stopNames = new Set(stationOptions.value)
    let matched = ''
    for (const st of nearby) {
      const clean = st.name.replace(/\(公交站\)$/, '').replace(/\(地铁站\)$/, '').trim()
      if (stopNames.has(clean)) {
        matched = clean
        break
      }
      if (stopNames.has(st.name)) {
        matched = st.name
        break
      }
    }

    const nearestPoi = nearby[0]!
    if (matched) {
      currentStationName.value = matched
      landmarkHint.value = `GPS 已对准 ${matched}（${Math.round(nearestPoi.distanceMeters)}m）`
      await loadPlatformDepartures()
    }
    else {
      landmarkHint.value = `最近站台 ${nearestPoi.name}（${Math.round(nearestPoi.distanceMeters)}m），不在关注线路中`
    }
  }
  finally {
    detecting.value = false
  }
}

async function bootstrap(): Promise<void> {
  await loadLineDetails()
  // Second pass: also load the opposite direction details for full platform coverage
  const tasks: Array<Promise<void>> = []
  for (const f of cityFavorites.value) {
    for (const dir of [0, 1]) {
      const key = detailKey(f.lineId, dir)
      if (lineDetails.value[key]) continue
      tasks.push((async () => {
        try {
          const qs = new URLSearchParams({ direction: String(dir), cityCode: cityStore.currentCode })
          const res = await fetch(`/api/transit/lines/${encodeURIComponent(f.lineId)}?${qs.toString()}`)
          const json = await res.json()
          if (json.success && json.data) {
            lineDetails.value[key] = json.data as LineDetail
          }
        }
        catch {
          // skip
        }
      })())
    }
  }
  await Promise.allSettled(tasks)
  buildStationOptions()
  await loadPlatformDepartures()
}

watch(
  () => cityStore.currentCode,
  () => {
    lineDetails.value = {}
    currentStationName.value = ''
    departureItems.value = []
    void transitStore.fetchFavorites().then(bootstrap)
  },
)

onMounted(() => {
  void cityStore.fetchCities()
  void transitStore.fetchFavorites().then(bootstrap)
})
</script>

<template>
  <div class="space-y-5 pb-12">
    <!-- Header -->
    <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 shadow-xl backdrop-blur-md sm:rounded-3xl sm:p-5 md:p-6">
      <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
        <div>
          <span class="text-xs font-semibold uppercase tracking-wider text-cyan-400">
            虚拟候车亭 · 多线聚合起降牌
          </span>
          <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold text-white sm:mt-1 md:text-2xl">
            当前站台：<span class="max-w-[200px] truncate text-cyan-300">{{ currentStationName || '选择中...' }}</span>
          </h2>
          <p class="text-xs text-slate-400">
            {{ landmarkHint }} · 按上游实际在途车推演到达时间升序排列
          </p>
        </div>

        <div class="flex w-full items-center gap-2 md:w-auto">
          <button
            class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95"
            :disabled="detecting"
            @click="detectNearbyPlatform"
          >
            <span class="inline-flex items-center gap-1.5 sm:hidden">
              <LocateFixed class="h-3.5 w-3.5 shrink-0" />
              <span>{{ detecting ? '扫描中...' : '定位' }}</span>
            </span>
            <span class="hidden items-center gap-1.5 sm:inline-flex">
              <LocateFixed class="h-3.5 w-3.5 shrink-0" />
              <span>{{ detecting ? '雷达扫描中...' : 'GPS 感知最近站台' }}</span>
            </span>
          </button>
          <select
            v-model="currentStationName"
            class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-base font-medium text-slate-200 outline-none transition focus:border-cyan-500 md:flex-none md:text-xs"
            @change="loadPlatformDepartures"
          >
            <option v-for="st in stationOptions" :key="st" :value="st">
              {{ st }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <!-- Departure Board Table -->
    <div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
      <!-- Desktop header: hidden on mobile, where the two-row card layout needs no headings -->
      <div class="hidden grid-cols-12 border-b border-slate-800 bg-slate-900/90 px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider md:grid">
        <div class="col-span-3">线路 / 始发</div>
        <div class="col-span-4">开往方向</div>
        <div class="col-span-3 text-right">预计到站</div>
        <div class="col-span-2 text-right">车况 / 状态</div>
      </div>

      <div v-if="loading" class="p-8 text-center text-xs text-slate-400">
        正在拉取上游实时车况数据...
      </div>

      <div v-else-if="departureItems.length === 0" class="p-8 text-center text-xs text-slate-400">
        该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路
      </div>

      <div v-else class="divide-y divide-slate-800/60">
        <div
          v-for="item in departureItems"
          :key="item.id"
          class="px-3 py-3 transition hover:bg-slate-900/50 md:grid md:grid-cols-12 md:items-center md:px-4 md:py-3.5"
        >
          <!-- Row 1 (mobile): line badge + direction -->
          <div class="flex items-center gap-2.5 md:col-span-3 md:col-start-1 md:row-start-1">
            <span
              class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 font-mono font-bold text-cyan-400 whitespace-nowrap"
              :class="item.lineName.length > 4 ? 'text-xs min-w-[58px]' : 'text-xs min-w-[44px]'"
            >
              {{ item.lineName }}
            </span>
            <span class="min-w-0 truncate text-xs font-medium text-slate-200 md:col-span-4 md:col-start-4 md:truncate">{{ item.terminal }}</span>
          </div>

          <!-- Row 2 (mobile): ETA + status, right-aligned against row 1's badge column -->
          <div class="mt-2 flex items-end justify-between md:col-span-6 md:col-start-7 md:row-start-1 md:mt-0 md:justify-end md:gap-4">
            <div class="font-mono">
              <template v-if="item.etaMinutes !== null">
                <span class="text-base font-bold text-cyan-400">{{ item.etaMinutes }}</span>
                <span class="text-xs text-slate-400"> 分钟</span>
                <span v-if="item.stopsAway !== null" class="block text-xs text-slate-400">距 {{ item.stopsAway }} 站</span>
              </template>
              <template v-else-if="item.statusText === '暂无来车'">
                <span class="text-xs font-normal text-slate-400">暂无来车</span>
                <span class="block text-xs text-slate-400">待发车/停运</span>
              </template>
              <template v-else-if="item.statusText === '离线'">
                <span class="text-xs font-normal text-slate-400">接口离线</span>
                <span class="block text-xs text-slate-400">数据暂不可用</span>
              </template>
              <template v-else>
                <!-- Vehicle en route but upstream provides no ETA -->
                <span class="text-xs font-normal text-slate-400">无法估算</span>
                <span class="block text-xs text-slate-400">上游未提供到站耗时</span>
              </template>
            </div>

            <span
              class="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
              :class="item.etaMinutes !== null ? (item.congestion === 'high' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300') : 'bg-slate-800 text-slate-400'"
            >
              {{ item.statusText }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
