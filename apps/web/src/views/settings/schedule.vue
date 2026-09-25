<script setup lang="ts">
/**
 * 通勤时段: the morning and evening windows the commute context adapts to.
 *
 * The card is the same component the old 设置 page rendered — the same `CommuteHoursCard` and
 * `CommuteHoursForm`, with the same draft-and-save cycle inside the form — but NOT unchanged:
 * the split's own touch-target pass edited it in this same change (`min-h-[44px]` on the
 * collapsed trigger, and the trigger's chevron from `text-slate-500` to `text-slate-400`). What
 * moved is where it sits: its own path (`/settings/schedule`), its own `<h2>`, its own way back.
 *
 * The collapsed summary is read HERE rather than by the card, and it is worded by
 * `index-summary.ts` — the same rule the index row uses, so the two cannot state two
 * different hours for one stored row. A read that fails says 「未读到」 and a read that
 * found NO row says 「未设置」。 The third answer — the row is there and its four times
 * were never chosen (NULL since 009) — says 「未设置」 too, because from the user's side
 * 「我还没设置过通勤时段」 is true in both cases, and `settingsReadOf` is where the two stay
 * apart so that nothing downstream can print a null as an hour. The card used to be
 * handed `06:30–11:30` in the first case, which is the default wearing the user's own
 * configuration's clothes, and the endpoint answered that same window in the second.
 * All of these states are pinned on THIS page, in `__tests__/settings-pages.test.ts`
 * and `__tests__/settings-unchosen-hours.test.ts` — the index row's own test mounts
 * another file and would stay green if this page's `catch` restored the default.
 *
 * The automatic expand/collapse state still follows the same breakpoint it followed inside
 * the old page: above xl there is room for the form and it stays open, below it the card is
 * collapsed (which is the state the 44px trigger exists for).
 */
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { BackToSettings, CommuteHoursCard } from './components'
import { hoursText, settingsReadOf, type SettingsSummaryValue } from './index-summary'
import type { UserSettings } from '@real-time-transport/shared'

/** The saved hours, in whichever of the states their read left them. */
const savedHours = shallowRef<SettingsSummaryValue<UserSettings>>({ state: 'reading' })

const summary = computed(() => hoursText(savedHours.value))

onMounted(async () => {
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    savedHours.value = settingsReadOf(json).hours
  }
  catch {
    // Keep the failure as a failure: a default here would look like the user's own hours.
    savedHours.value = { state: 'unreadable' }
  }
})

/**
 * Commute hours: expanded whenever there is room beside the content for the form (where
 * collapsing would only add a click), collapsed below that (where the height matters).
 */
const hoursExpanded = shallowRef(false)
const isSideRail = useMediaQuery('(min-width: 1280px)')

watch(isSideRail, (wide) => {
  // Only the automatic value follows the breakpoint; a manual toggle within a
  // layout is respected until the layout itself changes.
  hoursExpanded.value = wide
}, { immediate: true })
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      通勤时段
    </h2>

    <CommuteHoursCard
      v-model:expanded="hoursExpanded"
      :is-side-rail="isSideRail"
      :summary="summary"
    />
  </div>
</template>
