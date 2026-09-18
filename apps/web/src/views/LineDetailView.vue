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
  ArrowLeft,
  ArrowLeftRight,
  Footprints,
  Info,
  RefreshCw,
  X,
} from '@lucide/vue'
import { useEventListener, useIntervalFn } from '@vueuse/core'
import { useTransitStore } from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { useGis } from '@/composables/use-gis'
import RouteBoard from '@/components/RouteBoard.vue'
import type { Station } from '@real-time-transport/shared'

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
  return typeof window !== 'undefined' && window.innerWidth < 640 ? 10 : 20
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
const showLineInfo = shallowRef(false)
const stationArrivals = shallowRef<{ isExact: boolean, arrivals: Array<{ time: string, etaSeconds: number }> } | null>(null)

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
const currentDirection = computed(() => Number(propDirection ?? 0))
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

interface DirectionOption {
  direction: number
  lineId: string
  label: string
}

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
    // Terminal of each direction, derived from real station data.
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

function onSelectStation(st: Station): void {
  // Re-tapping the selected station closes the floating panel.
  if (selectedStation.value?.id === st.id) {
    selectedStation.value = null
    clearDecision()
    return
  }

  selectedStation.value = st
  clearDecision()
  // Fetch fresh data in parallel: the user tapped for CURRENT information, so
  // re-request the live snapshot (chelaile is a cached upstream, its data can
  // be a poll cycle old) and this station's arrivals. Failures keep whatever
  // is already on screen — never blank the panel on a flaky refresh.
  void transitStore.refreshLive()
  void fetchStationArrivals()
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
  // Exact official timetable wins over simulated estimate
  if (stationArrivals.value?.isExact && stationArrivals.value.arrivals.length > 0) {
    const next = stationArrivals.value.arrivals[0]!
    const mins = Math.max(1, Math.round(next.etaSeconds / 60))
    return `官方时刻 ${next.time} 到站（约 ${mins} 分钟）`
  }
  if (!selectedStation.value || !currentLiveStatus.value) return '等待发车'
  const buses = currentLiveStatus.value.buses
  const upcoming = buses
    .filter(b => typeof b.order === 'number' && (b.order as number) <= selectedStation.value!.order)
    .sort((a, b) => (b.order as number) - (a.order as number))

  if (upcoming.length === 0) return '前序暂无在途车'
  const bus = upcoming[0]!
  if (!bus.travelTimeSec) {
    // Upstream gave no travel time: refuse to guess minutes per stop
    return '在途中，到站耗时未知（上游未提供）'
  }
  const mins = Math.max(1, Math.round(bus.travelTimeSec / 60))
  const stops = selectedStation.value.order - (bus.order as number)
  return `预计 ${mins} 分钟到达 (距本站 ${stops} 站)`
})

