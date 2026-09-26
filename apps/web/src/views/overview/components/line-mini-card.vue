<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, Pin, PinOff } from '@lucide/vue'
import { statedArrivalMinutes } from '@real-time-transport/shared/departure'
import type { DepartureReference } from '@real-time-transport/shared/departure'
import { referenceLineOf } from '../reference-line'
import { cardRowProvenanceOf } from '../provenance'
import { commuteLegNoticeOf } from '../commute-leg'
import type { CommuteLegState } from '../commute-leg'
import { nearbyEmptyNoticeOf } from '../nearby-notice'
import type { NearbyLocationState } from '../nearby-notice'
import type { CardRowWithArrivals, ArrivalsFeed, OverviewMode } from '../types'
import { operatingTextOf } from '@/operating-copy'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import { readingText, unreadText, type ReadState } from '@/read-state'

const props = defineProps<{
  lineName: string
  /**
   * 卡片领起方向上终点的标签。来自权威的 `directionName`；行各自带着自己的，这里覆盖「一行
   * 都没解析出来」的情形（没设上车点、或这里没有站台）。
   */
  directionName: string
  /** 正在报告的那个站：通勤模式是上车点，附近模式是定位到的站台。 */
  stopName: string | null
  /** 到那个站的 GPS 距离，米 —— 仅附近模式。 */
  stopDistanceMeters: number | null
  /**
   * 调用方从关注行自己的上车点与方向建立起来的这一段通勤 —— 附近视图没有通勤段时为 null，
   * 所选方向的站表尚未加载时也是 null。
   *
   * 是一个状态，不是症状：读不出的通勤段同样一行都没有，所以卡片不能从「行缺席」读出一个。
   */
  legState: CommuteLegState | null
  /**
   * 应用是否有位置，按位置 store 报告的方式 —— 这是卡片「不能」推断的事实。一行都没有的
   * 附近卡片为空的原因不止一个（根本没有定位、有定位但解析不出任何站、浏览器不能定位），
   * 而空的行程单分不开它们，所以这个状态是「给」进来的。
   */
  nearbyLocation: NearbyLocationState
  rows: CardRowWithArrivals[]
  mode: OverviewMode
  detailLoaded: boolean
  /** 地铁用琥珀、公交用青 —— 线路类型只有一套强调色规则。 */
  isSubway: boolean
  /**
   * 这条线路是被钉住的那条。置顶是铺在列表顺序之上的一种状态，所以卡片带的是一个标记，而不是
   * 从列表里被抬出来；这个标记也从不挤掉它本要使之可读的到站数据。
   */
  isPinned: boolean
  /**
   * 一张卡片同时携带两个方向时，哪一个领起。领起的那一行由调用方决定（当季的通勤段、或一次
   * 手动选择），而不是由到站时间决定：在同一个站台上，两个方向服务对侧的路缘，所以马路对面
   * 更快的那班车不能挤掉正在等的那一班。
   */
  primaryDirection?: 0 | 1 | null
}>()

defineEmits<{
  (e: 'click'): void
  /** 用户点按了尾部那个方向，把它提上来。 */
  (e: 'switch-direction', direction: 0 | 1): void
  /** 用户点了置顶控件：钉住这张卡片，或在它已被钉住时取消钉住。 */
  (e: 'toggle-pin'): void
}>()

/**
   * 强调色调色板放在一处，使卡片上每个着色元素都跟随线路类型：地铁琥珀、公交青。
   */
const accent = computed(() => (props.isSubway
  ? {
      badgeBorder: 'border-amber-500/20',
      badgeBg: 'bg-amber-500/10',
      badgeText: 'text-amber-400',
      badgeShadow: 'shadow-[0_0_12px_rgba(245,158,11,0.2)]',
      headingHover: 'group-hover:text-amber-300',
      etaText: 'text-amber-400',
      spinner: 'border-t-amber-400',
      hoverBorder: 'hover:border-amber-500/50',
    }
  : {
      badgeBorder: 'border-cyan-500/20',
      badgeBg: 'bg-cyan-500/10',
      badgeText: 'text-cyan-400',
      badgeShadow: 'shadow-[0_0_12px_rgba(6,182,212,0.2)]',
      headingHover: 'group-hover:text-cyan-300',
      etaText: 'text-cyan-400',
      spinner: 'border-t-cyan-400',
      hoverBorder: 'hover:border-cyan-500/50',
    }))

