<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useIntervalFn } from '@vueuse/core'
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { TriangleAlert } from '@lucide/vue'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import type {
  CommuteChainDeductions,
  CommuteChainPurpose,
  RefreshLiveTarget,
  UserSettings,
} from '@real-time-transport/shared'
import { RefreshControl } from '@/components/refresh-control'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import { commutePurposeOf } from '@/commute-purpose'
import { ChainEmptyState, ChainLoadState, TransferCard } from './components'
import { chainCardOf } from './card'
import { anchorForPurpose, emptyStateOf } from './empty-state'
import type { PurposeOption } from './types'

/**
 * 换乘链路页：使用者录下的链路，逐条由引擎对着实时读数走一遍，逐换乘点回答「能不能赶上换乘点那班车」。
 *
 * 本页不产出任何结论：档位、余量与每个不给结论的码都是引擎的，本页只选词、只陈述每个答案值多少。
 * 链路止于末段的下车站：没有目的地，也没有总到达分钟，此处不算也不加总。
 *
 * 一次只服务一个目的。端点用同一套读数回答一个目的的各条链路，故屏幕上显示的目的永远是答案所属的目的。
 * 打开时选中哪一个由通勤时段决定（`commutePurposeOf`）；使用者点过页签之后由那一次选择决定。
 */

const transitStore = useTransitStore()
const cityStore = useCityStore()

const { commuteProfile } = storeToRefs(transitStore)

/** 两个通勤目的，用与首页相同的词。 */
const PURPOSES: PurposeOption[] = [
  { purpose: 'morning', label: '上班' },
  { purpose: 'evening', label: '下班' },
]

const manualPurpose = shallowRef<CommuteChainPurpose | null>(null)

/** 通勤时段蕴含的目的；没有可跟随的时段时是上班，由标签说明原因。 */
const autoPurpose = computed<CommuteChainPurpose>(() =>
  commutePurposeOf(commuteProfile.value) ?? 'morning')

/**
 * 本页显示的目的：使用者点过页签时就是他那一次选择，否则跟随时段。
 *
 * 手动选择是唯一的写入处，故 profile 的每一次重读（或时段本身变了）都改不动它 ——
 * 「已经点过」是一页访问内的事实，不是一个能被后到的读数翻掉的默认。
 */
const purpose = computed<CommuteChainPurpose>(() => manualPurpose.value ?? autoPurpose.value)

function onPickPurpose(value: unknown): void {
  // 只记这一次选择：显示的目的由它推出，故页签与屏幕上的答案不可能来自两个不同的选择。
  manualPurpose.value = value === 'evening' ? 'evening' : 'morning'
}

/** 端点的答案，以及它回答的是哪个目的。 */
const chains = shallowRef<CommuteChainDeductions['chains']>([])
const feedPurpose = shallowRef<CommuteChainPurpose | null>(null)
const loading = shallowRef(true)
/** 这个目的在屏幕上没有任何东西时失败的那次读取。 */
const loadError = shallowRef<string | null>(null)
/** 屏幕上仍有旧答案时失败的那次重读。 */
const reloadError = shallowRef<string | null>(null)
/** 锚点自己的状态，如设置的行所持有；未读取时为 null。 */
const anchorSaved = shallowRef<boolean | null>(null)

const hasFeed = computed(() => feedPurpose.value === purpose.value)
const cards = computed(() => (hasFeed.value ? chains.value.map(chainCardOf) : []))
const emptyState = computed(() => emptyStateOf({ purpose: purpose.value, anchorSaved: anchorSaved.value }))

/**
 * 读取该目的的链路，每条都已对着实时读数走过一遍。
 *
 * 读取失败按页面手里有什么分别报告：这个目的下什么都没有时是页面自己的加载失败（说明并提供重试）；
 * 旧答案仍在屏幕上时保留该答案并说明读取失败——把它清空会拿走用户正在看的读数。
 *
 * 最新的一次读取胜出。同时可以有多次读取在途（定时的重读与切换目的，或定时的重读与一次按下的重读），
 * 而 HTTP 答案不按询问顺序返回：旧答案最后落地会替换页面已展示的答案。故每次读取取一个序号，
 * 只有最新的一次可写。这同时也涵盖用户已离开的那个目的的答案。
 */
let readSequence = 0

