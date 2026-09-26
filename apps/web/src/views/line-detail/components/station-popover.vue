<script setup lang="ts">
import { computed } from 'vue'
import {
  PopoverAnchor,
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
} from 'reka-ui'
import { Footprints, House, Building2, X } from '@lucide/vue'
import type { ArrivalRow, Station, WalkDecision } from '@real-time-transport/shared'
import { statedArrivalMinutes } from '@real-time-transport/shared'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import { arrivalListProvenanceOf, arrivalRowProvenanceOf } from '../provenance'
import type { StationAnchor } from '../types'

const props = defineProps<{
  station: Station | null
  anchor: StationAnchor | null
  arrivals?: {
    arrivals: ArrivalRow[]
    /**
     * F-C：精确表对本站台自己的说明，逐字保留——例如只跑一段的末班车。
     * 它随它所限定的班次一起呈现，且绝不在这里重新措辞：加前缀会让本应用成为一个它只是携带的
     * 断言的作者。
     */
    note?: string | null
  } | null
  walkDecision?: WalkDecision | null
  hasUserCoords?: boolean
  gisLoading?: boolean
  eta: string
  /**
   * F4：`eta` 是哪种数字，线路不陈述时为 null。渲染在数字旁、比它轻一档，
   * 使推算出来的分钟不会读起来像一次读取。
   */
  etaMark?: string | null
  freshness: string
  isRefreshing?: boolean
  /** 本线路未被关注时为 false，因为没有地方存上车点。 */
  canPin?: boolean
  /** 打开的站绑定到哪个通勤目的，若有。 */
  stationPurpose?: 'morning' | 'evening' | null
  stopSaving?: boolean
  stopError?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'compute-walk'): void
  (e: 'toggle-stop', purpose: 'morning' | 'evening'): void
}>()

const isOpen = computed(() => Boolean(props.station && props.anchor))

/** 一个到站答案携带的行；它们作为一整个列表分类。 */
const arrivalRows = computed(() => props.arrivals?.arrivals ?? [])

/**
   * F4：整个列表的标记，在已分类的各行都一致时。
   *
   * 列表什么都不陈述、或各行不一致时为 `null`——一个词会对其中一部分为假，那时 `rowMarkOf`
   * 给这些行各自的标记。
   */
const listMark = computed(() => provenanceLabelOf(arrivalListProvenanceOf(arrivalRows.value)))

/**
   * 某一行自己的标记，只在列表不能代它说话时渲染。什么都没陈述的行什么也得不到——
   * 绝不是那个漂亮的答案。
   */
function rowMarkOf(index: number): string | null {
  return provenanceLabelOf(arrivalRowProvenanceOf(arrivalRows.value, index))
}

const virtualAnchor = computed(() => {
  if (!props.anchor) return undefined
  const x = props.anchor.screenX
  const y = props.anchor.screenY
  const r = props.anchor.radius ?? 12
  return {
    getBoundingClientRect(): DOMRect {
      return {
        x: x - r,
        y: y - r,
        top: y - r,
        left: x - r,
        bottom: y + r,
        right: x + r,
        width: 2 * r,
        height: 2 * r,
        toJSON() { return this },
      } as DOMRect
    },
  }
})

const decisionStyle = computed(() => {
  switch (props.walkDecision?.decision) {
    case 'comfortable':
      return { border: 'border-emerald-500/30 bg-emerald-500/10', text: 'text-emerald-300', emoji: '🟢' }
    case 'hurry':
      return { border: 'border-amber-500/30 bg-amber-500/10', text: 'text-amber-300', emoji: '🏃' }
    case 'missed':
      return { border: 'border-rose-500/30 bg-rose-500/10', text: 'text-rose-300', emoji: '🔴' }
    default:
      return { border: 'border-slate-700 bg-slate-800/50', text: 'text-slate-300', emoji: 'ℹ️' }
  }
})
</script>