/**
   * 附近卡片没有站台可报时的那句话，或 null。
   *
   * 用调用方「给」卡片的位置状态措辞，绝不用空行列表：那个列表在定位存在之前为空，在定位到来
   * 但这条线路没有站台解析出来之后也为空，而两种成因需要不同的说法。行数只决定「有没有东西
   * 可报」—— 那是卡片自己的数据 —— 绝不决定为什么。
   */
const nearbyNotice = computed(() => (
  props.mode === 'nearby' && props.rows.length === 0
    ? nearbyEmptyNoticeOf(props.nearbyLocation)
    : null
))

/**
   * 卡片读不出的那一段通勤的提示，或没有时为 null。
   *
   * 用调用方从关注行自己的字段建立的状态措辞 —— 绝不用卡片自己的行数，它分不出「上车点未设」
   * 和「方向未选」。
   */
const legNotice = computed(() => {
  if (props.mode === 'nearby') return null
  return commuteLegNoticeOf(props.legState, props.mode)
})

function nextOf(feed: ArrivalsFeed | null) {
  return feed?.arrivals?.[0] ?? null
}

/**
   * 到那一行下一班车的分钟数；0 表示它正在靠站。
   *
   * `null` 同时覆盖卡片必须分开的两个事实 —— 没有行，以及那一行说不出分钟 —— 所以给这一行
   * 措辞的那个分支还要问「行是否存在」。
   */
function minutesOf(feed: ArrivalsFeed | null): number | null {
  const a = nextOf(feed)
  if (!a) return null
  // 全应用一条规则，使参考行的结论正是由这个列表显示的同一个分钟数得出 —— 而说不出分钟的
  // 行是一次缺席，不是这张卡片得去编的一个数字。
  return statedArrivalMinutes(a)
}

function subsequentOf(feed: ArrivalsFeed | null) {
  return (feed?.arrivals ?? []).slice(1)
}

/**
   * 领起的那一行。
   *
   * 单行卡片（通勤）以那一行领起。双行卡片（附近）在调用方给出 `primaryDirection` 时以它
   * 领起，否则退回到最小的方向号 —— 一个稳定的选择，刻意「不是」最快的那班车，那会让对侧路缘
   * 每次刷新都偷走头条。没有到站数据的行在被选中时仍然领起：头条那时陈述的是那个方向的运营
   * 事实（F3），那正是用户实际在等的那个方向的诚实答案。
   */
const primaryRow = computed<CardRowWithArrivals | null>(() => {
  const rows = props.rows
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0] ?? null

  const chosen = props.primaryDirection
  if (chosen !== null && chosen !== undefined) {
    const match = rows.find(r => r.direction === chosen)
    if (match) return match
  }
  // 稳定的兜底：最小的方向号，绝不是到站时间。
  return [...rows].sort((a, b) => a.direction - b.direction)[0] ?? null
})

const primaryArrivals = computed(() => {
  const read = primaryRow.value?.arrivals
  return read?.state === 'read' ? read.value : null
})
const primarySubsequent = computed(() => subsequentOf(primaryArrivals.value))

/**
   * 一行「到站读数」的读取状态：`read` 是答了（哪怕答的是「一辆车都没有」），`unreadable`
   * 是没答上来，`reading`/缺省是还在读。三态来自 `@/read-state`，卡片不自己推。
   */
function readStateOf(row: CardRowWithArrivals | null): ReadState {
  return row?.arrivals?.state ?? 'reading'
}

/** 首行读数自己的状态，卡片上三处关于车辆的话都从它来。 */
const primaryReadState = computed<ReadState>(() => readStateOf(primaryRow.value))

/**
   * F4：这一行显示的是哪一类分钟。
   *
   * 一个 feed 可以混种类 —— payload 送出一辆真实车辆自己的分钟，而这个应用算出下一辆 —— 所以
   * 列表标记只在每个分类过的行都一致时成立，兜底是逐行的：每一行那时说出自己的种类，这正是让
   * 同一个列表里实时的一分钟能和算出来的区分开的东西。由服务端送来的行推出 —— 绝不来自
   * `isExact`，绝不来自线路类型，也绝不来自本组件的位置。null 什么都不渲染，因为「没有来源」
   * 不是「实时」。
   */
