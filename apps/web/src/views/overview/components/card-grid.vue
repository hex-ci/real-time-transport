<script setup lang="ts">
import LineMiniCard from './line-mini-card.vue'
import type { NearbyLocationState } from '../nearby-notice'
import type { ArrivalsFeed, MiniCardConfig, OverviewMode } from '../types'

defineProps<{
  cards: MiniCardConfig[]
  mode: OverviewMode
  /** Arrivals keyed by `${lineId}_${direction}`, merged into each row. */
  arrivals: Record<string, ArrivalsFeed | null>
  /**
   * Whether the app has a position, as the location store reports it. A page-level
   * fact — one per screen, not one per card — forwarded to every card because a
   * nearby card's empty state is worded by WHY it has no platform.
   */
  nearbyLocation: NearbyLocationState
}>()

defineEmits<{
  (e: 'open', lineId: string, direction: number): void
  (e: 'switch-direction', card: MiniCardConfig, direction: 0 | 1): void
  (e: 'toggle-pin', card: MiniCardConfig): void
}>()
</script>

<template>
  <!-- Fluid responsive grid from 1 col on mobile to 4 cols on ultrawide.
       Gap follows the page rhythm (space-y) so card-to-card matches nav-to-hero. -->
  <div class="grid grid-cols-1 gap-2.5 sm:gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    <!-- Keyed on the favourite's own id, not its index: pinning reorders this
         list at runtime, and an index in the key would unmount/re-mount every
         shifted card. `mode` stays as a discriminator; detailLineId is the
         fallback when a card has no favourite behind it. -->
    <LineMiniCard
      v-for="line in cards"
      :key="`${line.favoriteId ?? line.detailLineId}_${mode}`"
      :line-name="line.lineName"
      :direction-name="line.directionName"
      :stop-name="line.stopName"
      :stop-distance-meters="line.stopDistanceMeters"
      :rows="line.rows.map(r => ({
        ...r,
        arrivals: arrivals[`${r.lineId}_${r.direction}`] ?? null,
      }))"
      :leg-state="line.legState"
      :nearby-location="nearbyLocation"
      :mode="mode"
      :primary-direction="line.primaryDirection"
      :detail-loaded="line.detailLoaded"
      :is-subway="line.isSubway"
      :is-pinned="line.isPinned"
      @click="$emit('open', line.detailLineId, line.detailDirection)"
      @switch-direction="$emit('switch-direction', line, $event)"
      @toggle-pin="$emit('toggle-pin', line)"
    />
  </div>
</template>
