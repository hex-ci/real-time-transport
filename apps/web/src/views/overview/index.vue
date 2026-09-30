<script setup lang="ts">
import { computed, nextTick, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { House, LocateFixed, Building2, Wand2, TriangleAlert } from '@lucide/vue'
import { useIntervalFn } from '@vueuse/core'
import {
  useTransitStore,
} from '@/stores/transit.store'
import { useLocationStore } from '@/stores/location.store'
import { useCityStore } from '@/stores/city.store'
import { commutePurposeOf } from '@/commute-purpose'
import { RefreshControl } from '@/components/refresh-control'
import { CardGrid, EmptyState } from './components'
import { commuteLegStateOf, commuteStopOf } from './commute-leg'
import { nearbyLocationStateOf } from './nearby-notice'
import type { NearbyLocationState } from './nearby-notice'
import type { ArrivalsFeed, ArrivalsRead, CardRow, MiniCardConfig, OverviewMode } from './types'
import type { LineDetail, RefreshLiveTarget, UserFavoriteLine } from '@real-time-transport/shared'
import {
  effectiveCommuteDirection,
  favoriteDirections,
  favoriteIsBidirectional,
  resolveBoardStopRef,
  resolveFavoriteLineId,
  resolveNearbyStop,
} from '@real-time-transport/shared/line-group'
import type { ReadState } from '@/read-state'
import { runWithFeedback } from '@/action-feedback'

const transitStore = useTransitStore()
const locationStore = useLocationStore()
const cityStore = useCityStore()

const { commuteProfile, favorites } = storeToRefs(transitStore)

/** 到站数据每 10 秒重读一次；本页不渲染当前时刻，也不渲染上一次读数取到的时刻。 */
useIntervalFn(refreshAllArrivals, 10000)

/** 首页标签显示哪个视图。「nearby」由 GPS 驱动，另外两个走推导出的方向。 */

/** 通勤卡片上跟在下一班车之后的后续到站条数。 */
const SUBSEQUENT_ARRIVALS_COUNT = 2

/**
 * 一次手动模式选择，只记在它被做出来的那个通勤时段里。
 *
 * 默认是完全自动的：没有覆盖时，模式跟随配置的通勤时段，用户不必自己选方向。手动选择在它自己
 * 的时段内胜出（于是刻意做出的选择被尊重），一旦时段变了就失效 —— 早上 08:00 出门上班不会永远
 * 把晚高峰视图钉住。
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
    // 旧格式或外来值：当作没有覆盖，而不是去猜。
  }
  return null
}

const modeOverride = shallowRef(readOverride())

/**
 * 档案当前报告的通勤时段；一次手动选择的作用域就是它。
 *
 * `auto` 是档案不在任何已存窗口内时两种情形共同的诚实时段：在窗口之外，以及根本没有存过窗口。
 * 后者与前者的区别由 `windowState` 在下面的标签里承载 —— 时段本身不能说谎。
 */
const currentSlot = computed(() => commuteProfile.value?.mode ?? 'auto')

/**
 * 自动选择：通勤时段蕴含的目的决定，没有可跟随的时段（此刻在时段之外、或根本没有时段）时进附近视图。
 * 判定本身不在这里 —— 它与链路页读的是同一个函数，故两页对同一份 profile 不会得出两个目的。
 */
const autoMode = computed<OverviewMode>(() => commutePurposeOf(commuteProfile.value) ?? 'nearby')

/**
 * 档案读到的窗口是否是用户真的存过的。
 *
 * 从未保存过通勤时间的用户是「未设置」，不是「非通勤」：后者说本机时钟在两个已配置窗口之外，
 * 而这里根本没有窗口可在外。这是关于 store 的两个事实 —— `unset`（没有行）与 `unchosen`（有行
 * 但四个时间从未选过）—— 两者都意味着没有窗口可在内。这个区分随 payload 传递（`windowState`），
 * 因为在这里两个事实字节级相同。
 */
const commuteWindowUnset = computed(() => {
  const state = commuteProfile.value?.windowState
  return state === 'unset' || state === 'unchosen'
})

const isManual = computed(() => modeOverride.value?.slot === currentSlot.value)

const currentMode = computed<OverviewMode>(() =>
  isManual.value && modeOverride.value ? modeOverride.value.mode : autoMode.value)

/**
 * 自动规则解析出的东西的人话标签，显示在自动按钮上。
 *
 * 「当前非通勤时段」是在说本机时钟落在两个已配置窗口之外，故只有**读到过**窗口的 profile 才配说它：
 * 一份没答上来的 profile（`commuteProfile` 仍为 null）与一份没设过窗口的 profile 都不许为一个不存在
 * 或被没人看过的窗口记功。
 */
const autoModeLabel = computed(() => (
  commuteWindowUnset.value
    ? '未设置通勤时段'
    : commuteProfile.value === null
      ? '未读到通勤时段'
      : autoMode.value === 'morning' ? '上班' : autoMode.value === 'evening' ? '下班' : '当前非通勤时段'
))

function setMode(mode: OverviewMode): void {
  modeOverride.value = { mode, slot: currentSlot.value }
  localStorage.setItem(MODE_STORAGE_KEY, JSON.stringify(modeOverride.value))
}

/** 丢掉手动选择，把控制权交回通勤时段。 */
function useAutoMode(): void {
  modeOverride.value = null
  localStorage.removeItem(MODE_STORAGE_KEY)
}

/**
 * 附近视图里逐线路的手动方向选择，按关注行 id 记。
 *
 * 与模式覆盖一样限定在通勤时段内：早上站在一侧路缘做出的选择，不应该无声地决定晚高峰视图 ——
 * 那是反方向的另一段行程。
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
    // 旧格式或外来值：当作没有覆盖，而不是去猜。
    return {}
  }
}

const directionOverrides = shallowRef(readDirectionOverrides())

/** 在卡片上把一个方向提上来；这个选择在通勤时段改变前一直有效。 */
function setPrimaryDirection(favoriteId: string, direction: 0 | 1): void {
  directionOverrides.value = {
    ...directionOverrides.value,
    [favoriteId]: { direction, slot: currentSlot.value },
  }
  localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(directionOverrides.value))
}

