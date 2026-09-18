<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { Check, ChevronDown, MapPin } from '@lucide/vue'
import { onClickOutside } from '@vueuse/core'
import { useCityStore } from '@/stores/city.store'

const emit = defineEmits<{ (e: 'change', code: string): void }>()

const cityStore = useCityStore()
const rootRef = useTemplateRef('rootEl')
const open = ref(false)
const keyword = ref('')
const searchInputRef = useTemplateRef('searchInputEl')

onClickOutside(rootRef, () => {
  open.value = false
})

const matched = computed(() => cityStore.matchCity(keyword.value))

const displayList = computed(() => {
  if (keyword.value.trim()) return matched.value
  // No keyword: show all (hot already sorted first by store)
  return cityStore.cities
})

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    keyword.value = ''
    void nextTick(() => searchInputRef.value?.focus())
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
    <!-- Trigger -->
    <button
      class="flex h-10 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 text-xs font-medium text-slate-200 shadow-sm transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95 sm:h-9 sm:px-3"
      @click.stop="toggle"
    >
      <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
      <span class="max-w-[72px] truncate">{{ cityStore.currentCityName }}</span>
      <ChevronDown class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200" :class="open ? 'rotate-180' : ''" />
    </button>

    <!-- Dropdown Panel -->
    <Transition name="fade">
      <div
        v-if="open"
        class="absolute right-0 z-[60] mt-2 w-72 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl backdrop-blur-xl"
        @click.stop
      >
        <!-- Search -->
        <div class="border-b border-slate-800 p-3">
          <!-- text-base prevents iOS Safari from zoom-jumping the page on focus -->
          <input
            ref="searchInputEl"
            v-model="keyword"
            type="text"
            placeholder="搜索城市 / 拼音，如 上海、hangzhou"
            class="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 sm:text-xs"
          >
        </div>

        <!-- Hot cities -->
        <div v-if="!keyword.trim()" class="p-3">
          <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            热门城市
          </p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="c in cityStore.hotCities"
              :key="c.code"
              class="min-h-[36px] rounded-lg border px-3 py-1.5 text-xs transition"
              :class="c.code === cityStore.currentCode
                ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
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
            class="flex min-h-[40px] w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs transition hover:bg-slate-800"
            :class="c.code === cityStore.currentCode ? 'text-cyan-300' : 'text-slate-300'"
            @click="select(c.code)"
          >
            <span class="flex items-center gap-2">
              <span>{{ c.name }}</span>
              <span v-if="c.hasMetro" class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">地铁</span>
            </span>
            <Check v-if="c.code === cityStore.currentCode" class="h-4 w-4 shrink-0 text-cyan-400" />
          </button>
          <p v-if="displayList.length === 0" class="px-2 py-4 text-center text-xs text-slate-400">
            未找到匹配城市
          </p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
