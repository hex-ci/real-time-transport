<script setup lang="ts">
import type { KioskCard } from '../types'

defineProps<{
  cards: KioskCard[]
}>()
</script>

<template>
  <div class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    <div
      v-for="card in cards"
      :key="`${card.lineId}_${card.direction}`"
      class="rounded-2xl border border-slate-800 bg-slate-950 p-4 shadow-xl"
      :class="{ 'md:col-span-2 xl:col-span-3 2xl:col-span-4': cards.length === 1 }"
    >
      <div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <div class="flex items-center gap-2">
          <span
            class="rounded-lg border px-2.5 py-1 font-mono text-sm font-bold whitespace-nowrap lg:px-3 lg:py-1.5 lg:text-base"
            :class="card.isSubway
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
              : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'"
          >
            {{ card.lineName }}
          </span>
          <span class="text-sm font-semibold text-slate-200 lg:text-base">{{ card.directionName }}</span>
        </div>
        <span class="font-mono text-xs text-slate-400">
          {{ card.isSubway ? '官方排班推演' : '实时上游' }}
        </span>
      </div>

      <div class="flex items-center justify-between gap-3 py-3.5 sm:py-4">
        <div class="min-w-0 flex-1">
          <span class="block truncate text-xs text-slate-400 lg:text-base">
            {{ card.targetStationName ? `${card.targetStationName} 进站倒计时` : '目标站（未设置上车点）' }}
          </span>
          <div
            class="truncate font-mono text-2xl font-black sm:text-3xl"
            :class="card.isSubway ? 'text-amber-400' : 'text-cyan-400'"
          >
            <template v-if="card.etaMinutes !== null">
              {{ card.etaMinutes }} <span class="text-sm font-normal text-slate-400">分钟</span>
              <span v-if="card.etaTime" class="ml-1 text-xs font-normal text-slate-400">{{ card.etaTime }}</span>
            </template>
            <template v-else-if="card.targetStationName">
              <span class="font-sans text-base font-normal text-slate-400 sm:text-lg">暂无来车 / 待发车</span>
            </template>
            <template v-else>
              <span class="font-sans text-base font-normal text-slate-400 sm:text-lg">未设置上车点</span>
            </template>
          </div>
        </div>
        <div class="shrink-0 text-right">
          <span class="block text-xs text-slate-400">前方来车</span>
          <div class="flex items-baseline justify-end gap-1 font-mono text-xl font-bold whitespace-nowrap text-emerald-400">
            <span>{{ card.arrivalCount }}</span>
            <span class="text-xs font-normal text-slate-400">班</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
