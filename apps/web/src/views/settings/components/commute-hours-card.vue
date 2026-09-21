<script setup lang="ts">
import { Clock, ChevronDown } from '@lucide/vue'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
import CommuteHoursForm from './commute-hours-form.vue'

defineProps<{
  /** Above xl the card sits in a side rail, where the form stays visible. */
  isSideRail: boolean
  summary: string
}>()

/** Only meaningful below xl; the side-rail variant is never collapsed. */
const expanded = defineModel<boolean>('expanded', { required: true })
</script>

<template>
  <!-- Commute hours: a preference, not a per-line setting -->
  <section class="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5">
    <!-- Side rail (xl+): the form is always visible. It sits beside the list,
         so collapsing would save no scrolling and only add a click.
         Stacked below the list (<xl): collapsible, because there the card
         does add height to the page. -->
    <div v-if="isSideRail" class="space-y-4">
      <h3 class="flex items-center gap-2 text-sm font-semibold text-slate-200 lg:text-base">
        <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
        <span>通勤时段</span>
      </h3>
      <CommuteHoursForm />
    </div>

    <CollapsibleRoot v-else v-model:open="expanded">
      <CollapsibleTrigger
        class="group flex w-full items-center justify-between gap-2 text-left"
      >
        <span class="flex min-w-0 items-center gap-2">
          <Clock class="h-4 w-4 shrink-0 text-cyan-400" />
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-slate-200 lg:text-base">通勤时段</span>
            <span class="mt-0.5 block truncate font-mono text-xs text-slate-400">{{ summary }}</span>
          </span>
        </span>
        <ChevronDown
          class="h-4 w-4 shrink-0 text-slate-500 transition-transform group-data-[state=open]:rotate-180"
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
