<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { legMarkOf } from '../provenance'
import BandChip from './band-chip.vue'
import TransferRow from './transfer-row.vue'
import type { BranchView, ChainCardView, TransferRowView } from '../types'

/**
 * One chain: what it is, whether the transfers can be made, and what the answer is
 * worth.
 *
 * A chain is EITHER a conclusion or a refusal — never both, and never a partial
 * one: a refusal is a code rather than a smaller answer, so this card holds no
 * margin, no minute and no vehicle for it. The verdict line states the band and the
 * tightest margin WITH the transfer it belongs to, because a chain's number is the
 * smallest of its legs and a reader who cannot see which leg that is cannot act on
 * it. The two readings of an unresolvable margin are printed on that same transfer,
 * and nowhere else.
 *
 * Nothing below adds up the legs: the chain ends at its last leg's alight station,
 * so the last row's own minute is the last number the answer has.
 */
const props = defineProps<{ card: ChainCardView }>()

/**
 * F4's mark for one leg — or nothing, when the chain is already stating the one
 * word. When the legs disagree the chain states none, and then every leg states
 * its own, so a modelled minute never rides under a live word.
 */
function markFor(row: TransferRowView): string | null {
  return legMarkOf(row.provenance, props.card.chainProvenance)
}

/**
 * The two readings of an unresolvable margin, for the transfer that margin belongs
 * to — the engine's own `bindingSeq`, never an index of ours.
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

    <!-- Deduced: the band, the margin, and which transfer the margin is at. -->
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

    <!-- Refused: one sentence, which transfer it is about, and the cause's own
         affordance. Nothing may sit beside a refusal that could be read as an
         answer, and the service state rides beside it only where the empty answer
         is a question about the service day. -->
    <div v-else-if="card.refusal" class="mt-2.5">
      <p class="text-sm font-medium text-slate-100 lg:text-base">{{ card.refusal?.sentence }}</p>
      <p v-if="card.refusal?.legText" class="mt-0.5 text-xs text-slate-400 lg:text-base">
        {{ card.refusal?.legText }}
      </p>
      <p v-if="card.refusal?.serviceText" class="mt-0.5 text-xs text-slate-300 lg:text-base">
        {{ card.refusal?.serviceText }}
      </p>
      <!-- The action is about one 设置 row (the anchor a chain starts from), so it names
           that page rather than the index: 设置 is an index plus four pages now, and the
           refusal's own cause decides which one. -->
      <RouterLink
        v-if="card.refusal?.action === 'settings'"
        to="/settings/anchors"
        class="mt-2 inline-flex min-h-11 items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3.5 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 lg:gap-1.5 lg:text-base"
      >
        <span>去设置起点位置</span>
        <ChevronRight class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </RouterLink>
    </div>

    <!-- The reading this answer came from: its own instant, and the kind of number
         it is. A refusal whose leg was never read has no reading and states none. -->
    <p v-if="card.reading" class="mt-2 text-xs text-slate-400 lg:text-base">{{ card.reading?.text }}</p>
  </article>
</template>
