<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  shallowRef,
  watch,
  useTemplateRef,
} from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  RefreshCw,
  X,
} from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { useEventListener, useIntervalFn } from '@vueuse/core'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { useGis } from '@/composables/use-gis'
import {
  DesktopActionBar,
  LineHero,
  LineLoadState,
  MobileLineHeader,
  RouteBoard,
  StationPopover,
  type StationAnchor,
} from './components'
import type { DirectionOption } from './types'
import type { Station } from '@real-time-transport/shared'
import { effectiveCommuteDirection } from '@real-time-transport/shared/line-group'

const {
  id: propId,
  direction: propDirection,
  cityCode: propCityCode,
} = defineProps<{
  id: string
  direction: string
  cityCode: string
}>()

const router = useRouter()
const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()
const {
  walkDecision,
  fetchWalkDecision,
  clearDecision,
  isLoadingDecision,
} = useGis()

/** Root element of this view, used to size it to the available viewport. */
const pageRef = useTemplateRef('pageEl')

/**
 * Exact height for the fixed flex column so the page never scrolls: the room
 * between this view's top edge and the bottom of the viewport, minus the shell's
 * own bottom padding (App.vue gives <main> py-5 = 20px). Measured live because
 * the header height and padding are not constants we should hardcode.
 */
const pageHeight = shallowRef(600)

function getMainBottomPadding(): number {
  return typeof window !== 'undefined' && window.innerWidth < 768 ? 10 : 20
}

function updatePageHeight(): void {
  if (!pageRef.value) return
  // Use the DOCUMENT-relative top (rect.top + scrollY): rect.top alone shifts as
  // the page scrolls, which would feed back into the height calculation and
  // diverge (taller page -> more scroll -> smaller top -> taller page ...).
  const top = pageRef.value.getBoundingClientRect().top + window.scrollY
  const available = window.innerHeight - top - getMainBottomPadding()
  // Clamp so a very short viewport still leaves a usable board.
  pageHeight.value = Math.max(360, available)
}

const { currentLineDetail, currentLiveStatus } = storeToRefs(transitStore)
const { nearestStation } = storeToRefs(locationStore)
const { isLoading, loadError, isRefreshingLive } = storeToRefs(transitStore)

const selectedStation = shallowRef<Station | null>(null)
const stationAnchor = shallowRef<StationAnchor | null>(null)
const routeBoardRef = useTemplateRef<InstanceType<typeof RouteBoard>>('routeBoardRef')
const showLineInfo = shallowRef(false)
const stationArrivals = shallowRef<{
  isExact: boolean
  arrivals: Array<{
    time: string
    etaSeconds: number
    stopsAway?: number
    distanceMeters?: number
    isAtStation?: boolean
  }>
} | null>(null)

/**
 * Honest freshness label for the live data shown in the station panel: how long
 * ago the upstream snapshot we are rendering was produced. Never claims "实时"
 * without a timestamp behind it, and says so plainly when nothing has arrived.
 */
const liveFreshnessLabel = computed(() => {
  const updated = currentLiveStatus.value?.updatedAt
  if (!updated) return '暂无实时数据'
  const ageSec = Math.max(0, Math.round((Date.now() - updated) / 1000))
  if (ageSec < 60) return `实时数据 · ${ageSec} 秒前更新`
  const ageMin = Math.round(ageSec / 60)
  return `实时数据 · ${ageMin} 分钟前更新`
})

const lineId = computed(() => String(propId || ''))
const currentDirection = computed<0 | 1>(() => (Number(propDirection ?? 0) === 1 ? 1 : 0))
const currentCityCode = computed(() => String(propCityCode || cityStore.currentCode))
const gisLoading = computed(() => isLoadingDecision.value)

/**
 * Subway routes are tinted amber, buses cyan — the same rule KioskView and the
 * home-screen cards use, so the two badges here read as part of one system.
 * The `subway_` lineId prefix is a fallback for the moment before detail loads.
 */
