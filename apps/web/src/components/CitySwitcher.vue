<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import {
  Check,
  ChevronDown,
  MapPin,
  Search,
  X,
} from '@lucide/vue'
import {
  onClickOutside,
  useEventListener,
  useScrollLock,
} from '@vueuse/core'
import { useCityStore } from '@/stores/city.store'

const emit = defineEmits<{ (e: 'change', code: string): void }>()

const cityStore = useCityStore()

const rootRef = useTemplateRef('rootEl')
const mobileModalRef = useTemplateRef('mobileModalEl')
const desktopSearchInputRef = useTemplateRef('desktopSearchInputEl')
const mobileSearchInputRef = useTemplateRef('mobileSearchInputEl')

const open = shallowRef(false)
const keyword = shallowRef('')

function onDesktopSearchSubmit(): void {
  if (displayList.value.length === 1) {
    select(displayList.value[0]!.code)
  }
}

function onMobileSearchSubmit(): void {
  if (displayList.value.length === 1) {
    select(displayList.value[0]!.code)
  }
  else {
    mobileSearchInputRef.value?.blur()
  }
}

// Lock background scrolling on mobile while modal is open
const isBodyLocked = useScrollLock(typeof document !== 'undefined' ? document.body : null)

watch(open, (isOpen) => {
  if (typeof window !== 'undefined' && window.innerWidth < 640) {
    isBodyLocked.value = isOpen
  }
})

onClickOutside(rootRef, (e: any) => {
  // Only dismiss via onClickOutside on desktop popover.
  // On mobile, the sheet modal is teleported to <body> with its own backdrop & X button.
  if (typeof window !== 'undefined' && window.innerWidth < 640) return
  if (mobileModalRef.value && e.target && mobileModalRef.value.contains(e.target as Node)) return
  open.value = false
})

useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) {
    open.value = false
  }
})

const matched = computed(() => cityStore.matchCity(keyword.value))

const displayList = computed(() => {
  if (keyword.value.trim()) return matched.value
  return cityStore.cities
})

/** Top 10 high-frequency cities for a clean, non-bloated hot list (2 rows x 5 cols). */
const topHotCities = computed(() => cityStore.hotCities.slice(0, 10))

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    keyword.value = ''
    void nextTick(() => {
      // Focus desktop search if visible; on mobile, avoid autofocus to prevent virtual keyboard from covering screen immediately
      if (window.innerWidth >= 640) {
        desktopSearchInputRef.value?.focus()
      }
    })
  }
}

function select(code: string): void {
  if (code !== cityStore.currentCode) {
    cityStore.setCity(code)
    emit('change', code)
  }
  open.value = false
}

onMounted(() => {
  void cityStore.fetchCities()
})
</script>

