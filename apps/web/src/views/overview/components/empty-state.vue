<script setup lang="ts">
import { ChevronRight, RefreshCw, TriangleAlert } from '@lucide/vue'
import { followedLinesUnreadableText, type ReadState } from '@/read-state'

/**
 * 首页没有任何卡片可显示时的样子 —— 以及能造成它的「三种」原因，它们不能被说成一种。
 *
 * `state` 是做这次读取的页面传下来的关注线路读取状态。它在这里重要，因为这张卡片以前只凭
 * 空数组渲染，而数组为空既可能是用户什么都没关注，也可能是没人读过他的列表。
 *
 *  - `reading`    还没有答案，于是什么都不主张；
 *  - `unreadable` 读取失败：说出来，并给出唯一能改变它的动作；
 *  - `read`       列表答了且为空 —— 只有这个状态下这句话是真的，链接就是它的动作。
 */
defineProps<{
  cityName: string
  state?: ReadState
}>()

defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div class="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
    <!-- 读不到的列表：原因是那次读取，动作是再读一次。 -->
    <template v-if="state === 'unreadable'">
      <p class="flex items-center justify-center gap-1.5 text-sm text-rose-400 lg:text-base">
        <TriangleAlert class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{{ followedLinesUnreadableText('暂时无法显示通勤卡片') }}</span>
      </p>
      <button
        type="button"
        class="mt-3 inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:gap-1.5 lg:px-4.5 lg:py-2.5 lg:text-base"
        @click="$emit('retry')"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </template>

    <!-- 还在读：它自己有状态，不借空状态的话说。 -->
    <p v-else-if="state === 'reading'" class="text-sm text-slate-400 lg:text-base">
      正在读取关注线路…
    </p>

    <template v-else>
      <p class="text-sm text-slate-400 lg:text-base">
        当前城市（{{ cityName }}）还没有关注线路
      </p>
      <!-- 「设置」现在是索引加四页，这个指针指向持有本屏所缺之物（关注线路）的那一页，而不是
         索引 —— 在专为消除这个状态而存在的屏幕上，指向索引要多花一次点按。 -->
      <RouterLink
        to="/settings/lines"
        class="mt-3 inline-flex items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 lg:gap-1.5 lg:px-4.5 lg:py-2.5 lg:text-base"
      >
        <span>去搜索并关注线路</span>
        <ChevronRight class="h-3.5 w-3.5" />
      </RouterLink>
    </template>
  </div>
</template>
