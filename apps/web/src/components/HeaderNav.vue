<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { Bus, ChevronRight, Clock, Menu, Settings, Tv, X } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'
import CitySwitcher from '@/components/CitySwitcher.vue'
import SimulationBanner from '@/components/SimulationBanner.vue'

const transitStore = useTransitStore()
const router = useRouter()
const route = useRoute()
const { wsConnected } = storeToRefs(transitStore)

const mobileMenuOpen = shallowRef(false)

const navItems = [
  { to: '/', label: '关注线路', icon: Bus },
  { to: '/platform', label: '站台大屏', icon: Clock },
  { to: '/kiosk', label: '玄关看板', icon: Tv },
  { to: '/settings', label: '设置', icon: Settings },
]

// Auto-close mobile menu on route change
watch(() => route.fullPath, () => {
  mobileMenuOpen.value = false
})

function onCityChange(): void {
  // City switched: refresh favorites for the new city and go home
  void transitStore.fetchFavorites()
  if (router.currentRoute.value.name !== 'overview') {
    void router.push('/')
  }
}
</script>

<template>
  <header class="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
    <!-- Simulation strip inside the sticky header: always on screen on every
         page, and it keeps the header's positioning context for the mobile menu. -->
    <SimulationBanner />
    <div class="flex w-full items-center justify-between px-3 py-1.5 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 sm:py-3">
      <!-- Brand -->
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

      <!-- Desktop Nav Items: hidden on mobile, visible on tablet/desktop (md:) -->
      <nav class="hidden md:flex items-center gap-2">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-slate-300 transition hover:bg-slate-800 hover:text-white"
          active-class="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- Right Controls: WS Status (desktop), City Switcher, Mobile Hamburger -->
      <div class="flex shrink-0 items-center gap-2 sm:gap-3">
        <div class="hidden lg:flex items-center gap-2 text-xs">
          <span
            class="inline-block h-2 w-2 rounded-full"
            :class="wsConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)] animate-pulse' : 'bg-amber-400 animate-ping'"
          ></span>
          <span class="font-mono text-xs text-slate-400">
            {{ wsConnected ? 'LIVE WS' : 'CONNECTING' }}
          </span>
        </div>

        <CitySwitcher @change="onCityChange" />

        <!-- Mobile Hamburger Toggle: exact 40x40 (h-10 w-10), matching CitySwitcher's 40px height -->
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

    <!-- Mobile Floating Navigation Panel: absolute overlay, NEVER pushes page content down -->
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
        class="absolute inset-x-0 top-full z-50 border-b border-slate-800 bg-slate-950/95 px-4 py-3 shadow-2xl backdrop-blur-xl md:hidden"
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

        <!-- Live WS Status in Mobile Menu -->
        <div class="mt-3 flex items-center justify-between border-t border-slate-800/80 px-1 pt-2.5 text-xs text-slate-400">
          <span class="flex items-center gap-1.5">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="wsConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.9)] animate-pulse' : 'bg-amber-400 animate-ping'"
            ></span>
            <span class="font-mono text-xs">
              {{ wsConnected ? '实时 WebSocket 已连接' : 'WebSocket 正在连接...' }}
            </span>
          </span>
          <span class="font-mono text-xs text-slate-400">REALTIME</span>
        </div>
      </div>
    </Transition>
  </header>

  <!-- Mobile Backdrop Overlay: closes menu on tap outside -->
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
