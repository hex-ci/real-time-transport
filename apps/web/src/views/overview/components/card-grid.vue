<script setup lang="ts">
import { onBeforeUpdate, onUpdated, ref } from 'vue'
import LineMiniCard from './line-mini-card.vue'
import { captureCards, playReorder, type CardBox } from '../pin-motion'
import type { NearbyLocationState } from '../nearby-notice'
import type { ArrivalsRead, MiniCardConfig, OverviewMode } from '../types'

const props = defineProps<{
  cards: MiniCardConfig[]
  mode: OverviewMode
  arrivals: Record<string, ArrivalsRead>
  /**
   * 应用是否有位置，按位置 store 报告的方式。这是页面级事实 —— 每屏一个，不是每卡一个 ——
   * 转发给每张卡片，因为附近卡片的空状态是按它「为什么」没有站台来措辞的。
   */
  nearbyLocation: NearbyLocationState
  /**
   * 一次置顶/取消置顶正在进行时，被按下的那一条关注的 id；其余时候是 null。
   *
   * 它兼两个作用：一是**闸门** —— 只有它为真时才量坐标，故到站数据刷新引起的重排不会被画成
   * 动画；二是**点名** —— 动画要知道哪一张是「被移动的那张」，好给它抬起/下沉。
   */
  motionTargetId: string | null
}>()

defineEmits<{
  (e: 'switch-direction', card: MiniCardConfig, direction: 0 | 1): void
  (e: 'toggle-pin', card: MiniCardConfig): void
}>()

const gridEl = ref<HTMLElement | null>(null)
/** 重排前量下的坐标，键是关注 id。 */
let before: Map<string, CardBox> | null = null

/**
 * 重排前的坐标必须在 DOM 更新**之前**量。Vue 的 `onBeforeUpdate` 正是那一刻，而它跑在 props
 * 更新之后，故此处读到的 `motionTargetId` 已经是新值。
 */
onBeforeUpdate(() => {
  if (!props.motionTargetId || !gridEl.value) return
  before = captureCards(gridEl.value)
})

onUpdated(() => {
  const captured = before
  before = null
  if (!captured || !gridEl.value) return
  playReorder(gridEl.value, captured, props.motionTargetId)
})
</script>

<template>
  <!-- 流式响应网格：手机 1 列到超宽 4 列。间距跟随页面节奏（space-y），使卡片之间与导航到主区之间一致。 -->
  <div
    ref="gridEl"
    class="grid grid-cols-1 gap-2.5 sm:gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
  >
    <!-- 用关注行自己的 id 做 key，不用下标：置顶会在运行时重排这个列表，用下标会让每张被挪动
        的卡片卸载再挂载。`mode` 作为区分符留下；卡片背后没有关注行时用详情地址兜底。 -->
    <LineMiniCard
      v-for="line in cards"
      :key="`${line.favoriteId ?? line.detailHref}_${mode}`"
      :data-favorite-id="line.favoriteId"
      :line-name="line.lineName"
      :direction-name="line.directionName"
      :detail-href="line.detailHref"
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
      @switch-direction="$emit('switch-direction', line, $event)"
      @toggle-pin="$emit('toggle-pin', line)"
    />
  </div>
</template>
