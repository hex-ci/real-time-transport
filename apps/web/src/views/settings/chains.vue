<script setup lang="ts">
/**
 * 通勤链路：逐段录入与编辑用户要乘的链路。
 *
 * 卡片是 `CommuteChainCard`——编辑器、拒绝与保存周期都在其中——在此作为页面主体渲染，
 * 有自己的路径、`<h2>` 与返回方式。链路页仍是读结论的地方；录入留在这里。
 *
 * 这里不计算任何结论：没有余量、没有等待、没有时长。它多读一样东西——家与公司的坐标，
 * 因为录入时每个站旁边要标出到参考点的**直线**距离（参考点在录入屏里才定得下来）。
 * 读法与索引行、位置锚点页共用 `settingsReadOf`（`/settings` 应答的唯一读法），
 * 故「未设置」与「未读到」在这一处区分，而不是各屏各猜一遍。
 */
import { onMounted, shallowRef } from 'vue'
import type { ReadValue } from '@/read-state'
import { useLineStops } from './line-stops'
import { settingsReadOf } from './index-summary'
import type { StoredAnchors } from './anchors'
import { BackToSettings, CommuteChainCard } from './components'

const { chainLineOptions, favoritesRead, readFavorites } = useLineStops()

/**
 * 家与公司的坐标，以及这次读取自己的三种状态。
 *
 * 答不上来时记成「未读到」，绝不记成「未设置」——后者是关于用户存了什么的主张，
 * 而这个请求根本没有作答。读取作答而两处都没坐标时，`settingsReadOf` 给出的是已读到、
 * 坐标为 null，由参考点自己的规则说成「未设置家的位置」。
 */
const anchorsRead = shallowRef<ReadValue<StoredAnchors>>({ state: 'reading' })

async function readAnchors(): Promise<void> {
  try {
    const res = await fetch('/api/transit/settings')
    anchorsRead.value = settingsReadOf(await res.json()).anchors
  }
  catch {
    anchorsRead.value = { state: 'unreadable' }
  }
}

onMounted(() => {
  void readAnchors()
})
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
      :anchors-read="anchorsRead"
      @retry-lines="readFavorites"
    />
  </div>
</template>
