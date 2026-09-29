<script setup lang="ts">
import { RefreshCw, TriangleAlert } from '@lucide/vue'
import { computed } from 'vue'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import { followedLinesUnreadableText, type ReadState } from '@/read-state'
import { congestionChipClass, congestionLabel } from '../congestion'
import type { DepartureItem } from '../types'

const props = defineProps<{
  items: DepartureItem[]
  loading: boolean
  /**
   * 关注线路读取自己的状态，由发起该读取的页面给出。
   *
   * 行由关注线路构造，故空屏有三个成因，本字段是区分它们的依据：「该站台暂无已关注线路途经」
   * 只对「已作答的空列表」为真；读失败时同样没有可展示的站台，此时说用户什么都没关注，
   * 是对其已存数据一个无人取得过的断言。
   */
  favoritesRead: ReadState
  /**
   * 屏上这些行背后那次读取的新鲜度行，由页面报告——屏上没有读取产出的东西时为 `null`。
   * 时刻取自响应自己的 `updatedAt`，故刷新甚至失败时，这一行仍描述**可见的行**来自哪次读取。
   */
  freshness?: { text: string } | null
}>()

defineEmits<{
  (e: 'retry'): void
}>()

/**
 * 上一次完整读取是否让每一行都没有东西可陈述——端到端失败的刷新的形状。
 * 此时新鲜度行把失败放在保留行自己的时刻旁：行留下，而它们遭遇了什么就在用户读到之处陈述。
 */
const readFailed = computed(() =>
  props.items.length > 0 && props.items.every(item => item.unavailable))

/**
 * 新鲜度行陈述什么。刷新失败时两个事实都留：行自己的时刻留在屏上（它仍描述可见的行），
 * 失败以刷新家族自己的措辞并排呈现——绝不取而代之。
 */
const failureText = '刷新失败 · 未能取到最新数据'
const freshnessText = computed(() => {
  if (!readFailed.value) return props.freshness?.text ?? null
  return props.freshness?.text
    ? `${failureText} · ${props.freshness.text}`
    : failureText
})

/**
 * 本行到站分钟是哪一类数字，措辞交给唯一给标记措辞的地方。
 *
 * 读自本行自己的来源，由视图按载荷声明的来源决定——一块屏每行一条线路，故说不出一个
 * 覆盖整张列表的类别。没有陈述的行返回 null 且不渲染任何标记：「没有来源」绝不能读成实时。
 */
function markOf(item: DepartureItem): string | null {
  return provenanceLabelOf(item.provenance)
}
/**
 * 行的距离措辞：与剩余站数并排陈述（「距 1.2 公里 · 2 站」）。
 * 缺失就什么都不陈述（零假数据：绝不按站数估出一个距离）。
 */
