<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { House, LocateFixed, Building2, Wand2, TriangleAlert, RefreshCw } from '@lucide/vue'
import { useIntervalFn } from '@vueuse/core'
import {
  refreshFreshnessOf,
  refreshStatusTextOf,
  useTransitStore,
} from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { CardGrid, EmptyState } from './components'
import { commuteLegStateOf } from './commute-leg'
import { nearbyLocationStateOf } from './nearby-notice'
import type { NearbyLocationState } from './nearby-notice'
import type { ArrivalsFeed, CardRow, MiniCardConfig, OverviewMode } from './types'
import type { LineDetail, RefreshLiveTarget, UserFavoriteLine } from '@real-time-transport/shared'
import { REFRESH_MAX_LINES } from '@real-time-transport/shared'
import {
  effectiveCommuteDirection,
  favoriteDirections,
  favoriteIsBidirectional,
  resolveBoardStop,
  resolveFavoriteLineId,
  resolveNearbyStop,
} from '@real-time-transport/shared/line-group'
import type { ReadState } from '@/read-state'

const router = useRouter()
const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()

const { commuteProfile, favorites } = storeToRefs(transitStore)
const {
  refreshInFlight,
  refreshOutcome,
  refreshWaitSecondsLeft,
  refreshReading,
} = storeToRefs(transitStore)

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

/**
 * The commute slot the profile currently reports; a manual pick is scoped to it.
 *
 * `auto` is the honest slot for BOTH cases the profile can be in when it is not inside a
 * stored window: outside one, and with no window stored at all. `windowState` is what tells
 * the two apart for the LABELS below — the slot itself must not lie about it.
 */
const currentSlot = computed(() => commuteProfile.value?.mode ?? 'auto')

/** Automatic choice: the configured commute hours decide, otherwise the nearby view. */
const autoMode = computed<OverviewMode>(() => {
  const mode = commuteProfile.value?.mode
  if (mode === 'work') return 'morning'
  if (mode === 'home') return 'evening'
  return 'nearby'
})

/**
 * Whether the profile read a window the user actually stored.
 *
 * A user who never saved commute hours is 「未设置」, not 「非通勤」: 非通勤 says the clock is
 * outside two configured windows, and there are none to be outside of. That is TWO facts
 * about the store — `unset` (no row) and `unchosen` (a row exists and its four times were
 * never chosen, since 009 nulls) — and both mean there is no window to be inside. The
 * distinction travels on the payload (`windowState`) because the facts are otherwise
 * byte-identical here — this screen used to print 非通勤 for a window nobody had
 * configured, and it would do so again for a row nobody had chosen hours on.
 */
const commuteWindowUnset = computed(() => {
  const state = commuteProfile.value?.windowState
  return state === 'unset' || state === 'unchosen'
})

const isManual = computed(() => modeOverride.value?.slot === currentSlot.value)

const currentMode = computed<OverviewMode>(() =>
  isManual.value && modeOverride.value ? modeOverride.value.mode : autoMode.value)

