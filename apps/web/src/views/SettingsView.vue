<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useMediaQuery } from '@vueuse/core'
import {
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionRoot,
  AccordionTrigger,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
  RadioGroupItem,
  RadioGroupRoot,
} from 'reka-ui'
import { ChevronDown, Clock, Info, MapPin, TriangleAlert, X } from '@lucide/vue'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import StationPinPicker from '@/components/StationPinPicker.vue'
import CommuteHoursForm from '@/components/CommuteHoursForm.vue'
import {
  type LineDetail,
  type LineGroup,
  type Station,
  type UserFavoriteLine,
  type UserSettings,
} from '@real-time-transport/shared'
import {
  commuteDirectionFor,
  effectiveCommuteDirection,
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
/** Directions the API answered for but returned no detail for. */
const stationLoadFailed = shallowRef<Record<string, boolean>>({})
/**
 * Direction labels keyed `${favoriteId}_${direction}`, taken from each
 * direction's upstream `directionName` ("开往 X"). Stored per direction because
 * a bus route's two directions are separate upstream lines and each names its
 * own terminus; absent until that direction's stops are loaded.
 */
const directionLabels = shallowRef<Record<string, string>>({})
const pinError = shallowRef<string | null>(null)

onMounted(() => {
  void transitStore.fetchFavorites()
})

function pinKey(favoriteId: string, direction: number): string {
  return `${favoriteId}_${direction}`
}

/**
 * Commute direction options of a favourite, one entry per available direction.
 *
 * A bus route's two directions are two upstream lineIds, so each option carries
 * the lineId its stops must be fetched from. The label is the upstream's own
 * `directionName` ("开往 X"), which is what the vehicle's destination board
 * reads — 上行/下行 is not in the data and is not consistent between cities.
 */
function directionOptions(fav: UserFavoriteLine): Array<{
  direction: 0 | 1
  lineId: string
  label: string | null
}> {
  const primary = (fav.preferredDirection === 1 ? 1 : 0) as 0 | 1
  const other = (1 - primary) as 0 | 1
  const out: Array<{ direction: 0 | 1, lineId: string, label: string | null }> = []

  const push = (direction: 0 | 1) => {
    const lineId = resolveFavoriteLineId(fav, direction)
    if (!lineId) return
    out.push({ direction, lineId, label: directionLabels.value[pinKey(fav.id!, direction)] ?? null })
  }
  push(primary)
  push(other)
  return out
}

/** Direction the purpose rides, as chosen by the user. Null until they pick. */
function chosenDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return commuteDirectionFor(fav, purpose)
}

/**
 * Direction whose stops the picker lists.
 *
 * Same rule every other view uses, so the picker's stop source can never
 * disagree with what the home card or kiosk board renders for this purpose.
 */
function pickerDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return effectiveCommuteDirection(fav, purpose)
}

/** Stops of the direction a purpose rides; empty until a direction is chosen. */
function purposeStations(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): Station[] {
  const dir = pickerDirection(fav, purpose)
  if (dir === null || !fav.id) return []
  return stationLists.value[pinKey(fav.id, dir)] ?? []
}

/**
 * Whether the purpose's direction has no stops to offer.
 *
 * Only true once the API has actually ANSWERED for this direction and returned
 * nothing — a pending or failed request leaves the picker in place, because
 * "not loaded yet" and "upstream has nothing" must stay distinguishable.
 */
function stationsUnavailable(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): boolean {
  const dir = pickerDirection(fav, purpose)
  if (dir === null || !fav.id) return false
  return Boolean(stationLoadFailed.value[pinKey(fav.id, dir)])
}

/**
 * Whether the purpose's board stop is missing from its chosen direction.
 *
 * Both directions of a bus route do not call at identical stops (913 has four
 * stops served by one direction only — real platforms on opposite kerbs, not bad
 * data), so switching direction can strand a previously chosen stop. Reporting
 * the mismatch is required; silently keeping a stop that can never be boarded
 * would show a commute that cannot happen.
 */
function stopMissingFromDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): boolean {
  // The picker's own direction, so the warning matches the list the user sees.
  const dir = pickerDirection(fav, purpose)
  if (dir === null || !fav.id) return false
  const stops = stationLists.value[pinKey(fav.id, dir)]
  const stop = resolveBoardStop(fav, purpose)
  // `undefined` stops = not loaded yet; claiming a mismatch then would be a lie.
  if (!stops || !stop) return false
  return !stops.some(s => s.name === stop)
}

/**
 * A neutral note when both purposes ride the SAME physical direction.
 *
 * Allowed, not blocked: it is impossible on a linear route (you cannot travel
 * both ways at once) but loop lines exist and the user may have a reason, and
 * nothing downstream assumes the two differ. Naming the direction makes the
 * doubling obvious at a glance instead of leaving them to compare two blocks.
 *
 * Returns null unless there are two directions to choose between: on a
 * single-direction route the same value is the only value, so "pick the other
 * way" would be advice the user cannot act on.
 */
function sameDirectionNote(fav: UserFavoriteLine): string | null {
  if (directionOptions(fav).length < 2) return null
  const morning = effectiveCommuteDirection(fav, 'morning')
  const evening = effectiveCommuteDirection(fav, 'evening')
  if (morning === null || morning !== evening) return null
  const label = directionLabels.value[pinKey(fav.id!, morning)]
  return label
    ? `上班和下班都是「${label}」，返程通常应选另一个方向`
    : '上班和下班是同一方向，返程通常应选另一个方向'
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
      const detail = json.data as LineDetail
      stationLists.value = { ...stationLists.value, [key]: detail.stops }
      if (detail.directionName) {
        directionLabels.value = { ...directionLabels.value, [key]: detail.directionName }
      }
      return
    }
    // Reachable and empty: record it, so the panel can say the direction has no
    // stops instead of showing a picker that will never fill.
    stationLoadFailed.value = { ...stationLoadFailed.value, [key]: true }
  }
  catch {
    // Transient (offline, server down): leave unloaded so a later pass retries,
    // and do NOT claim the direction is unavailable — that would be a lie.
  }
}

/**
 * Load stop lists for every direction of the current city's followed lines.
 *
 * BOTH directions, not just the chosen one: the direction selector must show
 * "开往 X" for an option before the user picks it, and that label comes from the
 * direction's own detail. Driven by a watcher (not a one-shot call in
 * `onMounted`) because following a new line later in the session must load its
 * stops too — otherwise its picker stays empty until the page is reloaded.
 */
