<script setup lang="ts">
/**
 * 设置's INDEX: four rows, one per domain, each stating that domain's CURRENT STATE as a
 * fact.
 *
 * WHAT THIS PAGE IS. The four domains used to share one 841-line screen; they are now four
 * pages, and this is the map to them (`§4.1`). A row is a WHOLE-ROW `<RouterLink>` rather
 * than a scripted `router.push`: the row then carries the semantics, the keyboard
 * reachability and 「open in a new tab」 the browser already knows how to give a link.
 *
 * WHAT A ROW MAY SAY. Facts only — how many lines are followed, which hours are saved,
 * whether each anchor is set, how many chains are recorded. No advice, no 「去配置」: the
 * action is the row's own link, and a summary that also told the user what to do would
 * state the same thing twice. `index-summary.ts` owns every wording, and it is total over
 * the three states a read leaves a value in — STILL READING, READ AND FAILED, read — plus
 * the fourth the SETTINGS row adds: the read answered and there is no row, which says
 * 「未设置」. So a read that failed says 「未读到」 here rather than a default that would look
 * like the user's own configuration (the collapsed hours summary used to keep
 * `06:30–11:30` on a thrown request) or a count nobody obtained (「条数只在列表读到之后
 * 给」), and a row nobody ever saved says 「未设置」 rather than the built-in window.
 *
 * WHAT IT DOES NOT DO. It carries no state into a sub-page: each of the four is a real
 * path that reads everything it needs itself, so a refresh, a bookmark or a browser back
 * lands on the same page with the same content (`§4.1` 深链接).
 */
import { computed, onMounted, shallowRef } from 'vue'
import { storeToRefs } from 'pinia'
import { ChevronRight, Clock, MapPin, Search, Waypoints } from '@lucide/vue'
import { useCityStore } from '@/stores/city.store'
import { useTransitStore } from '@/stores/transit.store'
import type { StoredAnchors } from './anchors'
import {
  anchorsText,
  chainsText,
  followedLinesText,
  hoursText,
  settingsReadOf,
  type SettingsSummaryValue,
  type SummaryValue,
} from './index-summary'
import type { UserSettings } from '@real-time-transport/shared'

const transitStore = useTransitStore()
const cityStore = useCityStore()
const { favoriteOrder } = storeToRefs(transitStore)

/**
 * The followed lines of the CITY ON SCREEN — which is the domain 关注线路 manages, not the
 * whole stored list: a count over every city would describe a page the user is not looking
 * at, and which city that is is already named in the header.
 */
const cityFavorites = computed(() =>
  favoriteOrder.value.filter(f => f.cityCode === cityStore.currentCode),
)

/** The four facts, each in the state its own read left it in. */
const followedLines = shallowRef<SummaryValue<number>>({ state: 'reading' })
const savedHours = shallowRef<SettingsSummaryValue<UserSettings>>({ state: 'reading' })
const anchors = shallowRef<SummaryValue<StoredAnchors>>({ state: 'reading' })
const chains = shallowRef<SummaryValue<number>>({ state: 'reading' })

/**
 * The rows, in the order §4.1 lists the domains: followed lines, hours, anchors, chains.
 *
 * `favorites`, `hours` and `anchors` are read here rather than taken from a sub-page: this
 * page may be the first thing a session renders (an installed app opening on `/settings`),
 * so every fact it states has to come from its own read.
 */
const rows = computed(() => [
  { to: '/settings/lines', label: '关注线路', icon: Search, summary: followedLinesText(followedLines.value) },
  { to: '/settings/schedule', label: '通勤时段', icon: Clock, summary: hoursText(savedHours.value) },
  { to: '/settings/anchors', label: '位置锚点', icon: MapPin, summary: anchorsText(anchors.value) },
  { to: '/settings/chains', label: '通勤链路', icon: Waypoints, summary: chainsText(chains.value) },
])

onMounted(() => {
  void readFollowedLines()
  void readSettings()
  void readChains()
})

/**
 * The followed lines' count, and whether it is a count at all.
 *
 * The store answers whether the server actually handed back a list: a read that failed
 * leaves an empty array behind, and reporting that array's length would be reporting a
 * number this page never obtained.
 */
async function readFollowedLines(): Promise<void> {
  const answered = await transitStore.fetchFavorites()
  followedLines.value = answered
    ? { state: 'read', value: cityFavorites.value.length }
    : { state: 'unreadable' }
}

/** How many chains are recorded — read through the store's own answer, same rule. */
async function readChains(): Promise<void> {
  const answered = await transitStore.fetchCommuteChains()
  chains.value = answered
    ? { state: 'read', value: transitStore.commuteChains.length }
    : { state: 'unreadable' }
}

/**
 * The one settings row, which two of the four domains read from.
 *
 * The two are set together and separately from each other: a row without the four times is
 * not a readable schedule, while the same row's anchors may still be readable — so the
 * hours may say 「未读到」 beside anchors that are known, and neither ever borrows the
 * other's answer.
 *
 * The reading itself is `settingsReadOf`'s, and it carries the one state the server added:
 * a user who has never saved anything is answered `settingsState: 'unset'` with no row, so
 * this page says 「未设置」 — it used to say the built-in `06:30–11:30` here, which is the
 * default wearing the user's own configuration's clothes. That state is ALSO not 「未读到」:
 * one is a read that failed, the other a read that found nothing, and §4.1 keeps them
 * apart.
 */
async function readSettings(): Promise<void> {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    const read = settingsReadOf(json)
    savedHours.value = read.hours
    anchors.value = read.anchors
  }
  catch {
    // A request that never answered, or an answer that could not be parsed: nothing about
    // the stored row is known. 「未设置」 would be a claim about it, and a default would
    // look like the user's own schedule.
    savedHours.value = { state: 'unreadable' }
    anchors.value = { state: 'unreadable' }
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 pb-12">
    <div>
      <h2 class="text-xl font-bold text-white md:text-2xl">
        设置
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        每一项各自一页；这里只报出它们现在是什么样
      </p>
    </div>

    <!-- A list, each row one link, the row's own summary INSIDE that link: a row and its
         state must not be two places, or a reader who reaches the row by its link never
         hears the state. -->
    <ul class="divide-y divide-slate-800/80 overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/80 shadow-xl">
      <li v-for="row in rows" :key="row.to">
        <RouterLink
          :to="row.to"
          class="flex min-h-[44px] items-center gap-3 px-4 py-3.5 transition hover:bg-slate-950/60"
        >
          <component :is="row.icon" class="h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-slate-200 lg:text-base">{{ row.label }}</span>
            <span class="mt-0.5 block truncate text-xs text-slate-400 lg:text-base">{{ row.summary }}</span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
