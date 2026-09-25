<script setup lang="ts">
/**
 * 关注线路 (F1, F9): search for a route, follow it, and edit each followed line's own
 * commute direction and board stops.
 *
 * This is the block of the old 841-line 设置 page that manages the followed set, moved here
 * — the same controls and the same requests. It is NOT "moved whole, the same wording": three
 * things differ, each for a reason this file can be checked against.
 *
 *  - two colour classes went from `text-slate-500` to `text-slate-400`: the 「请先选择方向」 hint,
 *    which is text and so needs 4.5:1 — slate-500 is below AA on this surface — and the followed
 *    row's chevron, which moved with it (as an icon it cleared 1.4.11 at either value);
 *  - the 取消关注 control went from `min-h-[40px]` to `min-h-[44px]`;
 *  - the list's wording is now total over the three states its read can leave it in — the
 *    empty state, the still-reading state, and the failed state with its retry
 *    (`line-stops.ts`'s `favoritesRead`), where 「暂无关注线路」 is only reachable once the read
 *    actually answered.
 *
 * What changed besides the block is where it lives (its own path, `/settings/lines`) and what
 * it is: a page with its own `<h2>` and its own way back (`back-to-settings.vue`).
 *
 * The stop lists it offers a board stop out of come from `line-stops.ts`, shared with
 * 通勤链路 so a chain leg can never be offered a stop this card considers unavailable.
 */
import { shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionRoot,
  AccordionTrigger,
  RadioGroupItem,
  RadioGroupRoot,
} from 'reka-ui'
import { ChevronDown, GripVertical, Info, MapPin, RefreshCw, TriangleAlert, X } from '@lucide/vue'
import type { LineGroup, Station, UserFavoriteLine } from '@real-time-transport/shared'
import {
  commuteDirectionFor,
  effectiveCommuteDirection,
  isBidirectional,
  resolveBoardStop,
} from '@real-time-transport/shared/line-group'
import { followedLinesUnreadableText } from '@/read-state'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import { BackToSettings, LineOrderList, RemovalDialog, StationPinPicker } from './components'
import { useLineStops } from './line-stops'
import type { StationChoice } from './types'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favorites } = storeToRefs(transitStore)

const {
  cityFavorites,
  favoritesRead,
  readFavorites,
  stationLists,
  stationLoadFailed,
  directionLabels,
  pinKey,
  directionOptions,
} = useLineStops()

const searchKeyword = shallowRef('')
const searchResults = shallowRef<LineGroup[]>([])
const searched = shallowRef(false)
const lastKeyword = shallowRef('')

const pinError = shallowRef<string | null>(null)

/**
 * What this card says when the followed set has no list to show.
 *
 * The read's own state decides which of the three sentences fits, and it is read from
 * `line-stops.ts` rather than assumed from the array's length: a read that FAILED leaves an
 * empty array behind, and 「暂无关注线路，请在上方搜索框中搜索并添加线路」 would then tell the
 * user to add lines they already follow. Only the empty state is about what is stored; the
 * failed state is about the read, and it carries the retry that can change it.
 */
const unreadableNote = followedLinesUnreadableText('暂时无法显示已关注的线路')

/** Direction the purpose rides, as chosen by the user. Null until they pick. */
function chosenDirection(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): 0 | 1 | null {
  return commuteDirectionFor(fav, purpose)
}

/**
 * Direction whose stops the picker lists.
 *
 * Same rule every other view uses, so the picker's stop source can never
 * disagree with what the home card renders for this purpose.
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
 * Both directions of a bus route do not call at identical stops (some stops are
 * served by one direction only — real platforms on opposite kerbs, not bad
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
 * The pinned stop as the picker's own value: the stored NAME — which is the whole of what
 * a pin holds, `setBoardStop` writing a name and nothing else — together with that name's
 * order in the list on screen, so the trigger can read a stop number.
 *
 * The order is filled in only when the name stands ONCE in that list: 线上同名站不止一个
 * (PRD), so where two stops share a name no list can say which one the pin means, and the
 * trigger shows the name alone rather than a number that would only be a guess. A pin is a
 * name; the pair here is how that name is READ, never what is written.
 */