const isSubway = computed(() =>
  currentLineDetail.value?.type === 'subway' || lineId.value.startsWith('subway_'),
)

/**
 * Accent classes for the two route-identity badges ONLY (line-name chip and the
 * "N 站" pill).
 *
 * Deliberately narrow: the canvas keeps its own palette because the nearest-station
 * marker is yellow (#facc15), which would collide with an amber track colour and
 * hide the most important locator on the map. Direction tabs, ETA panel and the
 * metric badges stay neutral/emerald since they are not route-type signals.
 *
 * Each entry mirrors the cyan original's opacity steps and glow radius so the
 * subway variant carries exactly the same visual weight.
 */
const badgeAccent = computed(() => (isSubway.value
  ? {
      lineName: 'border-amber-500/30 bg-amber-500/10 text-amber-400 shadow-[0_0_16px_rgba(245,158,11,0.3)]',
      stops: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    }
  : {
      lineName: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400 shadow-[0_0_16px_rgba(6,182,212,0.3)]',
      stops: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    }))

/**
 * The opposite direction's upstream lineId.
 * - bus (chelaile): a distinct lineId per direction, exposed by the provider
 * - subway: the SAME lineId serves both directions (only the param changes)
 * Null when the provider could not resolve an opposite way, in which case no
 * switch is offered — we never guess a lineId.
 */
const oppositeLineId = computed<string | null>(() => {
  const d = currentLineDetail.value
  if (!d) return null
  if (d.type === 'subway') return d.lineId
  return d.otherDirectionLineId || null
})

const canSwitchDirection = computed(() => oppositeLineId.value !== null)

/**
 * Build the two direction tabs with REAL terminal names, in a FIXED order
 * (direction 0 first, direction 1 second) so the tabs behave like a tab bar:
 * each label keeps its slot and only the highlight moves.
 *
 * Previously the active direction was placed first, which pinned the highlight
 * to the left-hand tab on every switch and made the control feel like it jumped.
 *
 * The opposite way reverses the stop sequence, so its terminal is this
 * direction's first stop. Loop lines (first stop === last stop, e.g. Beijing
 * Line 10) cannot be told apart by terminal, so they fall back to 上行/下行.
 */
const directionOptions = computed<DirectionOption[]>(() => {
  const d = currentLineDetail.value
  const opp = oppositeLineId.value
  if (!d || !opp) return []

  const stops = d.stops
  const first = stops[0]?.name || ''
  const last = stops[stops.length - 1]?.name || ''
  const isLoop = first !== '' && first === last

  // `detail.direction` is upstream truth (it does not echo the query param), so
  // it is the reliable anchor for which way the loaded data describes.
  const curDir = d.direction

  /** lineId serving each direction: bus swaps ids, subway reuses one. */
  const lineIdFor = (direction: number): string =>
    (direction === curDir ? d.lineId : opp)

  const labelFor = (direction: number): string => {
    if (isLoop) return direction === 0 ? '上行' : '下行'
    // The loaded direction has the authoritative upstream label. The opposite
    // one is derived from its terminal — this direction's FIRST stop — because
    // its own detail is never fetched (the label is all the tab needs, and a
    // request per tab would cost a fetch for one string).
    if (direction === curDir && d.directionName) return d.directionName
    const terminal = direction === curDir ? last : first
    return terminal ? `开往 ${terminal}` : (direction === 0 ? '上行' : '下行')
  }

  // Always emit direction 0 then direction 1 — a stable tab order.
  return [0, 1].map(direction => ({
    direction,
    lineId: lineIdFor(direction),
    label: labelFor(direction),
  }))
})

/**
 * Which tab is active. Prefers the loaded detail's real direction over the URL
 * query, since a bus lineId belongs to one direction regardless of the param.
 */
const activeDirection = computed<number>(() => {
  const d = currentLineDetail.value
  return d ? d.direction : currentDirection.value
})

function isActiveTab(opt: DirectionOption): boolean {
  return opt.direction === activeDirection.value
}

