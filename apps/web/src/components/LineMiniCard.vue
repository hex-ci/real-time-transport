<script setup lang="ts">
import { computed } from 'vue'
import type { LiveBus } from '@real-time-transport/shared'

const {
  buses = [],
  targetOrder = 0,
  totalStops = 0,
  detailLoaded = false,
  isSubway = false,
} = defineProps<{
  lineName: string
  directionName: string
  startStop: string
  endStop: string
  buses?: LiveBus[]
  targetOrder?: number
  totalStops?: number
  detailLoaded?: boolean
  /** Subway routes are tinted amber, buses cyan — same rule as the kiosk board. */
  isSubway?: boolean
}>()

defineEmits<{
  (e: 'click'): void
}>()

/**
 * Accent palette, kept in one place so every cyan element on the card follows the
 * route type. Mirrors KioskView: subway = amber, bus = cyan.
 */
const accent = computed(() => (isSubway
  ? {
      badgeBorder: 'border-amber-500/20',
      badgeBg: 'bg-amber-500/10',
      badgeText: 'text-amber-400',
      badgeShadow: 'shadow-[0_0_12px_rgba(245,158,11,0.2)]',
      headingHover: 'group-hover:text-amber-300',
      trackFill: 'bg-amber-500/40',
      dot: 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.9)]',
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
      trackFill: 'bg-cyan-500/40',
      dot: 'bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.9)]',
      etaText: 'text-cyan-400',
      spinner: 'border-t-cyan-400',
      hoverBorder: 'hover:border-cyan-500/50',
    }))

const vehicleCount = computed(() => buses.length)

/** Whether a real target stop is set (pinned station or GPS-nearest). */
const hasTarget = computed(() => targetOrder > 0 && totalStops > 0)

/** Buses with a known position (order) can be placed on the mini track. */
const positionedBuses = computed(() => buses.filter(b => typeof b.order === 'number'))

const busPositions = computed(() => {
  const total = Math.max(totalStops, 1)
  return positionedBuses.value
    .map(b => Math.min(Math.max(((b.order as number) / total) * 100, 4), 96))
})

const trackProgress = computed(() => {
  const total = Math.max(totalStops, 1)
  return Math.min((targetOrder / total) * 100, 100)
})

// Calculate ETA to target
const nextBus = computed(() => {
  if (buses.length === 0) return null
  const upcoming = buses
    .filter(b => typeof b.order === 'number' && (b.order as number) <= targetOrder)
    .sort((a, b) => (b.order as number) - (a.order as number))
  return upcoming[0] || null
})

const stopsRemaining = computed(() => {
  if (!nextBus.value || typeof nextBus.value.order !== 'number') return null
  return Math.max(1, targetOrder - nextBus.value.order)
})

const nextEtaMinutes = computed(() => {
  if (!nextBus.value) return null
  if (nextBus.value.travelTimeSec) {
    return Math.max(1, Math.round(nextBus.value.travelTimeSec / 60))
  }
  // No travel time from upstream: refuse to fabricate an estimate
  return null
})

const nextDistanceKm = computed(() => {
  if (!nextBus.value) return null
  if (nextBus.value.distanceToWaitStn) {
    return (nextBus.value.distanceToWaitStn / 1000).toFixed(1)
  }
  // No distance from upstream: display honestly as missing
  return null
})

const congestionText = computed(() => {
  if (vehicleCount.value === 0) return '待发车/停运'
  const c = nextBus.value?.congestion
  if (c === 'high') return '较拥挤'
  if (c === 'medium') return '稍缓行'
  return '畅通快捷'
})
</script>

<template>
  <div
    class="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg backdrop-blur-md transition hover:bg-slate-900"
    :class="accent.hoverBorder"
    @click="$emit('click')"
  >
    <!-- Card Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <span
          class="flex h-9 shrink-0 items-center justify-center rounded-xl border px-2.5 font-mono font-bold whitespace-nowrap"
          :class="[accent.badgeBorder, accent.badgeBg, accent.badgeText, accent.badgeShadow, lineName.length > 4 ? 'text-xs min-w-[64px]' : lineName.length > 3 ? 'text-sm min-w-[52px]' : 'text-base min-w-[44px]']"
        >
          {{ lineName }}
        </span>
        <div>
          <h3 class="text-sm font-semibold text-slate-100 transition" :class="accent.headingHover">
            {{ directionName }}
          </h3>
          <p class="text-xs text-slate-400">
            {{ startStop }} ➔ {{ endStop }}
          </p>
        </div>
      </div>

      <!-- Live Vehicle Badge -->
      <span
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
        :class="vehicleCount > 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/60 text-slate-400'"
      >
        <span
          v-if="vehicleCount > 0"
          class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
        ></span>
        {{ vehicleCount > 0 ? `在途 ${vehicleCount} 辆` : '暂无在途' }}
      </span>
    </div>

    <!-- Loading state: detail not yet resolved from the API -->
    <template v-if="!detailLoaded">
      <div class="my-3.5 flex items-center justify-center rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-400">
        <span class="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600" :class="accent.spinner"></span>
        正在加载线路数据...
      </div>
      <div class="pt-1 text-xs text-slate-400">
        站序与实时车况加载中
      </div>
    </template>

    <template v-else>
      <!-- Mini Sparkline (Micro topological track) — only with a known target stop -->
      <div v-if="targetOrder > 0 && totalStops > 0" class="relative my-3.5 h-6 w-full overflow-hidden rounded-lg bg-slate-950/80 px-3 py-1 flex items-center">
        <div class="relative h-1 w-full rounded-full bg-slate-800">
          <!-- Progress track -->
          <div class="h-full rounded-full" :class="accent.trackFill" :style="{ width: `${trackProgress}%` }"></div>

          <!-- Bus Dots along the mini track -->
          <div
            v-for="(pos, idx) in busPositions"
            :key="idx"
            class="absolute -top-1 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-slate-950"
            :class="accent.dot"
            :style="{ left: `${pos}%` }"
          ></div>
        </div>
      </div>
      <div v-else class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-400 text-center">
        未指定目标站（关注时固定站点或开启定位后可显示车辆位置）
      </div>

      <!-- Core ETA Metrics -->
      <div class="flex items-center justify-between pt-1">
        <div v-if="vehicleCount > 0 && nextEtaMinutes !== null">
          <span class="text-xs text-slate-400">最近来车预计 </span>
          <span class="font-mono text-xl font-black tracking-tight" :class="accent.etaText">{{ nextEtaMinutes }}</span>
          <span class="text-xs font-semibold" :class="accent.etaText"> 分钟</span>
          <span v-if="stopsRemaining !== null && nextDistanceKm !== null" class="ml-2 text-xs text-slate-400 font-mono">
            ({{ stopsRemaining }} 站 · {{ nextDistanceKm }}km)
          </span>
          <span v-else class="ml-2 text-xs text-slate-400 font-mono">(位置信息暂无)</span>
        </div>
        <div v-else-if="vehicleCount > 0" class="flex items-center gap-2">
          <span class="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            {{ hasTarget ? '上游未提供到站耗时，无法估算' : '未指定目标站，无法计算到站时间' }}
          </span>
        </div>
        <div v-else>
          <span class="text-xs text-slate-400 font-medium">当前线路上暂无在途车辆</span>
        </div>

        <div class="text-right">
          <span
            class="inline-block rounded-md px-2 py-0.5 text-xs"
            :class="vehicleCount > 0 ? 'bg-slate-800 text-slate-300' : 'bg-slate-800/60 text-slate-400'"
          >
            {{ congestionText }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
