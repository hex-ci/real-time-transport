<script setup lang="ts">
/**
 * 通勤链路 (F10): record and edit the chains the user rides, leg by leg.
 *
 * The card is `CommuteChainCard` — the editor, the refusals and the save cycle all live in it —
 * rendered here as the page's subject rather than one card wedged into a settings screen, on its
 * own path (`/settings/chains`), with its own `<h2>` and its own way back. 链路页 (/commute-chain)
 * is still where a chain's CONCLUSION is read; recording stays here.
 *
 * This file makes no 「未变」 claim about the card: the card and this page landed in the same
 * working tree, so there is no earlier revision of the card to diff against — a comment saying
 * it was untouched by the split would be a claim nobody can check. What is checkable is the
 * shape above, plus what the page hands the card: the lines a leg may ride come from
 * `line-stops.ts`, shared with 关注线路, so the stop list a leg is checked against is the very
 * list the pin pickers offer — and that read's own state travels with them, so a read that
 * FAILED is stated as a failed read rather than as 「还没有关注线路」.
 *
 * Nothing here computes a conclusion: no margin, no wait, no duration.
 */
import { useLineStops } from './line-stops'
import { BackToSettings, CommuteChainCard } from './components'

const { chainLineOptions, favoritesRead, readFavorites } = useLineStops()
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      通勤链路
    </h2>

    <CommuteChainCard
      :lines="chainLineOptions"
      :lines-read="favoritesRead"
      @retry-lines="readFavorites"
    />
  </div>
</template>