function distanceText(meters: number | null): string | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return null
  if (meters >= 1000) return `距 ${(meters / 1000).toFixed(1)} 公里`
  return `距 ${Math.round(meters)} 米`
}
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
    <!-- 屏上这些行背后那次读取，按刷新家族的措辞陈述。有就渲染——刷新运行在保留的行之上时
         不替换它（时刻仍描述可见的行），刷新失败也在此陈述。 -->
    <div
      v-if="freshnessText"
      class="border-b border-slate-800/60 px-3 py-2 text-xs text-slate-400 lg:px-4 lg:text-base"
      :class="readFailed ? 'text-rose-400' : ''"
    >
      {{ freshnessText }}
    </div>

    <!-- 表头与数据行是**同一套**两列网格（见 PRD F5）：左列线路与开往、右列预计到站与拥挤度。
         移动端同样两列（只是排成两行），故移动端不隐藏任何信息。 -->
    <div class="grid grid-cols-[1fr_auto] border-b border-slate-800 bg-slate-900/90 px-3 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider md:px-4">
      <div>线路 / 开往</div>
      <div class="text-right">预计到站 · 拥挤度</div>
    </div>

    <!-- loading 体与行是两个独立状态，不是 v-if/v-else：体只在屏上无物可留时出现，
         而行在整次刷新中持续渲染（更新在控件上示意）。 -->
    <div v-if="loading && items.length === 0" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      正在加载车况数据...
    </div>

    <!-- 空屏有三个成因，各自照原样措辞：读失败（说出来并给出重试）、尚无任何读取作答、
         或列表已作答且没有关注线路经过本站台。只有最后一个是关于已存数据的事实。 -->
    <div
      v-else-if="items.length === 0 && favoritesRead === 'unreadable'"
      class="flex flex-wrap items-center justify-center gap-2 p-8 text-center lg:p-8.5"
    >
      <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ followedLinesUnreadableText('暂时无法判断该站台是否有已关注线路途经') }}</span>
      </p>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
        :disabled="loading"
        @click="$emit('retry')"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <div v-else-if="items.length === 0 && favoritesRead === 'reading'" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      正在读取关注线路…
    </div>

    <div v-else-if="items.length === 0" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路
    </div>

    <div v-else class="divide-y divide-slate-800/60">
      <div
        v-for="item in items"
        :key="item.id"
        class="grid grid-cols-[1fr_auto] items-center gap-x-3 px-3 py-3 transition hover:bg-slate-900/50 md:px-4 md:py-3.5"
      >
        <!-- 左列：线路徽标 + 开往方向（与表头左列同列） -->
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 font-mono font-bold text-cyan-400 whitespace-nowrap"
            :class="item.lineName.length > 4 ? 'text-xs min-w-[58px]' : 'text-xs min-w-[44px]'"
          >
            {{ item.lineName }}
          </span>
          <span class="min-w-0 truncate text-xs font-medium text-slate-200 lg:text-base">{{ item.terminal }}</span>
        </div>

        <!-- 右列：预计到站（含距离与站数）与拥挤度，与表头右列同列 -->
        <div class="flex items-center justify-end gap-3 md:gap-4">
          <div class="text-right font-mono">
            <template v-if="item.etaMinutes !== null">
              <span class="text-base font-bold text-cyan-400">{{ item.etaMinutes }}</span>
              <span class="text-xs text-slate-400"> 分钟</span>
              <!-- 分钟是哪一类数字，取自本行自己的来源。没有陈述的行不渲染任何标记，
                   故未归类的分钟绝不借用好看的那个词。 -->
              <span v-if="markOf(item)" class="ml-1 text-xs font-normal text-slate-400"><span aria-hidden="true">·</span> {{ markOf(item) }}</span>
              <span v-if="item.stopsAway !== null" class="block text-xs text-slate-400">
                <template v-if="distanceText(item.distanceMeters)">{{ distanceText(item.distanceMeters) }} · </template>{{ item.stopsAway }} 站
              </span>
            </template>
            <!-- 没有车带 ETA 时陈述运营事实：已收班、未开班，或运营中而范围内无车。 -->
            <template v-else-if="item.operatingText">
              <span class="text-xs font-normal text-slate-400">{{ item.operatingText }}</span>
            </template>
            <!-- 请求失败：本行没有车、也没有运营日可报。以具名状态为键，绝不以渲染用词为键。 -->
            <template v-else-if="item.unavailable">
              <span class="text-xs font-normal text-slate-400">无法获取</span>
              <span class="block text-xs text-slate-400">数据暂不可用</span>
            </template>
            <template v-else>
              <!-- 车在途但数据源没给 ETA。该 token 来自 `@/arrival-copy`——唯一为这个状态
                   措辞的地方，故每个展示它的界面展示同一句话。 -->
              <span class="text-xs font-normal text-slate-400">无法估算</span>
              <span class="block text-xs text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
            </template>
          </div>

          <!-- 拥挤度芯片是判决，词与色都只来自等级：绝不来自分钟是否存在。
               请求失败的行**不渲染**它（同一行不能同时说「这趟车取不到」和「这趟车未知」）。 -->
          <span
            v-if="!item.unavailable"
            class="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
            :class="congestionChipClass(item.congestion)"
          >
            {{ congestionLabel(item.congestion) }}
          </span>
        </div>
      </div>

    </div>
  </div>
</template>
