<script setup lang="ts">
defineProps<{
  cityName: string
  clockTime: string
  isWakeLocked: boolean
}>()
</script>

<template>
  <div class="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:p-4 md:p-5 md:flex-row md:items-center md:justify-between">
    <div>
      <h2 class="flex flex-wrap items-center gap-2 text-base font-bold text-white sm:text-lg">
        <span>玄关看板</span>
        <span class="rounded-full border border-cyan-500/30 bg-cyan-500/20 px-2 py-0.5 text-xs font-normal text-cyan-400">
          {{ isWakeLocked ? '屏幕常亮保持中' : '常亮待激活' }}
        </span>
      </h2>
      <p class="mt-0.5 text-xs text-slate-400">
        {{ cityName }} · 专为副屏、平板或玄关挂载优化，低刷省电防息屏
      </p>
    </div>

    <div class="flex items-center gap-2 font-mono text-lg font-bold text-cyan-400 sm:text-xl">
      {{ clockTime }}
    </div>
  </div>
</template>