/** 卡片要求改用另一个方向领起。 */
function onSwitchDirection(card: MiniCardConfig, direction: 0 | 1): void {
  if (!card.favoriteId) return
  setPrimaryDirection(card.favoriteId, direction)
}

/** 上一次置顶写入失败的原因，显示在网格上方。 */
const pinError = shallowRef<string | null>(null)

/**
 * 置顶写入仍在途的那个关注。
 *
 * 点按瞬间卡片已经动过了（store 乐观写入），所以没有这个的话，第二次点按会读到已经翻转的状态
 * 并发出反向请求。
 */
const pinningFavoriteId = shallowRef<string | null>(null)

/**
 * 一次置顶/取消置顶里正在动的那一条关注，供卡片网格的位移动画点名。
 *
 * 它比在途标记多活一拍：写入失败时 store 会把列表回滚回去，那次回滚的重排也要被画成动画，
 * 而回滚发生在请求落地之后 —— 立刻清掉的话，卡片会「自己跳回去」，正是要避免的那件事。
 */
const pinMotionTargetId = shallowRef<string | null>(null)

/**
 * 钉住或取消钉住一条关注线路 —— 总览自己的动作，也是这个状态唯一存在的地方：入口、标记与取消
 * 都在首页卡片上。
 *
 * 写入失败已经由 store 回滚，所以原因在这里浮出来，而不是让卡片无声地停在原处。
 */
async function onTogglePin(card: MiniCardConfig): Promise<void> {
  const favoriteId = card.favoriteId
  if (!favoriteId || pinningFavoriteId.value === favoriteId) return
  pinError.value = null
  pinningFavoriteId.value = favoriteId
  // 与 store 的乐观写入落在同一个 tick，于是列表的重排与这个点名同批渲染 —— 动画因此拿得到
  // 「重排前」的坐标。
  pinMotionTargetId.value = favoriteId
  try {
    await runWithFeedback(
      // 卡片上此刻是不是钉住的，决定这次按下是钉还是解 —— 与那枚按钮自己的措辞同源。
      card.isPinned ? 'favorite-unpin' : 'favorite-pin',
      () => transitStore.togglePin(favoriteId),
      { name: card.lineName },
    )
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '置顶设置失败'
  }
  finally {
    pinningFavoriteId.value = null
    // 多留一拍：回滚引起的那次重排也在这一拍里画完，再撤掉点名。
    await nextTick()
    pinMotionTargetId.value = null
  }
}