/** Human label for what the automatic rule resolved to, shown on the auto button. */
const autoModeLabel = computed(() => (
  commuteWindowUnset.value
    ? '未设置通勤时段'
    : autoMode.value === 'morning' ? '上班' : autoMode.value === 'evening' ? '下班' : '当前非通勤时段'
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

/** Reason the last pin write failed, shown above the grid. */
const pinError = shallowRef<string | null>(null)

/**
 * Favourite whose pin write is still in flight.
 *
 * The card moves on the tap (the store writes optimistically), so without this
 * a second tap reads the already-flipped state and sends the reverse request.
 */
const pinningFavoriteId = shallowRef<string | null>(null)

/**
 * Pin or un-pin one followed line — the overview's own action, the only place
 * this state exists: the entry point, the marker and the cancel all live on the
 * home cards.
 *
 * A failed write has already been rolled back by the store, so the reason is
 * surfaced here rather than leaving the card silently where it was.
 */
async function onTogglePin(card: MiniCardConfig): Promise<void> {
  const favoriteId = card.favoriteId
  if (!favoriteId || pinningFavoriteId.value === favoriteId) return
  pinError.value = null
  pinningFavoriteId.value = favoriteId
  try {
    await transitStore.togglePin(favoriteId)
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '置顶设置失败'
  }
  finally {
    pinningFavoriteId.value = null
  }
}

/** Cached line details keyed by lineId_direction (for stop counts + target order). */
const detailCache = shallowRef<Record<string, LineDetail>>({})

/**
 * Which of the three states the followed-lines read is in.
 *
 * The cards below are built from `favorites`, and a read that FAILED leaves that array
 * empty — so the length alone cannot tell the empty state's cause from a list nobody read.
 * The store reports the answer (`fetchFavorites()`), and this page states it: 「还没有关注
 * 线路」 is only true once the read actually answered.
 */
const favouritesRead = shallowRef<ReadState>('reading')

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
 * Whether the app has a position, in the state the location store reports.
 *
 * Derived from the store's OWN reads — the fix, the request in flight, and the
 * request that failed — rather than from a second guess in the template. A nearby
 * card's empty state has two causes (no fix at all, or a fix nothing resolves
 * from) and the cards receive this so they can word each as what it is.
 */
const nearbyLocation = computed<NearbyLocationState>(() => nearbyLocationStateOf({
  hasFix: locationStore.userCoords !== null,
  requesting: locationStore.isLocating,
  failed: locationStore.locationError !== null,
  supported: locationStore.isSupported,
}))

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
          lineId: resolveFavoriteLineId(f, direction) ?? detail.lineId,
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
        isPinned: f.isPinned,
        rows,
        legState: null,
        primaryDirection: nearbyPrimaryDirection(f, both, rows),
        detailLineId: rows[0]?.lineId ?? f.lineId,
        detailDirection: rows[0]?.direction ?? 0,
        favoriteId: f.id ?? null,
      })
      continue
    }

    const purpose = mode
    const direction = directionFor(f, purpose)
    // The stop the user stored for this leg, whether or not the chosen direction
    // calls there — the card's `stopName` is only the one it can report on.
    const boardStop = resolveBoardStop(f, purpose) ?? null
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
        isPinned: f.isPinned,
        rows: [],
        legState: commuteLegStateOf({ direction: null, stopName: boardStop, stops: undefined }),
        primaryDirection: null,
        detailLineId: f.lineId,
        detailDirection: (f.preferredDirection === 1 ? 1 : 0) as 0 | 1,
        favoriteId: f.id ?? null,
      })
      continue
    }

    const detail = both[direction]
    const stop = boardStop ? detail?.stops.find(s => s.name === boardStop) : undefined
    cards.push({
      lineName: f.lineName,
      directionName: detail?.directionName ?? '',
      stopName: stop?.name ?? null,
      stopDistanceMeters: null,
      detailLoaded: Boolean(detail),
      isSubway,
      isPinned: f.isPinned,
      rows: stop && detail
        ? [{
            lineId: resolveFavoriteLineId(f, direction) ?? detail.lineId,
            direction,
            stopOrder: stop.order,
            directionName: detail.directionName,
          }]
        : [],
      legState: commuteLegStateOf({ direction, stopName: boardStop, stops: detail?.stops }),
      // A commute card carries one row, so the lead is that row regardless.
      primaryDirection: null,
      // Direction is chosen here, but the stop may be unset: fall back to the
      // direction's own lineId so the card stays tappable either way.
      detailLineId: resolveFavoriteLineId(f, direction) ?? detail?.lineId ?? f.lineId,
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
type StationArrivalsFeed = ArrivalsFeed
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

/**
 * F11's entry on this screen: every line the cards are reading, in the order the
 * cards are shown, with the repeated one dropped — a line read twice is one
 * reading, and asking for it twice would spend two upstream reads in one press.
 *
 * The endpoint reads what it is asked for and nothing else, so the screen that
 * shows the cards is the one that names them; a line with no row on screen (no
 * board stop, no platform here) is not named, because nothing is reading it.
 */
const refreshTargets = computed<RefreshLiveTarget[]>(() => {
  const seen = new Set<string>()
  const targets: RefreshLiveTarget[] = []
  for (const card of cardsData.value) {
    for (const row of card.rows) {
      const key = arrivalsKey(row.lineId, row.direction)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({
        lineId: row.lineId,
        direction: row.direction,
        cityCode: cityStore.currentCode,
      })
    }
  }
  return targets
})

/**
 * The lines one press may actually name. The endpoint bounds the count, so the
 * screen's leading rows go and the rest wait for the next press — `covered`
 * against `wanted` is reported on the control, because a refresh of part of the
 * screen must not read as a refresh of all of it.
 */
const refreshNamed = computed(() => refreshTargets.value.slice(0, REFRESH_MAX_LINES))

/**
 * The state line under the button — its coarse state, which is what a live region
 * announces, and the seconds beside it, which are not announced at all. Null when
 * there is nothing to report.
 */
const refreshStatus = computed(() => refreshStatusTextOf({
  inFlight: refreshInFlight.value,
  outcome: refreshOutcome.value,
  waitSeconds: refreshWaitSecondsLeft.value,
  wanted: refreshTargets.value.length,
  covered: refreshNamed.value.length,
  // The targets are the arrival rows of the followed lines, so the list's own
  // tri-state is this screen's to state: an unreadable list leaves the same empty
  // array behind as an answered empty one, and the control must not claim a list
  // nobody read holds no line to re-read. While the read is still open the same
  // applies — this screen has not yet learned what it is showing.
  targetsRead: favouritesRead.value === 'read',
}))

/** The reading the last refresh obtained, as the freshness line reports it. */
const refreshFreshness = computed(() => refreshFreshnessOf(refreshReading.value))

/**
 * Tone of the state line. The words carry the state; the tone only backs them up,
 * so nothing here is the only signal of anything.
 */
const refreshStatusClass = computed(() => {
  if (refreshOutcome.value === 'throttled') return 'text-amber-400'
  if (refreshOutcome.value === 'unavailable' || refreshOutcome.value === 'offline') {
    return 'text-rose-400'
  }
  if (refreshOutcome.value === 'ok') return 'text-emerald-400'
  return 'text-slate-400'
})

/**
 * Ids the button points at, so the state is read out together with the control
 * instead of being a separate thing to find.
 */
const refreshDescribedBy = computed(() => refreshStatus.value
  ? 'refresh-freshness refresh-status'
  : 'refresh-freshness')

/**
 * True for the whole of a press: the request that spends the window, and the card
 * re-read that shows what it obtained. A press landing between the two would ask
 * the server a second time inside the window the first one just spent, and be
 * refused for it.
 */
const refreshing = shallowRef(false)

/**
 * Pressed: ask for a re-read through the shared request, then re-read the cards so
 * they show what that request obtained.
 *
 * Only a refresh that obtained a reading re-reads them: a refusal or a failure
 * carried nothing, and re-reading then would only re-ask for the values already
 * on screen.
 */
async function onRefresh(): Promise<void> {
  refreshing.value = true
  try {
    const outcome = await transitStore.refreshLive(refreshNamed.value)
    if (outcome === 'ok') await refreshAllArrivals()
  }
  finally {
    refreshing.value = false
  }
}

/**
 * Reload everything for the active city: favourites, then static detail, then arrivals.
 *
 * The first read's ANSWER is recorded as well as its result: everything below is derived
 * from the list it returns, so a failed read has to be stated rather than left to look like
 * a city with nothing followed.
 */
async function reloadForCurrentCity(): Promise<void> {
  favouritesRead.value = (await transitStore.fetchFavorites()) ? 'read' : 'unreadable'
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
              {{ commuteWindowUnset ? '未设置通勤时段' : commuteProfile?.mode === 'work' ? '早通勤' : commuteProfile?.mode === 'home' ? '晚通勤' : '非通勤' }}
            </span>
            <span class="font-mono text-xs text-slate-400">{{ currentTimeStr }}</span>
            <span class="text-xs text-slate-400">· {{ cityStore.currentCityName }}</span>
          </div>
          <h2 class="mt-1.5 text-xl font-bold tracking-tight text-white sm:mt-2 md:text-2xl">
            {{ commuteProfile?.description || `${cityStore.currentCityName}通勤实时态势监控` }}
          </h2>
          <!-- States what the card does and stops. The line this replaced named a
               data source, described how the number is computed, and borrowed a
               display-wall register the product does not have — while claiming a
               kind of data F4 forbids claiming for a subway line, whose trains are
               generated from the timetable. -->
          <p class="mt-1 hidden text-xs text-slate-400 md:block lg:text-base">
            点击卡片查看该线路的在途车辆与到站时刻
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

    <!-- F11: the home screen's one refresh entry. Both screens ask through the
         same request, so the window a press spends is shared rather than one per
         screen. The state line is this control's other job: a refusal with the
         wait left on the window, a failure, or the connection being gone is
         reported here, where the user is looking. -->
    <section
      aria-label="数据刷新"
      class="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:rounded-3xl sm:p-4"
    >
      <div class="min-w-0">
        <!-- The reading's own instant, and the kind of value it is. A reading
             that was never obtained reports no time at all. -->
        <p id="refresh-freshness" class="text-xs text-slate-400 lg:text-base">
          {{ refreshFreshness.text }}
        </p>
        <!-- The state line. Only the coarse state sits inside the live region: the
             seconds are rendered beside it, because a countdown in a live region
             queues one announcement per second of the wait. The region is rendered
             before it has anything to say — one created together with its first
             word is not announced at all by some screen readers. The two spans sit
             against each other, so the line reads as it did from one element. -->
        <p
          id="refresh-status"
          class="text-xs lg:text-base"
          :class="[refreshStatusClass, refreshStatus ? 'mt-0.5' : '']"
        >
          <span role="status" aria-live="polite">{{ refreshStatus?.announcement }}</span><span>{{ refreshStatus?.detail }}</span>
        </p>
      </div>
      <button
        class="flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-xs font-semibold text-cyan-400 transition active:scale-95 disabled:opacity-60 sm:w-auto sm:px-4 lg:min-h-11 lg:text-base"
        :disabled="refreshing || refreshNamed.length === 0"
        :aria-describedby="refreshDescribedBy"
        @click="onRefresh"
      >
        <RefreshCw
          class="h-3.5 w-3.5 shrink-0"
          :class="refreshing ? 'animate-spin' : ''"
          aria-hidden="true"
        />
        <span>刷新最新车况</span>
      </button>
    </section>

    <!-- A pin write that failed: the store already rolled the card back, so the
         reason is the only thing left to say. role="alert" announces it as a
         status message (SC 4.1.3) instead of leaving it to be noticed. -->
    <p
      v-if="pinError"
      role="alert"
      class="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400 lg:gap-2 lg:text-base"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ pinError }}</span>
    </p>

    <!-- Cards Grid: fluid responsive grid from 1 col on mobile to 4 cols on ultrawide.
         Gap follows the page rhythm (space-y) so card-to-card matches nav-to-hero. -->
    <CardGrid
      v-if="cardsData.length > 0"
      :cards="cardsData"
      :mode="currentMode"
      :arrivals="arrivalsMap"
      :nearby-location="nearbyLocation"
      @open="goToDetail"
      @switch-direction="onSwitchDirection"
      @toggle-pin="onTogglePin"
    />

    <!-- Empty state. WHICH empty it is comes from the read's own state: an unreadable list
         is stated as unreadable and offers a retry, and only an ANSWERED empty list is
         worded as 「还没有关注线路」. -->
    <EmptyState
      v-else
      :city-name="cityStore.currentCityName"
      :state="favouritesRead"
      @retry="reloadForCurrentCity"
    />
  </div>
</template>