function switchDirection(opt: DirectionOption): void {
  if (isActiveTab(opt)) return
  // Clear the selected station: station orders differ between directions.
  selectedStation.value = null
  stationAnchor.value = null
  stationArrivals.value = null
  clearDecision()
  void router.push({
    path: `/line/${encodeURIComponent(opt.lineId)}`,
    query: { direction: String(opt.direction), cityCode: currentCityCode.value },
  })
}

function toggleDirectionQuick(): void {
  if (!canSwitchDirection.value) return
  const other = directionOptions.value.find(opt => !isActiveTab(opt))
  if (other) {
    switchDirection(other)
  }
}

async function fetchStationArrivals(): Promise<void> {
  const st = selectedStation.value
  if (!st || !lineId.value) {
    stationArrivals.value = null
    return
  }
  try {
    const qs = new URLSearchParams({
      // Use the direction actually on screen (upstream truth), so a bookmarked
      // or hand-typed URL whose direction param disagrees with the bus lineId
      // cannot query arrivals for the opposite way.
      direction: String(activeDirection.value),
      order: String(st.order),
      count: '6',
      cityCode: currentCityCode.value,
    })
    const url = `/api/transit/lines/${encodeURIComponent(lineId.value)}/stations/${encodeURIComponent(st.name)}/arrivals?${qs.toString()}`
    const res = await fetch(url)
    const json = await res.json()
    stationArrivals.value = json.success ? json.data : null
  }
  catch {
    stationArrivals.value = null
  }
}

function onSelectStation(st: Station, anchor?: StationAnchor): void {
  // Re-tapping the selected station closes the popover.
  if (selectedStation.value?.id === st.id) {
    selectedStation.value = null
    stationAnchor.value = null
    clearDecision()
    return
  }

  selectedStation.value = st
  if (anchor) {
    stationAnchor.value = anchor
  }
  else if (routeBoardRef.value) {
    stationAnchor.value = routeBoardRef.value.getStationAnchor(st.id)
  }
  clearDecision()
  void transitStore.refreshLive()
  void fetchStationArrivals()
}

function onStationAnchorChange(anchor: StationAnchor): void {
  stationAnchor.value = anchor
}

function onCloseStationPopover(): void {
  selectedStation.value = null
  stationAnchor.value = null
  clearDecision()
}

/**
 * The favourite covering this line+direction, when one exists. Pinning is only
 * meaningful for a followed route — the home cards read pins off favourites, so
 * an unfollowed line has nowhere to store one.
 */
const matchingFavorite = computed(() => {
  const line = lineId.value
  const dir = currentDirection.value
  return transitStore.favorites.find((f) => {
    if (f.cityCode !== currentCityCode.value) return false
    const primary = f.preferredDirection === 1 ? 1 : 0
    const resolved = dir === primary ? f.lineId : f.reverseLineId
    return resolved === line
  }) ?? null
})

/**
 * Commute purpose the direction on screen serves, per the user's own choice.
 *
 * Reads the stored directions rather than inferring from stop order: the user
 * states which way they commute, and the current direction either matches that
 * choice or it does not. Null when they have not chosen, so no badge is shown
 * instead of one derived from a guess.
 *
 * Also null when BOTH purposes resolve to the direction on screen — on a
 * single-direction route they always do, and they may also coincide on a
 * two-way one. The badge names the purpose, so with two candidates it would be
 * picking one arbitrarily and asserting something untrue about the other.
 */
const activePurpose = computed<'morning' | 'evening' | null>(() => {
  const fav = matchingFavorite.value
  if (!fav) return null
  const dir = currentDirection.value
  const morning = effectiveCommuteDirection(fav, 'morning') === dir
  const evening = effectiveCommuteDirection(fav, 'evening') === dir
  if (morning && evening) return null
  if (morning) return 'morning'
  if (evening) return 'evening'
  return null
})

