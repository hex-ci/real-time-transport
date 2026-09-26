<script setup lang="ts">
import { Clock, ChevronDown } from '@lucide/vue'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
import CommuteHoursForm from './commute-hours-form.vue'

defineProps<{
  /**
   * 表单是否无需点击即保持可见——宽屏拿到的状态。
   *
   * 名字来自卡片当初的布局（旧单页 设置 里的侧栏）；现在是四个页面、没有侧栏，
   * 故该标志只回答「有没有地方放表单」。改它不是搬代码而是改本卡片的契约，故保持原名。
   */
  isSideRail: boolean
  summary: string
}>()

/** 只在 xl 以下有意义；侧栏变体从不折叠。 */
const expanded = defineModel<boolean>('expanded', { required: true })
</script>

<template>
  <!-- 通勤时段：偏好，不是逐线路设置 -->
  <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
    <!-- 侧栏（xl+）：表单始终可见，折叠不省滚动、只多一次点击。
         列表下方堆叠（小于 xl）：可折叠，因为此时卡片确实增加页面高度。 -->
    <div v-if="isSideRail" class="space-y-4">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
        <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
        <span>通勤时段</span>
      </h3>
      <CommuteHoursForm />
    </div>

    <CollapsibleRoot v-else v-model:open="expanded">
      <!-- min-h-[44px]：折叠触发器本身是控件，两行文字只有 38px，仍需满足触点目标。 -->
      <CollapsibleTrigger
        class="group flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
      >
        <span class="flex min-w-0 items-center gap-2">
          <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-slate-200 lg:text-base">通勤时段</span>
            <span class="mt-0.5 block truncate font-mono text-xs text-slate-400">{{ summary }}</span>
          </span>
        </span>
        <ChevronDown
          class="h-4 w-4 shrink-0 text-slate-400 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>

      <CollapsibleContent
        class="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
      >
        <div class="mt-4 border-t border-slate-800/60 pt-4">
          <CommuteHoursForm />
        </div>
      </CollapsibleContent>
    </CollapsibleRoot>
  </section>
</template>
