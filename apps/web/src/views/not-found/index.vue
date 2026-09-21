<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
</script>

<template>
  <div class="mx-auto max-w-lg rounded-3xl border border-slate-800 bg-slate-900/60 p-10 text-center">
    <p class="font-mono text-3xl font-black text-slate-600">404</p>
    <p class="mt-3 text-sm font-semibold text-slate-200 lg:text-base">这个地址没有对应的页面</p>
    <p class="mt-1.5 text-xs text-slate-400 lg:mt-2 lg:text-base">
      线路地址里缺少线路号时会出现这种情况，返回总览重新选择即可
    </p>
    <RouterLink
      to="/"
      class="mt-5 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:text-base"
    >
      <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
      返回总览
    </RouterLink>
  </div>
</template>
