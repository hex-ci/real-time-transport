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
import {
  refreshFreshnessOf,
  refreshStatusTextOf,
  useTransitStore,
} from '@/stores/transit.store'
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
import type { ArrivalRow, OperatingStatus, RefreshLiveTarget, Station, UserFavoriteLine } from '@real-time-transport/shared'
import { effectiveCommuteDirection, favoriteDirectionOfLine, resolveBoardStopRef } from '@real-time-transport/shared/line-group'
import { statedArrivalMinutes, vehicleProvenanceOf } from '@real-time-transport/shared'
import { operatingLabelOf, operatingTextOf } from '@/operating-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { AT_PLATFORM_ETA_TEXT } from './at-platform'
import { estimateSubwayArrivalSeconds } from './pending-estimate'

const {
  id: propId,
  direction: propDirection,
  cityCode: propCityCode,
} = defineProps<{
  id: string
  // 路由里可选：/line/:id 两者都不带，下面的 computed 退回 store 的方向与城市。
  direction?: string
  cityCode?: string
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

/** 本视图的根元素，用来把它按可用视口定高。 */
const pageRef = useTemplateRef('pageEl')

/**
 * 固定 flex 列的精确高度，使页面永不滚动：本视图顶边到视口底部之间的空间，减去外壳 <main>
 * 当前的底部内边距。从 DOM 读取而非镜像成常量：该内边距随断点变化，并按 iOS 底部指示条增大。
 */
const pageHeight = shallowRef(600)

function getMainBottomPadding(): number {
  const main = pageRef.value?.closest('main')
  if (!main) return 0
  return Number.parseFloat(getComputedStyle(main).paddingBottom) || 0
}

function updatePageHeight(): void {
  if (!pageRef.value) return
  // 用相对文档的顶部（rect.top + scrollY）：只看 rect.top 会随页面滚动而变，反馈进高度计算后发散。
  const top = pageRef.value.getBoundingClientRect().top + window.scrollY
  const available = window.innerHeight - top - getMainBottomPadding()
  // 钳制，使很矮的视口也留下可用的报站板。
  pageHeight.value = Math.max(360, available)
}

const { currentLineDetail, currentLiveStatus } = storeToRefs(transitStore)
const { nearestStation } = storeToRefs(locationStore)
const { isLoading, loadFailure, isRefreshingLive } = storeToRefs(transitStore)
const {
  refreshInFlight,
  refreshOutcome,
  refreshWaitSecondsLeft,
  refreshReading,
} = storeToRefs(transitStore)

const selectedStation = shallowRef<Station | null>(null)
const stationAnchor = shallowRef<StationAnchor | null>(null)
const routeBoardRef = useTemplateRef<InstanceType<typeof RouteBoard>>('routeBoardRef')
const showLineInfo = shallowRef(false)
const stationArrivals = shallowRef<{
  /** 每一行陈述自己的 F4 来源；列表标记由它们导出。 */
  arrivals: ArrivalRow[]
  /** F3：车是否在跑，取自线路自己的首末班。 */
  operatingStatus?: OperatingStatus
  /**
   * F-C：精确表对本站台自己的说明（例如只跑一段的末班车），答案不带时为 null。
   * 与下面的班次一起渲染，绝不改写。
   */
  note?: string | null
} | null>(null)

/**
   * F4：线路级标记，给头部与信息面板。
   *
   * 由**应答的**那个来源决定——不是线路类型，也不是这是哪个屏幕——故来源切换会被反映出来，
   * 而界面不必知道任何提供方。Null 不渲染任何标记。
   */
const lineDataMark = computed(() =>
  provenanceLabelOf(vehicleProvenanceOf(currentLiveStatus.value?.dataSource)))

/**
   * 站点面板所渲染快照的诚实新鲜度：我们正在画的这次读取是多久以前产生的，别无其他。
   *
   * 它曾把该读取称作「实时数据」，那是对它**种类**的断言——是 F4 标记的职责——且在每条地铁线上
   * 都是假的，因为那些列车由时刻表生成。年龄才是这一行真正知道的东西。
   */
const liveFreshnessLabel = computed(() => {
  const updated = currentLiveStatus.value?.updatedAt
  if (!updated) return '暂无数据'
  const ageSec = Math.max(0, Math.round((Date.now() - updated) / 1000))
  if (ageSec < 60) return `${ageSec} 秒前更新`
  const ageMin = Math.round(ageSec / 60)
  return `${ageMin} 分钟前更新`
})

const lineId = computed(() => String(propId || ''))

/**
 * 路由里请求的方向（URL 查询参数）—— 只是「这次要读哪个方向」的请求。
 *
 * URL 里的号由写它的人决定，故它不说明屏幕上现在显示的是哪个方向：显示什么、写进收藏行什么，
 * 都读 `activeDirection` 与 `favoriteDirection`。
 */
const requestedDirection = computed<0 | 1>(() => (Number(propDirection ?? 0) === 1 ? 1 : 0))
const currentCityCode = computed(() => String(propCityCode || cityStore.currentCode))
const gisLoading = computed(() => isLoadingDecision.value)

/**
 * F11 在本页的入口：它重读的那一条线路，点名给服务端。
 *
 * 建立在屏幕上真正显示的那条线路上——端点读的是它所问之物。方向读 `activeDirection`。
 */
const refreshTargets = computed<RefreshLiveTarget[]>(() => [{
  lineId: lineId.value,
  direction: activeDirection.value,
  cityCode: currentCityCode.value,
}])

/** 按钮下的状态行：粗粒度状态（live region 播报的那个）与其旁的秒数；无可报告时为 null。 */
const refreshStatus = computed(() => refreshStatusTextOf({
  inFlight: refreshInFlight.value,
  outcome: refreshOutcome.value,
  waitSeconds: refreshWaitSecondsLeft.value,
  // 只问了一条线路，故被上限截断的情形是本页不可能处的状态。
  wanted: refreshTargets.value.length,
  covered: refreshTargets.value.length,
  // 本页唯一的目标就是路由里的那条线路，故没有「读取仍未结束」的列表：刷新对话框挂在报站板上，而报站板只为已加载的线路渲染。
  targetsRead: true,
}))

/**
   * 按钮正在做什么。按下的一半仍在途时它都让开——花掉窗口的请求，或展示它的回读——
   * 因为其间第二次按下是关于另一个时刻的答案。
   */
const refreshing = computed(() => refreshInFlight.value || isRefreshingLive.value)

const refreshFreshness = computed(() => refreshFreshnessOf(refreshReading.value))

/** 状态行的色调。词承载状态，色调只作辅助，故此处绝不是任何东西的唯一信号。 */
const refreshStatusClass = computed(() => {
  if (refreshOutcome.value === 'throttled') return 'text-amber-400'
  if (refreshOutcome.value === 'unavailable' || refreshOutcome.value === 'offline') {
    return 'text-rose-400'
  }
  if (refreshOutcome.value === 'ok') return 'text-emerald-400'
  return 'text-slate-400'
})

/** 按钮指向的 id，使状态与控件一起被读出，而不是另一件要去找的东西。 */
const refreshDescribedBy = computed(() => refreshStatus.value
  ? 'refresh-freshness refresh-status'
  : 'refresh-freshness')

/**
   * 按下：经共享请求索要一次重读，然后把线路读回来，使报站板显示该请求取得之物。
   *
   * 被拒绝或失败的尝试什么都没取得，故报站板保留它已有的读取：屏幕上
   * 的数字不得为了迎合一个没携带读数的答案而改变。
   */
async function onRefresh(): Promise<void> {
  const outcome = await transitStore.refreshLive(refreshTargets.value)
  if (outcome === 'ok') await transitStore.reloadLiveStatus()
}

/**
   * 地铁线路着琥珀色、公交青色——与首页卡片同一条规则，故这两个徽标读起来像一个系统。
   * subway_ 前缀是详情加载之前的回退。
   */
const isSubway = computed(() =>
  currentLineDetail.value?.type === 'subway' || lineId.value.startsWith('subway_'),
)

/**
   * 仅两个线路身份徽标（线路名芯片与「N 站」药丸）的配色。
   *
   * 刻意窄：画布保留自己的配色，因为最近站标记是黄色，会与琥珀色线路色撞车并藏起地图上最重要的
   * 定位器。方向页签、到达面板与指标徽标保持中性/翠绿，因为它们不是线路类型的信号。
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
   * 反方向那条线路的 lineId。
   * - 公交：每个方向是不同的 lineId（由提供方给出）
   * - 地铁：同一个 lineId 服务两个方向（只有参数变）
   * 提供方没能解析出反向时为 null，那时不提供切换——绝不猜一个 lineId。
   */
const oppositeLineId = computed<string | null>(() => {
  const d = currentLineDetail.value
  if (!d) return null
  if (d.type === 'subway') return d.lineId
  return d.otherDirectionLineId || null
})

const canSwitchDirection = computed(() => oppositeLineId.value !== null)

/**
   * 用真正的终点站名构造两个方向页签，顺序固定（方向 0 在前，方向 1 在后），使页签像页签栏：
   * 每个标签占着自己的槽位，只有高亮在移动。
   *
   * 反向的终点是本方向的**首站**。环线（首站 === 末站）无法用终点区分，退回上行/下行。
   */
const directionOptions = computed<DirectionOption[]>(() => {
  const d = currentLineDetail.value
  const opp = oppositeLineId.value
  if (!d || !opp) return []

  const stops = d.stops
  const first = stops[0]?.name || ''
  const last = stops[stops.length - 1]?.name || ''
  const isLoop = first !== '' && first === last

  // `detail.direction` 是引擎侧的事实（它不回显查询参数），故它是已加载数据描述哪个方向的可靠锚点。
  const curDir = d.direction

  /** 各方向的 lineId：公交换 id，地铁复用同一个。 */
  const lineIdFor = (direction: number): string =>
    (direction === curDir ? d.lineId : opp)

  const labelFor = (direction: number): string => {
    if (isLoop) return direction === 0 ? '上行' : '下行'
    // 已加载的方向有权威标签；反向的那个由它的终点（本方向的首站）导出——反向的详情从不读取，因为页签只需要这一个字符串。
    if (direction === curDir && d.directionName) return d.directionName
    const terminal = direction === curDir ? last : first
    return terminal ? `开往 ${terminal}` : (direction === 0 ? '上行' : '下行')
  }

  // 固定先方向 0 再方向 1——稳定的页签顺序。
  return [0, 1].map(direction => ({
    direction,
    lineId: lineIdFor(direction),
    label: labelFor(direction),
  }))
})

/**
 * 这一页现在显示的方向 —— 页面上「当前方向」的唯一来源。
 *
 * payload 自己的方向就是它描述的线路的方向：屏幕显示的是它，实时/到站/步行读取也都按它走。
 * payload 未到之前退回 URL 里请求的那个号，那时请求本身是唯一存在的东西。
 * 收藏行自己的编号与它不是同一套，写收藏行字段时经 `favoriteDirection` 换算一次。
 */
const activeDirection = computed<number>(() => {
  const d = currentLineDetail.value
  return d ? d.direction : requestedDirection.value
})

function isActiveTab(opt: DirectionOption): boolean {
  return opt.direction === activeDirection.value
}

function switchDirection(opt: DirectionOption): void {
  if (isActiveTab(opt)) return
  // 清掉选中的站：站序在各方向之间不同。
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
      // 用屏幕上真正的方向（引擎侧事实），使书签或手写 URL 里与公交 lineId 不一致的方向参数无法查询反向的到站。
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
  // 再点选中的站关闭弹窗。
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
  void transitStore.reloadLiveStatus()
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
 * 覆盖屏幕上这条线路的收藏行，若存在——它的任一个方向 lineId 就是画着的那条。
 * 上车点只对已关注的线路有意义：首页卡片从收藏行读它，未关注的线路没有地方存。
 *
 * 按 line 认：这一页画的是屏幕上这条 lineId 的线路，而收藏行为每个方向各存一条 lineId。
 */
const matchingFavorite = computed(() => {
  const line = lineId.value
  return transitStore.favorites.find((f) => {
    if (f.cityCode !== currentCityCode.value) return false
    return f.lineId === line || f.reverseLineId === line
  }) ?? null
})

/**
 * 屏幕上这个方向，在收藏行自己的编号里是几号 —— 没关注这条线路时为 null。
 *
 * 要写的 `direction`（上车点带的那一个）是收藏行的编号，不是 payload 的号：两者对同一条线路
 * 可以相反。换算只在这一处做一次，来源是屏幕上那个方向。
 */
const favoriteDirection = computed<0 | 1 | null>(() => {
  const fav = matchingFavorite.value
  if (!fav) return null
  return favoriteDirectionOfLine(fav, lineId.value, activeDirection.value)
})

/**
 * 两个上车点各自属于哪个方向，同样用收藏行自己的编号（与 `favoriteDirection` 同一套）。
 *
 * 两向线路还没选过方向时为 null，那时这一对 (站名, 站序) 自己是它唯一的说法；报站板据此只在
 * 属于本屏那个方向时标角标。
 */
function pinnedStopDirection(purpose: 'morning' | 'evening'): 0 | 1 | null {
  const fav = matchingFavorite.value
  if (!fav) return null
  return effectiveCommuteDirection(fav, purpose)
}

const morningStopDirection = computed(() => pinnedStopDirection('morning'))
const eveningStopDirection = computed(() => pinnedStopDirection('evening'))

/**
 * 屏幕上这个方向服务哪个通勤目的，按使用者自己的选择。
 *
 * 读存下来的方向而不是从站序推断；未选过时为 null，故不显示徽标。两个目的都解析到屏幕上这个
 * 方向时同样为 null——徽标点名目的，有两个候选就是在替另一个作不实的断言。
 */
const activePurpose = computed<'morning' | 'evening' | null>(() => {
  const fav = matchingFavorite.value
  const dir = favoriteDirection.value
  if (!fav || dir === null) return null
  const morning = effectiveCommuteDirection(fav, 'morning') === dir
  const evening = effectiveCommuteDirection(fav, 'evening') === dir
  if (morning && evening) return null
  if (morning) return 'morning'
  if (evening) return 'evening'
  return null
})

/**
 * 弹窗里打开的站是否为某个目的存下来的那一站。
 *
 * 问的是收藏行持有的**一对** (站名, 站序)，不是它的名字：同名站在一条线路上出现两次时按名字比，
 * 会把两个都标上，从而把使用者从未选的站台说成他的上车点。只留了名字的旧行没有站序，那时名字是
 * 徽标唯一的依据。
 *
 * 此处刻意不看屏幕上的方向：一个目的乘哪个方向是另一个存下来的字段。
 */
function isStoredStop(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  station: { name: string, order: number },
): boolean {
  const ref = resolveBoardStopRef(fav, purpose)
  if (!ref || ref.name !== station.name) return false
  return ref.order === null || ref.order === station.order
}

/** 弹窗里当前打开的那个站的上车点状态。 */
const stationPurpose = computed<'morning' | 'evening' | null>(() => {
  const fav = matchingFavorite.value
  const station = selectedStation.value
  if (!fav || !station) return null
  if (isStoredStop(fav, 'morning', station)) return 'morning'
  if (isStoredStop(fav, 'evening', station)) return 'evening'
  return null
})

const stopSaving = shallowRef(false)
const stopError = shallowRef<string | null>(null)

/**
 * 把打开的站绑定到某个通勤目的，或解绑。
 *
 * 设站时也把屏幕上当前的方向记为那个目的的方向：使用者在指定上车点时所看的就是这个方向的站，
 * 没有方向的站定位不到任何东西。清空一个站不动方向，故日后重选只需该站。
 */
async function toggleBoardStop(purpose: 'morning' | 'evening'): Promise<void> {
  const fav = matchingFavorite.value
  const station = selectedStation.value
  const dir = favoriteDirection.value
  if (!fav?.id || !station || dir === null) return

  stopSaving.value = true
  stopError.value = null
  try {
    const clearing = stationPurpose.value === purpose
    await transitStore.updateCommuteSlot(fav.id, purpose, clearing
      ? { stop: null }
      : { stop: { name: station.name, order: station.order }, direction: dir })
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
    // 与到站同理：匹配屏幕上真正显示的方向。
    direction: activeDirection.value,
    stationName: selectedStation.value.name,
    cityCode: currentCityCode.value,
  })
}

/**
 * F4：面板的头条答案，连同它是哪种数字。
 *
 * 文本与标记刻意由同一个分支决定——陈述分钟的线路必须带上它陈述的那个分钟的来源，陈述营运事实的
 * 线路不带，因为没有数字可分类。把两者分开正是算出来的分钟看起来像一次读取的原因。
 */
const selectedStationEta = computed<{ text: string, mark: string | null }>(() => {
  if (!selectedStation.value) return { text: '等待发车', mark: null }
  const targetOrder = selectedStation.value.order

  /**
   * 地铁行的标记：由载荷声明的车辆种类决定（引擎声明的模型 → 排班推演）。
   * 本页不再为自己算出的分钟取标记 —— 那个入口随「本系统自算」那一档词汇表删除。
   */
  const vehicleMark = provenanceLabelOf(vehicleProvenanceOf(currentLiveStatus.value?.dataSource))

  // 1. 引擎返回的精确到站
  if (stationArrivals.value && stationArrivals.value.arrivals.length > 0) {
    const next = stationArrivals.value.arrivals[0]!
    const mark = provenanceLabelOf(next.provenance)
    if (next.isAtStation) {
      // 对车在哪里的观测，不是数字：标记限定的是数字，而这个断言没有数字。行的种类仍在下面的列表里显示。
      return { text: AT_PLATFORM_ETA_TEXT, mark: null }
    }
    // 没有分钟就是没有分钟。本分支原本会退回的外推（快照速度套在剩余各站上）误差没有固定的符号，故该行陈述缺失。
    const mins = statedArrivalMinutes(next)
    if (mins === null) return { text: ARRIVAL_MINUTE_UNAVAILABLE_TEXT, mark: null }
    // 公开下发的发车时刻是钟点而非位置：时间就是全部答案，旁边没有距离或站数可报。
    if (next.provenance === 'exact_timetable') {
      return { text: `${next.time} 到站 (约 ${mins} 分钟)`, mark }
    }
    const stopsText = next.stopsAway
      ? (next.stopsAway === 1 ? '即将进站 (1 站)' : `距本站 ${next.stopsAway} 站`)
      : ''
    const distText = next.distanceMeters && next.distanceMeters > 0
      ? ` · ${(next.distanceMeters / 1000).toFixed(1)}km`
      : ''
    return { text: `预计 ${mins} 分钟到达 (${stopsText}${distText} · ${next.time})`, mark }
  }

  // 2) 引擎明确确认没有接近的车辆
  if (stationArrivals.value && stationArrivals.value.arrivals.length === 0) {
    // F3：营运日优先。还没开始或已经结束，那就是答案——关于在途车辆的说法会是在描述一条没在跑的线路。
    const operating = stationArrivals.value.operatingStatus
    if (operating && (operating.state === 'after_last' || operating.state === 'before_first')) {
      return { text: operatingTextOf(operating), mark: null }
    }
    const allBuses = currentLiveStatus.value?.buses || []
    if (allBuses.length === 0) {
      // 线路上什么都没有。「待发车」曾附在这里，在没有车的时候声称有车即将开出。
      return {
        text: operating
          ? `${operatingLabelOf(operating)} · 线路上暂无在途车辆`
          : '线路上暂无在途车辆',
        mark: null,
      }
    }
    // 车辆的下一站已越过目标站时，它就是「已过」
    const passedBuses = allBuses.filter((b) => {
      const next = b.nextOrder ?? (b.order !== undefined ? b.order + 1 : undefined)
      return next !== undefined && next > targetOrder
    })
    const servingNow = allBuses.some(b => b.nextOrder === targetOrder || b.order === targetOrder)
    if (servingNow) {
      // 与上面的 at-platform 分支同一条规则：没有数字的陈述不带标记。
      return { text: AT_PLATFORM_ETA_TEXT, mark: null }
    }
    if (passedBuses.length > 0) {
      return { text: '本班车已过本站 · 前序暂无在途车', mark: null }
    }
    return { text: '前序暂无在途车辆', mark: null }
  }

  // 3. 车站到站答案仍在途时的回退：从 currentLiveStatus 推导
  if (!currentLiveStatus.value) return { text: '等待发车', mark: null }
  const allBuses = currentLiveStatus.value.buses
  if (allBuses.length === 0) return { text: '线路上暂无在途车辆', mark: null }

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
      // 与上面的 at-platform 分支同一条规则：没有数字的陈述不带标记。
      return { text: AT_PLATFORM_ETA_TEXT, mark: null }
    }
    if (passed.length > 0) {
      return { text: '本班车已过本站 · 前序暂无在途车', mark: null }
    }
    return { text: '前序暂无在途车辆', mark: null }
  }

  const bus = upcoming[0]!
  const stops = Math.max(1, targetOrder - (bus.nextOrder ?? (bus.order as number)))
  const stopsText = stops === 1 ? '即将进站 (1 站)' : `距本站 ${stops} 站`

  if (isSubway.value) {
    const progress = typeof bus.progress === 'number' ? bus.progress : 0
    // 服务端自己的模型，且取了下限——见 `pending-estimate.ts`。
    const etaSec = estimateSubwayArrivalSeconds(stops, progress)
    const mins = Math.max(1, Math.round(etaSec / 60))
    return { text: `预计 ${mins} 分钟到达 (${stopsText})`, mark: vehicleMark }
  }

  // 没有引擎侧分钟的公交行，与上面的到站分支一样不陈述分钟：该行说明分钟取不到，并保留它仍能陈述的东西。
  return { text: `${ARRIVAL_MINUTE_UNAVAILABLE_TEXT} (${stopsText})`, mark: null }
})

