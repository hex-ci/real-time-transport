<script setup lang="ts">
import { computed } from 'vue'
import type { ChainMarginBand } from '@real-time-transport/shared'

/**
 * 余量档位的芯片。
 *
 * 词由 `margin.ts` 给出，此处不另造句，故芯片与旁边的分钟不会互相矛盾。
 * 颜色只作辅助：档位由文字标签承载，任何档位都不只靠颜色区分。
 */
const props = defineProps<{
  band: ChainMarginBand
  label: string
}>()

const toneClass = computed(() => {
  if (props.band === 'insufficient') return 'border-rose-500/40 bg-rose-500/10 text-rose-400'
  if (props.band === 'tight') return 'border-amber-500/40 bg-amber-500/10 text-amber-400'
  if (props.band === 'uncertain') return 'border-slate-600 bg-slate-800/60 text-slate-300'
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
})
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium"
    :class="toneClass"
  >
    {{ label }}
  </span>
</template>
