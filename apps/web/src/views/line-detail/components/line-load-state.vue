<script setup lang="ts">
import { computed } from 'vue'
import { lineLoadNoticeOf, type LineLoadState } from '@/line-load-state'

const props = defineProps<{
  isLoading: boolean
  /**
   * Which absence the last read ended in, or null when it has not ended in one.
   *
   * A named state from the store, never a message: the two absences are two facts and
   * this component states each of them from `@/line-load-state`, so the heading can
   * never be a string the response carried. An absent state with nothing loaded falls
   * back to the load that failed — the honest one of the two, because it is the one a
   * second attempt can change.
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