<template>
  <PopoverRoot
    :open="isOpen"
    @update:open="(val: boolean) => { if (!val) emit('close') }"
  >
    <PopoverAnchor :reference="virtualAnchor" />

    <PopoverPortal>
      <PopoverContent
        v-if="station"
        data-station-popover="true"
        side="top"
        :side-offset="4"
        :avoid-collisions="true"
        :collision-padding="16"
        :arrow-padding="20"
        :hide-when-detached="true"
        sticky="always"
        update-position-strategy="always"
        class="z-50 w-[calc(100vw-32px)] sm:w-80 select-none focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
        @pointer-down-outside="(e: any) => {
          const target = e.detail?.originalEvent?.target as HTMLElement | null
          if (target?.tagName === 'CANVAS') {
            e.preventDefault()
          }
        }"
      >
        <!-- 主卡片体（动态钳制的最大高度，避免放大时溢出屏幕） -->
        <div class="relative max-h-[min(72vh,var(--reka-popover-content-available-height,460px))] md:max-h-[min(460px,var(--reka-popover-content-available-height,460px))] overflow-y-auto rounded-2xl border border-cyan-500/40 bg-slate-900 p-3.5 shadow-2xl space-y-2.5">
          <!-- 头部 -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]"></span>
              <h3 class="truncate text-sm font-bold text-slate-100 lg:text-base">
                {{ station.name }}
              </h3>
              <span class="shrink-0 rounded bg-cyan-950/80 px-1.5 py-0.5 font-mono text-xs text-cyan-400 border border-cyan-800/50 lg:px-2 lg:py-1">
                第 {{ station.order }} 站
              </span>
            </div>

            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
              aria-label="关闭站点详情"
              @click="emit('close')"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- 换乘 -->
          <div
            v-if="station.interchanges && station.interchanges.length > 0"
            class="flex flex-wrap items-center gap-1 text-xs text-slate-400"
          >
            <span class="text-slate-400 text-xs">换乘:</span>
            <span
              v-for="ic in station.interchanges"
              :key="ic"
              class="rounded bg-sky-950/60 border border-sky-800/40 px-1.5 py-0.5 text-sky-300 font-medium"
            >
              {{ ic }}
            </span>
          </div>

          <!-- 新鲜度与到达状态 -->
          <div class="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2.5 space-y-1">
            <div class="flex items-center gap-1.5 text-xs text-slate-400">
              <span
                class="inline-block h-1.5 w-1.5 rounded-full"
                :class="isRefreshing ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-400'"
              ></span>
              {{ isRefreshing ? '正在刷新…' : freshness }}
            </div>

            <!-- 数字，以及它旁边的数字种类（F4）。两者由视图里同一个分支决定，故不会互相矛盾。 -->
            <p class="font-mono text-xs font-semibold text-cyan-300 lg:text-base">
              {{ eta }}<span v-if="etaMark" class="ml-1 text-xs font-normal text-slate-400"><span aria-hidden="true">·</span> {{ etaMark }}</span>
            </p>
          </div>

          <!-- 后续进站计划 -->
          <div v-if="arrivals && arrivals.arrivals.length > 0" class="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2.5 space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="shrink-0 text-xs font-semibold text-slate-400">后续进站计划</span>
              <!-- 列表自己的标记：各行一致时说一次，使到站时间仍是面板里最响的东西。 -->
              <span
                v-if="listMark"
                class="shrink-0 rounded border border-slate-700/60 bg-slate-800/60 px-1.5 py-0.5 text-xs font-medium text-slate-300"
              >
                {{ listMark }}
              </span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(a, i) in arrivals.arrivals"
                :key="a.time || a.busId || i"
                class="rounded-lg border px-2 py-0.5 font-mono text-xs"
                :class="i === 0
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                  : 'border-slate-800 bg-slate-900 text-slate-300'"
              >
                <!-- 一行陈述分钟或不陈述，由 statedArrivalMinutes 决定。没有分钟的行渲染缺失
                     而不是数字——绝不用本应用估的分钟。 -->
                <template v-if="statedArrivalMinutes(a) !== null">
                  {{ a.time }}
                  <span v-if="!a.isAtStation" class="ml-1 text-xs text-slate-400">{{ statedArrivalMinutes(a) }}分</span>
                </template>
                <template v-else>{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</template>
                <span v-if="a.stopsAway" class="ml-1 text-xs text-slate-400">({{ a.stopsAway }}站)</span>
                <!-- 同一个列表里来源不同：每一行自己说话——且只对陈述了数字的行说。
                     在本站的行是关于车在哪里的观测，没有分钟可供标记限定。 -->
                <span v-if="!a.isAtStation && rowMarkOf(i)" class="ml-1 text-xs text-slate-400">{{ rowMarkOf(i) }}</span>
              </span>
            </div>
          </div>

          <!-- F-C：表自己的说明，逐字保留，放在它所限定的班次旁；刻意放在列表块**外面**，
               使列表为空时它仍被读到——而那正是它要紧的时段。 -->
          <p
            v-if="arrivals?.note"
            data-arrivals-note="true"
            class="rounded-xl border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-xs leading-relaxed text-amber-300/90 lg:text-base"
          >
            {{ arrivals.note }}
          </p>

          <!-- 上车点控件：使本站成为首页卡片在所见方向上的目标站。 -->
          <!-- 通勤上车点：把本站绑定到一个目的。一个站可以服务两腿；再点已激活的目的即解绑。 -->
          <div v-if="canPin" class="space-y-1">
            <div class="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                class="flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-medium transition active:scale-[0.99] disabled:opacity-60 lg:gap-2 lg:px-2.5 lg:py-2.5 lg:text-base"
                :class="stationPurpose === 'morning'
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300'"
                :disabled="stopSaving"
                @click="emit('toggle-stop', 'morning')"
              >
                <House class="h-3.5 w-3.5 shrink-0" :class="stationPurpose === 'morning' ? 'fill-current' : ''" />
                <span>{{ stationPurpose === 'morning' ? '上班上车点 ✓' : '设为上班上车点' }}</span>
              </button>
              <button
                type="button"
                class="flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-medium transition active:scale-[0.99] disabled:opacity-60 lg:gap-2 lg:px-2.5 lg:py-2.5 lg:text-base"
                :class="stationPurpose === 'evening'
                  ? 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-violet-500/50 hover:text-violet-300'"
                :disabled="stopSaving"
                @click="emit('toggle-stop', 'evening')"
              >
                <Building2 class="h-3.5 w-3.5 shrink-0" :class="stationPurpose === 'evening' ? 'fill-current' : ''" />
                <span>{{ stationPurpose === 'evening' ? '下班上车点 ✓' : '设为下班上车点' }}</span>
              </button>
            </div>
            <p v-if="stopError" class="text-xs text-rose-400 lg:text-base">{{ stopError }}</p>
          </div>

          <!-- 步行决策 -->
          <div
            v-if="walkDecision"
            class="rounded-xl border p-2.5 space-y-1"
            :class="decisionStyle.border"
          >
            <div class="flex items-center gap-1.5">
              <span class="text-sm">{{ decisionStyle.emoji }}</span>
              <span class="text-xs font-semibold lg:text-base" :class="decisionStyle.text">
                {{ walkDecision.advice }}
              </span>
            </div>
            <div class="flex items-center gap-3 text-xs text-slate-400 font-mono">
              <span>步行 {{ Math.round(walkDecision.walkSeconds / 60) }} 分钟 ({{ walkDecision.walkMeters }}米)</span>
              <span v-if="walkDecision.bufferSeconds !== null">
                缓冲 {{ Math.round(walkDecision.bufferSeconds / 60) }} 分
              </span>
            </div>
          </div>
          <button
            v-else-if="hasUserCoords"
            type="button"
            class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300 active:scale-[0.99] lg:gap-2 lg:px-3.5 lg:py-2.5 lg:text-base"
            :disabled="gisLoading"
            @click="emit('compute-walk')"
          >
            <Footprints class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span>{{ gisLoading ? '正在规划步行路径…' : `计算我到「${station.name}」的赶车决策` }}</span>
          </button>
        </div>

        <!-- 浮层的精确箭头：两段式无缝开口 V，遮住卡片基线 -->
        <PopoverArrow
          :width="16"
          :height="8"
          class="overflow-visible fill-slate-900 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
        >
          <polygon points="0,0 6,6 12,0" fill="#0f172a" />
          <line x1="-0.5" y1="0" x2="12.5" y2="0" stroke="#0f172a" stroke-width="3" />
          <path
            class="station-popover-arrow-path"
            d="M0 0 L6 6 L12 0"
            fill="none"
            vector-effect="non-scaling-stroke"
            stroke-width="1"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </PopoverArrow>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
:deep([data-station-popover] > span) {
  z-index: 20;
}

.station-popover-arrow-path {
  stroke: color-mix(in oklab, var(--color-cyan-500) 40%, transparent);
}
</style>