/** 缓存的线路详情，键为 lineId_direction（用于站数与本行目标顺序）。 */
const detailCache = shallowRef<Record<string, LineDetail>>({})

/**
 * 关注线路那次读取处在三种状态中的哪一种。
 *
 * 下面的卡片由 `favorites` 构建，而一次「失败」的读取留下的是空数组 —— 所以光看长度分不出空
 * 状态是因为读失败，还是没人读过这个列表。store 报告那个答案（`fetchFavorites()`），这个页面
 * 陈述它：只有读取真的答了，「还没有关注线路」才是真的。
 */
const favouritesRead = shallowRef<ReadState>('reading')

const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

/** 至少有一个关注支持切换 -> 显示全局开关。 */
const canSwitchAny = computed(() => cityFavorites.value.some(f => favoriteIsBidirectional(f)))

/**
 * 一个关注的某一段通勤乘坐的方向，按用户选择的方式。
 *
 * 从未选过时为 null —— 卡片那时显示一个显式的「设置方向」状态。刻意不回退到
 * `preferredDirection`：那个字段锚定的是哪条线路 id 是方向 0，把它当成通勤方向会显示一条
 * 用户从未选过的线路。
 */
function directionFor(f: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return effectiveCommuteDirection(f, purpose)
}

/** 一个关注两个方向的详情，按它自己的方向号索引。 */
function detailsOf(f: UserFavoriteLine): { 0: LineDetail | undefined, 1: LineDetail | undefined } {
  const primary = (f.preferredDirection === 1 ? 1 : 0) as 0 | 1
  const other = (1 - primary) as 0 | 1
  return {
    [primary]: detailCache.value[`${f.lineId}_${primary}`],
    [other]: f.reverseLineId ? detailCache.value[`${f.reverseLineId}_${other}`] : undefined,
  } as { 0: LineDetail | undefined, 1: LineDetail | undefined }
}

/**
 * 用户站着的那个站台，按方向分别解析。
 *
 * 两个方向从马路对侧停靠同一个同名站，所以共用的站名锚定卡片，而每个方向贡献它自己的站序。
 * 一个方向没有这个站时报出 null 站序并且干脆没有行 —— 绝不是另一个方向的时刻。
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
 * 应用是否有位置，按位置 store 报告的状态。
 *
 * 由 store「自己」的那几项读取推出 —— 定位、在途的请求、失败的请求 —— 而不是模板里的第二次
 * 猜测。附近卡片的空状态有两种成因（根本没有定位，或定位来了但解析不出任何站），卡片收到这个
 * 状态，好把每种说成它本来的样子。
 */
const nearbyLocation = computed<NearbyLocationState>(() => nearbyLocationStateOf({
  hasFix: locationStore.userCoords !== null,
  requesting: locationStore.isLocating,
  failed: locationStore.locationError !== null,
  supported: locationStore.isSupported,
}))

