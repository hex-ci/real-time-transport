<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { MapPin, TriangleAlert } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import StationPinPicker from '@/components/StationPinPicker.vue'
import {
  type LineDetail,
  type LineGroup,
  type Station,
  type UserFavoriteLine,
  type UserSettings,
} from '@real-time-transport/shared'
import {
  isBidirectional,
  resolveBoardStop,
  resolveFavoriteLineId,
} from '@real-time-transport/shared/line-group'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const searchKeyword = shallowRef('')
const searchResults = shallowRef<LineGroup[]>([])
const searched = shallowRef(false)
const lastKeyword = shallowRef('')

/**
 * Stops per favourite direction, keyed `${favoriteId}_${direction}`. Loaded
 * lazily when the user opens a pin picker — a favourite can cover both
 * directions, each needing its own stop list from its own upstream lineId.
 */
const stationLists = shallowRef<Record<string, Station[]>>({})
const pinError = shallowRef<string | null>(null)

onMounted(() => {
  void transitStore.fetchFavorites()
})

function pinKey(favoriteId: string, direction: number): string {
  return `${favoriteId}_${direction}`
}

/** The two commute legs of a favourite, each bound to its own direction lineId. */
function favoriteDirections(fav: UserFavoriteLine): Array<{
  direction: 0 | 1
  purpose: 'morning' | 'evening'
  label: string
  lineId: string | null
}> {
  const primary = (fav.preferredDirection === 1 ? 1 : 0) as 0 | 1
  const other = (1 - primary) as 0 | 1
  // The AM picker binds to the primary direction's lineId and the PM picker to
  // the reverse one; which direction "is" the commute is derived from the pair.
  const entries: Array<{ direction: 0 | 1, purpose: 'morning' | 'evening', label: string, lineId: string | null }> = [
    { direction: primary, purpose: 'morning', label: '上班上车点', lineId: fav.lineId },
  ]
  // Only offer the second picker when it resolves to a real lineId — never
  // invent one, which would show another route's stops.
  if (fav.reverseLineId) {
    entries.push({
      direction: other,
      purpose: 'evening',
      label: '下班上车点',
      lineId: resolveFavoriteLineId(fav, other),
    })
  }
  return entries
}

