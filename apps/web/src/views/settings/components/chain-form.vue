<script setup lang="ts">
/**
 * The chain editor: one chain's name, its origin anchor, its commute purpose and its
 * ride legs.
 *
 * Everything the user can get wrong is settled HERE, before the request exists: the
 * draft is judged by `refuseChainDraft` on the save press, and a refusal renders in
 * place of the request. That is F10's 「同一套判据在录入时就地拦下，不靠提交后报错」 —
 * the write boundary's own rules are the same ones, stated again at the point of
 * entry, and the server's answer is never used as the error message for something
 * this screen could see.
 *
 * It offers no route search and no plan: 「系统不替使用者选路线」, so the only choices
 * on it are the user's own lines and stations.
 */
import { computed, ref, watch } from 'vue'
import { Plus, RefreshCw, TriangleAlert } from '@lucide/vue'
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import type { CommuteChain } from '@real-time-transport/shared'
import ChainLegFields from './chain-leg-fields.vue'
import { followedLinesUnreadableText, type ReadState } from '@/read-state'
import {
  MAX_CHAIN_LEGS,
  chainBodyOf,
  chainDraftOf,
  emptyChainDraft,
  emptyLegDraft,
  refuseChainDraft,
} from '../chain-draft'
import type { ChainDraft, ChainRefusal } from '../chain-draft'
import type { ChainLineOption } from '../types'

const props = defineProps<{
  /** The chain being edited, or null when a new one is being recorded. */
  chain: CommuteChain | null
  /** Every line+direction the editor offers. */
  lines: ChainLineOption[]
  /**
   * Which of the three states the page's followed-lines read is in — `lines` IS that list,
   * per direction, so an empty `lines` means one of three different things and this decides
   * which. The page owns the read (`line-stops.ts`) and passes its state down; the form
   * cannot ask the length, because an empty array is what a failed read leaves behind.
   */
  linesRead: ReadState
  saving: boolean
  /** The server's own refusal, verbatim — never re-worded here. */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'submit', write: ReturnType<typeof chainBodyOf>): void
  (e: 'cancel'): void
  /** The draft changed: whatever was last said about it is about a draft that is gone. */
  (e: 'edit'): void
  /** The followed set could not be read: re-read it where it is owned. */
  (e: 'retry-lines'): void
}>()

const draft = ref<ChainDraft>(props.chain ? chainDraftOf(props.chain, props.lines) : emptyChainDraft())
const refusal = ref<ChainRefusal | null>(null)

/**
 * Forget the last refusal the moment the draft it was about changes.
 *
 * A refusal names a state — 「第 1 段的下车站还没选」 — and it is rendered beside the very
 * controls that state belongs to. Left standing while the user does what it asked, it
 * still claims a screen that no longer exists: the alight picker reads 「建国门 第4站」 and
 * the sentence underneath denies it. The rule is not kept across edits; the next save
 * re-judges the draft from scratch, so anything still wrong is said again, and anything
 * fixed is simply no longer mentioned.
 *
 * The parent is told for the same reason: the server's own answer to a save is about the
 * request THAT draft produced, so an edit retires it too.
 */
watch(draft, () => {
  refusal.value = null
  emit('edit')
}, { deep: true })

const ANCHORS = [
  { value: 'home' as const, label: '家' },
  { value: 'work' as const, label: '公司' },
]
const PURPOSES = [
  { value: 'morning' as const, label: '上班' },
  { value: 'evening' as const, label: '下班' },
]

/**
 * Whether the editor has any line to offer at all.
 *
 * False means no line is on offer — and WHY is three different facts that must not be told
 * as one: the followed set has not answered yet, its read failed, or it answered and there
 * is nothing followed. The empty case is the only one that is about what the user stored,
 * and the block below is where each of the three is stated as itself.
 */
const hasLines = computed(() => props.lines.length > 0)

/** What the missing lines read as when the followed set could not be read at all. */
const noLinesUnreadable = followedLinesUnreadableText('暂时无法录入乘车段')
const atLegLimit = computed(() => draft.value.legs.length >= MAX_CHAIN_LEGS)

function addLeg(): void {
  if (atLegLimit.value) return
  draft.value.legs = [...draft.value.legs, emptyLegDraft()]
}

function removeLeg(index: number): void {
  // The last leg is not removable — the control that would fire this is disabled, so
  // this guard is the same rule stated once more where the array is written.
  if (draft.value.legs.length <= 1) return
  draft.value.legs = draft.value.legs.filter((_, at) => at !== index)
}

/**
 * Judge the draft, then either refuse in place or hand the write up.
 *
 * A refusal is rendered beside the controls and NO request is made — the point of
 * catching it here is that the server never has to say what this screen already knew.
 */
function onSave(): void {
  const found = refuseChainDraft(draft.value, props.lines)
  refusal.value = found
  if (found) return
  emit('submit', chainBodyOf(draft.value, props.lines))
}

