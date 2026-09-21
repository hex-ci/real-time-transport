<script setup lang="ts">
import {
  computed,
  onMounted,
  shallowRef,
  watch,
} from 'vue'
import { storeToRefs } from 'pinia'
import { useIntervalFn } from '@vueuse/core'
import type { LineDetail, LiveBus } from '@real-time-transport/shared'
import { favoriteDirections } from '@real-time-transport/shared'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { useGis } from '@/composables/use-gis'
import { DepartureBoard, PlatformHeader } from './components'
import type { DepartureItem, PlatformLineRule } from './types'

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
/** A locate was requested and is waiting for the first GPS fix to arrive. */
const awaitingFix = shallowRef(false)
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
    // Load each direction the route actually HAS, under the lineId serving it:
    // upstream issues a distinct lineId per direction on bus routes, so the
    // reverse leg's stops are not reachable through f.lineId at all. A
    // single-direction route contributes one entry — never a phantom second
    // direction pointing at the same lineId.
    for (const { direction: dir, lineId } of favoriteDirections(f)) {
      const key = detailKey(lineId, dir)
      if (lineDetails.value[key]) continue
      try {
        const qs = new URLSearchParams({ direction: String(dir), cityCode: cityStore.currentCode })
        const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
        const json = await res.json()
        if (json.success && json.data) {
          lineDetails.value[key] = json.data as LineDetail
        }
      }
      catch {
        // skip
      }
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
    // The primary direction only: ranking hubs by how many followed lines call
    // here. `favoriteDirections` returns it first, so no direction arithmetic.
    const primary = favoriteDirections(f)[0]
    if (!primary) continue
    const detail = lineDetails.value[detailKey(primary.lineId, primary.direction)]
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
    // Every direction this route actually has — one row per direction, and a
    // single-direction route contributes exactly one.
    for (const { direction: dir, lineId } of favoriteDirections(f)) {
      const detail = lineDetails.value[detailKey(lineId, dir)]
      if (!detail) continue
      const stop = detail.stops.find(s => s.name === stationName)
      if (!stop) continue
      rules.push({
        lineId,
        lineName: f.lineName,
        direction: dir,
        terminal: detail.directionName,
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
  const coords = locationStore.userCoords
  if (!coords) {
    // Start tracking and let the coords watcher re-run this once a fix lands,
    // rather than sleeping a guessed interval and hoping it arrived in time.
    awaitingFix.value = true
    detecting.value = true
    locationStore.requestLocation({ userInitiated: true })
    landmarkHint.value = '正在获取定位…'
    return
  }

  awaitingFix.value = false
  detecting.value = true
  try {
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
  // loadLineDetails already pulls BOTH directions, each under the lineId that
  // serves it, so a second pass here would only re-fetch the forward route.
  await loadLineDetails()
  buildStationOptions()
  await loadPlatformDepartures()
}

/** Reload everything for the active city: favourites first, then the board. */
async function reloadForCurrentCity(): Promise<void> {
  await transitStore.fetchFavorites()
  await bootstrap()
}

watch(
  () => cityStore.currentCode,
  () => {
    lineDetails.value = {}
    currentStationName.value = ''
    departureItems.value = []
    void reloadForCurrentCity()
  },
)

/**
 * A GPS fix requested by `detectNearbyPlatform` arrives asynchronously; resume
 * the detection once coords land instead of leaving the board waiting.
 */
watch(
  () => locationStore.userCoords,
  (coords) => {
    if (coords && awaitingFix.value) void detectNearbyPlatform()
  },
)

onMounted(() => {
  void cityStore.fetchCities()
  void reloadForCurrentCity()
})
</script>

<template>
  <div class="space-y-5 pb-12">
    <PlatformHeader
      v-model="currentStationName"
      :station-options="stationOptions"
      :landmark-hint="landmarkHint"
      :detecting="detecting"
      @detect="detectNearbyPlatform"
      @change="loadPlatformDepartures"
    />

    <!-- Departure Board Table -->
    <DepartureBoard :items="departureItems" :loading="loading" />
  </div>
</template>
