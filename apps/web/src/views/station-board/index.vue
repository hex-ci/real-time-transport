<script setup lang="ts">
/**
 * 电子站牌：**按站台**看，不按线路看 —— 这个站台上经过的每一条线路各还有多久。
 *
 * 三件事都来自 PRD F5 的改写（旧的那一版站台页已下线）：
 *  - 站台上的线路**不限于已关注**：数据源按站台作答，故屏上有的车就是站台上有的车；
 *  - 「到站时刻」与「发车间隔预报」分开说：前者是车什么时候到，后者是多久一班，两者绝不互填；
 *  - 不做「给路人看的展示大屏」这个形态与受众：没有翻牌、跑马灯，读法与其余页面一致。
 *
 * 站台有三个来源：**已关注线路的站表**、**我附近的站台**（数据源的附近站台接口），以及
 * **我钉过的站台**（上下班上车点与关注站，F1）。前两个按远近排、取最近的 30 个；钉过的那些
 * **排在最前且不占那 30 个名额** —— 人走远之后，想看的站不该从下拉里消失。
 */
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useIntervalFn } from '@vueuse/core'
import { LocateFixed } from '@lucide/vue'
import type { LineDetail, NearbyStop, StationBoard } from '@real-time-transport/shared'
import { favoriteDirections } from '@real-time-transport/shared'
import { statedCoordinate } from '@real-time-transport/shared/geo'
import { SearchableCombobox, type ComboboxOption, type SelectedText } from '@/components/searchable-combobox'
import { RefreshControl } from '@/components/refresh-control'
import { congestionChipClass, congestionLabel } from '@/congestion-copy'
import { distanceTextOf } from '@/distance-copy'
import {
  applyAnchors,
  arrangeOptions,
  mergeStationSources,
  movedEnough,
  outOfNearbyNoteOf,
  stationSecondaryTextOf,
  withDistances,
  type StationOption,
} from './station-options'
import { anchorStationsOf, type FavoriteDetails } from './anchor-options'
import { useCityStore } from '@/stores/city.store'
import { useLocationStore } from '@/stores/location.store'
import { useTransitStore } from '@/stores/transit.store'
import {
  boardRowsOf,
  etaTextOf,
  footnoteTextOf,
  forecastTextOf,
  quietTextOf,
  distanceToStationTextOf,
  type BoardRow,
} from './board-rows'
import { rememberedStationId, rememberStationId } from './remembered-station'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const locationStore = useLocationStore()
const { favorites } = storeToRefs(transitStore)

const options = shallowRef<StationOption[]>([])
/** 关注线路的站表（未合并、未截断的那一份），定位变化时要用它重新合成列表。 */
const followedOptions = shallowRef<StationOption[]>([])
/** 我附近的站台（数据源给的那一份）。 */
const nearbyOptions = shallowRef<StationOption[]>([])
/** 我钉过的站台（上下班上车点、关注站）：排在最前，且不占那 30 个名额。 */
const anchorOptions = shallowRef<StationOption[]>([])
/**
 * 上一次取这张列表快照时站的位置：用来判断「人是不是真的走开了」。
 *
 * 有它，列表才是**一次快照**而不是一个跟着定位连续重排的东西 —— 后者会让下拉开着的时候
 * 顺序在手指底下跳（见 `station-options.ts` 的 `movedEnough`）。
 */
let listBuiltAt: { lat: number, lng: number } | null = null
/**
 * 当前站台的 id —— 而不是一个选项对象。
 *
 * 选项会被重新构造（换城市、定位到达后重新测距），持有一个旧对象会让「当前的站」与列表里
 * 那一条悄悄分家：距离与坐标停在旧的那一份上。
 */
const currentStationId = shallowRef('')
const current = computed<StationOption | null>(() =>
  options.value.find(option => option.stationId === currentStationId.value) ?? null,
)
const rows = shallowRef<BoardRow[]>([])
const readAt = shallowRef<number | null>(null)
/** 本屏读的是哪个站台：行是关于它的，故它随行一起记账。 */
const rowsStationId = shallowRef('')
/** 这一屏的读取状态：`reading` 尚无答案，`ok` 读到过，`unreadable` 这一次没读到。 */
const readState = shallowRef<'reading' | 'ok' | 'unreadable'>('reading')
const busy = shallowRef(false)
/** 一次手动刷新正在跑（含它之后的那次回读）。 */
const refreshing = shallowRef(false)
const detecting = shallowRef(false)
/** 站台下拉此刻开着没有：开着时不重排列表（见那个 watcher）。 */
const panelOpen = shallowRef(false)
/** 开着期间攒下的重排：等面板关上再补。 */
const rebuildPending = shallowRef(false)
const landmarkHint = shallowRef('')