async function ensureAllStations(): Promise<void> {
  const tasks: Array<Promise<void>> = []
  for (const fav of cityFavorites.value) {
    if (!fav.id) continue
    for (const opt of directionOptions(fav)) {
      tasks.push(ensureStations(fav, opt.direction, opt.lineId))
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

/**
 * Record the direction a purpose rides.
 *
 * The board stop is deliberately left untouched when it is not served by the new
 * direction: that is a real case (stops exist in one direction only) and the
 * user's typed choice is worth keeping visible so they can decide, rather than
 * being deleted under them. `stopMissingFromDirection` then flags it.
 */
async function onDirectionChange(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  direction: 0 | 1,
): Promise<void> {
  pinError.value = null
  try {
    await transitStore.updateCommuteSlot(fav.id!, purpose, { direction })
  }
  catch (err) {
    pinError.value = err instanceof Error ? err.message : '方向保存失败'
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

// Clear search state when the city changes
watch(() => cityStore.currentCode, () => {
  searchResults.value = []
  searchKeyword.value = ''
  searched.value = false
})

// ---------- Commute hours ----------

/**
 * Saved hours, kept only for the collapsed summary line. The form itself lives
 * in CommuteHoursForm, which owns its own draft and save cycle.
 */
const savedHours = shallowRef<UserSettings>({
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
})

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (json.success && json.data) {
      savedHours.value = json.data as UserSettings
    }
  }
  catch {
    // Keep defaults: a failed load must not fabricate a different schedule
  }
})

// ---------- Disclosure state ----------

/**
 * Which favourite's stop editors are open, as a one-element array because
 * AccordionRoot's single mode reports its value that way. One at a time: each
 * expanded row carries two comboboxes, and letting several open at once
 * rebuilds the very wall of controls the compact rows exist to avoid.
 */
const expandedFavorite = shallowRef<string[]>([])

/**
 * Commute hours: expanded whenever the card sits in the xl side rail (where
 * there is room beside the list and collapsing would only add a click), and
 * collapsed below that (where it stacks under the list and the height matters).
 */
const hoursExpanded = shallowRef(false)
const isSideRail = useMediaQuery('(min-width: 1280px)')

watch(isSideRail, (wide) => {
  // Only the automatic value follows the breakpoint; a manual toggle within a
  // layout is respected until the layout itself changes.
  hoursExpanded.value = wide
}, { immediate: true })

/** "06:30–11:30 · 17:00–22:00" — the collapsed summary of the saved hours. */
const hoursSummary = computed(() =>
  `${savedHours.value.morningStart}–${savedHours.value.morningEnd} · ${savedHours.value.eveningStart}–${savedHours.value.eveningEnd}`)

/** Favourite queued for removal, and the failure of the last attempt. */
const pendingRemoval = shallowRef<UserFavoriteLine | null>(null)
const removingFavorite = shallowRef(false)
const removalError = shallowRef<string | null>(null)

function requestRemoval(fav: UserFavoriteLine): void {
  removalError.value = null
  pendingRemoval.value = fav
}

/**
 * Unfollow the pending target, keeping the dialog up until the request settles.
 *
 * The confirm control is a plain button, NOT reka-ui's `AlertDialogAction`:
 * that component IS a `DialogClose`, whose own click handler closes the dialog,
 * and Vue runs the component's handler before the consumer's fallthrough one.
 * The close cleared `pendingRemoval` first, so the handler read `null` and
 * returned without ever sending the DELETE.
 *
 * Closing explicitly also keeps the button's pending state honest: it stays
 * disabled with 「处理中…」 while the request is in flight, and a failure leaves
 * the dialog open with the reason instead of vanishing mid-action.
 */
async function confirmRemoval(): Promise<void> {
  const target = pendingRemoval.value
  if (!target || removingFavorite.value) return
  removalError.value = null
  removingFavorite.value = true
  try {
    await transitStore.removeFavorite(target.id || target.lineId)
    pendingRemoval.value = null
  }
  catch (err) {
    removalError.value = err instanceof Error ? err.message : '取消关注失败'
  }
  finally {
    removingFavorite.value = false
  }
}

/**
 * One-line stop summary per favourite, so a collapsed row still answers the
 * question it exists for: which stops will the home cards report on.
 */
function stopSummary(fav: UserFavoriteLine): string {
  const morning = resolveBoardStop(fav, 'morning')
  const evening = resolveBoardStop(fav, 'evening')
  const parts: string[] = []
  if (morning) parts.push(`🏠 ${morning}`)
  if (evening) parts.push(`🏢 ${evening}`)
  return parts.length > 0 ? parts.join(' · ') : '未设置上车点'
}
</script>

<template>
  <div class="space-y-6 pb-12">
    <!-- Title -->
    <div class="mx-auto max-w-6xl">
      <h2 class="text-xl font-bold text-white md:text-2xl">
        设置与管理
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        管理日常通勤关注的公交和地铁线路
      </p>
    </div>

    <!--
      Two regions: the followed-lines work (search + list — one task that must not
      be interrupted) and the commute-hours preference (set once, rarely touched).
      Below xl they stack with hours last; from xl the preference moves to a side
      column so the list keeps the full left width and no settings card is wedged
      into the middle of the list.
    -->
    <div class="mx-auto grid max-w-6xl grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <!-- ============ Followed lines: search + list in one card ============ -->
      <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-200 lg:text-base">
            关注线路
            <span class="ml-1 font-normal text-slate-400">({{ cityFavorites.length }})</span>
          </h3>
          <span class="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-400">
            <MapPin class="h-3 w-3 shrink-0" />
            <span>{{ cityStore.currentCityName }}</span>
          </span>
        </div>

        <!-- Search sits inside the list card: adding and managing lines are the
             same task, so nothing unrelated may sit between them. -->
        <form action="" class="mt-3 flex gap-2" @submit.prevent="performSearch">
          <!-- min-h-[44px] keeps both controls inside the Apple HIG touch-target
               size; 16px input text stops iOS Safari from zoom-jumping on focus on mobile/small-foldable. -->
          <input
            v-model="searchKeyword"
            type="search"
            enterkeyhint="search"
            placeholder="输入线路号，如 372、地铁10号线、亦庄线..."
            class="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 md:text-xs lg:px-4 lg:text-base"
          >
          <button
            type="submit"
            class="min-h-[44px] shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 md:px-4 md:text-xs lg:text-base"
          >
            搜索
          </button>
        </form>

        <!-- Search results: ONE row per route, both directions bundled -->
        <div v-if="searchResults.length > 0" class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950">
          <div
            v-for="item in searchResults"
            :key="item.groupKey"
            class="flex items-center justify-between gap-2 p-3 text-xs lg:gap-2.5 lg:p-3.5 lg:text-base"
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
              <!-- Both directions labelled by their own terminus, matching the
                   direction selector below and the real destination board.
                   Never 去/回 here: following a route is not a commute, so
                   neither direction is the "return" one. -->
              <div v-if="item.up" class="mt-1 truncate text-xs text-slate-400">
                <span class="text-emerald-400">{{ item.up.directionName }}</span>
              </div>
              <div v-if="item.down" class="mt-0.5 truncate text-xs text-slate-400">
                <span class="text-violet-400">{{ item.down.directionName }}</span>
              </div>
            </div>
            <button
              class="min-h-[44px] shrink-0 rounded-lg bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-cyan-500 hover:text-slate-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-5 lg:text-base"
              :disabled="isRouteFollowed(item)"
              @click="addFavorite(item)"
            >
              {{ isRouteFollowed(item) ? '已关注' : '关注' }}
            </button>
          </div>
        </div>
        <p v-else-if="searched && searchResults.length === 0" class="mt-3 text-center text-xs text-slate-400 lg:text-base">
          在 {{ cityStore.currentCityName }} 未找到匹配「{{ lastKeyword }}」的线路
        </p>

        <!-- Followed list: compact rows, one expanded at a time. AccordionRoot
             (single) owns the disclosure state and the trigger/content ARIA
             wiring, so only one row's editors can be open. -->
        <AccordionRoot
          v-if="cityFavorites.length > 0"
          v-model="expandedFavorite"
          type="single"
          collapsible
          class="mt-3 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950"
        >
          <AccordionItem
            v-for="item in cityFavorites"
            :key="item.id || item.lineId"
            :value="item.id || item.lineId"
          >
            <AccordionHeader as-child>
              <!-- Vertical padding is set so the collapsed row still clears the 44px
                   touch target now that it carries a single line of text. -->
              <AccordionTrigger
                class="group flex w-full items-center gap-2.5 px-3 py-3.5 text-left transition hover:bg-slate-900/60"
              >
                <span
                  class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 font-mono font-bold whitespace-nowrap text-cyan-400"
                  :class="(item.lineName || '').length > 4 ? 'text-xs min-w-[54px]' : 'text-xs min-w-[36px]'"
                >
                  {{ item.lineName || '线路' }}
                </span>
                <span class="min-w-0 flex-1 truncate text-xs text-slate-300 lg:text-base">{{ stopSummary(item) }}</span>
                <!-- data-state comes from reka-ui, so the chevron needs no local
                     state binding. -->
                <ChevronDown
                  class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-data-[state=open]:rotate-180"
                />
              </AccordionTrigger>
            </AccordionHeader>

            <!-- reka-ui keeps the panel mounted when closed and exposes its measured
                 height as --reka-accordion-content-height; these utilities animate
                 to and from that value, so the row slides instead of snapping. The
                 border/padding live on the inner element: with border-box sizing a
                 height:0 box still renders its own border and padding, which would
                 leave a stray line when the row is collapsed. -->
            <AccordionContent
              class="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
            >
              <div class="border-t border-slate-800/60 space-y-4 px-3 pt-3 pb-3">
                <div
                  v-for="purpose in (['morning', 'evening'] as const)"
                  :key="`${item.id}_${purpose}`"
                  class="space-y-2"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-medium text-slate-300 lg:text-sm">
                      {{ purpose === 'morning' ? '🏠 上班' : '🏢 下班' }}
                    </span>
                    <span
                      v-if="purposeStations(item, purpose).length === 0 && pickerDirection(item, purpose) !== null"
                      class="text-xs text-slate-400"
                    >
                      正在加载站点…
                    </span>
                  </div>

                  <!-- Direction first: a stop's meaning (its number, whether it is
                       even served) depends on which way the bus travels, so picking
                       the stop before the direction would show numbers from a route
                       the user is not riding. -->
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs text-slate-400">方向</span>
                    <template v-if="directionOptions(item).length > 1">
                      <RadioGroupRoot
                        :model-value="chosenDirection(item, purpose) ?? undefined"
                        class="flex flex-wrap gap-2"
                        @update:model-value="(v) => onDirectionChange(item, purpose, Number(v) as 0 | 1)"
                      >
                        <RadioGroupItem
                          v-for="opt in directionOptions(item)"
                          :key="`${purpose}_${opt.direction}`"
                          :value="opt.direction"
                          class="min-h-[36px] rounded-lg border px-3 text-xs transition"
                          :class="chosenDirection(item, purpose) === opt.direction
                            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                            : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-cyan-500/40'"
                        >
                          {{ opt.label ?? `方向 ${opt.direction}` }}
                        </RadioGroupItem>
                      </RadioGroupRoot>
                    </template>
                    <span v-else class="text-xs text-slate-400">
                      {{ directionOptions(item)[0]?.label ?? '上游未提供方向' }}
                    </span>
                  </div>

                  <div v-if="chosenDirection(item, purpose) === null && directionOptions(item).length > 1" class="text-xs text-slate-500">
                    请先选择方向
                  </div>
                  <template v-else>
                    <!-- The direction has no stops at all: a picker here would be
                         permanently empty, so say why instead of showing it. -->
                    <p
                      v-if="stationsUnavailable(item, purpose)"
                      class="text-xs text-slate-400 lg:text-base"
                    >
                      该方向上游未提供，无法设置上车点
                    </p>
                    <template v-else>
                      <StationPinPicker
                        :model-value="resolveBoardStop(item, purpose) ?? null"
                        :stations="purposeStations(item, purpose)"
                        :direction-label="purpose === 'morning' ? '上班' : '下班'"
                        @update:model-value="(name) => onPinChange(item, purpose, name)"
                      />
                      <p
                        v-if="stopMissingFromDirection(item, purpose)"
                        class="flex items-center gap-1.5 text-xs text-amber-400"
                      >
                        <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                        <span>「{{ resolveBoardStop(item, purpose) }}」不在本方向停靠，请重选</span>
                      </p>
                    </template>
                  </template>
                </div>

                <!-- Neutral note, not a warning: a same-way choice is allowed and
                     the user may have meant it (loop lines, a one-station hop).
                     Placed once per route, after both direction blocks, because
                     it describes the PAIR rather than either purpose alone. -->
                <p
                  v-if="sameDirectionNote(item)"
                  class="flex items-start gap-1.5 text-xs text-slate-400"
                >
                  <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{{ sameDirectionNote(item) }}</span>
                </p>

                <p v-if="pinError" class="flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base">
                  <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
                  <span>{{ pinError }}</span>
                </p>

                <button
                  class="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
                  @click="requestRemoval(item)"
                >
                  <X class="h-3.5 w-3.5 shrink-0" />
                  <span>取消关注</span>
                </button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </AccordionRoot>

        <p v-else class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-6 text-center text-xs text-slate-400 lg:p-7 lg:text-base">
          暂无关注线路，请在上方搜索框中搜索并添加线路
        </p>
      </section>

      <!-- ============ Commute hours: a preference, not a per-line setting ===== -->
      <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
        <!-- Side rail (xl+): the form is always visible. It sits beside the list,
             so collapsing would save no scrolling and only add a click.
             Stacked below the list (<xl): collapsible, because there the card
             does add height to the page. -->
        <div v-if="isSideRail" class="space-y-4">
          <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
            <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
            <span>通勤时段</span>
          </h3>
          <CommuteHoursForm />
        </div>

        <CollapsibleRoot v-else v-model:open="hoursExpanded">
          <CollapsibleTrigger
            class="group flex w-full items-center justify-between gap-2 text-left"
          >
            <span class="flex min-w-0 items-center gap-2">
              <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-slate-200 lg:text-base">通勤时段</span>
                <span class="mt-0.5 block truncate font-mono text-xs text-slate-400">{{ hoursSummary }}</span>
              </span>
            </span>
            <ChevronDown
              class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>

          <CollapsibleContent
            class="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
          >
            <div class="mt-4 border-t border-slate-800/60 pt-4">
              <CommuteHoursForm />
            </div>
          </CollapsibleContent>
        </CollapsibleRoot>
      </section>
    </div>

    <!-- Removal confirmation. Unfollowing is irreversible from the UI (the line
         must be searched for again), so it takes an explicit confirm rather than
         firing on a single tap inside the expanded row. -->
    <AlertDialogRoot :open="pendingRemoval !== null" @update:open="(v) => { if (!v) pendingRemoval = null }">
      <AlertDialogPortal>
        <AlertDialogOverlay class="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm" />
        <AlertDialogContent
          class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        >
          <AlertDialogTitle class="text-sm font-semibold text-white lg:text-base">
            取消关注 {{ pendingRemoval?.lineName || '该线路' }}？
          </AlertDialogTitle>
          <AlertDialogDescription class="mt-2 text-xs text-slate-400 lg:text-base">
            取消后首页不再显示这条线路的实时车辆与到站信息，上车点设置也会一并移除。需要重新搜索才能再次关注。
          </AlertDialogDescription>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialogCancel
              class="min-h-[40px] rounded-xl border border-slate-700 bg-slate-800 px-4 text-xs text-slate-200 transition hover:bg-slate-700 active:scale-95 lg:px-5 lg:text-base"
            >
              保留
            </AlertDialogCancel>
            <!-- Plain button, NOT AlertDialogAction: that component is a
                 DialogClose, so its own click handler closed the dialog and
                 cleared the pending target before this handler could read it.
                 See confirmRemoval. -->
            <button
              type="button"
              class="min-h-[40px] rounded-xl border border-rose-500/30 bg-rose-500/15 px-4 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 lg:px-5 lg:text-base"
              :disabled="removingFavorite"
              @click="confirmRemoval"
            >
              {{ removingFavorite ? '处理中…' : '确认取消关注' }}
            </button>
          </div>
          <p
            v-if="removalError"
            class="mt-3 flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base"
          >
            <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{{ removalError }}</span>
          </p>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </div>
</template>