const decisionStyle = computed(() => {
  switch (walkDecision.value?.decision) {
    case 'comfortable':
      return { border: 'border-emerald-500/30 bg-emerald-500/10', text: 'text-emerald-300', icon: 'text-emerald-400', emoji: '🟢' }
    case 'hurry':
      return { border: 'border-amber-500/30 bg-amber-500/10', text: 'text-amber-300', icon: 'text-amber-400', emoji: '🏃' }
    case 'missed':
      return { border: 'border-rose-500/30 bg-rose-500/10', text: 'text-rose-300', icon: 'text-rose-400', emoji: '🔴' }
    default:
      return { border: 'border-slate-700 bg-slate-800/50', text: 'text-slate-300', icon: 'text-slate-400', emoji: 'ℹ️' }
  }
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
      locationStore.updateNearestStation(stops)
      // Auto-select only the real GPS-nearest station; without a fix no default is chosen
      selectedStation.value = nearestStation.value
      void fetchStationArrivals()
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
    class="flex min-h-0 flex-col gap-2.5 overflow-hidden sm:gap-4"
    :style="{ height: `${pageHeight}px` }"
  >
    <!-- Mobile Compact Single-Line Header: ~44px height, leaves 80%+ of screen for canvas -->
    <div
      v-if="currentLineDetail"
      class="flex sm:hidden shrink-0 items-center justify-between gap-1.5 rounded-xl border border-slate-800 bg-slate-900/90 px-2 py-1.5 shadow-md"
    >
      <div class="flex min-w-0 items-center gap-1.5">
        <RouterLink
          to="/"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 active:scale-95"
          aria-label="返回总览"
        >
          <ArrowLeft class="h-3.5 w-3.5" />
        </RouterLink>

        <!-- Clickable Line Badge: triggers full line details sheet -->
        <button
          class="flex h-8 shrink-0 items-center justify-center rounded-lg border px-2 font-mono text-xs font-bold whitespace-nowrap active:scale-95"
          :class="badgeAccent.lineName"
          title="点击查看线路详情"
          @click="showLineInfo = true"
        >
          {{ currentLineDetail.lineName }}
        </button>

        <!-- Direction with quick toggle -->
        <div class="flex min-w-0 items-center gap-1">
          <span class="max-w-[110px] truncate text-xs font-bold text-white">
            {{ currentLineDetail.directionName }}
          </span>
          <button
            v-if="canSwitchDirection"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-cyan-400 active:scale-95"
            title="切换反向"
            aria-label="切换反向"
            @click="toggleDirectionQuick"
          >
            <ArrowLeftRight class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <!-- Right: Live bus count chip + info trigger -->
      <button
        class="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2 text-xs font-mono active:scale-95"
        title="在途车辆与线路详情"
        @click="showLineInfo = true"
      >
        <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
        <span class="font-bold text-emerald-400">{{ currentLiveStatus?.buses.length || 0 }}</span>
        <span class="text-xs text-slate-400">车</span>
        <Info class="h-3.5 w-3.5 text-slate-400" />
      </button>
    </div>

    <!-- Desktop Top Action Bar -->
    <div class="hidden sm:flex shrink-0 items-center justify-between">
      <RouterLink
        to="/"
        class="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
        <span>返回总览</span>
      </RouterLink>

      <div class="flex items-center gap-2">
        <!-- Up/down direction switch, rendered as a real TAB BAR: a fixed
             left/right slot per direction so only the highlight moves between
             switches (never the labels). Swaps BOTH lineId and direction,
             because bus routes use a distinct upstream lineId per direction
             while subway reuses one. Only offered when the opposite way really
             resolves — never a "reverse driving" toggle on the same data. -->
        <div
          v-if="canSwitchDirection"
          role="tablist"
          aria-label="选择行驶方向"
          class="flex items-center rounded-xl border border-slate-700 bg-slate-800/80 p-0.5"
        >
          <button
            v-for="opt in directionOptions"
            :key="opt.direction"
            role="tab"
            :aria-selected="isActiveTab(opt)"
            class="rounded-lg px-3 py-1.5 text-xs font-medium transition"
            :class="isActiveTab(opt)
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 border border-transparent hover:text-slate-200'"
            @click="switchDirection(opt)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- Desktop Line Hero Banner -->
    <div
      v-if="currentLineDetail"
      class="hidden sm:block shrink-0 overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-5 shadow-xl"
    >
      <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="flex items-center gap-2.5 sm:gap-3.5">
          <div
            class="flex h-11 shrink-0 items-center justify-center rounded-xl border px-3 font-mono font-black whitespace-nowrap sm:h-14 sm:rounded-2xl sm:px-3.5"
            :class="[
              badgeAccent.lineName,
              currentLineDetail.lineName.length > 4 ? 'text-base min-w-[74px] sm:text-lg sm:min-w-[88px]' : currentLineDetail.lineName.length > 3 ? 'text-lg min-w-[62px] sm:text-xl sm:min-w-[76px]' : 'text-xl min-w-[54px] sm:text-2xl sm:min-w-[64px]',
            ]"
          >
            {{ currentLineDetail.lineName }}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="min-w-0 truncate text-base font-bold text-white sm:text-2xl">
                {{ currentLineDetail.directionName }}
              </h2>
              <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold border" :class="badgeAccent.stops">
                {{ currentLineDetail.stops.length }} 站
              </span>
            </div>
            <p class="mt-0.5 text-xs text-slate-400 font-mono">
              首末班：{{ currentLineDetail.firstBusTime || '--:--' }} - {{ currentLineDetail.lastBusTime || '--:--' }}
              <span class="ml-2 text-slate-400">· {{ currentLineDetail.type === 'subway' ? '官方排班推演' : '实时上游数据' }}</span>
            </p>
          </div>
        </div>

        <!-- Metric Badges -->
        <div class="flex shrink-0 items-center gap-2 text-xs">
          <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
            <span class="text-slate-400 block text-center text-xs leading-tight">当前在途</span>
            <span class="font-mono text-sm font-bold text-emerald-400 sm:text-base">
              {{ currentLiveStatus?.buses.length || 0 }}
            </span>
            <span class="text-slate-400 text-xs leading-none"> 辆</span>
          </div>

          <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
            <span class="text-slate-400 block text-center text-xs leading-tight">营运状态</span>
            <span
              class="font-mono text-xs font-semibold"
              :class="(currentLiveStatus?.buses.length || 0) > 0 ? 'text-emerald-400' : 'text-slate-400'"
            >
              {{ (currentLiveStatus?.buses.length || 0) > 0 ? '营运中' : '待发车/停运' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Loading / Error honest states -->
    <div
      v-if="!currentLineDetail"
      class="shrink-0 rounded-3xl border border-slate-800 bg-slate-900/60 p-12 text-center"
    >
      <template v-if="isLoading">
        <p class="text-sm text-slate-400">正在加载线路数据...</p>
      </template>
      <template v-else>
        <p class="text-sm font-semibold text-rose-400">{{ loadError || '线路不存在或数据源暂不可用' }}</p>
        <p class="mt-1.5 text-xs text-slate-400">上游实时接口未能返回该线路数据，请稍后重试或检查线路号</p>
      </template>
    </div>

    <!-- 2D Konva Route Board (supporting responsive folded and linear layouts).
         `relative` so the station panel can float over the board instead of stealing
         height from it — seeing the route is the whole point of this page, especially on a phone. -->
    <div v-if="currentLineDetail" class="relative flex min-h-0 flex-1 flex-col">
      <RouteBoard
        :line-detail="currentLineDetail"
        :buses="currentLiveStatus?.buses || []"
        :nearest-station="nearestStation"
        :selected-station="selectedStation"
        @select-station="onSelectStation"
      />

      <!-- Floating station panel (bottom sheet on mobile, card on desktop) -->
      <div
        v-if="selectedStation"
        class="absolute inset-x-2 bottom-2 z-20 max-h-[72%] space-y-2.5 overflow-y-auto rounded-2xl border border-cyan-500/30 bg-slate-900/95 p-3.5 shadow-2xl backdrop-blur-md sm:inset-x-4 sm:bottom-4 sm:max-h-[60%] sm:p-4"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="inline-block h-3 w-3 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]"></span>
            <h4 class="truncate font-semibold text-slate-100">
              {{ selectedStation.name }}
            </h4>
            <span class="shrink-0 font-mono text-xs text-slate-400">
              (第 {{ selectedStation.order }} 站)
            </span>
          </div>
          <button
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-400 transition hover:text-white active:scale-95"
            aria-label="关闭"
            @click="selectedStation = null"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- Freshness: the tap re-requests live data, so say so honestly. -->
        <div class="flex items-center gap-2 text-xs text-slate-400">
          <span
            class="inline-block h-1.5 w-1.5 rounded-full"
            :class="isRefreshingLive ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-400'"
          ></span>
          {{ isRefreshingLive ? '正在获取最新实时数据…' : liveFreshnessLabel }}
        </div>

        <p class="font-mono text-xs text-cyan-400">
          {{ selectedStationEta }}
        </p>

        <!-- Exact timetable arrivals (official minute-level, when available) -->
        <div v-if="stationArrivals && stationArrivals.arrivals.length > 0" class="rounded-xl border border-slate-700/60 bg-slate-950/60 px-3 py-2.5">
          <span class="text-xs font-semibold text-slate-400">
            到站时刻
            <span
              v-if="stationArrivals.isExact"
              class="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-400"
            >官方时刻表</span>
            <span
              v-else
              class="ml-1.5 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs font-medium text-slate-300"
            >推演估算</span>
          </span>
          <div class="mt-2 flex flex-wrap gap-2">
            <span
              v-for="(a, i) in stationArrivals.arrivals"
              :key="a.time || i"
              class="rounded-lg border px-2.5 py-1 font-mono text-xs"
              :class="i === 0
                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                : 'border-slate-700 bg-slate-800/60 text-slate-300'"
            >
              {{ a.time }}
              <span class="ml-1 text-xs opacity-75">{{ Math.max(1, Math.round(a.etaSeconds / 60)) }}分</span>
            </span>
          </div>
        </div>

        <!-- Catch-the-bus decision (Amap real-road walking) -->
        <div
          v-if="walkDecision"
          class="flex items-center gap-3 rounded-xl border px-3 py-2.5"
          :class="decisionStyle.border"
        >
          <span class="text-lg" :class="decisionStyle.icon">
            {{ decisionStyle.emoji }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold" :class="decisionStyle.text">
              {{ walkDecision.advice }}
            </p>
            <p class="mt-0.5 font-mono text-xs text-slate-400">
              步行 {{ Math.round(walkDecision.walkSeconds / 60) }} 分钟 / {{ walkDecision.walkMeters }} 米
              <template v-if="walkDecision.vehicleEtaSeconds !== null">
                · 车辆 {{ Math.round(walkDecision.vehicleEtaSeconds / 60) }} 分钟到站
              </template>
            </p>
          </div>
        </div>

        <button
          v-else-if="locationStore.userCoords"
          class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5 text-xs font-medium text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300 active:scale-[0.99]"
          :disabled="gisLoading"
          @click="computeWalkDecision"
        >
          <Footprints class="h-4 w-4 shrink-0 text-cyan-400" />
          <span>{{ gisLoading ? '正在规划真实步行路径...' : `计算我到「${selectedStation.name}」的赶车决策` }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Mobile Line Info Drawer: bottom sheet triggered by clicking the line badge or info chip -->
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="showLineInfo && currentLineDetail"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm sm:hidden"
        @click="showLineInfo = false"
      >
        <div
          class="max-h-[85vh] space-y-4 overflow-y-auto rounded-t-3xl border-t border-slate-700 bg-slate-900 p-5 shadow-2xl"
          @click.stop
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
              <span class="text-sm font-bold text-white">{{ currentLineDetail.directionName }}</span>
            </div>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-400 active:scale-95"
              aria-label="关闭"
              @click="showLineInfo = false"
            >
              <X class="h-4 w-4" />
            </button>
          </div>

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
                <span class="block truncate font-bold text-slate-200 text-xs">{{ opt.label }}</span>
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
              class="flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 py-3 text-xs font-semibold text-cyan-400 active:scale-95"
              :disabled="isRefreshingLive"
              @click="transitStore.refreshLive()"
            >
              <RefreshCw class="h-3.5 w-3.5 shrink-0" :class="isRefreshingLive ? 'animate-spin' : ''" />
              <span>{{ isRefreshingLive ? '正在拉取实时数据…' : '刷新最新实时车况' }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
