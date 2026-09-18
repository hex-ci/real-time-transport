<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { MapPin } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import { isBidirectional, type LineGroup } from '@real-time-transport/shared'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const searchKeyword = ref('')
const searchResults = ref<LineGroup[]>([])
const searched = ref(false)
const lastKeyword = ref('')

onMounted(() => {
  void transitStore.fetchFavorites()
})

/** Only show favorites belonging to the currently selected city. */
const cityFavorites = computed(() =>
  favorites.value.filter(f => (f.cityCode || '027') === cityStore.currentCode),
)

async function performSearch(): Promise<void> {
  const kw = searchKeyword.value.trim()
  if (!kw) return
  searched.value = true
  lastKeyword.value = kw
  searchResults.value = await transitStore.searchLines(kw, cityStore.currentCode)
}

/** A route is followed when either of its direction lineIds is favourited. */
function isRouteFollowed(item: LineGroup): boolean {
  const ids = new Set<string>()
  if (item.up) ids.add(item.up.lineId)
  if (item.down) ids.add(item.down.lineId)
  return favorites.value.some(f =>
    (f.cityCode || '027') === item.cityCode
    && (ids.has(f.lineId) || (f.reverseLineId !== undefined && ids.has(f.reverseLineId))),
  )
}

/**
 * Follow a route ONCE — both directions ride along when the upstream reported
 * both. `lineId` is the direction we store as primary; `reverseLineId` is the
 * other direction's lineId (bus routes use a distinct id per direction, subway
 * reuses the same id). When only one direction exists, `reverseLineId` stays
 * undefined so the UI does not offer a switch that cannot resolve.
 */
function addFavorite(item: LineGroup): void {
  if (isRouteFollowed(item)) return

  const primary = item.up ?? item.down
  if (!primary) return
  const other = item.up ? item.down : item.up

  void transitStore.addFavorite({
    lineId: primary.lineId,
    lineName: item.lineName,
    preferredDirection: primary.direction,
    reverseLineId: other ? other.lineId : undefined,
    cityCode: item.cityCode || cityStore.currentCode,
  })
  searchResults.value = []
  searchKeyword.value = ''
  searched.value = false
}

function removeFavorite(idx: number): void {
  const target = cityFavorites.value[idx]
  if (!target) return
  void transitStore.removeFavorite(target.id || target.lineId)
}

// Clear search state when the city changes
watch(() => cityStore.currentCode, () => {
  searchResults.value = []
  searchKeyword.value = ''
  searched.value = false
})
</script>

<template>
  <div class="space-y-6 pb-12">
    <!-- Title -->
    <div>
      <h2 class="text-xl font-bold text-white sm:text-2xl">
        设置与管理
      </h2>
      <p class="mt-1 text-xs text-slate-400">
        管理日常通勤关注的公交和地铁线路
      </p>
    </div>

    <!-- Search & Add Lines -->
    <div class="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-slate-200">
          搜索添加线路
        </h3>
        <span class="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-400">
          <MapPin class="h-3 w-3 shrink-0" />
          <span>{{ cityStore.currentCityName }}</span>
        </span>
      </div>
      <div class="mt-3 flex gap-2">
        <!-- min-h-[44px] keeps both controls inside the Apple HIG touch-target
             size; 16px input text stops iOS Safari from zoom-jumping on focus. -->
        <input
          v-model="searchKeyword"
          type="text"
          placeholder="输入线路号，如 372、地铁10号线、亦庄线..."
          class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 sm:text-xs"
          @keyup.enter="performSearch"
        >
        <button
          class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 sm:px-4 sm:text-xs"
          @click="performSearch"
        >
          搜索
        </button>
      </div>

      <!-- Search Results: ONE row per route, both directions bundled -->
      <div v-if="searchResults.length > 0" class="mt-4 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950">
        <div
          v-for="item in searchResults"
          :key="item.groupKey"
          class="flex items-center justify-between gap-2 p-3 text-xs"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-mono font-bold text-cyan-400">{{ item.lineName }}</span>
              <span
                v-if="isBidirectional(item)"
                class="rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-xs font-medium text-cyan-400 whitespace-nowrap"
              >
                上下行
              </span>
              <span
                v-else
                class="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-xs font-medium text-slate-300 whitespace-nowrap"
              >
                单向
              </span>
            </div>
            <div v-if="item.up" class="mt-1 truncate text-xs text-slate-400">
              <span class="text-emerald-500/80">去</span> {{ item.up.startStop }} ➔ {{ item.up.endStop }}
            </div>
            <div v-if="item.down" class="mt-0.5 truncate text-xs text-slate-400">
              <span class="text-violet-500/80">回</span> {{ item.down.startStop }} ➔ {{ item.down.endStop }}
            </div>
          </div>
          <button
            class="min-h-[44px] shrink-0 rounded-lg bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-cyan-500 hover:text-slate-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isRouteFollowed(item)"
            @click="addFavorite(item)"
          >
            {{ isRouteFollowed(item) ? '已关注' : '关注' }}
          </button>
        </div>
      </div>
      <p v-else-if="searched && searchResults.length === 0" class="mt-4 text-center text-xs text-slate-400">
        在 {{ cityStore.currentCityName }} 未找到匹配「{{ lastKeyword }}」的线路
      </p>
    </div>

    <!-- Pinned Lines Management -->
    <div class="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-slate-200">
          已关注线路列表 ({{ cityFavorites.length }})
        </h3>
        <span class="text-xs text-slate-400">仅显示 {{ cityStore.currentCityName }}</span>
      </div>

      <div v-if="cityFavorites.length > 0" class="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950">
        <div
          v-for="(item, idx) in cityFavorites"
          :key="item.id || item.lineId"
          class="flex min-h-[52px] items-center justify-between p-3 text-xs"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 font-mono font-bold whitespace-nowrap text-cyan-400"
              :class="(item.lineName || '').length > 4 ? 'text-xs min-w-[54px]' : 'text-xs min-w-[36px]'"
            >
              {{ item.lineName || '线路' }}
            </span>
            <span class="text-xs text-slate-400">
              {{ item.reverseLineId ? '上下行均已关注' : '单方向' }}
            </span>
          </div>
          <!-- min-h-40 + px-3: comfortable touch target with balanced vertical baseline -->
          <button
            class="min-h-[40px] shrink-0 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95"
            @click="removeFavorite(idx)"
          >
            取消关注
          </button>
        </div>
      </div>

      <div v-else class="p-6 text-center text-xs text-slate-400">
        暂无关注线路，请在上方的搜索框中搜索并添加线路。
      </div>
    </div>
  </div>
</template>
