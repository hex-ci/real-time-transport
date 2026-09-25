<script setup lang="ts">
import BandChip from './band-chip.vue'
import type { BranchView, TransferRowView } from '../types'

/**
 * One transfer: which vehicle is taken, how long the wait at this platform is, and
 * the margin — together with what that margin is measured against.
 *
 * The row is about ONE vehicle, the one being boarded, and it says so. When the
 * margin's own reference has already gone (`referenceGone`), no margin is printed
 * at all: a negative minute beside the bus the user is walking to would read as
 * that bus's own margin, which is the one misreading this feature exists to
 * prevent. What the row does print then is the next vehicle's, and `basisText`
 * says so — `basisText` is stated in both cases, because a margin with no
 * reference is a number about no bus.
 *
 * The two branch readings are printed only on the leg the chain's unresolvable
 * margin belongs to (the card passes them to that row alone), where they replace
 * the single verdict the margin cannot give.
 */
defineProps<{
  row: TransferRowView
  /** F4's mark for this leg — null when the chain is already stating the one word. */
  markText: string | null
  /** The two readings of an unresolvable margin, or null for every other leg. */
  branches: BranchView[] | null
}>()
</script>

<template>
  <li class="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 lg:p-3">
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <p class="text-sm font-medium text-slate-100 lg:text-base">
        {{ row.lineName }}
      </p>
      <BandChip :band="row.band" :label="row.bandLabel" />
    </div>

    <p class="mt-1 text-xs text-slate-300 lg:text-base">
      {{ row.positionText }} · {{ row.vehicleText }} · {{ row.waitText }}
    </p>
    <p v-if="row.marginText" class="mt-0.5 text-xs text-slate-200 lg:text-base">
      {{ row.marginText }}
    </p>
    <p class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ row.basisText }}
    </p>
    <p class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ row.rideText }} · {{ row.alightText }}
    </p>
    <p v-if="markText" class="mt-0.5 text-xs text-slate-400 lg:text-base">
      {{ markText }}
    </p>

    <ul v-if="branches" class="mt-1.5 space-y-1">
      <li
        v-for="branch in branches"
        :key="branch.outcomeText"
        class="rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5"
      >
        <p class="text-xs font-medium text-slate-200 lg:text-base">{{ branch.outcomeText }}</p>
        <p class="mt-0.5 text-xs text-slate-400 lg:text-base">{{ branch.detailText }}</p>
      </li>
    </ul>
  </li>
</template>
