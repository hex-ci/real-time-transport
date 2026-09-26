<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import type { ChainEmptyStateView, EmptyStateAction } from '../types'

/**
 * 这个时段没有任何链路记录。
 *
 * 空屏只点名使用者可行动的成因，且一个成因不得掩盖另一个：链路将要起步的锚点从未保存时，
 * 该事实先说，并给出它自己的页面。锚点状态完全读不到时既非已保存也非缺失，对此不作断言。
 */
const props = defineProps<{ view: ChainEmptyStateView }>()

const ACTION: Record<EmptyStateAction, { to: string, label: string }> = {
  // 锚点行由位置锚点页拥有。
  settings: { to: '/settings/anchors', label: '去设置起点位置' },
  chains: { to: '/settings/chains', label: '去设置里录入链路' },
}

const action = computed(() => (props.view.action === null ? null : ACTION[props.view.action]))
</script>

<template>
  <div class="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center sm:p-10">
    <p class="text-sm text-slate-300 lg:text-base">{{ view.headline }}</p>
    <p v-if="view.detail" class="mt-1.5 text-xs text-slate-400 lg:text-base">{{ view.detail }}</p>
    <RouterLink
      v-if="action"
      :to="action.to"
      class="mt-3 inline-flex min-h-11 items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:gap-1.5 lg:text-base"
    >
      <span>{{ action.label }}</span>
      <ChevronRight class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </RouterLink>
  </div>
</template>
