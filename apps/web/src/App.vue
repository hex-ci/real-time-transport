<script setup lang="ts">
import { onMounted } from 'vue'
import HeaderNav from '@/components/HeaderNav.vue'
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
    <main class="w-full px-3 py-2.5 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 sm:py-5">
      <RouterView />
    </main>
  </div>
</template>