/**
 * 附近卡片上哪个方向领起。
 *
 * 优先顺序：
 *   1. 这条线路的手动选择，且在有效期内；
 *   2. 当前时段所属的那一段通勤 —— 出门上班用早上的上车点方向，回家用晚上的；
 *   3. 方向 0。
 *
 * 刻意绝不用到站时间。两个方向停靠对侧路缘，所以马路对面恰好更近的一班车不能接管头条 ——
 * 那会让那个大号的预计到站每次刷新都指另一段行程。
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

  // 用户为这个时段声明的方向，在那个站台存在时胜出；在通勤时段之外他们没有表达过偏好。
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
 * 每条关注的「线路」一张卡片。
 *
 * 通勤模式读用户为该时段选的方向，给出一行。附近模式锚定定位到的站台，为每个真的停靠那里的
 * 方向给出一行。
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
        if (order === null) continue // 这个方向在这里没有站台
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
        detailHref: detailHrefOf(rows[0]?.lineId ?? f.lineId, rows[0]?.direction ?? 0),
        favoriteId: f.id ?? null,
      })
      continue
    }

    const purpose = mode
    const direction = directionFor(f, purpose)
    // 用户为这一段存下的那个站，以它本来的身份：站名「与」站序（`resolveBoardStopRef`）。所选
    // 方向是否停靠那里 —— 以及它是两个同名站中的「哪一个」 —— 都从这一对读出，绝不只看站名。
    const boardStop = resolveBoardStopRef(f, purpose)
    // 还没选方向：让卡片带着它诚实的空状态渲染，而不是退回到方向 0 —— 那会显示一条用户从没
    // 说过他乘坐的线路。
    if (direction === null) {
      // 这一段什么都没配置，所以没有行可以读出目标。线路本身仍看得见，所以指向关注行自己的主
      // 线路 id —— `preferredDirection` 所描述的那个锚点。
      cards.push({
        lineName: f.lineName,
        directionName: '',
        stopName: null,
        stopDistanceMeters: null,
        detailLoaded: Boolean(anyDetail),
        isSubway,
        isPinned: f.isPinned,
        rows: [],
        legState: commuteLegStateOf({ direction: null, stop: boardStop, stops: undefined }),
        primaryDirection: null,
        detailHref: detailHrefOf(f.lineId, (f.preferredDirection === 1 ? 1 : 0) as 0 | 1),
        favoriteId: f.id ?? null,
      })
      continue
    }

    const detail = both[direction]
    // 这张卡片所关于的那个实体站，或存储的站在这个方向里定位不到时为 null（站名有歧义，或存的
    // 站序列表里已经没有）。这里用 `find(name)` 会取第一个同名站，于是卡片的步行时间、到站分钟
    // 与出发结论都是为一个用户没有选的站台算出来的。
    const stop = commuteStopOf(f, purpose, detail?.stops)
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
      legState: commuteLegStateOf({ direction, stop: boardStop, stops: detail?.stops }),
      // 通勤卡片只有一行，所以领起的就是那一行，无论如何。
      primaryDirection: null,
      // 方向在这里是选了的，但上车点可能未设：回退到该方向自己的 lineId，使卡片两种情况都点得动。
      detailHref: detailHrefOf(resolveFavoriteLineId(f, direction) ?? detail?.lineId ?? f.lineId, direction),
      favoriteId: f.id ?? null,
    })
  }
  return cards
})

/**
 * 为当前城市的所有关注（两个方向）加载静态线路详情，客户端缓存。必须遍历 cityFavorites 而不是
 * cardsData，否则缓存永远不会被填充，卡片也永远不会出现。
 *
 * 每个方向解析到它「自己」的线路 id：公交线路每个方向一个 id（reverseLineId），地铁两个方向
 * 共用一个。
 */
async function ensureDetails(): Promise<void> {
  const nextCache = { ...detailCache.value }
  let hasNew = false
  const tasks: Array<Promise<void>> = []

  for (const f of cityFavorites.value) {
    // 线路实际拥有的每个方向，以及服务它的 lineId。单方向线路只产出一个条目，于是不会去取一条
    // 数据源根本没有的反向段。
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
          // 保持未缓存：卡片会显示诚实的加载中 / 不可用状态。
        }
      })())
    }
  }
  await Promise.allSettled(tasks)
  if (hasNew) {
    detailCache.value = nextCache
  }
}

/** 每张卡片键上的到站 feed：lineId_direction -> 那一行的到站数据，带着它读取的状态。 */
type StationArrivalsFeed = ArrivalsFeed
const arrivalsMap = shallowRef<Record<string, ArrivalsRead>>({})

function arrivalsKey(lineId: string, direction: number): string {
  return `${lineId}_${direction}`
}

