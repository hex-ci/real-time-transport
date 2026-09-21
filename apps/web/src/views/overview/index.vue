<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { House, LocateFixed, Building2, Wand2 } from '@lucide/vue'
import { useIntervalFn } from '@vueuse/core'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { CardGrid, EmptyState } from './components'
import type { CardRow, MiniCardConfig, OverviewMode } from './types'
import type { LineDetail, UserFavoriteLine } from '@real-time-transport/shared'
import {
  effectiveCommuteDirection,
  favoriteDirections,
  favoriteIsBidirectional,
  resolveBoardStop,
  resolveFavoriteLineId,
  resolveNearbyStop,
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
useIntervalFn(refreshAllArrivals, 10000)

/** Which view the home tab shows. "nearby" is GPS-driven, the other two ride the derived directions. */

/** Subsequent arrivals shown after the next bus on a commute card. */
const SUBSEQUENT_ARRIVALS_COUNT = 2

/**
 * A manual mode pick, remembered only for the commute slot it was made in.
 *
 * The default is fully automatic: while no override applies, the mode follows
 * the configured commute hours, so the user never has to choose a direction.
 * A manual pick wins within its own slot (so a deliberate choice is respected)
 * and expires once the slot changes — leaving for work at 08:00 does not pin
 * the evening view forever.
 */
const MODE_STORAGE_KEY = 'rt-transit-overview-mode'

function readOverride(): { mode: OverviewMode, slot: string } | null {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { mode?: string, slot?: string }
    if (
      parsed?.slot
      && (parsed.mode === 'morning' || parsed.mode === 'evening' || parsed.mode === 'nearby')
    ) {
      return { mode: parsed.mode, slot: parsed.slot }
    }
  }
  catch {
    // Legacy/foreign value: treat as no override rather than guessing
  }
  return null
}

const modeOverride = shallowRef(readOverride())

/** The commute slot the profile currently reports; a manual pick is scoped to it. */
const currentSlot = computed(() => commuteProfile.value?.mode ?? 'auto')

/** Automatic choice: the configured commute hours decide, otherwise the nearby view. */
const autoMode = computed<OverviewMode>(() => {
  const mode = commuteProfile.value?.mode
  if (mode === 'work') return 'morning'
  if (mode === 'home') return 'evening'
  return 'nearby'
})

const isManual = computed(() => modeOverride.value?.slot === currentSlot.value)

const currentMode = computed<OverviewMode>(() =>
  isManual.value && modeOverride.value ? modeOverride.value.mode : autoMode.value)

/** Human label for what the automatic rule resolved to, shown on the auto button. */
const autoModeLabel = computed(() => (
  autoMode.value === 'morning' ? '上班' : autoMode.value === 'evening' ? '下班' : '当前非通勤时段'
))

function setMode(mode: OverviewMode): void {
  modeOverride.value = { mode, slot: currentSlot.value }
  localStorage.setItem(MODE_STORAGE_KEY, JSON.stringify(modeOverride.value))
}

/** Drop the manual pick and hand control back to the commute hours. */
function useAutoMode(): void {
  modeOverride.value = null
  localStorage.removeItem(MODE_STORAGE_KEY)
}

/**
 * Per-line manual direction pick for the nearby view, keyed by favourite id.
 *
 * Scoped to a commute slot exactly like the mode override: a pick made while
 * standing on one kerb in the morning should not silently decide the evening
 * view, which is a different trip in the opposite direction.
 */
const DIRECTION_STORAGE_KEY = 'rt-transit-nearby-direction'

function readDirectionOverrides(): Record<string, { direction: 0 | 1, slot: string }> {
  try {
    const raw = localStorage.getItem(DIRECTION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, { direction?: unknown, slot?: unknown }>
    const out: Record<string, { direction: 0 | 1, slot: string }> = {}
    for (const [id, entry] of Object.entries(parsed ?? {})) {
      const d = entry?.direction
      if ((d === 0 || d === 1) && typeof entry?.slot === 'string') {
        out[id] = { direction: d, slot: entry.slot }
      }
    }
    return out
  }
  catch {
    // Legacy/foreign value: treat as no override rather than guessing.
    return {}
  }
}

const directionOverrides = shallowRef(readDirectionOverrides())

/** Promote a direction on one card; the pick applies until the commute slot changes. */
function setPrimaryDirection(favoriteId: string, direction: 0 | 1): void {
  directionOverrides.value = {
    ...directionOverrides.value,
    [favoriteId]: { direction, slot: currentSlot.value },
  }
  localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(directionOverrides.value))
}