/** 「最近的站台也在 3 公里外」那句话：规则在 `station-options.ts`，这一页只渲染它。 */
const outOfNearbyNote = computed(() => outOfNearbyNoteOf(options.value))

/** 当前站台离我多远（只说距离，不带来源标记）：页头那一句用它。 */
const currentDistanceText = computed(() => distanceTextOf(current.value?.distanceMeters ?? null))

const comboboxOptions = computed<ComboboxOption[]>(() =>
  options.value.map(option => ({
    key: option.stationId,
    primary: option.name,
    secondary: stationSecondaryTextOf(option),
  })),
)
const comboboxSelected = computed<SelectedText | null>(() =>
  (current.value ? { primary: current.value.name, secondary: stationSecondaryTextOf(current.value) } : null),
)

/** 本地钟点 `HH:mm:ss` —— 一个时刻，绝不是时长。 */
function clockTimeOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 最后更新时间：只要屏上还有**某一次读数**的行，就说那一次的时刻 —— 重读期间与重读失败时都不把它藏起来。
 *
 * 那批数字的年龄属于它们自己，不属于这次请求：把抬头行藏起来，屏幕上就出现一批没有年龄的读数，
 * 而它们恰恰可能是旧的（PRD §7：抬头行披露的正是这件事）。
 */
const freshnessText = computed(() =>
  (readAt.value !== null ? `最后更新 ${clockTimeOf(readAt.value)}` : null),
)

/**
 * 关注线路两个方向的站表，每条线路读一次。
 *
 * 候选与「钉过的站台」都从这一份来：同一个站要在两处解析成同一个实体，读两份就会漂。
 */
async function loadFollowedDetails(): Promise<FavoriteDetails[]> {
  const cityFavorites = favorites.value.filter(f => f.cityCode === cityStore.currentCode)

  return await Promise.all(cityFavorites.map(async (favorite) => {
    const details: { 0: LineDetail | null, 1: LineDetail | null } = { 0: null, 1: null }
    for (const { direction, lineId } of favoriteDirections(favorite)) {
      try {
        const qs = new URLSearchParams({ direction: String(direction), cityCode: cityStore.currentCode })
        const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
        const json = await res.json()
        if (json?.success && json?.data) details[direction] = json.data as LineDetail
      }
      catch {
        // 单条线路读不到：它不贡献选项，其余照旧 —— 一条线读失败不该清空整个选择器。
      }
    }
    return { favorite, details }
  }))
}

/** 站表的第一个来源：**已关注线路的站表**里出现过的站名。 */
function stopsOf(entries: FavoriteDetails[]): StationOption[] {
  const found = new Map<string, StationOption>()

  for (const { details } of entries) {
    for (const detail of [details[0], details[1]]) {
      for (const stop of detail?.stops ?? []) {
        const name = stop.name
        const stationId = stop.id
        if (!name || !stationId) continue
        if (found.has(name)) continue
        found.set(name, {
          name,
          stationId,
          lat: statedCoordinate(stop.lat) ?? null,
          lng: statedCoordinate(stop.lng) ?? null,
          distanceMeters: null,
          origin: 'followed',
        })
      }
    }
  }
  return [...found.values()]
}

/**
 * 站台的第二个来源：**我附近的站台**（坐标 + 城市问数据源要的那一份）。
 *
 * 它是「没有关注线路经过的站台也能在这一页读」这条路：数据源直接给站 id，故这些站上面
 * 读得到全部经过线路的到站。读不到就什么都不加（列表退回关注线路的站表），不报错、不编 ——
 * 定位与所选城市脱钩时（跨城看线）数据源多半答空，同样退回。
 */