/**
 * 通过站点到站端点，为每张卡片的每一行取真实预计到站（服务端过滤已过的车，并遵守 -1 哨兵）。
 *
 * 每一行携带它「自己」对显示站的站序，所以把该站编号编得不同的方向仍查询它自己的时刻表 ——
 * 借用另一个方向的站序会无声地返回另一个站的数据，因为服务端先按站序匹配。
 */
async function refreshAllArrivals(): Promise<void> {
  const nextMap: Record<string, ArrivalsRead> = {}

  const tasks = cardsData.value.flatMap(async (card) => {
    if (!card.stopName) return
    for (const row of card.rows) {
      const key = arrivalsKey(row.lineId, row.direction)
      // 没有站台就没有要问的东西：这一行不会有请求，因此也没有读取可报（`cardsData` 同样只生成
      // 有站序的行 —— 两处都以「有站台」为前提）。
      if (row.stopOrder === null) continue
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
        // 答了才是读数，没有 data 的应答与异常一样是「没答上来」；两种都记下来，让卡片各自说自己的
        // 那句话。先前这里把失败写成 null，卡片就无法把它与「读了、确实没有车」分开。
        nextMap[key] = json.success && json.data
          ? { state: 'read', value: json.data as StationArrivalsFeed }
          : { state: 'unreadable' }
      }
      catch {
        nextMap[key] = { state: 'unreadable' }
      }
    }
  })

  await Promise.allSettled(tasks)
  arrivalsMap.value = nextMap
}

/**
 * 卡片主体作为链接指向的线路详情地址。
 *
 * 一条线路的详情地址由「线路 id + 方向 + 城市」三件事决定，而它们都在这里定：线路 id 与方向
 * 来自卡片自己那一段通勤（没配好时回退到关注行的锚点），城市取当下选中的那个。
 */
function detailHrefOf(lineId: string, direction: 0 | 1): string {
  const qs = new URLSearchParams({
    direction: String(direction),
    cityCode: cityStore.currentCode,
  })
  return `/line/${encodeURIComponent(lineId)}?${qs.toString()}`
}

/**
 * F11 在本屏的入口：卡片正在读的每一条线路，按卡片显示的顺序，去掉重复的那条 —— 一条线路读两次
 * 就是一次读数，要两次会在一次按压里花掉两次读取。
 *
 * 端点只读它被点名的东西，所以显示卡片的界面就是点名它们的那个；屏幕上没有行的线路（没有上车
 * 点、这里没有站台）不被点名，因为没有东西在读它。
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
 * 刷新图标按钮的可访问名。它是图标按钮，没有可见文字，故那个词由本页给出 —— 一次，
 * 不随状态变。
 */
const REFRESH_LABEL = '刷新最新车况'

/**
 * 一次按压的全程都为真：花掉窗口的那个请求，以及显示它取到了什么的卡片重读。落在两者之间的
 * 一次按压会在第一个刚花掉的窗口里再问服务端一次，并因此被拒。
 */
const refreshing = shallowRef(false)

/**
 * 交给共用控件的那几样。一次按下的结局由全局提示承载，故这里没有读数那一半。
 *
 * 同一页有两处入口（桌面那一份、移动端那一份），故这份值只有一处 —— 两份入口说的是同一件事。
 */
const refreshControl = computed(() => ({
  refreshing: refreshing.value,
  /**
   * 页面自己的禁用条件：屏幕上没有可重读的线路。
   *
   * 窗口还关着**不**禁用：那时按下要走完一次请求，由 store 报出「刷新太频繁 · N 秒后可刷新」——
   * 把一个按不动的按钮摆在用户面前，等于把「为什么按不动」也一起藏起来。
   */
  disabled: refreshTargets.value.length === 0,
  label: REFRESH_LABEL,
}))

/**
 * 按下：通过共享请求要一次重读，然后重读卡片，使它们显示那个请求取到的东西。
 *
 * 只有取到读数的刷新才重读它们：一次拒绝或失败什么都没带，那时重读只会再问一遍屏幕上已有的值。
 */
async function onRefresh(): Promise<void> {
  refreshing.value = true
  try {
    const outcome = await transitStore.refreshLive(refreshTargets.value)
    if (outcome === 'ok') await refreshAllArrivals()
  }
  finally {
    refreshing.value = false
  }
}

