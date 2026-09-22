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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui'
import {
  Check,
  ChevronDown,
  MapPin,
  Search,
  X,
} from '@lucide/vue'
import { useCityStore } from '@/stores/city.store'

const emit = defineEmits<{ (e: 'change', code: string): void }>()

const cityStore = useCityStore()

const desktopOpen = shallowRef(false)
const mobileOpen = shallowRef(false)
const keyword = shallowRef('')

const desktopSearchInputRef = useTemplateRef<HTMLInputElement>('desktopSearchInputEl')
const mobileSearchInputRef = useTemplateRef<HTMLInputElement>('mobileSearchInputEl')

watch(desktopOpen, (isOpen) => {
  if (isOpen) {
    keyword.value = ''
    void nextTick(() => {
      desktopSearchInputRef.value?.focus()
    })
  }
})

watch(mobileOpen, (isOpen) => {
  if (isOpen) {
    keyword.value = ''
  }
})

const matched = computed(() => cityStore.matchCity(keyword.value))

const displayList = computed(() => {
  if (keyword.value.trim()) return matched.value
  return cityStore.cities
})

/** Top 10 high-frequency cities for a clean, non-bloated hot list (2 rows x 5 cols). */
const topHotCities = computed(() => cityStore.hotCities.slice(0, 10))

function select(code: string): void {
  if (code !== cityStore.currentCode) {
    cityStore.setCity(code)
    emit('change', code)
  }
  desktopOpen.value = false
  mobileOpen.value = false
}

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

onMounted(() => {
  void cityStore.fetchCities()
})
</script>

<template>
  <div class="relative">
    <!-- Desktop Popover Flow (md: and up) -->
    <div class="hidden md:block">
      <PopoverRoot v-model:open="desktopOpen">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3 text-xs font-medium text-slate-200 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
            aria-label="选择城市"
          >
            <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span class="max-w-[72px] truncate">{{ cityStore.currentCityName }}</span>
            <ChevronDown
              class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200"
              :class="desktopOpen ? 'rotate-180' : ''"
            />
          </button>
        </PopoverTrigger>

        <PopoverPortal>
          <PopoverContent
            align="end"
            :side-offset="8"
            :collision-padding="16"
            class="z-50 w-80 lg:w-96 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl backdrop-blur-xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
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
                  class="min-h-[38px] w-full rounded-xl border border-slate-700 bg-slate-950 pl-8 pr-8 text-xs text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 lg:pl-9 lg:pr-9 lg:text-base"
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
                class="flex min-h-[36px] w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition hover:bg-slate-800 lg:px-3 lg:py-2 lg:text-base"
                :class="c.code === cityStore.currentCode ? 'font-medium text-cyan-300' : 'text-slate-300'"
                @click="select(c.code)"
              >
                <span class="flex items-center gap-2">
                  <span>{{ c.name }}</span>
                  <span v-if="c.hasMetro" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">地铁</span>
                </span>
                <Check v-if="c.code === cityStore.currentCode" class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              </button>
              <p v-if="displayList.length === 0" class="px-2 py-4 text-center text-xs text-slate-400 lg:py-5 lg:text-base">
                未找到匹配城市
              </p>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <!-- Mobile Trigger & Bottom Sheet (Screens < md, powered by Reka UI Dialog) -->
    <div class="md:hidden">
      <DialogRoot v-model:open="mobileOpen">
        <DialogTrigger as-child>
          <button
            type="button"
            class="flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 text-xs font-medium text-slate-200 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
            aria-label="选择城市"
          >
            <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span class="max-w-[72px] truncate">{{ cityStore.currentCityName }}</span>
            <ChevronDown
              class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200"
              :class="mobileOpen ? 'rotate-180' : ''"
            />
          </button>
        </DialogTrigger>

        <DialogPortal>
          <DialogOverlay class="fixed inset-0 z-[90] bg-slate-950/75 backdrop-blur-sm transition-opacity duration-200 data-[state=open]:opacity-100 data-[state=closed]:opacity-0" />
          <DialogContent
            class="fixed inset-x-0 bottom-0 z-[100] flex h-[82vh] max-h-[85dvh] flex-col rounded-t-3xl border-t border-slate-700/80 bg-slate-900 shadow-2xl focus:outline-none transition-transform duration-250 ease-out data-[state=open]:translate-y-0 data-[state=closed]:translate-y-full"
          >
            <!-- Drag/Pull Indicator -->
            <div class="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-slate-700"></div>

            <!-- Header -->
            <div class="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div class="flex items-center gap-2">
                <DialogTitle class="text-base font-bold text-white">
                  选择城市
                </DialogTitle>
                <span class="rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-400">
                  当前: <strong class="font-semibold text-cyan-300">{{ cityStore.currentCityName }}</strong>
                </span>
              </div>
              <DialogClose as-child>
                <button
                  type="button"
                  class="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white active:scale-95"
                  aria-label="关闭城市选择"
                >
                  <X class="h-5 w-5" />
                </button>
              </DialogClose>
            </div>
            <DialogDescription class="sr-only">
              选择用于查询实时公交和地铁的城市
            </DialogDescription>

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

            <!-- Hot Cities -->
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

            <!-- Scrollable List -->
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2 pb-safe-offset-6">
              <p class="py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                {{ keyword.trim() ? `匹配结果 (${matched.length})` : '全部城市' }}
              </p>
              <div class="divide-y divide-slate-800/50">
                <button
                  v-for="c in displayList"
                  :key="c.code"
                  type="button"
                  class="flex min-h-[44px] w-full items-center justify-between py-2.5 text-sm transition hover:bg-slate-800/60 lg:py-3 lg:text-base"
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
          </DialogContent>
        </DialogPortal>
      </DialogRoot>
    </div>
  </div>
</template>

<style scoped>
/* Suppress native WebKit search cancel/decoration buttons to prevent collision with custom X button */
input[type="search"]::-webkit-search-cancel-button,
input[type="search"]::-webkit-search-decoration,
input[type="search"]::-webkit-search-results-button,
input[type="search"]::-webkit-search-results-decoration {
  -webkit-appearance: none;
  display: none;
}
</style>
