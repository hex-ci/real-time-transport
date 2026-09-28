<script setup lang="ts">
import { onMounted } from 'vue'
import { Toaster } from 'vue-sonner'
import { HeaderNav } from '@/components/header-nav'
import { useTransitStore } from '@/stores/transit.store'

const transitStore = useTransitStore()

/**
 * 顶部提示往上避让多少。
 *
 * 它固定在视口上，逃出了 `<main>` 为每个路由加的安全区留白，故自己加上 notch 那一段；
 * 后半个数是全站控件之间那一个间距。
 */
const TOAST_OFFSET = 'calc(env(safe-area-inset-top, 0px) + 0.625rem)'

/** 条目样式对齐全站：本仓的圆角与边框、暗底、12px 正文。 */
const TOAST_ITEM_CLASS = 'rounded-xl border border-slate-700 bg-slate-800/90 text-xs'

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
    <!-- 全站唯一一份提示宿主：三页共用，页面只说结局。位置在顶部居中 —— 底部被导航与 Home
         指示条占着，且它是移动优先的。库自带的那条 live region 负责播报。 -->
    <Toaster
      theme="dark"
      position="top-center"
      close-button
      :offset="TOAST_OFFSET"
      :mobile-offset="TOAST_OFFSET"
      :toast-options="{ class: TOAST_ITEM_CLASS }"
    />
  </div>
</template>