// 路由（lineId + 请求的方向）变了就重新读这一条线：这里请求的是 URL 里那个方向 —— 加载还没
// 回来之前，它是唯一存在的东西（地铁就是靠它选方向）。payload 回来之后，屏幕上的方向以
// `activeDirection` 为准。
watch(
  () => [lineId.value, requestedDirection.value],
  () => {
    if (lineId.value) {
      void transitStore.loadLine(lineId.value, requestedDirection.value, currentCityCode.value)
      void fetchStationArrivals()
    }
  },
)

watch(
  () => currentLineDetail.value?.stops,
  (stops) => {
    if (stops && stops.length > 0) {
      // 最近站池喂给报站板自己的标记（黄圈与涟漪），刻意**不**升级为 `selectedStation`——那会在加载线路时就打开弹窗。
      locationStore.updateNearestStation(stops)
    }
  },
  { immediate: true },
)

// 保持精确表的倒计时新鲜（班次每分钟都在过）
useIntervalFn(() => {
  if (selectedStation.value) void fetchStationArrivals()
}, 30000)

useEventListener(window, 'resize', updatePageHeight)

onMounted(() => {
  transitStore.initWs()
  // 收藏行驱动上车点控件：没有它就无法判断这条线路是否被关注，而上车点没有地方可存。
  void transitStore.fetchFavorites()
  // 开始定位，使报站板能标出最近的站。拒绝授权在这里是空操作，故绝不重复询问。
  locationStore.requestLocation()
  if (lineId.value) {
    void transitStore.loadLine(lineId.value, requestedDirection.value, currentCityCode.value)
  }
  // 布局之后再量，使头部高度是真的，而不是 0。
  void nextTick(updatePageHeight)
})