async function loadNearbyStops(): Promise<void> {
  // 送原始定位：服务端在自己的边界上换算，这里换算过就会二次换算。
  const coords = locationStore.deviceFix
  if (!coords) return
  try {
    const qs = new URLSearchParams({
      cityCode: cityStore.currentCode,
      lng: String(coords.lng),
      lat: String(coords.lat),
    })
    const res = await fetch(`/api/transit/stations/nearby?${qs.toString()}`)
    const json = await res.json()
    if (!json?.success || !Array.isArray(json.data)) return
    nearbyOptions.value = (json.data as NearbyStop[]).map(stop => ({
      name: stop.name,
      stationId: stop.stationId,
      lat: stop.lat,
      lng: stop.lng,
      distanceMeters: null,
      origin: 'nearby' as const,
    }))
  }
  catch {
    // 附近站台读不到：列表退回关注线路的站表，不报错也不编。
  }
}

/**
 * 两个来源合并后量距离、按远近排、取最近的 30 个。
 *
 * 成员、顺序与每行的距离**一起**在这一刻定下：只更新距离而留住旧顺序，屏上就会出现
 * 「298 米」排在「278 米」上面，那条「最近的在前」当场作废。
 */
function refreshOptions(): void {
  const merged = mergeStationSources(followedOptions.value, nearbyOptions.value)
  // 钉过的站台先用它自己解析出来的身份（id 与坐标）盖住同名项：它才是用户钉的那一个。
  const identified = applyAnchors(merged, anchorOptions.value)
  options.value = arrangeOptions(withDistances(identified, locationStore.userCoords), 30)
  listBuiltAt = locationStore.userCoords
}

/**
 * 首次加载：先取关注线路的站表，再问附近的站台，然后合成列表。
 *
 * 选中哪一个是三步：当前选中的那一份（定位到达后列表被重算时用）> 上次看过的那个（刷新、
 * 重新进入，见 `remembered-station.ts`）> 列表第一个。记下的那个**必须真在列表里**才拿回来：
 * 它早已不在附近、或那条关注线路被取关之后，屏上会出现一个下拉里点不到的站台。
 */
async function loadStationOptions(): Promise<void> {
  const entries = await loadFollowedDetails()
  followedOptions.value = stopsOf(entries)
  anchorOptions.value = anchorStationsOf(entries)
  await loadNearbyStops()
  refreshOptions()

  const remembered = rememberedStationId(cityStore.currentCode)
  const present = (stationId: string) => options.value.some(option => option.stationId === stationId)
  if (!current.value || !present(currentStationId.value)) {
    currentStationId.value = (remembered && present(remembered) ? remembered : options.value[0]?.stationId) ?? ''
  }
}

/** 抖动不算「换了地方」时的那条底线：走出去 50 米以上才重取、重排一次。 */
const LIST_REBUILD_MIN_METERS = 50

/**
 * 这一次重排的门槛（米）。
 *
 * 取两者之大者：固定底线，与**设备自己声明的精度** —— 一个承认自己有 ±N 米误差的定位，
 * 分不出相隔几十米的两站谁更近，按它重排只会让顺序来回跳。精度缺省（模拟定位、部分设备）
 * 时只剩底线。
 */
function rebuildThresholdM(): number {
  return Math.max(LIST_REBUILD_MIN_METERS, locationStore.accuracyM ?? 0)
}

/**
 * 真的走开了才重建：先重取附近的站台（**成员**可能变了），再合成一张（顺序与每行的距离）。
 *
 * 同一次快照之内什么都不动 —— 这是下拉不再跳的全部原因。
 */
async function rebuildListIfMoved(fix: { lat: number, lng: number } | null): Promise<void> {
  if (!fix) return
  if (!movedEnough(listBuiltAt, fix, rebuildThresholdM())) return
  if (followedOptions.value.length > 0) await loadNearbyStops()
  if (options.value.length > 0 || followedOptions.value.length > 0) refreshOptions()
}

/**
 * 换站台：屏上的行是为上一个站台构造的，故它们连同它们的时刻一起离开。
 *
 * `remember` 说的是**这算不算用户选定了这一站**：从下拉里点的是选定（下次进入还看它）；
 * 「定位最近站台」按出来的那个不是 —— 那个动作的意思是「跟着我到的地方走」，把它固定下来，
 * 人挪走之后就再也回不到自动了。解除固定正是它记下空值的那一下。
 *
 * 记忆先落，与「选中的是不是当前这一站」无关：按定位而最近的那个恰好就是当前这一站时，
 * 解不解除固定是两件不同的事，不该因为重复选中而被跳过。
 */
