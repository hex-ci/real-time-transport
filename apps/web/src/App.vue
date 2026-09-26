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
    <!-- 安全区阶梯：横向 inset 加到各断点自己的 gutter（横屏刘海），底部 inset 加到页面
         gutter（Home 指示条）。底部必须写成 calc()：插件的 offset 变体只接受整数级距，
         而这个 gutter 是 2.5，且 inset 是要加上去、不是替换。 -->
    <main class="w-full pt-2.5 sm:pt-5 px-safe-offset-3 sm:px-safe-offset-6 lg:px-safe-offset-8 xl:px-safe-offset-10 2xl:px-safe-offset-12 pb-[calc(0.625rem+var(--twsa-safe-area-inset-bottom))] sm:pb-[calc(1.25rem+var(--twsa-safe-area-inset-bottom))]">
      <RouterView />
    </main>
  </div>
</template>
