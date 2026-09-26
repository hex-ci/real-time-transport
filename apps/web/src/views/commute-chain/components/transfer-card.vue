<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { legMarkOf } from '../provenance'
import BandChip from './band-chip.vue'
import TransferRow from './transfer-row.vue'
import type { BranchView, ChainCardView, TransferRowView } from '../types'

/**
 * 一张链路：它是什么、能不能赶上换乘，以及这个答案值多少。
 *
 * 链路要么是结论要么是拒绝，绝不是两者，也不是部分——拒绝是一个码而不是更小的答案。
 * 判决行把档位与最紧的余量连同它所属的那一段一起陈述：链路的数字是最小的那一段，
 * 看不出是哪一段的读者无法据此行动。余量不可解析时的两个读数只印在那一处。
 * 此处不加总各段：链路止于末段的下车站。
 */
const props = defineProps<{ card: ChainCardView }>()

/**
 * F4 在这一段的标记；链路已在陈述那个词时为 null。各段不一致时链路不陈述，
 * 于是每段各述其类。
 */
function markFor(row: TransferRowView): string | null {
  return legMarkOf(row.provenance, props.card.chainProvenance)
}

/**
 * 余量不可解析时的两个读数，只给余量所属的那一段——用引擎自己的 `bindingSeq`，
 * 不是本页的下标。
 */
function branchesFor(row: TransferRowView): BranchView[] | null {
  const conclusion = props.card.conclusion
  if (!conclusion || row.seq !== conclusion.bindingSeq) return null
  return conclusion.branches
}
</script>

<template>
  <article class="rounded-3xl border border-slate-800 bg-slate-900/60 p-3.5 sm:p-5">
    <header class="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-slate-100 lg:text-lg">{{ card.name }}</h3>
        <p class="mt-0.5 text-xs text-slate-400 lg:text-base">{{ card.originText }}</p>
      </div>
      <BandChip
        v-if="card.conclusion"
        :band="card.conclusion.band"
        :label="card.conclusion.bandLabel"
      />
    </header>

    <div v-if="card.conclusion" class="mt-2.5">
      <p class="text-sm font-medium text-slate-100 lg:text-base">{{ card.conclusion?.verdict }}</p>
      <p class="mt-0.5 text-xs text-slate-400 lg:text-base">
        {{ card.conclusion?.bindingText }}<template v-if="card.conclusion?.marginText"> · {{ card.conclusion?.marginText }}</template>
      </p>
      <ul class="mt-2 space-y-2">
        <TransferRow
          v-for="row in card.conclusion?.legs ?? []"
          :key="row.seq"
          :row="row"
          :mark-text="markFor(row)"
          :branches="branchesFor(row)"
        />
      </ul>
    </div>

    <!-- 拒绝：句子旁不得有任何可被读成答案的东西。 -->
    <div v-else-if="card.refusal" class="mt-2.5">
      <p class="text-sm font-medium text-slate-100 lg:text-base">{{ card.refusal?.sentence }}</p>
      <p v-if="card.refusal?.legText" class="mt-0.5 text-xs text-slate-400 lg:text-base">
        {{ card.refusal?.legText }}
      </p>
      <p v-if="card.refusal?.serviceText" class="mt-0.5 text-xs text-slate-300 lg:text-base">
        {{ card.refusal?.serviceText }}
      </p>
      <!-- 动作属于设置里的一行，故点名那一页而非设置的索引。 -->
      <RouterLink
        v-if="card.refusal?.action === 'settings'"
        to="/settings/anchors"
        class="mt-2 inline-flex min-h-11 items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3.5 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:gap-1.5 lg:text-base"
      >
        <span>去设置起点位置</span>
        <ChevronRight class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </RouterLink>
    </div>

    <p v-if="card.reading" class="mt-2 text-xs text-slate-400 lg:text-base">{{ card.reading?.text }}</p>
  </article>
</template>
