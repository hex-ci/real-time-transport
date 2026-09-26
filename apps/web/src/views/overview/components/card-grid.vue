<script setup lang="ts">
import LineMiniCard from './line-mini-card.vue'
import type { NearbyLocationState } from '../nearby-notice'
import type { ArrivalsRead, MiniCardConfig, OverviewMode } from '../types'

defineProps<{
  cards: MiniCardConfig[]
  mode: OverviewMode
  arrivals: Record<string, ArrivalsRead>
  /**
   * 应用是否有位置，按位置 store 报告的方式。这是页面级事实 —— 每屏一个，不是每卡一个 ——
   * 转发给每张卡片，因为附近卡片的空状态是按它「为什么」没有站台来措辞的。
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
  <!-- 流式响应网格：手机 1 列到超宽 4 列。间距跟随页面节奏（space-y），使卡片之间与导航到主区之间一致。 -->
  <div class="grid grid-cols-1 gap-2.5 sm:gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
    <!-- 用关注行自己的 id 做 key，不用下标：置顶会在运行时重排这个列表，用下标会让每张被挪动
        的卡片卸载再挂载。`mode` 作为区分符留下；卡片背后没有关注行时用 detailLineId 兜底。 -->
    <LineMiniCard
      v-for="line in cards"
      :key="`${line.favoriteId ?? line.detailLineId}_${mode}`"
      :line-name="line.lineName"
      :direction-name="line.directionName"
      :stop-name="line.stopName"
      :stop-distance-meters="line.stopDistanceMeters"
      :rows="line.rows.map(r => ({
        ...r,
        arrivals: arrivals[`${r.lineId}_${r.direction}`] ?? { state: 'reading' },
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
