<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { FlaskConical } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'

const { simulationEnabled } = storeToRefs(useTransitStore())
</script>

<template>
  <!-- 模拟数据横幅：挂在 sticky header 内，故每页可见、不随滚动消失。刻意不可关闭。 -->
  <div
    v-if="simulationEnabled"
    data-simulation-banner
    role="status"
    aria-live="polite"
    class="flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-amber-300"
  >
    <FlaskConical class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span class="text-xs font-semibold tracking-wide">模拟数据模式</span>
    <span class="text-xs text-amber-400/80">
      · 车辆为推演生成，非真实在途数据
    </span>
  </div>
</template>