/** Card asked to lead with the other direction. */
function onSwitchDirection(card: MiniCardConfig, direction: 0 | 1): void {
  if (!card.favoriteId) return
  setPrimaryDirection(card.favoriteId, direction)
}

/** Cached line details keyed by lineId_direction (for stop counts + target order). */
const detailCache = shallowRef<Record<string, LineDetail>>({})

const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

/** At least one favourite supports switching -> show the global toggle. */
const canSwitchAny = computed(() => cityFavorites.value.some(f => favoriteIsBidirectional(f)))

/**
 * The direction a favourite's purpose rides, as the user chose it.
 *
 * Null when never chosen — the card then shows an explicit "set your direction"
 * state. Deliberately no fallback to `preferredDirection`: that field anchors
 * which upstream lineId is direction 0, so pretending it is the commute
 * direction would display a route the user never picked.
 */
function directionFor(f: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return effectiveCommuteDirection(f, purpose)
}

/** Details of both directions of a favourite, keyed by its own direction numbers. */
function detailsOf(f: UserFavoriteLine): { 0: LineDetail | undefined, 1: LineDetail | undefined } {
  const primary = (f.preferredDirection === 1 ? 1 : 0) as 0 | 1
  const other = (1 - primary) as 0 | 1
  return {
    [primary]: detailCache.value[`${f.lineId}_${primary}`],
    [other]: f.reverseLineId ? detailCache.value[`${f.reverseLineId}_${other}`] : undefined,
  } as { 0: LineDetail | undefined, 1: LineDetail | undefined }
}

/** The upstream lineId a direction resolves to, or null when unavailable. */
function lineIdFor(f: UserFavoriteLine, direction: 0 | 1): string | null {
  if (!favoriteIsBidirectional(f)) {
    return direction === (f.preferredDirection === 1 ? 1 : 0) ? f.lineId : null
  }
  return resolveFavoriteLineId(f, direction)
}

/**
 * The platform the user is standing at, resolved per direction.
 *
 * Both directions call at the same named stop from opposite sides of the road,
 * so the shared name anchors the card while each direction contributes its own
 * order. A direction with no such stop reports a null order and simply gets no
 * row — never the other direction's timings.
 */
const nearbyByFavorite = computed<Record<string, ReturnType<typeof resolveNearbyStop>>>(() => {
  const coords = locationStore.userCoords
  const map: Record<string, ReturnType<typeof resolveNearbyStop>> = {}
  for (const f of cityFavorites.value) {
    const d = detailsOf(f)
    map[f.id!] = resolveNearbyStop({ 0: d[0]?.stops, 1: d[1]?.stops }, coords)
  }
  return map
})

/**
 * Which direction leads on a nearby card.
 *
 * Order of preference:
 *   1. a manual pick for this line, while it is still in season;
 *   2. the commute leg the current slot belongs to — leaving for work leads with
 *      the morning board-stop direction, heading home with the evening one;
 *   3. direction 0.
 *
 * Deliberately never arrival time. The two directions call at opposite kerbs, so
 * a bus that happens to be closer across the road must not take over the
 * headline — that would make the big ETA mean a different trip every refresh.
 */
function nearbyPrimaryDirection(
  f: UserFavoriteLine,
  both: { 0: LineDetail | undefined, 1: LineDetail | undefined },
  rows: CardRow[],
): 0 | 1 | null {
  if (rows.length < 2) return null

  const available = new Set(rows.map(r => r.direction))

  const override = directionOverrides.value[f.id!]
  if (override && override.slot === currentSlot.value && available.has(override.direction)) {
    return override.direction
  }

  // The user's stated direction for this slot wins when that platform exists
  // here; outside the commute slots they have expressed no preference.
  const purpose = currentMode.value === 'morning'
    ? 'morning'
    : currentMode.value === 'evening' ? 'evening' : null
  if (purpose) {
    const chosen = directionFor(f, purpose)
    if (chosen !== null && available.has(chosen)) return chosen
  }

  return 0
}

/**
 * One card per followed ROUTE.
 *
 * Commute modes read the direction the user chose for that slot and yield a
 * single row. Nearby mode anchors on the located platform and yields one row
 * per direction that actually calls there.
 */