/** Board-stop states of the station currently open in the popover. */
const stationPurpose = computed<'morning' | 'evening' | null>(() => {
  const fav = matchingFavorite.value
  if (!fav || !selectedStation.value) return null
  if (fav.morningStopName === selectedStation.value.name) return 'morning'
  if (fav.eveningStopName === selectedStation.value.name) return 'evening'
  return null
})

const stopSaving = shallowRef(false)
const stopError = shallowRef<string | null>(null)

/**
 * Bind or unbind the open station to a commute purpose.
 *
 * Setting a stop also records the direction currently on screen as that
 * purpose's direction: the user is looking at this direction's stops while
 * assigning one, so "where I board in the morning" and "which way I travel in
 * the morning" are answered by the same gesture. Without it the stop would carry
 * no direction, and its stop number would be meaningless. Clearing the stop
 * leaves the direction alone, so re-picking later only needs the stop.
 */
async function toggleBoardStop(purpose: 'morning' | 'evening'): Promise<void> {
  const fav = matchingFavorite.value
  const station = selectedStation.value
  if (!fav?.id || !station) return

  stopSaving.value = true
  stopError.value = null
  try {
    const clearing = stationPurpose.value === purpose
    await transitStore.updateCommuteSlot(fav.id, purpose, clearing
      ? { stopName: null }
      : { stopName: station.name, direction: currentDirection.value })
  }
  catch (err) {
    stopError.value = err instanceof Error ? err.message : '上车点保存失败'
  }
  finally {
    stopSaving.value = false
  }
}

async function computeWalkDecision(): Promise<void> {
  const coords = locationStore.userCoords
  if (!coords || !selectedStation.value) return
  await fetchWalkDecision({
    originLng: coords.lng,
    originLat: coords.lat,
    lineId: lineId.value,
    // Same reason as arrivals: match the direction actually displayed.
    direction: activeDirection.value,
    stationName: selectedStation.value.name,
    cityCode: currentCityCode.value,
  })
}