function onCancel(): void {
  emit('cancel')
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="onSave">
    <div class="flex items-center justify-between gap-2">
      <h4 class="text-sm font-semibold text-slate-200">
        {{ chain ? '编辑链路' : '新增链路' }}
      </h4>
      <span class="text-xs text-slate-400">逐段录入，不由系统规划</span>
    </div>

    <!-- No line to offer: WHICH cause it is decides the words. A read that failed says so
         and offers the retry that can change it; nothing has answered yet says that; only an
         ANSWERED empty list is worded as 「还没有关注线路」, which is a claim about the stored
         rows and needs that answer to be true. -->
    <div
      v-if="!hasLines"
      class="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3"
      :class="linesRead === 'unreadable' ? 'border-rose-500/30 bg-rose-500/5' : 'border-slate-800 bg-slate-950/60'"
    >
      <p
        class="flex items-center gap-1.5 text-xs"
        :class="linesRead === 'unreadable' ? 'text-rose-400' : 'text-slate-400'"
      >
        <TriangleAlert v-if="linesRead === 'unreadable'" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span v-if="linesRead === 'unreadable'">{{ noLinesUnreadable }}</span>
        <span v-else-if="linesRead === 'reading'">正在读取关注线路…</span>
        <span v-else>还没有关注线路，无法录入乘车段：先用「关注线路」关注你要坐的线路，再从它的站序里选上车站与下车站</span>
      </p>
      <button
        v-if="linesRead === 'unreadable'"
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95"
        @click="emit('retry-lines')"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <label class="block">
      <span class="text-xs text-slate-400">名称</span>
      <input
        v-model="draft.name"
        type="text"
        maxlength="40"
        placeholder="给这条链路起个名字"
        class="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-slate-100 placeholder:text-slate-400 outline-none focus:border-cyan-500 lg:text-sm"
      >
    </label>

    <div class="space-y-1.5">
      <span class="text-xs text-slate-400">起点</span>
      <RadioGroupRoot
        v-model="draft.originAnchor"
        aria-label="起点"
        class="flex flex-wrap gap-2"
      >
        <RadioGroupItem
          v-for="anchor in ANCHORS"
          :key="anchor.value"
          :value="anchor.value"
          class="inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-medium transition data-[state=checked]:border-cyan-500/60 data-[state=checked]:bg-cyan-500/15 data-[state=checked]:text-cyan-200"
          :class="draft.originAnchor === anchor.value
            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
            : 'border-slate-700 bg-slate-950 text-slate-300'"
        >
          {{ anchor.label }}
        </RadioGroupItem>
      </RadioGroupRoot>
    </div>

    <div class="space-y-1.5">
      <span class="text-xs text-slate-400">通勤目的</span>
      <RadioGroupRoot
        v-model="draft.purpose"
        aria-label="通勤目的"
        class="flex flex-wrap gap-2"
      >
        <RadioGroupItem
          v-for="item in PURPOSES"
          :key="item.value"
          :value="item.value"
          class="inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-medium transition data-[state=checked]:border-cyan-500/60 data-[state=checked]:bg-cyan-500/15 data-[state=checked]:text-cyan-200"
          :class="draft.purpose === item.value
            ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
            : 'border-slate-700 bg-slate-950 text-slate-300'"
        >
          {{ item.label }}
        </RadioGroupItem>
      </RadioGroupRoot>
    </div>

    <div class="space-y-2">
      <span class="text-xs text-slate-400">乘车段</span>
      <ChainLegFields
        v-for="(leg, index) in draft.legs"
        :key="index"
        :leg="leg"
        :index="index"
        :lines="lines"
        :removable="draft.legs.length > 1"
        @update:leg="(next) => { draft.legs[index] = next }"
        @remove="removeLeg(index)"
      />
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 text-xs text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="atLegLimit || !hasLines"
        :title="atLegLimit ? `首版一条链路最多 ${MAX_CHAIN_LEGS} 段乘车` : undefined"
        @click="addLeg"
      >
        <Plus class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ atLegLimit ? `首版一条链路最多 ${MAX_CHAIN_LEGS} 段乘车` : '添加乘车段' }}</span>
      </button>
    </div>

    <!-- The refusal, worded as the fact it is: 「半截的链路存下去，链路页只能回
         station-unset」, so what the entry screen can settle in place it settles here. -->
    <p
      v-if="refusal"
      data-chain-refusal
      role="alert"
      class="flex items-start gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
    >
      <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ refusal.message }}</span>
    </p>
    <p
      v-if="error"
      data-chain-error
      role="alert"
      class="flex items-start gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400"
    >
      <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ error }}</span>
    </p>

    <div class="flex flex-wrap gap-2">
      <button
        type="submit"
        class="min-h-[44px] flex-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="saving"
      >
        {{ saving ? '保存中…' : '保存链路' }}
      </button>
      <button
        type="button"
        class="min-h-[44px] rounded-xl border border-slate-700 bg-slate-900 px-4 text-xs text-slate-200 transition hover:bg-slate-800 active:scale-95"
        @click="onCancel"
      >
        取消
      </button>
    </div>
  </form>
</template>
