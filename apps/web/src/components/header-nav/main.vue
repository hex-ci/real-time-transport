<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { Bus, ChevronRight, Clock, Menu, Settings, Waypoints, X } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'
import { CitySwitcher } from '@/components/city-switcher'
import { SimulationBanner } from '@/components/simulation-banner'
import { GpsSimulationBanner } from '@/components/gps-simulation-banner'

const transitStore = useTransitStore()
const router = useRouter()
const route = useRoute()
const { wsConnected } = storeToRefs(transitStore)

const mobileMenuOpen = shallowRef(false)

const navItems = [
  { to: '/', label: '关注线路', icon: Bus },
  // 换乘链路与首页同级：它服务出门前那一刻。
  { to: '/commute-chain', label: '换乘链路', icon: Waypoints },
  { to: '/platform', label: '站台大屏', icon: Clock },
  { to: '/settings', label: '设置', icon: Settings },
]

watch(() => route.fullPath, () => {
  mobileMenuOpen.value = false
})

function onCityChange(): void {
  void transitStore.fetchFavorites()
  if (router.currentRoute.value.name !== 'overview') {
    void router.push('/')
  }
}
</script>

<template>
  <header class="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 pt-safe backdrop-blur-xl">
    <!-- 模拟横幅挂在 sticky header 内：每页常驻，并为移动菜单保留定位上下文；两者颜色刻意区分。 -->
    <SimulationBanner />
    <GpsSimulationBanner />
    <!-- lg:py-2.5 抵消更高的 text-base 导航项，使 sticky header 保持原高度 -->
    <div class="flex w-full items-center justify-between px-safe-offset-3 py-1.5 sm:px-safe-offset-6 lg:px-safe-offset-8 xl:px-safe-offset-10 2xl:px-safe-offset-12 sm:py-3 lg:py-2.5">
      <!-- 品牌 -->
      <RouterLink to="/" class="flex shrink-0 items-center gap-2.5 transition hover:opacity-90">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.4)]">
          <span class="text-sm font-black">RT</span>
        </div>
        <div>
          <h1 class="text-base font-bold tracking-wide text-slate-100 flex items-center gap-1.5">
            实时交通
          </h1>
        </div>
      </RouterLink>

      <!-- 桌面导航项：移动端隐藏，md: 起显示 -->
      <nav class="hidden md:flex items-center gap-2">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-slate-300 transition hover:bg-slate-800 hover:text-white lg:px-3 lg:py-2 lg:text-base"
          active-class="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- 右侧控件：连接状态（桌面）、城市切换、移动端汉堡 -->
      <div class="flex shrink-0 items-center gap-2 sm:gap-3">
        <div class="hidden lg:flex items-center gap-2 text-xs">
          <span
            class="inline-block h-2 w-2 rounded-full"
            :class="wsConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)] animate-pulse' : 'bg-amber-400 animate-ping'"
          ></span>
          <span class="font-mono text-xs text-slate-400">
            {{ wsConnected ? '已连接' : '连接中' }}
          </span>
        </div>

        <CitySwitcher @change="onCityChange" />

        <!-- 移动端汉堡按钮：精确 40×40（h-10 w-10），与 CitySwitcher 的 40px 高度对齐 -->
        <button
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800/80 text-slate-300 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95 md:hidden"
          :class="mobileMenuOpen ? 'border-cyan-500/50 text-cyan-400 bg-slate-800' : ''"
          :aria-label="mobileMenuOpen ? '关闭导航菜单' : '打开导航菜单'"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <Menu v-if="!mobileMenuOpen" class="h-5 w-5" />
          <X v-else class="h-5 w-5 text-cyan-400" />
        </button>
      </div>
    </div>

    <!-- 移动端浮动导航面板：绝对定位浮层，绝不把页面内容往下推 -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div
        v-if="mobileMenuOpen"
        class="absolute inset-x-0 top-full z-50 border-b border-slate-800 bg-slate-950/95 px-safe-offset-4 py-3 shadow-2xl backdrop-blur-xl md:hidden"
      >
        <nav class="flex flex-col gap-1.5">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="flex min-h-[44px] items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white active:scale-[0.99]"
            active-class="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
            @click="mobileMenuOpen = false"
          >
            <div class="flex items-center gap-3">
              <component :is="item.icon" class="h-4.5 w-4.5 shrink-0 text-cyan-400" />
              <span>{{ item.label }}</span>
            </div>
            <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" />
          </RouterLink>
        </nav>

        <!-- 移动菜单里的实时连接状态 -->
        <div class="mt-3 flex items-center justify-between border-t border-slate-800/80 px-1 pt-2.5 text-xs text-slate-400">
          <span class="flex items-center gap-1.5">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="wsConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)] animate-pulse' : 'bg-amber-400 animate-ping'"
            ></span>
            <span class="font-mono text-xs">
              {{ wsConnected ? '实时数据已连接' : '正在连接实时数据…' }}
            </span>
          </span>
          <span class="font-mono text-xs text-slate-400">REALTIME</span>
        </div>
      </div>
    </Transition>
  </header>

  <!-- 移动端背景遮罩：点击外部关闭菜单 -->
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="mobileMenuOpen"
      class="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs md:hidden"
      @click="mobileMenuOpen = false"
    ></div>
  </Transition>
</template>
