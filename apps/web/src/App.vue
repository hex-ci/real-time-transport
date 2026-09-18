<script setup lang="ts">
import { onMounted } from 'vue'
import HeaderNav from '@/components/HeaderNav.vue'
import { useTransitStore } from '@/stores/transit.store'

const transitStore = useTransitStore()

onMounted(() => {
  transitStore.initWs()
})
</script>

<template>
  <div class="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased selection:bg-cyan-500 selection:text-white">
    <HeaderNav />
    <main class="mx-auto max-w-[1200px] px-3 py-2.5 sm:px-6 sm:py-5">
      <RouterView />
    </main>
  </div>
</template>