onUnmounted(() => {
  // 丢掉本视图的数据，使从首页再次进入时显示加载态而不是上一条线路。切换方向复用同一个实例（同一个路由记录），故不会走到这里。
  transitStore.resetLineData()
})
</script>

<template>
  <!-- 固定高度的 flex 列：报站板区伸缩填满头部/横幅/到达面板留下的空间，故页面自己永不需要滚动条。
       高度在 JS 里测量（见 pageHeight），因为外壳头部高度不是已知常量。 -->
  <div
    ref="pageEl"
    class="flex min-h-0 flex-col gap-2.5 overflow-hidden md:gap-4"
    :style="{ height: `${pageHeight}px` }"
  >
    <!-- 移动端单行头部：约 44px 高，把 80%+ 的屏幕留给画布（md 以下） -->
    <MobileLineHeader
      v-if="currentLineDetail"
      :detail="currentLineDetail"
      :live-status="currentLiveStatus"
      :can-switch-direction="canSwitchDirection"
      :accent="badgeAccent"
      @switch-direction="toggleDirectionQuick"
      @show-info="showLineInfo = true"
    />

    <!-- 桌面端顶部操作栏（md 及以上） -->
    <DesktopActionBar
      :can-switch-direction="canSwitchDirection"
      :direction-options="directionOptions"
      :is-active-tab="isActiveTab"
      :active-purpose="activePurpose"
      @switch-direction="switchDirection"
    />

    <!-- 桌面端线路横幅（md 及以上） -->
    <LineHero
      v-if="currentLineDetail"
      :detail="currentLineDetail"
      :live-status="currentLiveStatus"
      :accent="badgeAccent"
    />

    <!-- 加载/失败的诚实状态 -->
    <LineLoadState v-if="!currentLineDetail" :is-loading="isLoading" :failure="loadFailure" />

    <!-- 2D Konva 报站板视口（全宽、零遮挡、自适应锚点弹窗） -->
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
        :shown-direction="favoriteDirection"
        :morning-stop-name="matchingFavorite?.morningStopName ?? null"
        :morning-stop-order="matchingFavorite?.morningStopOrder ?? null"
        :morning-stop-direction="morningStopDirection"
        :evening-stop-name="matchingFavorite?.eveningStopName ?? null"
        :evening-stop-order="matchingFavorite?.eveningStopOrder ?? null"
        :evening-stop-direction="eveningStopDirection"
        @select-station="onSelectStation"
        @close-station="onCloseStationPopover"
        @station-anchor-change="onStationAnchorChange"
      />

      <!-- 最近站锚点弹窗（Reka UI，自动翻转、平移与零裁切箭头） -->
      <StationPopover
        :station="selectedStation"
        :anchor="stationAnchor"
        :arrivals="stationArrivals"
        :walk-decision="walkDecision"
        :has-user-coords="Boolean(locationStore.userCoords)"
        :gis-loading="gisLoading"
        :eta="selectedStationEta.text"
        :eta-mark="selectedStationEta.mark"
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

  <!-- 移动端线路信息抽屉：点线路徽标或信息芯片触发的底部面板（Reka UI 对话框） -->
  <DialogRoot v-model:open="showLineInfo">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity duration-200 data-[state=open]:opacity-100 data-[state=closed]:opacity-0 md:hidden" />
      <DialogContent
        v-if="currentLineDetail"
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col space-y-4 overflow-y-auto rounded-t-3xl border-t border-slate-700 bg-slate-900 px-5 pt-5 pb-safe-offset-5 shadow-2xl focus:outline-none transition-transform duration-250 ease-out data-[state=open]:translate-y-0 data-[state=closed]:translate-y-full md:hidden"
      >
        <!-- 头部 -->
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

        <!-- 参数网格 -->
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
            <span class="block text-xs text-slate-400">数据类型</span>
            <span class="font-mono text-xs font-semibold text-cyan-400">
              {{ lineDataMark ?? '暂无数据' }}
            </span>
          </div>
        </div>

        <!-- 抽屉里的方向切换 -->
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

        <!-- 图例参考 -->
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

        <!-- F11：本页唯一的刷新入口。它经拥有冷却期的那个请求索要，故此处一次按下与首页一次按下
             共用同一个窗口；它报告该请求的答案：拒绝剩下的等待、失败，以及所取得读取的时刻。 -->
        <div class="pt-1">
          <button
            class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 py-3 text-xs font-semibold text-cyan-400 transition active:scale-95 disabled:opacity-60 lg:gap-2.5 lg:py-3.5 lg:text-base"
            :disabled="refreshing"
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
          <!-- 读取自己的时刻，以及它是哪种值。从未取得的读取不报任何时间。 -->
          <p id="refresh-freshness" class="mt-2 text-xs text-slate-400 lg:text-base">
            {{ refreshFreshness.text }}
          </p>
          <!-- 状态行。只有粗粒度状态坐在 live region 里：秒数渲染在它旁边，因为 live region 里的
               倒计时会按秒排队播报。region 在没有话可说时就渲染——与第一个词一同创建的 region 在某些
               屏幕阅读器上根本不播报。两个 span 紧挨着，故这一行读起来仍像一个元素。 -->
          <p
            id="refresh-status"
            class="text-xs lg:text-base"
            :class="[refreshStatusClass, refreshStatus ? 'mt-1' : '']"
          >
            <span role="status" aria-live="polite">{{ refreshStatus?.announcement }}</span><span>{{ refreshStatus?.detail }}</span>
          </p>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
