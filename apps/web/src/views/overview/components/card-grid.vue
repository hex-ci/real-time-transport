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
  /**
   * 置顶 PATCH 请求在途的那个关注的 id（没有时为 null）。请求优先：卡片在 PATCH 落定、
   * store 做唯一一次写入之前不动，在途的那一张在操作栏那一格显示 loading。
   */
  pinningId: string | null
}>()

defineEmits<{
  (e: 'switch-direction', card: MiniCardConfig, direction: 0 | 1): void
  (e: 'toggle-pin', card: MiniCardConfig): void
  (e: 'edit-followed', card: MiniCardConfig): void
}>()
</script>

<template>
  <!-- 流式响应网格：手机 1 列到超宽 4 列。间距跟随页面节奏（space-y），使卡片之间与导航到主区之间一致。 -->
  <!--
    Vue 自己量旧/新位置并只给真的换槽位的项加 `favorite-reorder-move`。这是唯一的重排动画入口：
    到站读数更新只改卡片内容，stable key 让它不会被误认为列表移动。
  -->
  <TransitionGroup
    tag="div"
    name="favorite-reorder"
    class="grid grid-cols-1 gap-2.5 sm:gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
  >
    <!--
      TransitionGroup 只能量「直接子项」的 DOM。把卡片组件包进这一层会让它量到组件 vnode 的注释锚点，
      move 被静默跳过；故这里显式渲出带稳定 key 的 div，卡片留在里面。
    -->
    <div
      v-for="line in cards"
      :key="line.favoriteId ?? line.detailHref"
      :data-favorite-id="line.favoriteId"
      class="min-w-0"
    >
      <LineMiniCard
        :line-name="line.lineName"
        :direction-name="line.directionName"
        :detail-href="line.detailHref"
        :stop-name="line.stopName"
        :stop-distance-meters="line.stopDistanceMeters"
        :anchor-source="line.anchorSource ?? null"
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
        :is-pinning="pinningId === line.favoriteId"
        @switch-direction="$emit('switch-direction', line, $event)"
        @toggle-pin="$emit('toggle-pin', line)"
        @edit-followed="$emit('edit-followed', line)"
      />
    </div>
  </TransitionGroup>
</template>

<style scoped>
/*
 * 只过渡 Vue 写入的 move transform。过渡期间不加阴影、缩放或第二条 transform；手机与桌面由同一
 * 浏览器列表过渡驱动，不再有两套时序相互覆盖。
 */
:deep(.favorite-reorder-move) {
  transition: transform 0.4s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  :deep(.favorite-reorder-move) {
    transition: none;
  }
}
</style>