/**
 * 为当前城市重新加载一切：关注线路、静态详情、到站数据。
 *
 * 第一次读取的「答案」也被记下来：下面的一切都由它返回的列表推出，所以一次失败的读取必须被
 * 陈述，而不是看起来像一个什么都没关注的城市。
 */
async function reloadForCurrentCity(): Promise<void> {
  favouritesRead.value = (await transitStore.fetchFavorites()) ? 'read' : 'unreadable'
  await ensureDetails()
  await refreshAllArrivals()
}

// 城市变了 -> 丢掉缓存并为新城市重新加载
watch(
  () => cityStore.currentCode,
  () => {
    detailCache.value = {}
    arrivalsMap.value = {}
    void reloadForCurrentCity()
  },
)

// 模式变了 -> 为新显示的方向刷新到站数据
watch(
  () => currentMode.value,
  () => {
    void refreshAllArrivals()
  },
)

// 附近模式下到来的定位会填充最近站锚点
watch(
  () => locationStore.userCoords,
  (coords) => {
    if (coords && currentMode.value === 'nearby') void refreshAllArrivals()
  },
)

// 关注变了（在设置里增删）-> 为新线路预取详情
watch(
  () => cityFavorites.value.map(f => `${f.lineId}_${f.cityCode}`).join('|'),
  async () => {
    await ensureDetails()
    await refreshAllArrivals()
  },
)

onMounted(() => {
  void cityStore.fetchCities()
  transitStore.fetchCommuteProfile()
  void reloadForCurrentCity()
  locationStore.requestLocation()
})
</script>

