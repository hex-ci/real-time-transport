<script setup lang="ts">
import { ArrowLeft, LocateFixed } from '@lucide/vue'

defineProps<{
  stationOptions: string[]
  landmarkHint: string
  detecting: boolean
}>()

const emit = defineEmits<{
  (e: 'detect'): void
  (e: 'change'): void
}>()

/** 所选站台；由视图持有，因为发车随它切换而重载。 */
const stationName = defineModel<string>({ required: true })
</script>

<template>
  <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-3.5 shadow-xl backdrop-blur-md sm:rounded-3xl sm:p-5 md:p-6">
    <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
      <div>
        <RouterLink
          to="/"
          class="mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg text-xs font-medium text-slate-400 transition hover:text-cyan-300 active:scale-95"
          aria-label="返回总览"
        >
          <ArrowLeft class="h-3.5 w-3.5 shrink-0" />
          <span>返回总览</span>
        </RouterLink>
        <span class="text-xs font-semibold uppercase tracking-wider text-cyan-400">
          虚拟候车亭 · 多线聚合起降牌
        </span>
        <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold text-white sm:mt-1 md:text-2xl">
          当前站台：<span class="max-w-[260px] truncate text-cyan-300">{{ stationName || '选择中...' }}</span>
        </h2>
        <p class="text-xs text-slate-400">
          {{ landmarkHint }} · 按预计到站时间升序排列
        </p>
      </div>

      <div class="flex w-full items-center gap-2 md:w-auto">
        <button
          class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:px-3.5 lg:py-2.5 lg:text-base"
          :disabled="detecting"
          @click="emit('detect')"
        >
          <span class="inline-flex items-center gap-1.5 sm:hidden lg:gap-2">
            <LocateFixed class="h-3.5 w-3.5 shrink-0" />
            <span>{{ detecting ? '扫描中...' : '定位' }}</span>
          </span>
          <span class="hidden items-center gap-1.5 sm:inline-flex lg:gap-2">
            <LocateFixed class="h-3.5 w-3.5 shrink-0" />
            <span>{{ detecting ? '雷达扫描中...' : 'GPS 感知最近站台' }}</span>
          </span>
        </button>
        <select
          v-model="stationName"
          class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-base font-medium text-slate-200 outline-none transition focus:border-cyan-500 md:flex-none md:text-xs lg:px-3.5 lg:py-2.5 lg:text-base"
          @change="emit('change')"
        >
          <option v-for="st in stationOptions" :key="st" :value="st">
            {{ st }}
          </option>
        </select>
      </div>
    </div>
  </div>
</template>
