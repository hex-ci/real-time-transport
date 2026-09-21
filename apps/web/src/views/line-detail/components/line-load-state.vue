<script setup lang="ts">
defineProps<{
  isLoading: boolean
  loadError: string | null
}>()
</script>

<template>
  <div class="shrink-0 rounded-3xl border border-slate-800 bg-slate-900/60 p-12 text-center">
    <template v-if="isLoading">
      <p class="text-sm text-slate-400 lg:text-base">正在加载线路数据...</p>
    </template>
    <template v-else>
      <p class="text-sm font-semibold text-rose-400 lg:text-base">{{ loadError || '线路不存在或数据源暂不可用' }}</p>
      <p class="mt-1.5 text-xs text-slate-400 lg:mt-2 lg:text-base">上游实时接口未能返回该线路数据，请稍后重试或检查线路号</p>
    </template>
  </div>
</template>