function pinnedChoice(fav: UserFavoriteLine, purpose: 'morning' | 'evening'): StationChoice | null {
  const name = resolveBoardStop(fav, purpose)
  if (!name) return null
  const matches = purposeStations(fav, purpose).filter(station => station.name === name)
  return { name, order: matches.length === 1 ? matches[0]!.order : null }
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

async function onPinChange(
  fav: UserFavoriteLine,
  purpose: 'morning' | 'evening',
  choice: StationChoice | null,
): Promise<void> {
  pinError.value = null
  try {
    await transitStore.setBoardStop(fav.id!, purpose, choice?.name ?? null)
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

/** Failure of the last order write, so a rejected drop is never silent. */
const orderError = shallowRef<string | null>(null)

/**
 * Persist a drop: the dragged row takes the slot of the row it was dropped on.
 *
 * The two rows are named, not indexed, because the order is ONE list over every
 * followed line while this page shows one city at a time. Resolving the drop
 * against the whole list is what leaves the rows this page does not show in
 * their own relative places instead of renumbering them behind the user's back.
 */
async function onReorder(movedId: string, anchorId: string): Promise<void> {
  orderError.value = null
  try {
    await transitStore.moveFavorite(movedId, anchorId)
  }
  catch (err) {
    orderError.value = err instanceof Error ? err.message : '顺序保存失败'
  }
}

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
async function addFavorite(item: LineGroup): Promise<void> {
  if (isRouteFollowed(item)) return

  const primary = item.up ?? item.down
  if (!primary) return
  const other = item.up ? item.down : item.up

  const followed = await transitStore.addFavorite({
    lineId: primary.lineId,
    lineName: item.lineName,
    preferredDirection: primary.direction,
    reverseLineId: other ? other.lineId : undefined,
    cityCode: item.cityCode || cityStore.currentCode,
  })
  // A refused follow (the line is already followed: one row per line) must leave
  // the searched row up so its own control can state the outcome.
  if (!followed) return
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

/**
 * Which favourite's stop editors are open, as a one-element array because
 * AccordionRoot's single mode reports its value that way. One at a time: each
 * expanded row carries two comboboxes, and letting several open at once
 * rebuilds the very wall of controls the compact rows exist to avoid.
 */
const expandedFavorite = shallowRef<string[]>([])

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
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      关注线路
    </h2>

    <!-- Search and list in one card: adding and managing lines are the same task, so
         nothing unrelated may sit between them. -->
    <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-slate-200 lg:text-base">
          关注线路
          <!-- The count is a fact about the stored list, so it is printed only once that
               list was READ: a count taken from a failed read is a number nobody obtained. -->
          <span v-if="favoritesRead === 'read'" class="ml-1 font-normal text-slate-400">({{ cityFavorites.length }})</span>
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
          placeholder="输入线路号，如 快线 1 路、地铁 88 号线、甲乙线..."
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
           wiring, so only one row's editors can be open.

           The rows are the STORED order and the list is where that order is
           edited, so it is rendered through the drag container rather than
           straight from the store's array: the array carries the home
           screen's presentation, and a dragged row must leave from — and
           land on — the position it actually holds. -->
      <AccordionRoot
        v-if="cityFavorites.length > 0"
        v-model="expandedFavorite"
        type="single"
        collapsible
        class="mt-3 rounded-xl border border-slate-800 bg-slate-950"
      >
        <LineOrderList :items="cityFavorites" @move="onReorder">
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
                <!-- The only place a drag can start. A row that answered to a
                     press anywhere would swallow the swipe that scrolls this
                     page and fight the tap that opens the row; touch-none
                     stops the browser claiming the grip's own gesture, and
                     the swallowed click keeps a grab from toggling the row. -->
                <span
                  data-drag-handle
                  aria-hidden="true"
                  title="拖动调整顺序"
                  class="-ml-1 flex h-9 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-300 active:cursor-grabbing"
                  @click.stop
                >
                  <GripVertical class="h-4 w-4" />
                </span>
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
                  class="h-4 w-4 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180"
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
                          class="min-h-11 rounded-lg border px-3 text-xs transition"
                          :class="chosenDirection(item, purpose) === opt.direction
                            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                            : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-cyan-500/40'"
                        >
                          {{ opt.label ?? `方向 ${opt.direction}` }}
                        </RadioGroupItem>
                      </RadioGroupRoot>
                    </template>
                    <span v-else class="text-xs text-slate-400">
                      {{ directionOptions(item)[0]?.label ?? '方向未知' }}
                    </span>
                  </div>

                  <div v-if="chosenDirection(item, purpose) === null && directionOptions(item).length > 1" class="text-xs text-slate-400">
                    请先选择方向
                  </div>
                  <template v-else>
                    <!-- The direction has no stops at all: a picker here would be
                         permanently empty, so say why instead of showing it. -->
                    <p
                      v-if="stationsUnavailable(item, purpose)"
                      class="text-xs text-slate-400 lg:text-base"
                    >
                      该方向暂无站点数据，无法设置上车点
                    </p>
                    <template v-else>
                      <StationPinPicker
                        :model-value="pinnedChoice(item, purpose)"
                        :stations="purposeStations(item, purpose)"
                        :direction-label="purpose === 'morning' ? '上班' : '下班'"
                        @update:model-value="(choice) => onPinChange(item, purpose, choice)"
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
                  class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 text-xs text-rose-400 transition hover:bg-rose-500/20 active:scale-95 lg:gap-2 lg:px-3.5 lg:text-base"
                  @click="requestRemoval(item)"
                >
                  <X class="h-3.5 w-3.5 shrink-0" />
                  <span>取消关注</span>
                </button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </LineOrderList>
      </AccordionRoot>

      <!-- The read FAILED: this is its own cause, with the retry that is the only thing
           that can fix it — never the empty state below, which claims what is stored. -->
      <div v-else-if="favoritesRead === 'unreadable'" class="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 p-4">
        <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
          <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{{ unreadableNote }}</span>
        </p>
        <button
          type="button"
          class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
          @click="readFavorites"
        >
          <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>重试</span>
        </button>
      </div>

      <!-- Still reading: not the empty state either, and it must not borrow its words. -->
      <p v-else-if="favoritesRead === 'reading'" class="mt-3 text-center text-xs text-slate-400 lg:text-base">
        正在读取关注线路…
      </p>

      <p v-else class="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 p-6 text-center text-xs text-slate-400 lg:p-7 lg:text-base">
        暂无关注线路，请在上方搜索框中搜索并添加线路
      </p>

      <!-- A dropped row is written immediately, so a rejected write has to say
           so here: the list has already sprung back to the stored order and
           would otherwise look like the drag never happened. -->
      <p
        v-if="orderError"
        class="mt-2 flex items-center gap-1.5 text-xs text-rose-400 lg:gap-2 lg:text-base"
      >
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" />
        <span>{{ orderError }}</span>
      </p>
    </section>

    <!-- Removal confirmation. Unfollowing is irreversible from the UI (the line
         must be searched for again), so it takes an explicit confirm rather than
         firing on a single tap inside the expanded row. -->
    <RemovalDialog
      :open="pendingRemoval !== null"
      :line-name="pendingRemoval?.lineName ?? null"
      :removing="removingFavorite"
      :error="removalError"
      @confirm="confirmRemoval"
      @cancel="pendingRemoval = null"
    />
  </div>
</template>