async function ensureStations(fav: UserFavoriteLine, direction: 0 | 1, lineId: string): Promise<void> {
  const key = pinKey(fav.id!, direction)
  if (stationLists.value[key]) return
  try {
    const qs = new URLSearchParams({
      direction: String(direction),
      cityCode: fav.cityCode || cityStore.currentCode,
    })
    const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${qs.toString()}`)
    const json = await res.json()
    if (json.success && json.data) {
      stationLists.value = { ...stationLists.value, [key]: (json.data as LineDetail).stops }
    }
  }
  catch {
    // Leave unloaded: the picker shows an empty list rather than wrong stops
  }
}

/**
 * Load stop lists for every followed direction of the current city, so a picker
 * never opens onto an empty list. Driven by a watcher (not a one-shot call in
 * `onMounted`) because following a new line later in the session must load its
 * stops too — otherwise its picker stays empty until the page is reloaded.
 */
async function ensureAllStations(): Promise<void> {
  const tasks: Array<Promise<void>> = []
  for (const fav of cityFavorites.value) {
    if (!fav.id) continue
    for (const entry of favoriteDirections(fav)) {
      if (entry.lineId) tasks.push(ensureStations(fav, entry.direction, entry.lineId))
    }
  }
  await Promise.allSettled(tasks)
}

async function onPinChange(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  name: string | null,
): Promise<void> {
  pinError.value = null
  try {
    await transitStore.setBoardStop(fav.id!, purpose, name)
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '上车点保存失败'
  }
}

/** Only show favorites belonging to the currently selected city. */
const cityFavorites = computed(() =>
  favorites.value.filter(f => f.cityCode === cityStore.currentCode),
)

// Followed set or active city changed -> load any stops not yet cached.
// ensureStations skips what it already holds, so this stays a no-op on reruns.
watch(
  () => cityFavorites.value
    .map(f => `${f.id}_${f.lineId}_${f.reverseLineId ?? ''}`)
    .join('|'),
  () => void ensureAllStations(),
  { immediate: true },
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
    f.cityCode === item.cityCode
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

// ---------- Commute hours ----------

const settingsDraft = shallowRef<UserSettings>({
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
})
const settingsSaving = shallowRef(false)
const settingsError = shallowRef<string | null>(null)
const settingsSaved = shallowRef(false)

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (json.success && json.data) {
      settingsDraft.value = json.data as UserSettings
    }
  }
  catch {
    // Keep defaults: a failed load must not fabricate a different schedule
  }
})

async function saveSettings(): Promise<void> {
  settingsSaving.value = true
  settingsError.value = null
  settingsSaved.value = false
  try {
    const res = await fetch('/api/transit/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsDraft.value),
    })
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || '保存失败')
    }
    settingsDraft.value = json.data as UserSettings
    settingsSaved.value = true
  }
  catch (err) {
    settingsError.value = err instanceof Error ? err.message : '保存失败'
  }
  finally {
    settingsSaving.value = false
  }
}
</script>

<template>
  <div class="space-y-6 pb-12">
    <!-- Centered Content Column: ergonomic reading and input width (max-w-3xl) -->
    <div class="mx-auto max-w-3xl space-y-6">
      <!-- Title -->
      <div>
        <h2 class="text-xl font-bold text-white md:text-2xl">
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
        <form action="" class="mt-3 flex gap-2" @submit.prevent="performSearch">
          <!-- min-h-[44px] keeps both controls inside the Apple HIG touch-target
               size; 16px input text stops iOS Safari from zoom-jumping on focus on mobile/small-foldable. -->
          <input
            v-model="searchKeyword"
            type="search"
            enterkeyhint="search"
            placeholder="输入线路号，如 372、地铁10号线、亦庄线..."
            class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 md:text-xs"
          >
          <button
            type="submit"
            class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 md:px-4 md:text-xs"
          >
            搜索
          </button>
        </form>

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

      <!-- Commute hours: drive the default home-tab view (morning/evening/nearby) -->
      <div class="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl space-y-3">
        <h3 class="text-sm font-semibold text-slate-200">
          通勤时段
        </h3>
        <p class="text-xs text-slate-500">
          用于自动切换「上班 / 下班 / 附近」视图，不参与方向判定
        </p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
            <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300">
              <span>🏠</span><span>早高峰</span>
            </span>
            <span class="flex items-center gap-1">
              <input
                v-model="settingsDraft.morningStart"
                type="time"
                class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
              >
              <span class="text-xs text-slate-500">—</span>
              <input
                v-model="settingsDraft.morningEnd"
                type="time"
                class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
              >
            </span>
          </label>
          <label class="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2">
            <span class="flex shrink-0 items-center gap-1.5 text-xs text-slate-300">
              <span>🏢</span><span>晚高峰</span>
            </span>
            <span class="flex items-center gap-1">
              <input
                v-model="settingsDraft.eveningStart"
                type="time"
                class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
              >
              <span class="text-xs text-slate-500">—</span>
              <input
                v-model="settingsDraft.eveningEnd"
                type="time"
                class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white outline-none focus:border-cyan-500"
              >
            </span>
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="min-h-[44px] rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="settingsSaving"
            @click="saveSettings"
          >
            {{ settingsSaving ? '保存中…' : '保存时段' }}
          </button>
          <span v-if="settingsSaved" class="text-xs text-emerald-400">已保存</span>
          <span v-if="settingsError" class="flex items-center gap-1.5 text-xs text-rose-400">
            <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
            <span>{{ settingsError }}</span>
          </span>
        </div>
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
            class="p-3 text-xs"
          >
            <div class="flex min-h-[40px] items-center justify-between">
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

            <!-- Board stop per commute purpose. Home cards derive the direction
                 from the stop pair and read the stop for the active purpose. -->
            <div class="mt-2.5 space-y-2 border-t border-slate-800/60 pt-2.5">
              <div
                v-for="entry in favoriteDirections(item)"
                :key="`${item.id}_${entry.purpose}`"
                class="space-y-1"
              >
                <div class="flex items-center justify-between">
                  <span class="text-xs text-slate-400">
                    {{ entry.purpose === 'morning' ? '🏠' : '🏢' }} {{ entry.label }}
                  </span>
                  <span
                    v-if="entry.lineId && !stationLists[pinKey(item.id!, entry.direction)]"
                    class="text-xs text-slate-500"
                  >
                    展开后加载站点
                  </span>
                </div>
                <StationPinPicker
                  v-if="entry.lineId"
                  :model-value="resolveBoardStop(item, entry.purpose) ?? null"
                  :stations="stationLists[pinKey(item.id!, entry.direction)] || []"
                  :direction-label="entry.label"
                  @update:model-value="(name) => onPinChange(item, entry.purpose, name)"
                />
                <p v-else class="text-xs text-slate-500">
                  该方向上游未提供，无法设置上车点
                </p>
              </div>
              <p class="text-xs text-slate-500">
                ⓘ 两个上车点设置后，上班/下班方向自动判定
              </p>
              <p v-if="pinError" class="flex items-center gap-1.5 text-xs text-rose-400">
                <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                <span>{{ pinError }}</span>
              </p>
            </div>
          </div>
        </div>

        <div v-else class="p-6 text-center text-xs text-slate-400">
          暂无关注线路，请在上方的搜索框中搜索并添加线路。
        </div>
      </div>
    </div>
  </div>
</template>
