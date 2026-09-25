<script setup lang="ts">
/**
 * 位置锚点 (F2): 家 and 公司, taken from the current position.
 *
 * The card is unchanged — the same `AnchorPicker` with its own read of
 * `/api/transit/settings` and its own three honest states (reading, read-and-failed, read).
 * This page adds only the frame: its own path (`/settings/anchors`), its own `<h2>`, and its
 * own way back. The index row that states whether each anchor is set reads the same row
 * through `anchors.ts`.
 */
import { BackToSettings, AnchorPicker } from './components'
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 pb-12">
    <BackToSettings />
    <h2 class="text-xl font-bold text-white md:text-2xl">
      位置锚点
    </h2>

    <AnchorPicker />
  </div>
</template>
