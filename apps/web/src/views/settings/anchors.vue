<script setup lang="ts">
/**
 * 位置锚点（F2）：家与公司，取自当前定位。
 *
 * 卡片没有变 —— 还是那个 `AnchorPicker`，自己读 `/api/transit/settings`，自己有诚实的三种状态
 * （读取中、读失败、已读）。这个页面只加了框：它自己的路径（`/settings/anchors`）、自己的
 * `<h2>`、以及自己的返回方式。陈述每个锚点是否已设置的索引行，通过 `anchors.ts` 读同一个应答。
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
