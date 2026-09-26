<script setup lang="ts">
import { computed } from 'vue'
import { lineLoadNoticeOf, type LineLoadState } from '@/line-load-state'

const props = defineProps<{
  isLoading: boolean
  /**
   * 上一次读取结束于哪一种缺失；没有结束于缺失时为 null。
   *
   * 取自 store 的具名状态，绝不是一段消息：两个缺失是两个事实，本组件从 @/line-load-state 各自
   * 陈述，故标题绝不可能是响应携带的字符串。有缺失状态却没有加载到任何东西时退回「加载失败」——
   * 两者中诚实的那一个，因为它是第二次尝试能改变的那个。
   */
  failure: LineLoadState | null
}>()

const notice = computed(() => lineLoadNoticeOf(props.failure ?? 'unavailable'))
</script>

<template>
  <div class="shrink-0 rounded-3xl border border-slate-800 bg-slate-900/60 p-12 text-center">
    <template v-if="isLoading">
      <p class="text-sm text-slate-400 lg:text-base">正在加载线路数据...</p>
    </template>
    <template v-else>
      <p class="text-sm font-semibold text-rose-400 lg:text-base">{{ notice.title }}</p>
      <p class="mt-1.5 text-xs text-slate-400 lg:mt-2 lg:text-base">{{ notice.detail }}</p>
    </template>
  </div>
</template>
