<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import type { ChainEmptyStateView, EmptyStateAction } from '../types'

/**
 * This purpose has no chain recorded.
 *
 * The empty state names a cause the USER can act on, and it may not let one cause
 * hide another: when the anchor a chain would start from was never saved, that fact
 * is stated and its screen is offered, whatever else is also true. The sentence and
 * the destination are F1's own for the same settings row, so the two features that
 * read it speak one language about it.
 *
 * The words are decided in `empty-state.ts` — including the case where the anchor
 * state could not be read at all, which is stated as neither saved nor missing.
 *
 * EACH CAUSE GETS ITS OWN PAGE, never 设置's index: 设置 is an index plus four pages, and
 * the cause picks which one. `chains` is only here because that recording surface exists
 * (see `EmptyStateAction` and `empty-state.ts`).
 */
const props = defineProps<{ view: ChainEmptyStateView }>()

/** Where a cause's one control goes, and the words it does it in. */
const ACTION: Record<EmptyStateAction, { to: string, label: string }> = {
  // The anchor row F1's own sentence names, on the page that owns it.
  settings: { to: '/settings/anchors', label: '去设置起点位置' },
  // The page a chain is recorded on (F10).
  chains: { to: '/settings/chains', label: '去设置里录入链路' },
}

/** The control to render, or none when the cause leaves the user nothing to press. */
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