function applyStation(option: StationOption | null, remember: boolean): void {
  rememberStationId(cityStore.currentCode, remember ? option?.stationId ?? '' : '')
  if (option?.stationId === currentStationId.value) {
    void readBoard()
    return
  }
  currentStationId.value = option?.stationId ?? ''
  rows.value = []
  readAt.value = null
  rowsStationId.value = ''
  readState.value = 'reading'
  void readBoard()
}

/** 用户从下拉里选定了这一站。 */
function selectStation(option: StationOption | null): void {
  applyStation(option, true)
}

/** 回到自动：跟着最近的那个站走，并解除固定 —— 「定位最近站台」的按钮就是这条路。 */
function followNearest(option: StationOption | null): void {
  applyStation(option, false)
}

/**
 * 手动刷新（F11）：这一次点名的是**这个站台**，而不是屏幕上那几条线路 ——
 * 冷却窗口与线路刷新共用同一个，结局由全局提示说（与另三页同一句措辞）。
 */
async function onRefresh(): Promise<void> {
  const station = current.value
  if (!station || refreshing.value) return
  refreshing.value = true
  try {
    const outcome = await transitStore.refreshStationBoard({
      stationId: station.stationId,
      cityCode: cityStore.currentCode,
    })
    if (outcome === 'ok') await readBoard()
  }
  finally {
    refreshing.value = false
  }
}

/**
 * 读一次站牌。
 *
 * 保留契约与旧屏同一套：有行的屏在重读期间留着行，更新由控件示意；首次加载与换站台才清空。
 * 时刻只由**这一次读数自己的** `readAt` 写入 —— 请求发生的钟绝不能变成读数时刻。
 */
async function readBoard(): Promise<void> {
  const station = current.value
  if (!station) {
    rows.value = []
    readAt.value = null
    rowsStationId.value = ''
    readState.value = 'reading'
    return
  }
  busy.value = true
  const qs = new URLSearchParams({ cityCode: cityStore.currentCode })
  try {
    const res = await fetch(`/api/transit/stations/${encodeURIComponent(station.stationId)}/board?${qs.toString()}`)
    const json = await res.json()
    if (!json?.success || !json?.data) throw new Error('board read failed')
    const board = json.data as StationBoard
    // 晚到的答案若属于别的站台，就不是本屏的答案：丢掉，而不是把它挂在当前站台下。
    if (station.stationId !== current.value?.stationId) return
    rows.value = boardRowsOf(board)
    readAt.value = board.readAt
    rowsStationId.value = station.stationId
    readState.value = 'ok'
  }
  catch {
    readState.value = 'unreadable'
  }
  finally {
    busy.value = false
  }
}

useIntervalFn(() => {
  if (current.value) void readBoard()
}, 12000)

/** GPS 雷达：在**已有选项**里找最近的真实站台，找不到就如实说它不在关注线路里。 */
async function detectNearby(): Promise<void> {
  const coords = locationStore.userCoords
  if (!coords) {
    detecting.value = true
    locationStore.requestLocation({ userInitiated: true })
    landmarkHint.value = '正在获取定位…'
    return
  }
  detecting.value = true
  try {
    // 重取附近的站台再选最近的那个：这些站本身带站 id，故不必按站名去匹配已有选项。
    // 早前那条路走的是高德 POI 雷达，匹配不上只能说「不在关注线路中」。
    await loadNearbyStops()
    refreshOptions()
    const nearest = options.value[0] ?? null
    if (!nearest) {
      landmarkHint.value = '这一带没有读到站台'
      return
    }
    landmarkHint.value = `已对准 ${nearest.name}`
    // 这是「回到自动」，不是「选定这一站」：它解除之前的固定。
    followNearest(nearest)
  }
  finally {
    detecting.value = false
  }
}

onMounted(async () => {
  await transitStore.fetchFavorites()
  await loadStationOptions()
  if (current.value) await readBoard()
})

watch(() => cityStore.currentCode, async () => {
  options.value = []
  followedOptions.value = []
  nearbyOptions.value = []
  anchorOptions.value = []
  listBuiltAt = null
  currentStationId.value = ''
  rows.value = []
  readAt.value = null
  rowsStationId.value = ''
  readState.value = 'reading'
  await transitStore.fetchFavorites()
  await loadStationOptions()
  if (current.value) await readBoard()
})

