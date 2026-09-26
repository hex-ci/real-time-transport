<script setup lang="ts">
import { ArrowLeft, ArrowLeftRight, Info } from '@lucide/vue'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'

defineProps<{
  detail: LineDetail
  liveStatus: LiveLineStatus | null
  canSwitchDirection: boolean
  accent: { lineName: string, stops: string }
}>()

const emit = defineEmits<{
  (e: 'switch-direction'): void
  (e: 'show-info'): void
}>()
</script>

<template>
  <!-- 移动端单行头部：约 44px 高，把 80%+ 的屏幕留给画布（md 以下） -->
  <div class="flex md:hidden shrink-0 items-center justify-between gap-1.5 rounded-xl border border-slate-800 bg-slate-900/90 px-2 py-1.5 shadow-md">
    <div class="flex min-w-0 items-center gap-1.5">
      <RouterLink
        to="/"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 active:scale-95"
        aria-label="返回总览"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
      </RouterLink>

      <!-- 可点的线路徽标：打开完整线路详情面板。 -->
      <button
        class="flex h-8 shrink-0 items-center justify-center rounded-lg border px-2 font-mono text-xs font-bold whitespace-nowrap active:scale-95"
        :class="accent.lineName"
        title="点击查看线路详情"
        @click="emit('show-info')"
      >
        {{ detail.lineName }}
      </button>

      <!-- 方向与快速切换。 -->
      <div class="flex min-w-0 items-center gap-1">
        <span class="min-w-0 truncate text-xs font-bold text-white">
          {{ detail.directionName }}
        </span>
        <button
          v-if="canSwitchDirection"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-cyan-400 active:scale-95"
          title="切换反向"
          aria-label="切换反向"
          @click="emit('switch-direction')"
        >
          <ArrowLeftRight class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- 右侧：在途车辆数芯片与详情入口。 -->
    <button
      class="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2 text-xs font-mono active:scale-95"
      title="在途车辆与线路详情"
      @click="emit('show-info')"
    >
      <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
      <span class="font-bold text-emerald-400">{{ liveStatus?.buses.length || 0 }}</span>
      <span class="text-xs text-slate-400">车</span>
      <Info class="h-3.5 w-3.5 text-slate-400" />
    </button>
  </div>
</template>