const cardsData = computed<MiniCardConfig[]>(() => {
  const mode = currentMode.value
  const cards: MiniCardConfig[] = []

  for (const f of cityFavorites.value) {
    const both = detailsOf(f)
    const anyDetail = both[0] ?? both[1]
    const isSubway = anyDetail?.type === 'subway' || f.lineId.startsWith('subway_')

    if (mode === 'nearby') {
      const located = nearbyByFavorite.value[f.id!]
      const rows: CardRow[] = []
      for (const direction of [0, 1] as const) {
        const detail = both[direction]
        if (!detail || !located) continue
        const order = located.perDirection[direction]?.order ?? null
        if (order === null) continue // this direction has no platform here
        rows.push({
          lineId: lineIdFor(f, direction) ?? detail.lineId,
          direction,
          stopOrder: order,
          directionName: detail.directionName,
        })
      }
      cards.push({
        lineName: f.lineName,
        directionName: rows[0]?.directionName ?? '',
        stopName: located?.name ?? null,
        stopDistanceMeters: located?.distanceMeters ?? null,
        detailLoaded: Boolean(anyDetail),
        isSubway,
        rows,
        primaryDirection: nearbyPrimaryDirection(f, both, rows),
        detailLineId: rows[0]?.lineId ?? f.lineId,
        detailDirection: rows[0]?.direction ?? 0,
        favoriteId: f.id ?? null,
      })
      continue
    }

    const purpose = mode
    const direction = directionFor(f, purpose)
    // No direction chosen yet: render the card with its honest empty state
    // rather than defaulting to direction 0, which would show a route the user
    // never said they ride.
    if (direction === null) {
      // Nothing is configured for this leg, so there is no row to read a target
      // from. The route itself is still viewable, so point at the favourite's
      // own primary lineId — the anchor `preferredDirection` describes.
      cards.push({
        lineName: f.lineName,
        directionName: '',
        stopName: null,
        stopDistanceMeters: null,
        detailLoaded: Boolean(anyDetail),
        isSubway,
        rows: [],
        primaryDirection: null,
        detailLineId: f.lineId,
        detailDirection: (f.preferredDirection === 1 ? 1 : 0) as 0 | 1,
        favoriteId: f.id ?? null,
      })
      continue
    }

    const detail = both[direction]
    const stopName = resolveBoardStop(f, purpose)
    const stop = stopName ? detail?.stops.find(s => s.name === stopName) : undefined
    cards.push({
      lineName: f.lineName,
      directionName: detail?.directionName ?? '',
      stopName: stop?.name ?? null,
      stopDistanceMeters: null,
      detailLoaded: Boolean(detail),
      isSubway,
      rows: stop && detail
        ? [{
            lineId: lineIdFor(f, direction) ?? detail.lineId,
            direction,
            stopOrder: stop.order,
            directionName: detail.directionName,
          }]
        : [],
      // A commute card carries one row, so the lead is that row regardless.
      primaryDirection: null,
      // Direction is chosen here, but the stop may be unset: fall back to the
      // direction's own lineId so the card stays tappable either way.
      detailLineId: lineIdFor(f, direction) ?? detail?.lineId ?? f.lineId,
      detailDirection: direction,
      favoriteId: f.id ?? null,
    })
  }
  return cards
})

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
    // Each direction the route actually has, with the lineId serving it. A
    // single-direction route yields one entry, so nothing fetches a phantom
    // reverse leg that upstream does not have.
    for (const { direction: dir, lineId } of favoriteDirections(f)) {
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

/** Arrival feed per card key: lineId_direction -> station arrivals response. */
interface StationArrivalsFeed {
  isExact: boolean
  arrivals: Array<{
    time: string
    etaSeconds: number
    stopsAway?: number
    distanceMeters?: number
    isAtStation?: boolean
  }>
}
const arrivalsMap = shallowRef<Record<string, StationArrivalsFeed | null>>({})

function arrivalsKey(lineId: string, direction: number): string {
  return `${lineId}_${direction}`
}

/**
 * Fetch real ETAs for every row of every card via the station-arrivals
 * endpoint (the server filters passed buses and honours the upstream -1
 * sentinel).
 *
 * Each row carries its OWN order for the displayed stop, so a direction that
 * numbers the stop differently still queries its own timetable — borrowing the
 * other direction's order would silently return a different station's data,
 * because the server matches by order first.
 */
async function refreshAllArrivals(): Promise<void> {
  const nextMap: Record<string, StationArrivalsFeed | null> = {}

  const tasks = cardsData.value.flatMap(async (card) => {
    if (!card.stopName) return
    for (const row of card.rows) {
      const key = arrivalsKey(row.lineId, row.direction)
      if (row.stopOrder === null) {
        nextMap[key] = null
        continue
      }
      try {
        const qs = new URLSearchParams({
          direction: String(row.direction),
          order: String(row.stopOrder),
          count: String(1 + SUBSEQUENT_ARRIVALS_COUNT),
          cityCode: cityStore.currentCode,
        })
        const res = await fetch(
          `/api/transit/lines/${encodeURIComponent(row.lineId)}/stations/${encodeURIComponent(card.stopName)}/arrivals?${qs.toString()}`,
        )
        const json = await res.json()
        nextMap[key] = json.success ? (json.data as StationArrivalsFeed) : null
      }
      catch {
        nextMap[key] = null
      }
    }
  })

  await Promise.allSettled(tasks)
  arrivalsMap.value = nextMap
}

function goToDetail(lineId: string, direction: number): void {
  router.push({
    path: `/line/${encodeURIComponent(lineId)}`,
    query: { direction: String(direction), cityCode: cityStore.currentCode },
  })
}

/** Reload everything for the active city: favourites, then static detail, then arrivals. */
async function reloadForCurrentCity(): Promise<void> {
  await transitStore.fetchFavorites()
  await ensureDetails()
  await refreshAllArrivals()
}

// City changed -> drop caches and reload for the new city
watch(
  () => cityStore.currentCode,
  () => {
    detailCache.value = {}
    arrivalsMap.value = {}
    void reloadForCurrentCity()
  },
)

// Mode switched -> refresh arrivals for the newly displayed direction(s)
watch(
  () => currentMode.value,
  () => {
    void refreshAllArrivals()
  },
)

// A GPS fix landing in nearby mode fills the nearest-stop anchors
watch(
  () => locationStore.userCoords,
  (coords) => {
    if (coords && currentMode.value === 'nearby') void refreshAllArrivals()
  },
)

// Favorites changed (added/removed in settings) -> prime details for new lines
watch(
  () => cityFavorites.value.map(f => `${f.lineId}_${f.cityCode}`).join('|'),
  async () => {
    await ensureDetails()
    await refreshAllArrivals()
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
  <div class="space-y-2.5 sm:space-y-5 pb-12">
    <!-- Smart Context Hero Banner -->
    <div class="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 p-3.5 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5 md:p-6">
      <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
        <!-- Left Column: Mode badge, Time, Title -->
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
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
          <p class="mt-1 hidden text-xs text-slate-400 md:block lg:text-base">
            真实上游秒级推演，点击卡片进入拓扑长轴报站大屏
          </p>
        </div>

        <!-- Right Column: mode switcher (auto/morning/evening/nearby) + locate.
             Full width on mobile (switcher and locate stack), inline from md up. -->
        <div class="flex w-full shrink-0 flex-col gap-1.5 md:w-auto md:flex-row md:items-center md:gap-2">
          <div
            v-if="canSwitchAny"
            class="flex h-10 w-full items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 p-1 shadow-sm md:w-auto"
          >
            <!-- Auto: hands control back to the configured commute hours. Active
                 whenever the user has not pinned a mode for the current slot. -->
            <button
              class="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition md:flex-none md:px-2.5"
              :class="!isManual ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
              :title="`自动：按通勤时段判断（当前 ${autoModeLabel}）`"
              @click="useAutoMode"
            >
              <Wand2 class="h-3.5 w-3.5 shrink-0" />
              <span>自动</span>
            </button>
            <button
              class="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition md:flex-none md:px-2.5"
              :class="currentMode === 'morning' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
              @click="setMode('morning')"
            >
              <House class="h-3.5 w-3.5 shrink-0" />
              <span>上班</span>
            </button>
            <button
              class="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition md:flex-none md:px-2.5"
              :class="currentMode === 'evening' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
              @click="setMode('evening')"
            >
              <Building2 class="h-3.5 w-3.5 shrink-0" />
              <span>下班</span>
            </button>
            <button
              class="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition md:flex-none md:px-2.5"
              :class="currentMode === 'nearby' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
              @click="setMode('nearby')"
            >
              <LocateFixed class="h-3.5 w-3.5 shrink-0" />
              <span>附近</span>
            </button>
          </div>
          <button
            class="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-2.5 text-xs font-medium whitespace-nowrap text-cyan-400 shadow-sm transition hover:bg-cyan-500/20 active:scale-95 md:w-auto md:px-3 lg:min-h-11 lg:gap-2 lg:px-3.5 lg:text-base"
            @click="locationStore.requestLocation({ userInitiated: true })"
          >
            <LocateFixed class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span>定位最近站</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Cards Grid: fluid responsive grid from 1 col on mobile to 4 cols on ultrawide.
         Gap follows the page rhythm (space-y) so card-to-card matches nav-to-hero. -->
    <CardGrid
      v-if="cardsData.length > 0"
      :cards="cardsData"
      :mode="currentMode"
      :arrivals="arrivalsMap"
      @open="goToDetail"
      @switch-direction="onSwitchDirection"
    />

    <!-- Empty state -->
    <EmptyState v-else :city-name="cityStore.currentCityName" />
  </div>
</template>
