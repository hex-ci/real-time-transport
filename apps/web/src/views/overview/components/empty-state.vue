<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'

defineProps<{
  cityName: string
}>()
</script>

<template>
  <div class="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
    <p class="text-sm text-slate-400 lg:text-base">
      当前城市（{{ cityName }}）还没有关注线路
    </p>
    <RouterLink
      to="/settings"
      class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 lg:gap-1.5 lg:px-4.5 lg:py-2.5 lg:text-base"
    >
      <span>去搜索并关注线路</span>
      <ChevronRight class="h-3.5 w-3.5" />
    </RouterLink>
  </div>
</template>