/**
 * 定位到达或改变后：只有**真的走开了一段**才重建列表（重取附近站台 + 重排，见
 * `rebuildListIfMoved`）—— 定位每一下都在动，按每一下重排就是「顺序在手指底下跳」。
 *
 * 量的是两次原始定位之间的距离：与取快照时记下的那一份同一个坐标系（换算后的定位拿去比，
 * 同一个位置的差就有 500 米，每次定位都会重排）。
 *
 * 下拉正开着时不重排，只记下该重排：列表正被人读着，顺序在手指底下换掉比距离旧几秒糟得多。
 */
watch(() => locationStore.deviceFix, async (fix) => {
  if (!fix) return
  if (panelOpen.value) {
    rebuildPending.value = true
    return
  }
  await rebuildListIfMoved(fix)
})

/** 下拉开合：关上的那一刻把开着期间攒下的重排补上。 */
async function onPanelOpenChange(isOpen: boolean): Promise<void> {
  panelOpen.value = isOpen
  if (isOpen || !rebuildPending.value) return
  rebuildPending.value = false
  await rebuildListIfMoved(locationStore.deviceFix)
}

/** 这一行的车辆标签（如「无障碍」）：数据源挂了才说。 */
function tagsTextOf(row: BoardRow): string | null {
  return row.tags.length > 0 ? row.tags.join(' · ') : null
}

/**
 * 一行的小字事实：**这趟车距本站多远**与车辆标签（如「无障碍」）。
 *
 * 两者都是关于「哪辆车」的：距本站是它的位置，标签是它的配备。线路自己的静态事实
 * （总站数、本站序、下一站名）刻意不出现在这屏 —— 它们不随车走，说在这儿会被读成车辆状态。
 *
 * 移动端它们跟在「开往」下面，宽屏上自成中列 —— 两档排布不同、字段一字不差，
 * 故这一份由同一个函数给出：分成两份写，两档就会慢慢说出不同的东西。
 */
function factsOf(row: BoardRow): string[] {
  return [distanceToStationTextOf(row), tagsTextOf(row)]
    .filter((fact): fact is string => fact !== null)
}

function laterTextOf(row: BoardRow): string | null {
  return row.laterClocks.length > 0 ? row.laterClocks.join(' · ') : null
}

/** 选择器选中一个选项：站的选择按数据源的站 id 认，不按名字。 */
function onSelectOption(option: ComboboxOption): void {
  selectStation(options.value.find(candidate => candidate.stationId === option.key) ?? null)
}
</script>

