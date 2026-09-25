<script setup lang="ts">
import { computed } from 'vue'
import type { ChainMarginBand } from '@real-time-transport/shared'

/**
 * F10's band, as a chip.
 *
 * The PRD asks for both the band and the minutes, and both are views of ONE
 * number: the band is the interpretation (`chainMarginBandOf` of the very margin
 * the row prints beside this chip) and the number is the reading. Nothing here
 * decides either — the label arrives already worded from `margin.ts`, so the chip
 * cannot disagree with the minute it is printed next to.
 *
 * The tone only backs the word up: every band has its own label, so no band is
 * ever signalled by colour alone, and each tone clears 4.5:1 at 12px on the
 * surfaces this page uses. 不足 (the vehicle the chain was timed against has gone)
 * is stated as a fact about a bus that left, not as a warning about the user.
 */
const props = defineProps<{
  band: ChainMarginBand
  label: string
}>()

const toneClass = computed(() => {
  if (props.band === 'insufficient') return 'border-rose-500/40 bg-rose-500/10 text-rose-400'
  if (props.band === 'tight') return 'border-amber-500/40 bg-amber-500/10 text-amber-400'
  if (props.band === 'uncertain') return 'border-slate-600 bg-slate-800/60 text-slate-300'
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
})
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium"
    :class="toneClass"
  >
    {{ label }}
  </span>
</template>
