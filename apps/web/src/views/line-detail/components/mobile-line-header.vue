<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeft, ArrowLeftRight, Info } from '@lucide/vue'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { purposeBadgeOf } from '@/purpose-badge'

const props = defineProps<{
  detail: LineDetail
  liveStatus: LiveLineStatus | null
  canSwitchDirection: boolean
  /** 屏幕上这个方向服务哪一腿通勤；未声明过时为 null。 */
  activePurpose: 'morning' | 'evening' | null
  accent: { lineName: string, stops: string }
}>()

const emit = defineEmits<{
  (e: 'switch-direction'): void
  (e: 'show-info'): void
}>()

/** 通勤目的徽标：与桌面端头部同一个词表、同一个来源（页面给的那一个值）。 */
const purposeBadge = computed(() => purposeBadgeOf(props.activePurpose))
</script>

<template>
  <!-- 移动端单行头部：约 44px 高，把 80%+ 的屏幕留给画布（md 以下） -->
  <div class="flex md:hidden shrink-0 items-center justify-between gap-1.5 rounded-xl border border-slate-800 bg-slate-900/90 px-2 py-1.5 shadow-md">
    <div class="flex min-w-0 items-center gap-1.5">
      <RouterLink
        to="/"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 active:scale-95"
        aria-label="返回总览"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
      </RouterLink>

      <!-- 可点的线路徽标：打开完整线路详情面板。 -->
      <button
        class="flex h-8 shrink-0 items-center justify-center rounded-lg border px-2 font-mono text-xs font-bold whitespace-nowrap active:scale-95"
        :class="accent.lineName"
        title="点击查看线路详情"
        @click="emit('show-info')"
      >
        {{ detail.lineName }}
      </button>

      <!-- 方向与快速切换。 -->
      <div class="flex min-w-0 items-center gap-1">
        <span class="min-w-0 truncate text-xs font-bold text-white">
          {{ detail.directionName }}
        </span>

        <!-- 通勤目的徽标：坐在方向名旁边一行之内，不占第二行（头部高度是固定的预算）。
             词与色调取同一个词表；未声明过时一个字都不显示。 -->
        <span
          v-if="purposeBadge"
          class="shrink-0 rounded-md px-1 py-0.5 text-xs font-medium leading-none whitespace-nowrap"
          :class="purposeBadge.tone"
        >
          {{ purposeBadge.text }}
        </span>

        <button
          v-if="canSwitchDirection"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-cyan-400 active:scale-95"
          title="切换反向"
          aria-label="切换反向"
          @click="emit('switch-direction')"
        >
          <ArrowLeftRight class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- 右侧：在途车辆数芯片与详情入口。 -->
    <button
      class="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2 text-xs font-mono active:scale-95"
      title="在途车辆与线路详情"
      @click="emit('show-info')"
    >
      <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
      <span class="font-bold text-emerald-400">{{ liveStatus?.buses.length || 0 }}</span>
      <span class="text-xs text-slate-400">车</span>
      <Info class="h-3.5 w-3.5 text-slate-400" />
    </button>
  </div>
</template>
