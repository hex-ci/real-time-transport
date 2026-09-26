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
 * 报告板的加载体：只在屏上没有东西可留时显示。
 *
 * 只在屏空时移动：首屏加载、切换站台，或一次什么都没留下的关注线路重载。
 */
const boardLoading = shallowRef(false)
const detecting = shallowRef(false)
/**
 * 报告板的刷新控件正在读取。与加载体不同，它示意更新正运行在留在屏上的行**之上**：
 * 同一事实的非破坏性一半，故忙时的措辞用刷新家族自己的，且占用期间控件禁用。
 */
const boardBusy = shallowRef(false)
/** 已请求定位，正在等第一次 GPS 定位结果到达。 */
const awaitingFix = shallowRef(false)
const departureItems = shallowRef<DepartureItem[]>([])

/**
 * 屏上这些行是为哪个站台构造的。
 *
 * 一行声称它是关于某个站台的，故站台是这些行所断言的一部分；把这一半留在行旁边，
 * 一次变更就能在加载开始时立即被判断，而不必等响应式刷新轮上。
 */
const rowsStation = shallowRef('')

/**
 * 报告板自己的这次加载：屏上这些行由哪次读取产出。
 *
 * 时刻取自响应自己的 `updatedAt`——服务端在实时缓存条目存活期间原样重放该对象，
 * 故晚到的响应不会重新打时间戳；而请求时刻的钟正是本字段绝不能变成的东西：
 * 那样一个没人作答的请求就会被读成一次读数。
 *
 * 清空与写入同样刻意。行随切站台离开（它们是为另一个站台构造的，绝不该在新站台下存活），
 * 时刻随之离开：没有行的戳是更好看的谎。
 */
const rowsReadAt = shallowRef<number | null>(null)

/**
 * 关注线路读取处于三种状态中的哪一种。
 *
 * 本页每个站台选项都来自关注线路，故读失败会让屏上空无一物；而空屏与读不到的列表
 * 会就用户已存的数据说同一句话。由 store 报告答案，本页陈述它，空状态措辞交给报告板。
 */
const favouritesRead = shallowRef<ReadState>('reading')

/** 当前城市所有已关注线路的线路详情（两个方向按需解析）。 */
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
    // 只为线路真正拥有的方向加载，且用它自己的 lineId：公交线路每个方向
    // 各有一个 lineId，故反向段的站点根本无法通过 f.lineId 取到。单方向
    // 线路贡献一条记录——绝不产生指向同一 lineId 的幻影第二方向。
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
      }
    }
  })
  await Promise.allSettled(tasks)
}

/**
 * 构造站台选项：按有多少已关注线路经过给站排序，
 * 使靠前的选项是真正的多线枢纽。
 */
