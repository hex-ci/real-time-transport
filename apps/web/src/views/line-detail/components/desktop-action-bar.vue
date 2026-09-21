<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import type { DirectionOption } from '../types'

defineProps<{
  canSwitchDirection: boolean
  directionOptions: DirectionOption[]
  isActiveTab: (opt: DirectionOption) => boolean
  activePurpose: 'morning' | 'evening' | null
}>()

const emit = defineEmits<{
  (e: 'switch-direction', opt: DirectionOption): void
}>()
</script>

<template>
  <div class="hidden md:flex shrink-0 items-center justify-between">
    <RouterLink
      to="/"
      class="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:text-white lg:gap-2 lg:px-3.5 lg:py-2 lg:text-base"
    >
      <ArrowLeft class="h-3.5 w-3.5" />
      <span>返回总览</span>
    </RouterLink>

    <div class="flex items-center gap-2">
      <!-- Up/down direction switch, rendered as a real TAB BAR: a fixed
           left/right slot per direction so only the highlight moves between
           switches (never the labels). Swaps BOTH lineId and direction,
           because bus routes use a distinct upstream lineId per direction
           while subway reuses one. Only offered when the opposite way really
           resolves — never a "reverse driving" toggle on the same data. -->
      <div
        v-if="canSwitchDirection"
        role="tablist"
        aria-label="选择行驶方向"
        class="flex items-center rounded-xl border border-slate-700 bg-slate-800/80 p-0.5"
      >
        <button
          v-for="opt in directionOptions"
          :key="opt.direction"
          role="tab"
          :aria-selected="isActiveTab(opt)"
          class="rounded-lg px-3 py-1.5 text-xs font-medium transition lg:px-3.5 lg:py-2 lg:text-base"
          :class="isActiveTab(opt)
            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
            : 'text-slate-400 border border-transparent hover:text-slate-200'"
          @click="emit('switch-direction', opt)"
        >
          {{ opt.label }}
        </button>
      </div>

      <!-- Commute purpose badge: which leg this direction serves, read from the
           user's stored choice. Hidden when they have not chosen. -->
      <span
        v-if="activePurpose"
        class="hidden shrink-0 rounded-lg px-2 py-1 text-xs font-medium sm:inline-block"
        :class="activePurpose === 'morning'
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-violet-500/10 text-violet-400'"
      >
        {{ activePurpose === 'morning' ? '🏠 上班方向' : '🏢 下班方向' }}
      </span>
    </div>
  </div>
</template>