async function loadChains(): Promise<void> {
  const requested = purpose.value
  const hadFeed = feedPurpose.value === requested
  const sequence = ++readSequence
  loading.value = true

  let feed: CommuteChainDeductions | null = null
  try {
    const qs = new URLSearchParams({ purpose: requested, userId: DEFAULT_USER_ID })
    const res = await fetch(`/api/transit/commute-chains/deductions?${qs.toString()}`)
    const json = await res.json()
    if (json.success && Array.isArray(json.data?.chains)) feed = json.data as CommuteChainDeductions
  }
  catch {
    // 在下面按页面能诚实呈现的状态报告。
  }

  // 已被取代的读取什么都不陈述：更新的读取已写，或目的已经变了。
  if (sequence !== readSequence) return
  loading.value = false

  if (feed) {
    chains.value = feed.chains
    feedPurpose.value = requested
    loadError.value = null
    reloadError.value = null
    return
  }
  if (hadFeed) {
    reloadError.value = '换乘链更新失败 · 下面显示的是上一次读取的结果'
    return
  }
  chains.value = []
  feedPurpose.value = null
  loadError.value = '换乘链数据读取失败'
}

/**
 * 这个目的的链路将要起步的锚点是否已存坐标。
 *
 * 只有一处理由读它：空态得点名使用者可行动的成因，而从未保存的锚点是有屏幕在背后（设置）的那一个。
 * 读取失败留着 UNKNOWN，而未知既非已保存也非缺失：此时对没人读过的行不作断言。
 * 「没有这一行」不是未知，而是「没有存锚点」这个事实，故为 false——可行动的那一个。
 */
async function loadAnchorState(): Promise<void> {
  anchorSaved.value = null
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (json.settingsState === 'unset') {
      anchorSaved.value = false
      return
    }
    const settings: UserSettings | undefined = json.success ? json.data : undefined
    if (!settings) return

    const anchor = anchorForPurpose(purpose.value)
    const lng = anchor === 'home' ? settings.homeLng : settings.workLng
    const lat = anchor === 'home' ? settings.homeLat : settings.workLat
    anchorSaved.value = typeof lng === 'number' && typeof lat === 'number'
  }
  catch {
    // 未知，且按未知陈述。
  }
}

/**
 * 本页答案所要读取的线路。
 *
 * 由答案自己点名：推导的链路点名它走过的每一段，被拒绝的链路只点名它拒绝的那一段。
 * 不在屏幕上显示的线路不点名，因为端点读的是它所问之物。
 *
 * 地铁 id 携带两个方向，而答案不说它的段跑哪个方向，故两个方向都点名：只点一个会让该段自己的方向未刷新，
 * 而控件仍报告「已刷新」。
 *
 * 城市是正在浏览的那个：答案刻意不回显它走过的段。
 */
