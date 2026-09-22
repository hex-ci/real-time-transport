<script setup lang="ts">
import { onMounted } from 'vue'
import { HeaderNav } from '@/components/header-nav'
import { useTransitStore } from '@/stores/transit.store'

const transitStore = useTransitStore()

onMounted(() => {
  void transitStore.fetchRuntimeFlags()
  transitStore.initWs()
})
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-950 font-sans text-slate-100 antialiased selection:bg-cyan-500 selection:text-white">
    <HeaderNav />
    <!-- Safe-area ladder. The horizontal inset is added to each breakpoint's own
         gutter (landscape notch); the bottom inset to the page gutter (home
         indicator). The bottom one is spelled out as calc() because the plugin's
         offset variant only takes whole spacing steps and this gutter is 2.5 —
         and because the inset has to be added to it, not swapped in. -->
    <main class="w-full pt-2.5 sm:pt-5 px-safe-offset-3 sm:px-safe-offset-6 lg:px-safe-offset-8 xl:px-safe-offset-10 2xl:px-safe-offset-12 pb-[calc(0.625rem+var(--twsa-safe-area-inset-bottom))] sm:pb-[calc(1.25rem+var(--twsa-safe-area-inset-bottom))]">
      <RouterView />
    </main>
  </div>
</template>
