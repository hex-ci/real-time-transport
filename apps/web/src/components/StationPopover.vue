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
import type { Station, WalkDecision } from '@real-time-transport/shared'
import type { StationAnchor } from '@/components/RouteBoard.vue'

const props = defineProps<{
  station: Station | null
  anchor: StationAnchor | null
  arrivals?: {
    isExact: boolean
    arrivals: Array<{
      time: string
      etaSeconds: number
      stopsAway?: number
      distanceMeters?: number
      isAtStation?: boolean
    }>
  } | null
  walkDecision?: WalkDecision | null
  hasUserCoords?: boolean
  gisLoading?: boolean
  eta: string
  freshness: string
  isRefreshing?: boolean
  /** False when this line is not followed, so there is nowhere to store a board stop. */
  canPin?: boolean
  /** Which commute purpose the open station is bound to, if any. */
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
        <!-- Main Card Body (Dynamic clamped max-height prevents screen overflow when zoomed in) -->
        <div class="relative max-h-[min(72vh,var(--reka-popover-content-available-height,460px))] md:max-h-[min(460px,var(--reka-popover-content-available-height,460px))] overflow-y-auto rounded-2xl border border-cyan-500/40 bg-slate-900 p-3.5 shadow-2xl space-y-2.5">
          <!-- Header -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]"></span>
              <h3 class="truncate text-sm font-bold text-slate-100">
                {{ station.name }}
              </h3>
              <span class="shrink-0 rounded bg-cyan-950/80 px-1.5 py-0.5 font-mono text-[11px] text-cyan-400 border border-cyan-800/50">
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

          <!-- Interchanges -->
          <div
            v-if="station.interchanges && station.interchanges.length > 0"
            class="flex flex-wrap items-center gap-1 text-[11px] text-slate-400"
          >
            <span class="text-slate-500 text-[10px]">换乘:</span>
            <span
              v-for="ic in station.interchanges"
              :key="ic"
              class="rounded bg-sky-950/60 border border-sky-800/40 px-1.5 py-0.5 text-sky-300 font-medium"
            >
              {{ ic }}
            </span>
          </div>

          <!-- Freshness & ETA Status -->
          <div class="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2.5 space-y-1">
            <div class="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span
                class="inline-block h-1.5 w-1.5 rounded-full"
                :class="isRefreshing ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-400'"
              ></span>
              {{ isRefreshing ? '正在获取最新实时数据…' : freshness }}
            </div>

            <p class="font-mono text-xs font-semibold text-cyan-300">
              {{ eta }}
            </p>
          </div>

          <!-- Exact Timetable / Subsequent Arrivals -->
          <div v-if="arrivals && arrivals.arrivals.length > 0" class="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2.5 space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-semibold text-slate-400">后续进站计划</span>
              <span
                v-if="arrivals.isExact"
                class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/30"
              >官方时刻</span>
              <span
                v-else
                class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 border border-slate-700/50"
              >推演排班</span>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(a, i) in arrivals.arrivals"
                :key="a.time || i"
                class="rounded-lg border px-2 py-0.5 font-mono text-xs"
                :class="i === 0
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                  : 'border-slate-800 bg-slate-900 text-slate-300'"
              >
                {{ a.time }}
                <span v-if="!a.isAtStation" class="ml-1 text-[11px] text-slate-400">{{ Math.max(1, Math.round(a.etaSeconds / 60)) }}分</span>
                <span v-if="a.stopsAway" class="ml-1 text-[10px] text-slate-500">({{ a.stopsAway }}站)</span>
              </span>
            </div>
          </div>

          <!-- Pin control: makes this stop the route's target on the home cards
               for the direction being viewed. -->
          <!-- Commute board stops: bind this station to a purpose. One station can
               serve both legs; tapping the active purpose unbinds it. -->
          <div v-if="canPin" class="space-y-1">
            <div class="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                class="flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-medium transition active:scale-[0.99] disabled:opacity-60"
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
                class="flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs font-medium transition active:scale-[0.99] disabled:opacity-60"
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
            <p v-if="stopError" class="text-[11px] text-rose-400">{{ stopError }}</p>
          </div>

          <!-- Walk Decision -->
          <div
            v-if="walkDecision"
            class="rounded-xl border p-2.5 space-y-1"
            :class="decisionStyle.border"
          >
            <div class="flex items-center gap-1.5">
              <span class="text-sm">{{ decisionStyle.emoji }}</span>
              <span class="text-xs font-semibold" :class="decisionStyle.text">
                {{ walkDecision.advice }}
              </span>
            </div>
            <div class="flex items-center gap-3 text-[11px] text-slate-400 font-mono">
              <span>步行 {{ Math.round(walkDecision.walkSeconds / 60) }} 分钟 ({{ walkDecision.walkMeters }}米)</span>
              <span v-if="walkDecision.bufferSeconds !== null">
                缓冲 {{ Math.round(walkDecision.bufferSeconds / 60) }} 分
              </span>
            </div>
          </div>
          <button
            v-else-if="hasUserCoords"
            type="button"
            class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300 active:scale-[0.99]"
            :disabled="gisLoading"
            @click="emit('compute-walk')"
          >
            <Footprints class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span>{{ gisLoading ? '正在规划步行路径…' : `计算我到「${station.name}」的赶车决策` }}</span>
          </button>
        </div>

        <!-- Floating UI Precise Arrow: 2-line seamless open V, masks card base line -->
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
