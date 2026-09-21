<script setup lang="ts">
import LineMiniCard from './line-mini-card.vue'
import type { ArrivalsFeed, MiniCardConfig, OverviewMode } from '../types'

defineProps<{
  cards: MiniCardConfig[]
  mode: OverviewMode
  /** Arrivals keyed by `${lineId}_${direction}`, merged into each row. */
  arrivals: Record<string, ArrivalsFeed | null>
}>()

defineEmits<{
  (e: 'open', lineId: string, direction: number): void
  (e: 'switch-direction', card: MiniCardConfig, direction: 0 | 1): void
}>()
</script>

<template>
  <!-- Fluid responsive grid from 1 col on mobile to 4 cols on ultrawide.
       Gap follows the page rhythm (space-y) so card-to-card matches nav-to-hero. -->
  <div class="grid grid-cols-1 gap-2.5 sm:gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    <LineMiniCard
      v-for="(line, idx) in cards"
      :key="`${line.lineName}_${idx}_${mode}`"
      :line-name="line.lineName"
      :direction-name="line.directionName"
      :stop-name="line.stopName"
      :stop-distance-meters="line.stopDistanceMeters"
      :rows="line.rows.map(r => ({
        ...r,
        arrivals: arrivals[`${r.lineId}_${r.direction}`] ?? null,
      }))"
      :mode="mode"
      :primary-direction="line.primaryDirection"
      :detail-loaded="line.detailLoaded"
      :is-subway="line.isSubway"
      @click="$emit('open', line.detailLineId, line.detailDirection)"
      @switch-direction="$emit('switch-direction', line, $event)"
    />
  </div>
</template>