const primaryRows = computed(() => primaryArrivals.value?.arrivals ?? [])

/** 首行的标记：feed 的那一个词，或那一行自己的种类。 */
const primaryMark = computed(() => provenanceLabelOf(cardRowProvenanceOf(primaryRows.value, 0)))

/**
   * 一条后续行的标记，或 null。只在 feed 混了种类时才说：一个词对整个列表都成立时它已经搭在
   * 首行的分钟上，在子列表里逐行重复会挤掉它描述的那些分钟。
   */
function subsequentMarkOf(index: number): string | null {
  return provenanceLabelOf(cardRowProvenanceOf(primaryRows.value, index + 1))
}

/**
   * F3：领起的那一行没有分钟可显示时它说什么。
   *
   * 列表为空不是全部事实 —— 可能还没到首班、可能已经收班、也可能范围内就是没有车 —— 所以这句
   * 话来自服务端根据这条线路自己的首末班得出的运营状态，绝不是这里读的时钟。
   *
   * 但这一切的前提是那一次读取答了：读没答上来时，「一辆车也没有」是一件没有人得到过的事；
   * 还在读时，读还在路上。三种情形都走到这里，说的却是三句话（见 `noMinutesText`）。
   */
const primaryOperatingText = computed(() => noMinutesText(
  primaryReadState.value,
  operatingTextOf(primaryArrivals.value?.operatingStatus),
))

/**
   * 「没有分钟可说」时的那句话：读数答了才谈运营状态，没答上来与还在读各自说自己。
   *
   * 三件事走到这个位置的样子是一样的（都没有行内分钟），但它们不是一句话：读了而确实没有车，
   * 是这个行自己的运营状态；读取没答上来，是关于世界的一句话没有人得到过；还在读，就还在读。
   */
function noMinutesText(state: ReadState, operating: string): string {
  if (state === 'unreadable') return unreadText('本站来车', '无法显示到站时间')
  if (state === 'reading') return readingText('到站数据')
  return operating
}

/**
   * 另一个方向，紧凑显示。即使它没有到站数据也留着，使用户仍能看见（并切换到）对侧路缘。
   */
const secondaryRow = computed<CardRowWithArrivals | null>(() =>
  props.rows.find(r => r !== primaryRow.value) ?? null)

/** 反向行的读数（答了才有），或 null（还在读 / 没答上来）。 */
const secondaryArrivals = computed(() => {
  const read = secondaryRow.value?.arrivals
  return read?.state === 'read' ? read.value : null
})

/** 只有双行卡片能切换；单行卡片没有可换的。 */
const canSwitch = computed(() => props.rows.length > 1 && secondaryRow.value !== null)

/** 反方向只有真的有一班车时才值得点按。 */
const secondaryHasArrivals = computed(() => nextOf(secondaryArrivals.value) !== null)

/** 尾部那一行的 F3：同一个运营事实、同一套措辞 —— 它没有分钟可说时同样按它自己那次读取
   *  的状态说话（见 `noMinutesText`）。 */
const secondaryOperatingText = computed(() => noMinutesText(
  readStateOf(secondaryRow.value),
  operatingTextOf(secondaryArrivals.value?.operatingStatus),
))

/** 尾部那一行的 F4：它自己的 feed，它自己有资格说出一个标记。 */
const secondaryRows = computed(() => secondaryArrivals.value?.arrivals ?? [])

/**
   * 尾部那一行的标记。与首行同一套兜底：行一致时用 feed 的那一个词，否则被显示的那一行说出
   * 自己的种类。
   */
const secondaryMark = computed(() => provenanceLabelOf(cardRowProvenanceOf(secondaryRows.value, 0)))

/** 一行读了之后车有几辆；没答上来或还在读的行不贡献数字。 */
function aheadCountOf(row: CardRowWithArrivals): number {
  const read = row.arrivals
  return read?.state === 'read' ? read.value.arrivals.length : 0
}

/** 所有行加起来未来还有几班车 —— 诚实的「还有几辆要来」。 */
const aheadCount = computed(() =>
  props.rows.reduce((sum, r) => sum + aheadCountOf(r), 0))

/**
   * 这几行的读取状态，合起来看那一个数字能不能说出口。
   *
   * 角标上的数字是前方的车数，跨行求和，所以它只有在每一行的读取都答了的时候才是一个关于世界的
   * 事实：还有一行在读，总数可能还会变大；有一行没答上来，总数可能少算了。两者都不是「一辆也
   * 没有」，因此都不能读作「前方暂无来车」。
   */
