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
import { favoriteDirections, operatingDaySecondsOf, operatingStatusOf } from '@real-time-transport/shared'
import { operatingTextOf } from '@/operating-copy'
import { refreshFreshnessOf, useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { useGis } from '@/composables/use-gis'
import { departureRowOf } from './departure-row'
import { statedDistanceSuffix } from './landmark-distance'
import { DepartureBoard, PlatformHeader } from './components'
import type { DepartureItem, PlatformLineRule } from './types'
import type { ReadState } from '@/read-state'

const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()
const { fetchNearbyStations } = useGis()

const { favorites } = storeToRefs(transitStore)

const currentStationName = shallowRef('')
const stationOptions = shallowRef<string[]>([])
const landmarkHint = shallowRef('多线聚合')
/**
 * The board's loading body: shown only while there is nothing on screen to keep.
 *
 * Renamed from `loading` because the name was the defect's hiding place: every
 * refresh set it, and the board rendered the WHOLE body from it, so a refresh
 * unmounted the rows. It now moves only when the board is empty (first load, a
 * station change, a followed-lines reload that left nothing to show).
 */
const boardLoading = shallowRef(false)
const detecting = shallowRef(false)
/**
 * The board's refresh control is mid-read. Unlike the loading body this signals
 * an update running OVER rows that stay on screen: it is the non-destructive
 * half of the same fact, so the busy wording is the refresh family's own
 * (「正在刷新…」) and the control is disabled while it holds.
 */
const boardBusy = shallowRef(false)
/** A locate was requested and is waiting for the first GPS fix to arrive. */
const awaitingFix = shallowRef(false)
const departureItems = shallowRef<DepartureItem[]>([])

/**
 * The station the rows on screen were built for. A row claims to be about a
 * platform, so the station is part of what the rows assert — this is the other
 * half of that claim, kept beside the rows so a change can be judged the moment
 * a load starts rather than whenever the reactive flush gets to it.
 */
const rowsStation = shallowRef('')

/**
 * The board's own load: which read the rows on screen were produced by.
 *
 * Honesty needs an instant on screen, and the view's rows are already the read they
 * describe — so the instant recorded here is the response's OWN `updatedAt`. The
 * upstream stamps each reading the moment it obtained it; the server replays the
 * cached object unchanged until the 18 s TTL forces a fresh read (measured on the
 * dev API: two hits inside one TTL carry the same instant), so a late serve never
 * restamps it, and a clock stamped at request time is exactly what this field must
 * never become: a request nobody answered would then read as a reading.
 *
 * Clearing is as deliberate as setting. The rows leave on a station change (they
 * were built for another platform and must never survive under a new one — the
 * station is part of what a row claims to be about), and the instant goes with
 * them: a stamp without its rows is the fresher-looking lie.
 */
const rowsReadAt = shallowRef<number | null>(null)

/**
 * Which of the three states the followed-lines read is in.
 *
 * Every station option on this page is built from the followed lines, so a read that FAILED
 * leaves the board with nothing — and an empty board and an unreadable list would otherwise
 * say the same sentence about the user's stored rows. The store reports the answer; this page
 * states it and lets the board word its own empty state.
 */
const favouritesRead = shallowRef<ReadState>('reading')

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

      // F3: the operating fact comes from the detail this rule was just built
      // from, so the row states it from the line's own first/last departure
      // rather than from a clock. Rules are rebuilt on every poll, so the state
      // follows the service day across midnight without a second request.
      const operating = operatingStatusOf({
        firstDeparture: detail.firstBusTime,
        lastDeparture: detail.lastBusTime,
        nowSecOfDay: operatingDaySecondsOf(),
      })

      rules.push({
        lineId,
        lineName: f.lineName,
        direction: dir,
        terminal: detail.directionName,
        stationOrder: stop.order,
        operatingText: operatingTextOf(operating),
      })
    }
  }
  return rules
}

/**
 * One full read of the board, whatever asked for it (12 s poll, station picker,
 * GPS snap, retry).
 *
 * The destructive refresh this page shipped is fixed by WHEN each state moves, not
 * by painting anything new: the rows on screen stay rendered through a refresh and
 * only the refresh control shows the update is running, the loading body appears
 * only when there is nothing to keep, and the rows' instant is written only by the
 * response that produced the rows now on screen.
 */
