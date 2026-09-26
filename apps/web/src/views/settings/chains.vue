<script setup lang="ts">
/**
 * 通勤链路：逐段录入与编辑用户要乘的链路。
 *
 * 卡片是 `CommuteChainCard`——编辑器、拒绝与保存周期都在其中——在此作为页面主体渲染，
 * 有自己的路径、`<h2>` 与返回方式。链路页仍是读结论的地方；录入留在这里。
 *
 * 这里不计算任何结论：没有余量、没有等待、没有时长。
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