const aheadReadState = computed<ReadState>(() => {
  const states = props.rows.map(row => readStateOf(row))
  if (states.includes('unreadable')) return 'unreadable'
  if (states.includes('reading')) return 'reading'
  return 'read'
})

/** 角标上有数字，且那是一个读到了的数字。 */
const aheadCountIsAFact = computed(() => aheadReadState.value === 'read')

/**
   * 角标的话，三件事实三句。
   *
   * 「前方暂无来车」是一句关于世界的话，只属于「读了、确实一辆也没有」这一种情形；读取没答上来
   * 与还在读各有自己的说法 —— 先前它们与「一辆也没有」共用这一句，于是一次失败的读取被显示成
   * 「没有车要来」。
   */
const aheadBadgeText = computed(() => {
  if (aheadReadState.value === 'unreadable') return '前方来车未读到'
  if (aheadReadState.value === 'reading') return readingText('来车')
  return aheadCount.value > 0 ? `前方 ${aheadCount.value} 辆` : '前方暂无来车'
})

const modeLabel = computed(() => (props.mode === 'morning'
  ? '🏠 上班'
  : props.mode === 'evening' ? '🏢 下班' : '📍 附近'))

/**
   * 首行的 F1 参考，或 null。
   *
   * 只有通勤段才有。那里「家 / 公司」确实就是「你所在的地方」，这才使「锚点 → 站台」成为用户
   * 即将走的一段路；附近视图里显示的站台只是离一次实时定位最近的那个，同一段步行会是一个关于
   * 没人要走的旅程的数字。
   */
const reference = computed<DepartureReference | null>(() => {
  if (props.mode === 'nearby') return null
  return primaryArrivals.value?.reference ?? null
})

/**
   * 参考行的文本，没有诚实的话可说时为 null。
   *
   * 它是「参考」，不是替代：上面的到站分钟数保持完整，这一行只能给面板加一条，绝不能隐藏、
   * 缩小或截断其中任何一个分钟数。
   */
const referenceLine = computed(() => referenceLineOf(reference.value))
</script>