<template>
  <div class="space-y-5 pb-12">
    <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 shadow-xl backdrop-blur-md sm:rounded-3xl sm:p-5">
      <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
        <div>
          <span class="text-xs font-semibold uppercase tracking-wider text-cyan-400">
            电子站牌
          </span>
          <h2 class="mt-0.5 flex flex-wrap items-center gap-x-2 text-lg font-bold text-white md:text-2xl">
            当前站台：<span class="max-w-[260px] truncate text-cyan-300">{{ current?.name || '选择中…' }}</span>
            <span v-if="currentDistanceText" class="text-xs font-normal text-slate-400 lg:text-sm">距你 {{ currentDistanceText }}</span>
          </h2>
          <p class="text-xs text-slate-400">
            按到站先后排列 · 含本站台上未关注的线路<template v-if="outOfNearbyNote"> · {{ outOfNearbyNote }}</template><template v-if="landmarkHint"> · {{ landmarkHint }}</template>
          </p>
        </div>

        <div class="flex w-full items-center gap-2 md:w-auto">
          <SearchableCombobox
            :model-value="current?.stationId ?? null"
            label="选择站台"
            :options="comboboxOptions"
            :selected="comboboxSelected"
            placeholder="选择站台"
            search-placeholder="搜索站台名…"
            empty-text="未找到匹配站台"
            class="min-w-0 flex-1 md:w-60 md:flex-none lg:w-64"
            @select="onSelectOption"
            @update:open="onPanelOpenChange"
          />
          <button
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95"
            :disabled="detecting"
            :aria-busy="detecting"
            aria-label="定位最近站台"
            @click="detectNearby"
          >
            <LocateFixed class="h-5 w-5" aria-hidden="true" />
          </button>
          <!-- F11：本屏的刷新入口，与另三页共用同一个控件、同一个 store 动作与同一个冷却端点，
               而结局由全局提示说。它这一次点名的是**这个站台**。它是控件，故与其余控件同一行
               （宽屏靠右），不在内容底部单独占一行。 -->
          <RefreshControl
            :refreshing="refreshing || busy"
            :disabled="!current"
            label="刷新本站台到站"
            variant="button"
            :has-reading="false"
            class="shrink-0"
            @refresh="onRefresh"
          />
        </div>
      </div>
    </div>

    <div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
      <div
        v-if="freshnessText"
        class="border-b border-slate-800/60 px-3 py-2 text-xs text-slate-400 lg:px-4 lg:text-base"
      >
        {{ freshnessText }}
      </div>

      <div class="grid grid-cols-[1fr_auto] border-b border-slate-800 bg-slate-900/90 px-3 py-3 text-xs font-semibold tracking-wider text-slate-400 uppercase md:px-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] lg:gap-x-6">
        <div>线路 / 开往</div>
        <!-- 宽屏上小字事实自成中列，故表头也给那一列一个名字：与数据行一一对应。 -->
        <div class="hidden lg:block lg:text-right">距本站</div>
        <div class="text-right">到站 · 拥挤度</div>
      </div>

      <div v-if="!current" class="p-8 text-center text-xs text-slate-400 lg:text-base">
        该城市还没有可选的站台：站台来自已关注线路的站表，请先在「设置」里关注经过站台的线路
      </div>

      <div v-else-if="rows.length === 0 && readState === 'reading'" class="p-8 text-center text-xs text-slate-400 lg:text-base">
        正在读取本站台的到站数据…
      </div>

      <div v-else-if="rows.length === 0 && readState === 'unreadable'" class="p-8 text-center text-xs text-rose-400 lg:text-base">
        未读到本站台的到站数据
      </div>

      <div v-else-if="rows.length === 0" class="p-8 text-center text-xs text-slate-400 lg:text-base">
        本站台上没有可报的线路
      </div>

      <div v-else class="divide-y divide-slate-800/60">
        <div
          v-for="row in rows"
          :key="row.key"
          class="grid grid-cols-[1fr_auto] items-center gap-x-3 px-3 py-3 transition hover:bg-slate-900/50 md:px-4 md:py-3.5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] lg:gap-x-6"
        >
          <!-- 左列：线路徽标 + 开往。小字事实在窄屏上跟在开往下面，宽屏上自成中列（见下一块）。 -->
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 font-mono text-xs font-bold whitespace-nowrap text-cyan-400"
              :class="row.lineName.length > 4 ? 'min-w-[58px]' : 'min-w-[44px]'"
            >
              {{ row.lineName }}
            </span>
            <div class="min-w-0">
              <div class="text-xs font-medium text-slate-200 lg:text-base">开往 {{ row.destination }}</div>
              <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 lg:hidden">
                <span v-for="fact in factsOf(row)" :key="fact">{{ fact }}</span>
              </div>
            </div>
          </div>

          <!-- 中列（宽屏专有）：同一批小字事实，由 `factsOf` 一处给出，故两档不会说出不同的东西。 -->
          <div class="hidden flex-wrap items-center gap-x-3 text-xs text-slate-500 lg:flex lg:justify-end">
            <span v-for="fact in factsOf(row)" :key="fact">{{ fact }}</span>
          </div>

          <div class="flex items-center justify-end gap-3 text-right">
            <div class="font-mono">
              <template v-if="row.etaMinutes !== null">
                <span class="text-base font-bold text-cyan-400">{{ etaTextOf(row) }}</span>
              </template>
              <template v-else-if="forecastTextOf(row)">
                <span class="text-xs font-medium text-amber-300/90 lg:text-sm">{{ forecastTextOf(row) }}</span>
              </template>
              <template v-else>
                <span class="text-xs text-slate-400 lg:text-sm">{{ quietTextOf(row) }}</span>
              </template>
              <div v-if="footnoteTextOf(row)" class="text-[11px] text-slate-500 lg:text-xs">
                {{ footnoteTextOf(row) }}<template v-if="laterTextOf(row)"> · 后 {{ laterTextOf(row) }}</template>
              </div>
            </div>
            <span
              v-if="row.etaMinutes !== null"
              class="rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap lg:text-xs"
              :class="congestionChipClass(row.congestion)"
            >
              {{ congestionLabel(row.congestion) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="busy" class="sr-only" aria-live="polite">正在更新本站台到站数据</p>
  </div>
</template>