<template>
  <div ref="rootEl" class="relative">
    <!-- Trigger Button -->
    <button
      type="button"
      class="flex h-10 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 text-xs font-medium text-slate-200 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95 sm:h-9 sm:px-3"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="选择城市"
      @click.stop="toggle"
    >
      <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
      <span class="max-w-[72px] truncate">{{ cityStore.currentCityName }}</span>
      <ChevronDown
        class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <!-- Desktop Dropdown Panel (sm: and up) -->
    <div class="hidden sm:block">
      <Transition name="fade">
        <div
          v-if="open"
          class="absolute right-0 z-[60] mt-2 w-80 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl backdrop-blur-xl"
          @click.stop
        >
          <!-- Search -->
          <div class="border-b border-slate-800 p-3">
            <form action="" class="relative flex items-center" @submit.prevent="onDesktopSearchSubmit">
              <Search class="pointer-events-none absolute left-3 h-3.5 w-3.5 text-slate-400" />
              <input
                ref="desktopSearchInputEl"
                v-model="keyword"
                type="search"
                enterkeyhint="search"
                placeholder="搜索城市 / 拼音，如 上海、hangzhou"
                class="min-h-[38px] w-full rounded-xl border border-slate-700 bg-slate-950 pl-8 pr-8 text-xs text-white placeholder:text-slate-400 outline-none focus:border-cyan-500"
              >
              <button
                v-if="keyword"
                type="button"
                class="absolute right-2 flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:text-white"
                aria-label="清空搜索"
                @click="keyword = ''"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </form>
          </div>

          <!-- Hot cities -->
          <div v-if="!keyword.trim()" class="border-b border-slate-800/80 p-3">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              热门城市
            </p>
            <div class="grid grid-cols-5 gap-1.5">
              <button
                v-for="c in topHotCities"
                :key="c.code"
                type="button"
                class="flex h-8 items-center justify-center rounded-lg border text-xs transition active:scale-95"
                :class="c.code === cityStore.currentCode
                  ? 'border-cyan-500/50 bg-cyan-500/15 font-semibold text-cyan-300'
                  : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:text-white'"
                @click="select(c.code)"
              >
                {{ c.name }}
              </button>
            </div>
          </div>

          <!-- Scrollable list -->
          <div class="max-h-64 overflow-y-auto p-2">
            <p class="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
              {{ keyword.trim() ? `匹配 ${matched.length} 个城市` : '全部城市' }}
            </p>
            <button
              v-for="c in displayList"
              :key="c.code"
              type="button"
              class="flex min-h-[36px] w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition hover:bg-slate-800"
              :class="c.code === cityStore.currentCode ? 'font-medium text-cyan-300' : 'text-slate-300'"
              @click="select(c.code)"
            >
              <span class="flex items-center gap-2">
                <span>{{ c.name }}</span>
                <span v-if="c.hasMetro" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">地铁</span>
              </span>
              <Check v-if="c.code === cityStore.currentCode" class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            </button>
            <p v-if="displayList.length === 0" class="px-2 py-4 text-center text-xs text-slate-400">
              未找到匹配城市
            </p>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Mobile Bottom Sheet (Screen < sm, teleported to body for clean viewport stacking) -->
    <Teleport to="body">
      <Transition name="sheet">
        <div
          v-if="open"
          class="sheet-wrapper fixed inset-0 z-[90] flex flex-col justify-end sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="选择城市"
        >
          <!-- Backdrop -->
          <div
            class="sheet-backdrop fixed inset-0 bg-slate-950/75 backdrop-blur-sm"
            @click="open = false"
          ></div>

          <!-- Bottom Sheet Modal Content (Stable fixed 82vh height avoids jitter when searching) -->
          <div
            ref="mobileModalEl"
            class="sheet-content relative z-[100] flex h-[82vh] max-h-[85dvh] flex-col rounded-t-3xl border-t border-slate-700/80 bg-slate-900 shadow-2xl"
            @click.stop
          >
            <!-- Top Drag/Pull Indicator -->
            <div class="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-slate-700"></div>

            <!-- Modal Header -->
            <div class="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div class="flex items-center gap-2">
                <h3 class="text-base font-bold text-white">选择城市</h3>
                <span class="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-400">
                  当前: <strong class="font-semibold text-cyan-300">{{ cityStore.currentCityName }}</strong>
                </span>
              </div>
              <button
                type="button"
                class="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white active:scale-95"
                aria-label="关闭城市选择"
                @click="open = false"
              >
                <X class="h-5 w-5" />
              </button>
            </div>

            <!-- Search Bar -->
            <div class="shrink-0 border-b border-slate-800 px-4 pb-3">
              <form action="" class="relative flex items-center" @submit.prevent="onMobileSearchSubmit">
                <Search class="pointer-events-none absolute left-3.5 h-4 w-4 text-slate-400" />
                <input
                  ref="mobileSearchInputEl"
                  v-model="keyword"
                  type="search"
                  enterkeyhint="search"
                  placeholder="搜索城市 / 拼音，如 上海、hangzhou"
                  class="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 pl-10 pr-10 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500"
                >
                <button
                  v-if="keyword"
                  type="button"
                  class="absolute right-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:text-white active:scale-90"
                  aria-label="清空搜索"
                  @click="keyword = ''"
                >
                  <X class="h-4 w-4" />
                </button>
              </form>
            </div>

            <!-- Hot Cities (Compact 2 rows x 5 cols, hidden during active keyword search) -->
            <div v-if="!keyword.trim()" class="shrink-0 border-b border-slate-800/80 px-4 py-3">
              <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                热门城市
              </p>
              <div class="grid grid-cols-5 gap-1.5">
                <button
                  v-for="c in topHotCities"
                  :key="c.code"
                  type="button"
                  class="flex h-9 items-center justify-center rounded-lg border text-xs font-medium transition active:scale-95"
                  :class="c.code === cityStore.currentCode
                    ? 'border-cyan-500/60 bg-cyan-500/20 font-semibold text-cyan-300'
                    : 'border-slate-700/80 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'"
                  @click="select(c.code)"
                >
                  {{ c.name }}
                </button>
              </div>
            </div>

            <!-- Scrollable List (Adapts dynamically to remaining viewport height) -->
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2 pb-6">
              <p class="py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                {{ keyword.trim() ? `匹配结果 (${matched.length})` : '全部城市' }}
              </p>
              <div class="divide-y divide-slate-800/50">
                <button
                  v-for="c in displayList"
                  :key="c.code"
                  type="button"
                  class="flex min-h-[44px] w-full items-center justify-between py-2.5 text-sm transition hover:bg-slate-800/60"
                  :class="c.code === cityStore.currentCode ? 'font-medium text-cyan-300' : 'text-slate-200'"
                  @click="select(c.code)"
                >
                  <span class="flex items-center gap-2">
                    <span>{{ c.name }}</span>
                    <span v-if="c.hasMetro" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">地铁</span>
                  </span>
                  <Check v-if="c.code === cityStore.currentCode" class="h-4 w-4 shrink-0 text-cyan-400" />
                </button>
              </div>
              <p v-if="displayList.length === 0" class="py-8 text-center text-sm text-slate-400">
                未找到匹配城市
              </p>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.22s ease;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-active .sheet-content,
.sheet-leave-active .sheet-content {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.sheet-enter-from .sheet-content,
.sheet-leave-to .sheet-content {
  transform: translateY(100%);
}

/* Suppress native WebKit search cancel/decoration buttons to prevent collision with custom X button */
input[type="search"]::-webkit-search-cancel-button,
input[type="search"]::-webkit-search-decoration,
input[type="search"]::-webkit-search-results-button,
input[type="search"]::-webkit-search-results-decoration {
  -webkit-appearance: none;
  display: none;
}
</style>