async function loadPlatformDepartures(): Promise<void> {
  if (!currentStationName.value) {
    departureItems.value = []
    rowsReadAt.value = null
    rowsStation.value = ''
    boardLoading.value = false
    return
  }
  const rules = buildRulesForStation(currentStationName.value)
  if (rules.length === 0) {
    departureItems.value = []
    rowsReadAt.value = null
    rowsStation.value = ''
    boardLoading.value = false
    return
  }

  // An empty board has nothing to keep: show the loading body. A board WITH rows
  // keeps them (the retention contract) and signals the update on the control —
  // but only rows built for THIS station. The picker's change handler and the
  // v-model write are not one synchronous step, so rows can still be the old
  // station's here; they are not this station's answer to keep.
  if (rowsStation.value !== currentStationName.value) {
    departureItems.value = []
    rowsReadAt.value = null
  }
  if (departureItems.value.length === 0) {
    boardLoading.value = true
  }
  else {
    boardBusy.value = true
  }
  rowsStation.value = currentStationName.value

  const results: DepartureItem[] = []
  /**
   * The instant each RESPONSE reports as the reading's own (upstream `updatedAt`,
   * replayed unchanged by the server while the live cache entry is alive). Keyed
   * by the row id the answer produced, so a failed request contributes nothing
   * and the winner below is answered rows only.
   */
  const stamps = new Map<string, number>()

  const promises = rules.map(async (rule, idx) => {
    const id = `dep_${rule.lineId}_${rule.direction}_${idx}`
    try {
      // The stop this row is about has to travel with the request: upstream prices a
      // vehicle to the requested stop order and to the line's terminus otherwise, so a
      // reading asked for without one carries every vehicle's minute for the END of the
      // line — which is why this column could state no minute at all (see
      // `departure-row.ts`). `order` is the platform's own ordinal on THIS direction.
      const qs = new URLSearchParams({
        direction: String(rule.direction),
        cityCode: cityStore.currentCode,
        order: String(rule.stationOrder),
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(rule.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      const buses: LiveBus[] = (json.success && json.data?.buses) ? json.data.buses : []
      /**
       * F4: the source this response declared. The row builder decides the kind of
       * number from it — this view never guesses one from the route type, and a source
       * this build does not know leaves its rows unclassified.
       */
      const dataSource = (json.success && json.data) ? json.data.dataSource : null
      // The reading's own instant, exactly as the response stated it — the
      // record of WHEN these rows were read, or nothing if the body carried
      // no instant to state.
      const updatedAt = (json.success && json.data) ? json.data.updatedAt : null
      if (typeof updatedAt === 'number') stamps.set(id, updatedAt)

      results.push(departureRowOf({ id, rule, answer: { dataSource, buses } }))
    }
    catch {
      // The request failed: neither a vehicle nor the service day is known.
      results.push(departureRowOf({ id, rule, answer: null }))
    }
  })

  await Promise.allSettled(promises)

  results.sort((a, b) => {
    if (a.etaMinutes === null && b.etaMinutes === null) return 0
    if (a.etaMinutes === null) return 1
    if (b.etaMinutes === null) return -1
    return a.etaMinutes - b.etaMinutes
  })

  // The instant the rows on screen were read at comes from the responses
  // themselves, and only when at least one answer arrived: all-failed results
  // keep the previous read's instant, because the rows it produced are still
  // the rows on screen (the failed rows state their own failure per row).
  const answeredAt = results
    .filter(row => !row.unavailable)
    .map(row => stamps.get(row.id))
    .filter((at): at is number => typeof at === 'number')
    .sort((a, b) => b - a)[0]
  if (answeredAt !== undefined) rowsReadAt.value = answeredAt

  departureItems.value = results
  boardLoading.value = false
  boardBusy.value = false
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
    // The distance is rendered only where the radar stated one: it is absent for a
    // POI Amap did not measure, and a substituted 0 would read as 「you are on the
    // platform」.
    const distance = statedDistanceSuffix(nearestPoi.distanceMeters)
    if (matched) {
      currentStationName.value = matched
      landmarkHint.value = `GPS 已对准 ${matched}${distance}`
      await loadPlatformDepartures()
    }
    else {
      landmarkHint.value = `最近站台 ${nearestPoi.name}${distance}，不在关注线路中`
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

/**
 * Reload everything for the active city: favourites first, then the board.
 *
 * The first read's ANSWER is recorded as well as its result: every station option below is
 * derived from the list it returns, so a failed read has to be stated rather than left to look
 * like a city with nothing followed.
 */
async function reloadForCurrentCity(): Promise<void> {
  favouritesRead.value = (await transitStore.fetchFavorites()) ? 'read' : 'unreadable'
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

/**
 * The station picker moved: the rows on screen were built for the PREVIOUS
 * platform, and under the new station's title they are a false claim about
 * data the board does not hold — a station change is not a refresh, so
 * nothing is kept across it. The rows and their read instant go together
 * (a stamp without its rows is the fresher-looking lie), and the board
 * drops back into its loading state until the new station's read lands.
 *
 * `rowsStation` is deliberately NOT reset here: it is the load's own
 * keep/clear bookkeeping, and a reset landing after a load has begun would
 * make the NEXT load misjudge whose rows are on screen. The load's guard at
 * its start is the authority that decides keep-versus-clear.
 */
watch(currentStationName, () => {
  departureItems.value = []
  rowsReadAt.value = null
})

/**
 * The freshness line's instant, in the one shape the refresh family words it:
 * the read behind the rows on screen, never the clock that sent the request.
 * Null renders the store's own 「尚未获取到数据」 — a board nobody has read
 * states no time rather than a borrowed one.
 */
const rowsFreshness = computed(() =>
  refreshFreshnessOf(rowsReadAt.value === null
    ? null
    : { at: rowsReadAt.value, dataSource: null, isDegraded: null }))
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
    <DepartureBoard
      :items="departureItems"
      :loading="boardLoading"
      :refreshing="boardBusy"
      :freshness="rowsFreshness"
      :favorites-read="favouritesRead"
      @refresh="loadPlatformDepartures"
      @retry="reloadForCurrentCity"
    />
  </div>
</template>
