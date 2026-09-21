<script setup lang="ts">
import type { DepartureItem } from '../types'

defineProps<{
  items: DepartureItem[]
  loading: boolean
}>()
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
    <!-- Desktop header: hidden on mobile, where the two-row card layout needs no headings -->
    <div class="hidden grid-cols-12 border-b border-slate-800 bg-slate-900/90 px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider md:grid">
      <div class="col-span-3">线路 / 始发</div>
      <div class="col-span-4">开往方向</div>
      <div class="col-span-3 text-right">预计到站</div>
      <div class="col-span-2 text-right">车况 / 状态</div>
    </div>

    <div v-if="loading" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      正在拉取上游实时车况数据...
    </div>

    <div v-else-if="items.length === 0" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路
    </div>

    <div v-else class="divide-y divide-slate-800/60">
      <div
        v-for="item in items"
        :key="item.id"
        class="px-3 py-3 transition hover:bg-slate-900/50 md:grid md:grid-cols-12 md:items-center md:px-4 md:py-3.5"
      >
        <!-- Row 1 (mobile): line badge + direction -->
        <div class="flex items-center gap-2.5 md:col-span-4 md:col-start-1 md:row-start-1">
          <span
            class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 font-mono font-bold text-cyan-400 whitespace-nowrap"
            :class="item.lineName.length > 4 ? 'text-xs min-w-[58px]' : 'text-xs min-w-[44px]'"
          >
            {{ item.lineName }}
          </span>
          <span class="min-w-0 truncate text-xs font-medium text-slate-200 lg:text-base">{{ item.terminal }}</span>
        </div>

        <!-- Row 2 (mobile): ETA + status, right-aligned against row 1's badge column -->
        <div class="mt-2 flex items-end justify-between md:col-span-6 md:col-start-7 md:row-start-1 md:mt-0 md:justify-end md:gap-4">
          <div class="font-mono">
            <template v-if="item.etaMinutes !== null">
              <span class="text-base font-bold text-cyan-400">{{ item.etaMinutes }}</span>
              <span class="text-xs text-slate-400"> 分钟</span>
              <span v-if="item.stopsAway !== null" class="block text-xs text-slate-400">距 {{ item.stopsAway }} 站</span>
            </template>
            <template v-else-if="item.statusText === '暂无来车'">
              <span class="text-xs font-normal text-slate-400">暂无来车</span>
              <span class="block text-xs text-slate-400">待发车/停运</span>
            </template>
            <template v-else-if="item.statusText === '离线'">
              <span class="text-xs font-normal text-slate-400">接口离线</span>
              <span class="block text-xs text-slate-400">数据暂不可用</span>
            </template>
            <template v-else>
              <!-- Vehicle en route but upstream provides no ETA -->
              <span class="text-xs font-normal text-slate-400">无法估算</span>
              <span class="block text-xs text-slate-400">上游未提供到站耗时</span>
            </template>
          </div>

          <span
            class="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
            :class="item.etaMinutes !== null ? (item.congestion === 'high' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300') : 'bg-slate-800 text-slate-400'"
          >
            {{ item.statusText }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