const selectedStationEta = computed(() => {
  if (!selectedStation.value) return '等待发车'
  const targetOrder = selectedStation.value.order

  // 1. Precise station arrivals returned by backend
  if (stationArrivals.value && stationArrivals.value.arrivals.length > 0) {
    const next = stationArrivals.value.arrivals[0]!
    if (next.isAtStation) {
      return '车辆正在本站 (即将发车)'
    }
    const mins = Math.max(1, Math.round(next.etaSeconds / 60))
    if (stationArrivals.value.isExact) {
      return `官方时刻 ${next.time} 到站 (约 ${mins} 分钟)`
    }
    const stopsText = next.stopsAway
      ? (next.stopsAway === 1 ? '即将进站 (1 站)' : `距本站 ${next.stopsAway} 站`)
      : ''
    const distText = next.distanceMeters && next.distanceMeters > 0
      ? ` · ${(next.distanceMeters / 1000).toFixed(1)}km`
      : ''
    return `预计 ${mins} 分钟到达 (${stopsText}${distText} · ${next.time})`
  }

  // 2. Explicitly confirmed no approaching buses from backend
  if (stationArrivals.value && stationArrivals.value.arrivals.length === 0) {
    const allBuses = currentLiveStatus.value?.buses || []
    if (allBuses.length === 0) {
      return '线路上暂无在途车辆 / 待发车'
    }
    // A bus is "past" when its next stop is already beyond the target
    const passedBuses = allBuses.filter((b) => {
      const next = b.nextOrder ?? (b.order !== undefined ? b.order + 1 : undefined)
      return next !== undefined && next > targetOrder
    })
    const servingNow = allBuses.some(b => b.nextOrder === targetOrder || b.order === targetOrder)
    if (servingNow) {
      return '车辆正在本站 (即将发车)'
    }
    if (passedBuses.length > 0) {
      return '本班车已过本站 · 前序暂无在途车'
    }
    return '前序暂无在途车辆'
  }

  // 3. Fallback when stationArrivals is pending: derive from currentLiveStatus
  if (!currentLiveStatus.value) return '等待发车'
  const allBuses = currentLiveStatus.value.buses
  if (allBuses.length === 0) return '线路上暂无在途车辆 / 待发车'

  const upcoming = allBuses
    .filter((b) => {
      const next = b.nextOrder ?? (b.order !== undefined ? b.order + 1 : undefined)
      return next !== undefined && next <= targetOrder
    })
    .sort((a, b) => ((a.nextOrder ?? a.order)!) - ((b.nextOrder ?? b.order)!))

  if (upcoming.length === 0) {
    const passed = allBuses.filter((b) => {
      const next = b.nextOrder ?? (b.order !== undefined ? b.order + 1 : undefined)
      return next !== undefined && next > targetOrder
    })
    const servingNow = allBuses.some(b => b.nextOrder === targetOrder || b.order === targetOrder)
    if (servingNow) {
      return '车辆正在本站 (即将发车)'
    }
    if (passed.length > 0) {
      return '本班车已过本站 · 前序暂无在途车'
    }
    return '前序暂无在途车辆'
  }

  const bus = upcoming[0]!
  const stops = Math.max(1, targetOrder - (bus.nextOrder ?? (bus.order as number)))
  const stopsText = stops === 1 ? '即将进站 (1 站)' : `距本站 ${stops} 站`

  if (isSubway.value) {
    const progress = typeof bus.progress === 'number' ? bus.progress : 0
    const mins = Math.max(1, Math.round(((stops - progress) * 135) / 60))
    return `预计 ${mins} 分钟到达 (${stopsText})`
  }

  const sd = currentLineDetail.value?.stationDistances
  if (sd && typeof bus.distanceFromStart === 'number' && sd[targetOrder - 1]) {
    const targetDist = sd[targetOrder - 1]!
    const remainingMeters = targetDist - bus.distanceFromStart
    if (remainingMeters > 0) {
      const speed = (bus.speed && bus.speed >= 3 && bus.speed <= 18) ? bus.speed : 6.0
      const etaSec = Math.round(remainingMeters / speed + (stops - 1) * 30)
      const mins = Math.max(1, Math.round(etaSec / 60))
      const km = (remainingMeters / 1000).toFixed(1)
      return `预计 ${mins} 分钟到达 (${stopsText} · ${km}km)`
    }
  }

  return `正在获取到站时间… (${stopsText})`
})

watch(
  () => [lineId.value, currentDirection.value],
  () => {
    if (lineId.value) {
      void transitStore.loadLine(lineId.value, currentDirection.value, currentCityCode.value)
      void fetchStationArrivals()
    }
  },
)

watch(
  () => currentLineDetail.value?.stops,
  (stops) => {
    if (stops && stops.length > 0) {
      // The nearest-stop pool feeds the board's own marker (yellow ring + ripple);
      // it is deliberately NOT promoted to `selectedStation`, which would open
      // the popover on arrival. Which station deserves a popover is a decision
      // for the user, not a side effect of loading the line.
      locationStore.updateNearestStation(stops)
    }
  },
  { immediate: true },
)

// Keep the exact-timetable countdown fresh (departures pass by every minute)
useIntervalFn(() => {
  if (selectedStation.value) void fetchStationArrivals()
}, 30000)

useEventListener(window, 'resize', updatePageHeight)

onMounted(() => {
  transitStore.initWs()
  // Favourites drive the pin control: without them we cannot tell whether this
  // line is followed, and a pin would have nowhere to be stored.
  void transitStore.fetchFavorites()
  // Start tracking so the board can mark the stop nearest to the user. Denied
  // permission is a no-op here (see requestLocation), so this never prompts twice.
  locationStore.requestLocation()
  if (lineId.value) {
    void transitStore.loadLine(lineId.value, currentDirection.value, currentCityCode.value)
  }
  // Measure after layout so the header height is real, not zero.
  void nextTick(updatePageHeight)
})