function buildStationOptions(): void {
  const counter = new Map<string, number>()
  for (const f of cityFavorites.value) {
    // 只用主方向：按有多少已关注线路在此停靠给枢纽排序。
    // `favoriteDirections` 先返回主方向，故无需方向算术。
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

/** 经过所选站台的所有（线路，方向，站序）规则。 */
function buildRulesForStation(stationName: string): PlatformLineRule[] {
  const rules: PlatformLineRule[] = []
  for (const f of cityFavorites.value) {
    // 这条线路真正拥有的每个方向——每个方向一行，
    // 单方向线路恰好贡献一行。
    for (const { direction: dir, lineId } of favoriteDirections(f)) {
      const detail = lineDetails.value[detailKey(lineId, dir)]
      if (!detail) continue
      const stop = detail.stops.find(s => s.name === stationName)
      if (!stop) continue

      // 运营事实取自刚构造出本规则的详情，故陈述的是线路自己的首末班而非时钟。
      // 规则每次轮询都重建，故运营日跨零点能自动跟上，
      // 无需第二次请求。
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
 * 报告板的一次完整读取，无论由什么触发（12 秒轮询、站台选择器、GPS 对准、重试）。
 *
 * 破坏性刷新问题由「每个状态何时移动」解决，而非靠多画什么：刷新期间屏上的行继续渲染，
 * 只有刷新控件示意更新在跑；加载体只在没有东西可留时出现；行的时刻只由产出屏上这些行的
 * 那个响应写入。
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

  // 空屏没有东西可留：显示加载体。有行的屏保留它们（保留契约）并在控件上示意更新——
  // 但只保留为本站台构造的行。选择器的 change 处理与 v-model 写入不是同一个同步步骤，
  // 故这里的行仍可能是旧站台的；
  // 它们不是本站台的答案，不该被保留。
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
   * 每个**响应**报告为自身读数时刻的瞬时值（数据源的 `updatedAt`，实时缓存条目存活期间
   * 由服务端原样重放）。以答案产出的行 id 为键，故失败的请求不贡献任何东西，
   * 下面取到的是已作答的行。
   */
  const stamps = new Map<string, number>()

  const promises = rules.map(async (rule, idx) => {
    const id = `dep_${rule.lineId}_${rule.direction}_${idx}`
    try {
      // 本行所关于的站必须随请求一起走：数据源按所请求的站序定价车辆，否则按线路终点，
      // 故不带站序的读数把每辆车的分钟都算到线路**末端**——这正是本列曾经一个分钟
      // 都说不出来的原因（见 `departure-row.ts`）。
      // `order` 是本站台在**本**方向上的站序。
      const qs = new URLSearchParams({
        direction: String(rule.direction),
        cityCode: cityStore.currentCode,
        order: String(rule.stationOrder),
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(rule.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      const buses: LiveBus[] = (json.success && json.data?.buses) ? json.data.buses : []
      /**
       * 本响应声明的来源。行的类别由构造器据此决定——本视图绝不从线路类型猜，
       * 本版本不认识的来源使其行不归类。
       */
      const dataSource = (json.success && json.data) ? json.data.dataSource : null
      // 读数自己的时刻，照响应陈述的原样——记录这些行是何时读到的，
      // 若响应体未携带时刻则什么都没有。
      const updatedAt = (json.success && json.data) ? json.data.updatedAt : null
      if (typeof updatedAt === 'number') stamps.set(id, updatedAt)

      results.push(departureRowOf({ id, rule, answer: { dataSource, buses } }))
    }
    catch {
      // 请求失败：车辆与运营日都未知。
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

  // 屏上这些行的读取时刻来自响应本身，且只在至少有一个答案到达时写入：
  // 全部失败的结果保留上一次读取的时刻，因为它产出的行仍是屏上的行
  // （失败的行逐行陈述自己的失败）。
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
 * GPS 雷达：找出最近的真实站台（地图 POI），把报告板对准关注线路中匹配的站名。
 */
async function detectNearbyPlatform(): Promise<void> {
  const coords = locationStore.userCoords
  if (!coords) {
    // 开始跟踪并在定位结果到达后让 coords 侦听器重跑本函数，
    // 而不是睡一个猜出来的间隔、指望它及时到达。
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

    // 去掉 POI 名称里的「(公交站)」这类后缀，再与已知站名比对
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
    // 只在地图陈述了距离时渲染它：它对该 POI 缺失，
    // 而补一个 0 会被读成「你就站在站台上」。
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
  // loadLineDetails 已经拉取了**两个**方向，各用它自己的 lineId，
  // 故此处再来一遍只会重复请求正向线路。
  await loadLineDetails()
  buildStationOptions()
  await loadPlatformDepartures()
}

/**
 * 为当前城市重载一切：先关注线路，再报告板。
 *
 * 第一次读取的**答案**与其结果一同记录：下面每个站台选项都派生自它返回的列表，
 * 故读失败必须被陈述，而不能看起来像一个什么都没关注的城。
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
 * `detectNearbyPlatform` 请求的 GPS 定位是异步到达的；坐标落地后继续那次探测，
 * 而不是让报告板一直等。
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
 * 站台选择器移动了：屏上的行是为**上一个**站台构造的，挂在新站台标题下就是关于报告板
 * 并不持有的数据的假陈述——切站台不是刷新，故不跨它保留任何东西。行与它们的读取时刻
 * 一同离开（没有行的戳是更好看的谎），报告板退回加载状态，直到新站台的读取落地。
 *
 * `rowsStation` 刻意**不**在此重置：它是加载自己的保留/清空记账，一次在加载开始后才落地的
 * 重置会让**下一次**加载误判屏上是谁的行。加载开始处的守卫才是保留与清空的裁定者。
 */
watch(currentStationName, () => {
  departureItems.value = []
  rowsReadAt.value = null
})

/**
 * 新鲜度行的时刻，用刷新家族唯一的那种形状：屏上这些行背后的那次读取，
 * 绝不是发出请求的时钟。为 null 时渲染 store 自己的「尚未获取到数据」——
 * 一块没人读过的屏不陈述时间，而不是借来的时间。
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

    <!-- 发车报告板 -->
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
