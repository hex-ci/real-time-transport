<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeft } from '@lucide/vue'
import { purposeBadgeOf } from '@/purpose-badge'
import type { DirectionOption } from '../types'

const props = defineProps<{
  canSwitchDirection: boolean
  directionOptions: DirectionOption[]
  isActiveTab: (opt: DirectionOption) => boolean
  activePurpose: 'morning' | 'evening' | null
}>()

const emit = defineEmits<{
  (e: 'switch-direction', opt: DirectionOption): void
}>()

/** 通勤目的徽标：词与色调取自同一个词表，故与移动端头部说的是同一句话。 */
const purposeBadge = computed(() => purposeBadgeOf(props.activePurpose))
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
      <!-- 上下行方向切换，渲染成真正的页签栏：每个方向固定一个槽位，故切换时只有高亮在移动。
         同时替换 lineId 与 direction（公交每个方向是不同的线路 id，地铁复用同一个），
         且只在反向真的能解析时提供。 -->
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

      <!-- 通勤目的徽标：这个方向服务哪一腿，取自使用者存下来的选择；未选过时隐藏。 -->
      <span
        v-if="purposeBadge"
        class="hidden shrink-0 rounded-lg px-2 py-1 text-xs font-medium sm:inline-block"
        :class="purposeBadge.tone"
      >
        {{ purposeBadge.text }}
      </span>
    </div>
  </div>
</template>