const refreshTargets = computed<RefreshLiveTarget[]>(() => {
  const seen = new Set<string>()
  const targets: RefreshLiveTarget[] = []

  for (const chain of cards.value) {
    const lineIds = chain.deduction.status === 'deduced'
      ? chain.deduction.legs.map(leg => leg.lineId)
      : chain.deduction.leg ? [chain.deduction.leg.lineId] : []

    for (const lineId of lineIds) {
      const directions: Array<0 | 1> = lineId.startsWith('subway_') ? [0, 1] : [0]
      for (const direction of directions) {
        const key = `${lineId}_${direction}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ lineId, direction, cityCode: cityStore.currentCode })
      }
    }
  }
  return targets
})

/**
 * 一次按下的全程为 true：花掉窗口的那次请求，以及展示它取得之物的那次重读。
 * 落在两者之间的按下会在刚花掉的窗口内再问服务端一次。
 */
const refreshing = shallowRef(false)

/**
 * 交给共用控件的那几样。一次按下的结局由全局提示承载，故这里没有读数那一半。
 *
 * 同一页有两处入口（桌面那一份、窄屏那一份），故这份值只有一处 —— 两份入口说的是同一件事。
 *
 * `disabled` 是**本页**的事实，而不是「正在刷新」：屏幕上没有可点名的线路时，按下什么都不
 * 会问到，故控件从第一次渲染起就这么说。
 */
const refreshControl = computed(() => ({
  refreshing: refreshing.value,
  disabled: refreshTargets.value.length === 0,
  label: '刷新最新车况',
}))

/**
 * 按下：经由拥有冷却期的那**一个**请求去问，然后重读答案以展示它取得之物。
 * 只有取得读数的那次按下才重读：拒绝或失败什么都没携带。
 */
async function onRefresh(): Promise<void> {
  refreshing.value = true
  try {
    const outcome = await transitStore.refreshLive(refreshTargets.value)
    if (outcome === 'ok') await loadChains()
  }
  finally {
    refreshing.value = false
  }
}

/**
 * 让答案持续更新，但不成为第二个刷新入口。
 *
 * 它索要服务端已持有的东西，在服务端的读取缓存还热时不花上游读取，故节奏比该缓存更长。
 * 上面的手动入口才是花掉一次真实重读的地方。
 */
useIntervalFn(() => {
  void loadChains()
}, 20_000)

watch(purpose, () => {
  loadError.value = null
  reloadError.value = null
  void loadChains()
  void loadAnchorState()
}, { immediate: true })

onMounted(() => {
  // 使用者所处的时段决定本页打开时的目的。
  transitStore.fetchCommuteProfile()
})
</script>

<template>
  <div class="space-y-2.5 pb-12 sm:space-y-5">
    <!-- 信息区两块互斥：窄屏那一块在文档里靠前（e2e 量高度的就是页面的第一块），宽屏那一块在后。
         两块各自持有自己那一档的排布，没有一处靠断点前缀替另一档拼行。 -->
    <!-- 窄屏（768 以下）：一行 —— 目的页签占满余量、刷新贴在它后面。 -->
    <div
      data-info-area="narrow"
      class="md:hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 px-2.5 py-2 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5"
    >
      <div class="flex min-w-0 flex-col gap-1.5">
        <!-- 装不下时整体换行，而不是把某一项压到它的字以下：容器与每一项都带最小内容宽度的下限。 -->
        <div
          data-toolbar="narrow"
          class="flex min-w-0 flex-wrap items-center gap-2"
        >
          <RadioGroupRoot
            aria-label="通勤目的"
            :model-value="purpose"
            class="flex h-11 min-w-max flex-1 items-center gap-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-800/80 p-0"
            @update:model-value="onPickPurpose"
          >
            <RadioGroupItem
              v-for="option in PURPOSES"
              :key="option.purpose"
              :value="option.purpose"
              class="inline-flex h-11 min-w-max flex-1 items-center justify-center rounded-lg px-2.5 text-xs font-medium whitespace-nowrap text-slate-300 transition data-[state=checked]:bg-cyan-500/20 data-[state=checked]:text-cyan-300"
            >
              {{ option.label }}
            </RadioGroupItem>
          </RadioGroupRoot>

          <!-- 一次按下的结局由全局提示说；本页没有读数那一半，故按钮不描述任何东西。 -->
          <RefreshControl
            v-bind="refreshControl"
            variant="button"
            :has-reading="false"
            class="ms-auto shrink-0"
            @refresh="onRefresh"
          />
        </div>
      </div>
    </div>

    <!-- 宽屏（768 起）：一行 —— 目的页签在左，刷新那枚图标按钮贴着卡片右内边。 -->
    <div
      data-info-area="wide"
      class="hidden md:block rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 p-3.5 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5"
    >
      <div
        data-toolbar="wide"
        class="flex min-w-0 items-center gap-3"
      >
        <RadioGroupRoot
          aria-label="通勤目的"
          :model-value="purpose"
          class="flex h-11 shrink-0 items-center gap-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-800/80 p-0"
          @update:model-value="onPickPurpose"
        >
          <RadioGroupItem
            v-for="option in PURPOSES"
            :key="option.purpose"
            :value="option.purpose"
            class="inline-flex h-11 items-center rounded-lg px-2.5 text-xs font-medium text-slate-300 transition data-[state=checked]:bg-cyan-500/20 data-[state=checked]:text-cyan-300"
          >
            {{ option.label }}
          </RadioGroupItem>
        </RadioGroupRoot>

        <!-- 刷新那枚停在行尾：`ms-auto` 把行里剩下的余量全部落在它前面。 -->
        <RefreshControl
          v-bind="refreshControl"
          variant="button"
          :has-reading="false"
          class="ms-auto shrink-0"
          @refresh="onRefresh"
        />
      </div>
    </div>

    <!-- 屏幕上仍有旧答案时失败的重读：答案留着，陈述失败而不是让页面变空。 -->
    <p
      v-if="reloadError"
      role="alert"
      class="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400 lg:gap-2 lg:text-base"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ reloadError }}</span>
    </p>

    <ChainLoadState
      v-if="!hasFeed && loading"
      :loading="true"
      :load-error="null"
      @retry="loadChains"
    />
    <ChainLoadState
      v-else-if="!hasFeed && loadError"
      :loading="false"
      :load-error="loadError"
      @retry="loadChains"
    />
    <ChainEmptyState v-else-if="cards.length === 0" :view="emptyState" />

    <div v-else class="space-y-2.5 sm:space-y-5">
      <TransferCard v-for="card in cards" :key="card.chainId" :card="card" />
    </div>
  </div>
</template>