onUnmounted(() => {
  // Drop this view's data so re-entering from home shows a loading state instead
  // of the previous line. Direction switches reuse this instance (same route
  // record) and therefore never reach here — their stability is preserved.
  transitStore.resetLineData()
})
</script>

<template>
  <!-- Fixed-height flex column: the board area flexes to fill whatever room the
       header/hero/ETA panel leave, so the page itself never needs a scrollbar.
       Height is measured in JS (see pageHeight) because the shell header height
       is not a known constant. -->
  <div
    ref="pageEl"
    class="flex min-h-0 flex-col gap-2.5 overflow-hidden md:gap-4"
    :style="{ height: `${pageHeight}px` }"
  >
    <!-- Mobile Compact Single-Line Header: ~44px height, leaves 80%+ of screen for canvas (screens < md) -->
    <MobileLineHeader
      v-if="currentLineDetail"
      :detail="currentLineDetail"
      :live-status="currentLiveStatus"
      :can-switch-direction="canSwitchDirection"
      :accent="badgeAccent"
      @switch-direction="toggleDirectionQuick"
      @show-info="showLineInfo = true"
    />

    <!-- Desktop Top Action Bar (screens >= md) -->
    <DesktopActionBar
      :can-switch-direction="canSwitchDirection"
      :direction-options="directionOptions"
      :is-active-tab="isActiveTab"
      :active-purpose="activePurpose"
      @switch-direction="switchDirection"
    />

    <!-- Desktop Line Hero Banner (screens >= md) -->
    <LineHero
      v-if="currentLineDetail"
      :detail="currentLineDetail"
      :live-status="currentLiveStatus"
      :accent="badgeAccent"
    />

    <!-- Loading / Error honest states -->
    <LineLoadState v-if="!currentLineDetail" :is-loading="isLoading" :load-error="loadError" />

    <!-- 2D Konva Route Board Viewport (Full width, zero obstruction, adaptive anchor popover) -->
    <div
      v-if="currentLineDetail"
      class="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <RouteBoard
        ref="routeBoardRef"
        :line-detail="currentLineDetail"
        :buses="currentLiveStatus?.buses || []"
        :nearest-station="nearestStation"
        :selected-station="selectedStation"
        :morning-stop-name="matchingFavorite?.morningStopName ?? null"
        :evening-stop-name="matchingFavorite?.eveningStopName ?? null"
        @select-station="onSelectStation"
        @close-station="onCloseStationPopover"
        @station-anchor-change="onStationAnchorChange"
      />

      <!-- Near-Station Anchor Popover (Powered by Reka UI with auto-flip, shift & zero clipping arrow) -->
      <StationPopover
        :station="selectedStation"
        :anchor="stationAnchor"
        :arrivals="stationArrivals"
        :walk-decision="walkDecision"
        :has-user-coords="Boolean(locationStore.userCoords)"
        :gis-loading="gisLoading"
        :eta="selectedStationEta"
        :freshness="liveFreshnessLabel"
        :is-refreshing="isRefreshingLive"
        :can-pin="Boolean(matchingFavorite)"
        :station-purpose="stationPurpose"
        :stop-saving="stopSaving"
        :stop-error="stopError"
        @close="onCloseStationPopover"
        @compute-walk="computeWalkDecision"
        @toggle-stop="toggleBoardStop"
      />
    </div>
  </div>

  <!-- Mobile Line Info Drawer: bottom sheet triggered by clicking the line badge or info chip (powered by Reka UI Dialog) -->
  <DialogRoot v-model:open="showLineInfo">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-200 data-[state=open]:opacity-100 data-[state=closed]:opacity-0 md:hidden" />
      <DialogContent
        v-if="currentLineDetail"
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col space-y-4 overflow-y-auto rounded-t-3xl border-t border-slate-700 bg-slate-900 p-5 shadow-2xl focus:outline-none transition-transform duration-250 ease-out data-[state=open]:translate-y-0 data-[state=closed]:translate-y-full md:hidden"
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div class="flex items-center gap-2">
            <span
              class="flex h-8 items-center rounded-lg border px-2.5 font-mono text-sm font-bold"
              :class="badgeAccent.lineName"
            >
              {{ currentLineDetail.lineName }}
            </span>
            <DialogTitle class="text-sm font-bold text-white">
              {{ currentLineDetail.directionName }}
            </DialogTitle>
          </div>
          <DialogClose as-child>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 active:scale-95"
              aria-label="关闭线路信息"
            >
              <X class="h-4 w-4" />
            </button>
          </DialogClose>
        </div>
        <DialogDescription class="sr-only">
          线路概况与行驶方向配置
        </DialogDescription>

        <!-- Specs Grid -->
        <div class="grid grid-cols-2 gap-2.5 text-xs">
          <div class="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
            <span class="block text-xs text-slate-400">首末班运营时间</span>
            <span class="font-mono text-sm font-semibold text-white">
              {{ currentLineDetail.firstBusTime || '--:--' }} - {{ currentLineDetail.lastBusTime || '--:--' }}
            </span>
          </div>
          <div class="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
            <span class="block text-xs text-slate-400">全程站数 / 里程</span>
            <span class="font-mono text-sm font-semibold text-white">
              {{ currentLineDetail.stops.length }} 站
              <span v-if="currentLineDetail.routeLengthMeters" class="text-xs font-normal text-slate-400">
                ({{ (currentLineDetail.routeLengthMeters / 1000).toFixed(1) }}km)
              </span>
            </span>
          </div>
          <div class="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
            <span class="block text-xs text-slate-400">当前在途车辆</span>
            <span class="font-mono text-base font-bold text-emerald-400">
              {{ currentLiveStatus?.buses.length || 0 }} 辆
            </span>
          </div>
          <div class="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
            <span class="block text-xs text-slate-400">营运与数据源</span>
            <span class="font-mono text-xs font-semibold text-cyan-400">
              {{ currentLineDetail.type === 'subway' ? '官方排班推演' : '实时上游数据' }}
            </span>
          </div>
        </div>

        <!-- Direction Switcher in Drawer -->
        <div v-if="canSwitchDirection" class="space-y-1.5">
          <span class="text-xs font-semibold text-slate-400">行驶方向选择</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="opt in directionOptions"
              :key="opt.direction"
              class="rounded-xl border p-3 text-left transition"
              :class="isActiveTab(opt)
                ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
                : 'border-slate-800 bg-slate-950 text-slate-400'"
              @click="switchDirection(opt); showLineInfo = false"
            >
              <span class="block font-mono text-xs text-slate-400">方向 {{ opt.direction === 0 ? '去程' : '返程' }}</span>
              <span class="block truncate font-bold text-slate-200 text-xs lg:text-base">{{ opt.label }}</span>
            </button>
          </div>
        </div>

        <!-- Legend Reference -->
        <div class="rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs">
          <span class="block text-xs font-semibold text-slate-400 mb-2">地图图例</span>
          <div class="flex flex-wrap gap-4 text-xs text-slate-300">
            <span class="flex items-center gap-1.5">
              <span class="h-2.5 w-2.5 rounded-full bg-cyan-400 inline-block"></span>
              拓扑线路
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-2.5 w-2.5 rounded-full bg-amber-400 inline-block"></span>
              当前定位最近站
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-2.5 w-2.5 rounded-full border-2 border-cyan-400 inline-block"></span>
              选中站点
            </span>
          </div>
        </div>

        <!-- Quick Action -->
        <div class="pt-1">
          <button
            class="flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 py-3 text-xs font-semibold text-cyan-400 active:scale-95 lg:gap-2.5 lg:py-3.5 lg:text-base"
            :disabled="isRefreshingLive"
            @click="transitStore.refreshLive()"
          >
            <RefreshCw class="h-3.5 w-3.5 shrink-0" :class="isRefreshingLive ? 'animate-spin' : ''" />
            <span>{{ isRefreshingLive ? '正在拉取实时数据…' : '刷新最新实时车况' }}</span>
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