<template>
  <div class="space-y-2.5 sm:space-y-5 pb-12">
    <!-- 信息区两块互斥：窄屏那一块在文档里靠前（e2e 量高度的就是页面的第一块），宽屏那一块在后。
         两块各自持有自己那一档的排布，没有一处靠断点前缀替另一档拼行。 -->
    <!-- 窄屏（<768）：一行 —— 模式容器吃满余量、定位与刷新贴在它后面。分段项不带图标（带图标时
         这一行在 375 装不下），故一行放得下；装不下时换行，而不是把某一项压到它的字以下。 -->
    <div
      data-info-area="narrow"
      class="md:hidden relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 px-2.5 py-2 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5"
    >
      <div
        data-toolbar="narrow"
        class="flex min-w-0 flex-wrap items-center gap-2"
      >
        <!-- 模式切换（自动/上班/下班/附近）。 -->
        <div
          v-if="canSwitchAny"
          class="flex h-11 min-w-max-content flex-1 items-center gap-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-800/80 p-0 shadow-sm"
        >
          <!-- 自动：把控制权交回配置的通勤时段。用户没有为当前时段钉住模式时它处于选中态。 -->
          <button
            class="flex h-11 min-w-max-content flex-1 items-center justify-center rounded-lg px-2 text-xs font-medium whitespace-nowrap transition"
            :class="!isManual ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            :title="`自动：按通勤时段判断（当前 ${autoModeLabel}）`"
            @click="useAutoMode"
          >
            <span>自动</span>
          </button>
          <button
            class="flex h-11 min-w-max-content flex-1 items-center justify-center rounded-lg px-2 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'morning' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('morning')"
          >
            <span>上班</span>
          </button>
          <button
            class="flex h-11 min-w-max-content flex-1 items-center justify-center rounded-lg px-2 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'evening' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('evening')"
          >
            <span>下班</span>
          </button>
          <button
            class="flex h-11 min-w-max-content flex-1 items-center justify-center rounded-lg px-2 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'nearby' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('nearby')"
          >
            <span>附近</span>
          </button>
        </div>

        <!-- 从未存过通勤时段的用户：只说这一句，且它不是可点之物。存过即无。 -->
        <p
          v-if="commuteWindowUnset"
          class="shrink-0 text-xs font-medium text-amber-400"
        >
          ⚠ 未设置通勤时段
        </p>

        <button
          type="button"
          aria-label="定位最近站"
          class="ms-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 shadow-sm transition hover:bg-cyan-500/20 active:scale-95"
          @click="locationStore.requestLocation({ userInitiated: true })"
        >
          <LocateFixed class="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>

        <!-- F11：首页的刷新入口，与另两页共用同一个控件、同一个 store 动作、同一个冷却端点，
             而结局由全局提示说。本页没有读数那一半，故按钮不描述任何东西。 -->
        <RefreshControl
          v-bind="refreshControl"
          variant="button"
          :has-reading="false"
          class="shrink-0"
          @refresh="onRefresh"
        />
      </div>
    </div>

    <!-- 宽屏（≥768）：一行 —— 模式与提示在左，定位与刷新两枚图标按钮贴着卡片右内边。 -->
    <div
      data-info-area="wide"
      class="hidden md:block relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 p-3.5 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5 md:p-6"
    >
      <div
        data-toolbar="wide"
        class="flex min-w-0 items-center gap-3"
      >
        <div
          v-if="canSwitchAny"
          class="flex h-11 shrink-0 items-center gap-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-800/80 p-0 shadow-sm"
        >
          <button
            class="flex h-11 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition"
            :class="!isManual ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            :title="`自动：按通勤时段判断（当前 ${autoModeLabel}）`"
            @click="useAutoMode"
          >
            <Wand2 class="h-3.5 w-3.5 shrink-0" />
            <span>自动</span>
          </button>
          <button
            class="flex h-11 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'morning' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('morning')"
          >
            <House class="h-3.5 w-3.5 shrink-0" />
            <span>上班</span>
          </button>
          <button
            class="flex h-11 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'evening' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('evening')"
          >
            <Building2 class="h-3.5 w-3.5 shrink-0" />
            <span>下班</span>
          </button>
          <button
            class="flex h-11 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition"
            :class="currentMode === 'nearby' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-300 hover:text-slate-100'"
            @click="setMode('nearby')"
          >
            <LocateFixed class="h-3.5 w-3.5 shrink-0" />
            <span>附近</span>
          </button>
        </div>

        <!-- 从未存过通勤时段的用户：只说这一句，且它不是可点之物。存过即无。 -->
        <p
          v-if="commuteWindowUnset"
          class="shrink-0 text-xs font-medium text-amber-400"
        >
          ⚠ 未设置通勤时段
        </p>

        <button
          type="button"
          aria-label="定位最近站"
          class="ms-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 shadow-sm transition hover:bg-cyan-500/20 active:scale-95"
          @click="locationStore.requestLocation({ userInitiated: true })"
        >
          <LocateFixed class="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>

        <!-- 两枚动作停在行尾：`ms-auto` 把行里剩下的余量全部落在它们前面。本页没有读数那一半，
             故按钮不描述任何东西。 -->
        <RefreshControl
          v-bind="refreshControl"
          variant="button"
          :has-reading="false"
          class="shrink-0"
          @refresh="onRefresh"
        />
      </div>
    </div>

    <!-- 一次失败的置顶写入：store 已经把卡片回滚了，所以原因就是唯一剩下要说的话。
         role="alert" 把它作为状态消息播报，而不是让它等着被注意到。 -->
    <p
      v-if="pinError"
      role="alert"
      class="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400 lg:gap-2 lg:text-base"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ pinError }}</span>
    </p>

    <!-- 卡片网格：流式响应网格，手机 1 列到超宽 4 列。间距跟随页面节奏（space-y），使卡片之间
         与导航到主区之间一致。 -->
    <CardGrid
      v-if="cardsData.length > 0"
      :cards="cardsData"
      :mode="currentMode"
      :arrivals="arrivalsMap"
      :nearby-location="nearbyLocation"
      :motion-target-id="pinMotionTargetId"
      @switch-direction="onSwitchDirection"
      @toggle-pin="onTogglePin"
    />

    <!-- 空状态。「哪一种空」来自读取自己的状态：读不到的列表被陈述为读不到并给出重试，只有答了
         且为空的列表才被措辞成「还没有关注线路」。 -->
    <EmptyState
      v-else
      :city-name="cityStore.currentCityName"
      :state="favouritesRead"
      @retry="reloadForCurrentCity"
    />
  </div>
</template>