<template>
  <div
    class="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 shadow-lg backdrop-blur-md transition hover:bg-slate-900"
    :class="accent.hoverBorder"
    @click="$emit('click')"
  >
    <!-- 置顶标记：卡片自己顶边上的一条。刻意中性 —— 青色/琥珀色强调的是线路「类型」，
         借用其中任一的状态标记会被读成另一种线路。 -->
    <div
      v-if="isPinned"
      class="flex items-center gap-1.5 bg-slate-800/90 px-4 py-1.5 text-xs font-semibold text-slate-100"
    >
      <Pin class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>置顶</span>
    </div>

    <div class="p-4">
      <!-- 卡片头部 -->
      <div class="flex items-center justify-between">
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="flex h-9 shrink-0 items-center justify-center rounded-xl border px-2.5 font-mono font-bold whitespace-nowrap"
            :class="[accent.badgeBorder, accent.badgeBg, accent.badgeText, accent.badgeShadow, lineName.length > 4 ? 'text-xs min-w-[64px]' : lineName.length > 3 ? 'text-sm min-w-[52px]' : 'text-base min-w-[44px]']"
          >
            {{ lineName }}
          </span>
          <div class="min-w-0">
            <h3 class="line-clamp-2 text-sm font-semibold text-slate-100 transition lg:text-base" :class="accent.headingHover">
              {{ primaryRow?.directionName || directionName }}
            </h3>
            <p class="truncate text-xs text-slate-400">
              {{ modeLabel }}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <!-- 前方车辆角标：只有未来的车，诚实的零。只有读了才数车：没答上来与还在读各自说自己
               那句话，而不是被当成「一辆也没有」。卡片一行都没有（这一段还没设好、或附近没有
               站台）时不摆这个角标 —— 它的主语是本站前方的车，没有站台就没有主语，那种情形由
               正文里那句自己的话说明。 -->
          <span
            v-if="rows.length > 0"
            class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
            :class="aheadCountIsAFact && aheadCount > 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/60 text-slate-400'"
          >
            <span
              v-if="aheadCountIsAFact && aheadCount > 0"
              class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
            ></span>
            {{ aheadBadgeText }}
          </span>

          <!-- 置顶入口与取消，都在卡片上：这个开关点名它执行的动作，所以被钉住的卡片自带从顶上退
               下来的路。按项目对次要控件的 40px 下限 —— 卡片主体是打开详情，所以过小的点按
               目标会换来一次错误的跳转。 -->
          <button
            type="button"
            class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition"
            :class="isPinned
              ? 'border-slate-600 bg-slate-800 text-slate-100'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-700 hover:text-slate-100'"
            :aria-label="isPinned ? '取消置顶' : '置顶此线路'"
            :title="isPinned ? '取消置顶' : '置顶此线路'"
            :aria-pressed="isPinned"
            @click.stop="$emit('toggle-pin')"
          >
            <PinOff v-if="isPinned" class="h-4 w-4" aria-hidden="true" />
            <Pin v-else class="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- 加载态：详情还没从接口解析出来 -->
      <div v-if="!detailLoaded" class="my-3.5 flex items-center justify-center rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-400 lg:px-3.5 lg:py-2 lg:text-base">
        <span class="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600" :class="accent.spinner"></span>
        正在加载线路数据...
      </div>

      <template v-else>
        <!-- 诚实的空状态，一种成因一条 -->
        <div v-if="nearbyNotice" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
          {{ nearbyNotice }}
        </div>
        <div v-else-if="legNotice" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
          {{ legNotice }}
        </div>

        <div v-else-if="stopName" class="my-3.5 space-y-2.5 rounded-xl bg-slate-950/80 p-3">
          <!-- 这张卡片报告的那个站 -->
          <div class="flex items-center justify-between text-xs lg:text-base">
            <span class="min-w-0 truncate text-slate-300">
              {{ stopName }}<span v-if="primaryRow?.stopOrder" class="ml-1.5 text-slate-400">第 {{ primaryRow.stopOrder }} 站</span>
            </span>
            <!-- 附近模式加上 GPS 距离；通勤模式已经在标题下点了这一段，所以右侧留空。 -->
            <span v-if="stopDistanceMeters !== null" class="shrink-0 font-mono text-slate-400">
              {{ stopDistanceMeters }}m
            </span>
          </div>

          <!-- 首行的预计到站。分钟来自服务端能诚实产出的东西；旁边的标记说出那是哪一类数字（F4）。
               `flex-wrap` 使尾部元数据（现在以标记结尾）在 375px 手机上换到自己那一行，而不是
               挤压分钟数；`ml-auto` 使它在换行后仍右对齐。 -->
          <div v-if="nextOf(primaryArrivals)?.isAtStation" class="flex items-baseline gap-2">
            <!-- 这是关于车辆位置的「观测」，不是数字：它背后那一行带着自己的种类（服务端把它定价为
                 `live`），但标记回答的是「这个数字来自哪里」，而这句话不陈述任何分钟数 ——
                 线路详情面板对同一状态也不渲染标记。 -->
            <span class="font-mono text-xl font-black tracking-tight" :class="accent.etaText">正在进站</span>
          </div>
          <div v-else-if="minutesOf(primaryArrivals) !== null" class="flex flex-wrap items-baseline gap-2">
            <span class="font-mono text-2xl font-black tracking-tight" :class="accent.etaText">
              {{ minutesOf(primaryArrivals) }}
            </span>
            <span class="text-xs font-semibold" :class="accent.etaText">分钟后到站</span>
            <span class="ml-auto font-mono text-xs text-slate-400">
              {{ nextOf(primaryArrivals)?.time }}<template v-if="nextOf(primaryArrivals)?.stopsAway !== undefined"> <span aria-hidden="true">·</span> 距 {{ nextOf(primaryArrivals)?.stopsAway }} 站</template><template v-if="nextOf(primaryArrivals)?.distanceMeters"> <span aria-hidden="true">·</span> {{ ((nextOf(primaryArrivals)!.distanceMeters!) / 1000).toFixed(1) }}km</template><template v-if="primaryMark"> <span aria-hidden="true">·</span> {{ primaryMark }}</template>
            </span>
          </div>
          <!-- F-E：行存在但说不出分钟 —— 数据源携带了这辆车，却没有为它发布到站时间，而这个应用
               不再估算。这个缺席在「这里」说出，而不是留给下面的兜底，后者主张的是另一件事：
               范围内根本没有车。 -->
          <div v-else-if="nextOf(primaryArrivals)" class="text-xs text-slate-400 lg:text-base">
            {{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}<template v-if="nextOf(primaryArrivals)?.stopsAway !== undefined"> <span aria-hidden="true">·</span> 距 {{ nextOf(primaryArrivals)?.stopsAway }} 站</template>
          </div>
          <div v-else class="text-xs text-slate-400 lg:text-base">
            {{ primaryOperatingText }}
          </div>

          <!-- 同一个站台上的反方向。点按它把那个方向提到头条；标签说出它开往哪里，所以两行从不
               含糊。 -->
          <button
            v-if="secondaryRow"
            type="button"
            class="flex w-full items-center justify-between gap-2 border-t border-slate-800/60 pt-2 text-left text-xs transition lg:gap-2.5 lg:pt-2.5 lg:text-base"
            :class="canSwitch ? 'cursor-pointer hover:opacity-80 active:scale-[0.99]' : 'cursor-default'"
            :disabled="!canSwitch"
            :aria-label="canSwitch
              ? `切换到${secondaryRow.directionName}方向`
              : undefined"
            @click.stop="canSwitch && $emit('switch-direction', secondaryRow.direction)"
          >
            <span class="flex min-w-0 items-center gap-1 text-slate-400">
              <ArrowLeftRight v-if="canSwitch" class="h-3 w-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ secondaryRow.directionName }}</span>
            </span>
            <span class="flex shrink-0 items-baseline gap-1.5">
              <template v-if="secondaryHasArrivals">
                <template v-if="minutesOf(secondaryArrivals) !== null">
                  <span class="font-mono font-bold" :class="accent.etaText">
                    {{ minutesOf(secondaryArrivals) }}分
                  </span>
                  <span class="font-mono text-slate-400">{{ nextOf(secondaryArrivals)?.time }}</span>
                  <!-- 尾部那一行是第二个 feed：它说出自己的种类（F4）。 -->
                  <span v-if="secondaryMark" class="text-xs text-slate-400"><span aria-hidden="true">·</span> {{ secondaryMark }}</span>
                </template>
                <!-- 一行说不出分钟：那是缺席，不是运营事实 —— 另一个方向确实有车要来。 -->
                <span v-else class="text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
              </template>
              <span v-else class="text-slate-400">{{ secondaryOperatingText }}</span>
            </span>
          </button>

          <!-- 首行的后续车次。feed 混了种类时每行说出自己的种类（F4）；一个词对整个列表成立时它
               已经搭在上面首行的分钟上。`flex-wrap` 使标记在 375px 手机上不挤压分钟数。 -->
          <div v-if="primarySubsequent.length > 0" class="flex flex-wrap items-center gap-2 border-t border-slate-800/60 pt-2 text-xs">
            <span class="shrink-0 text-slate-400">后续</span>
            <span
              v-for="(a, i) in primarySubsequent"
              :key="a.busId || i"
              class="flex items-baseline gap-1"
            >
              <!-- 后续行说出自己的分钟或说没有 —— 与首行同一条规则，而它没有数字可供标记限定时，自己
                   的标记是 `null`。 -->
              <template v-if="statedArrivalMinutes(a) !== null">
                <span class="font-mono font-bold text-slate-300">{{ statedArrivalMinutes(a) }}分</span>
                <span class="font-mono text-slate-400">{{ a.time }}</span>
              </template>
              <span v-else class="text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
              <span v-if="subsequentMarkOf(i)" class="text-slate-400">{{ subsequentMarkOf(i) }}</span>
            </span>
          </div>

          <!-- F1 的参考行：锚点真实的步行时间，以及服务端由此得出的结论。刻意次要 —— 比上面的分钟
               数小一档、也更轻 —— 且按约束只做加法：它只能给这个面板加一条，绝不隐藏或压缩它
               所参考的任何一个到站分钟数。 -->
          <div
            v-if="referenceLine"
            class="flex flex-wrap items-baseline gap-x-1.5 border-t border-slate-800/60 pt-2 text-xs lg:text-base"
          >
            <template v-if="referenceLine.walk">
              <span class="text-slate-400">{{ referenceLine.walk }}</span>
              <span class="text-slate-400" aria-hidden="true">·</span>
            </template>
            <span class="text-slate-300">{{ referenceLine.conclusion }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
