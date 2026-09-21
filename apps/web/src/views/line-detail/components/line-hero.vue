<script setup lang="ts">
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'

defineProps<{
  detail: LineDetail
  liveStatus: LiveLineStatus | null
  /** Subway vs bus accent classes, resolved by the view (one rule, one place). */
  accent: { lineName: string, stops: string }
}>()
</script>

<template>
  <div class="hidden md:block shrink-0 overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-5 shadow-xl">
    <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
      <div class="flex items-center gap-2.5 sm:gap-3.5">
        <div
          class="flex h-11 shrink-0 items-center justify-center rounded-xl border px-3 font-mono font-black whitespace-nowrap sm:h-14 sm:rounded-2xl sm:px-3.5"
          :class="[
            accent.lineName,
            detail.lineName.length > 4 ? 'text-base min-w-[74px] sm:text-lg sm:min-w-[88px]' : detail.lineName.length > 3 ? 'text-lg min-w-[62px] sm:text-xl sm:min-w-[76px]' : 'text-xl min-w-[54px] sm:text-2xl sm:min-w-[64px]',
          ]"
        >
          {{ detail.lineName }}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="min-w-0 truncate text-base font-bold text-white sm:text-2xl">
              {{ detail.directionName }}
            </h2>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold border" :class="accent.stops">
              {{ detail.stops.length }} 站
            </span>
          </div>
          <p class="mt-0.5 text-xs text-slate-400 font-mono">
            首末班：{{ detail.firstBusTime || '--:--' }} - {{ detail.lastBusTime || '--:--' }}
            <span class="ml-2 text-slate-400">· {{ detail.type === 'subway' ? '官方排班推演' : '实时上游数据' }}</span>
          </p>
        </div>
      </div>

      <!-- Metric Badges -->
      <div class="flex shrink-0 items-center gap-2 text-xs">
        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">当前在途</span>
          <span class="font-mono text-sm font-bold text-emerald-400 sm:text-base">
            {{ liveStatus?.buses.length || 0 }}
          </span>
          <span class="text-slate-400 text-xs leading-none"> 辆</span>
        </div>

        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">营运状态</span>
          <span
            class="font-mono text-xs font-semibold"
            :class="(liveStatus?.buses.length || 0) > 0 ? 'text-emerald-400' : 'text-slate-400'"
          >
            {{ (liveStatus?.buses.length || 0) > 0 ? '营运中' : '待发车/停运' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
