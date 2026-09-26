<script setup lang="ts">
/**
 * 链路编辑器：一条链路的名称、通勤目的与乘车段。
 *
 * 起点刻意不在表单里：它由通勤目的决定（上班从家出发、下班从公司出发），
 * 故录入的是名称、目的与各段乘车段 —— 一个可以由规则算出的值不该再问一次使用者。
 *
 * 用户可能弄错的一切都在此敲定，先于请求存在：保存按下时由 `refuseChainDraft` 评判草稿，
 * 拒绝就渲染在请求的位置。写入边界自己的规则就是这些规则，在录入之处再说一遍，
 * 服务端的答案绝不拿来当本屏自己看得见之事的错误消息。
 *
 * 它不提供线路搜索、不提供方案：系统不替使用者选路线，故上面可选的只有用户自己的线路与站点。
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
  /** 正在编辑的链路；新录入时为 null。 */
  chain: CommuteChain | null
  /** 编辑器提供的每条线路+方向。 */
  lines: ChainLineOption[]
  /**
   * 页面那次关注线路读取处于三种状态中的哪一种——`lines` **就是**那份按方向的列表，
   * 故空的 `lines` 意味着三件不同的事之一，由本字段决定是哪一件。页面拥有那次读取
   * （`line-stops.ts`）并把状态传下来；表单不能去问长度，因为读失败留下的正是一个空数组。
   */
  linesRead: ReadState
  saving: boolean
  /** 服务端自己的拒绝，逐字——绝不在此改写。 */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'submit', write: ReturnType<typeof chainBodyOf>): void
  (e: 'cancel'): void
  /** 草稿变了：之前就它所说的一切，都是关于一个已不存在的草稿。 */
  (e: 'edit'): void
  /** 关注集合读不到：在它被拥有的地方重读。 */
  (e: 'retry-lines'): void
}>()

const draft = ref<ChainDraft>(props.chain ? chainDraftOf(props.chain, props.lines) : emptyChainDraft())
const refusal = ref<ChainRefusal | null>(null)

/**
 * 草稿一变，就忘掉上一次的拒绝。
 *
 * 拒绝点名的是一种状态——「第 1 段的下车站还没选」——而它渲染在那种状态所属的控件旁。
 * 用户照它说的做了之后它还站着，就在断言一个已不存在的屏幕：下车选择器读作「建国门 第4站」，
 * 而下面那句话否认它。规则不跨编辑保留；下一次保存从头重新评判草稿，
 * 故仍然错的会再说一遍，已改好的就不再提及。
 *
 * 通知父级同理：服务端对一次保存的答案是关于**那份**草稿产生的请求，
 * 故一次编辑也把它退掉。
 */
watch(draft, () => {
  refusal.value = null
  emit('edit')
}, { deep: true })

const ANCHOR_NOTE = '起点由通勤目的决定：上班从家出发、下班从公司出发'
const PURPOSES = [
  { value: 'morning' as const, label: '上班' },
  { value: 'evening' as const, label: '下班' },
]

/**
 * 编辑器到底有没有线路可提供。
 *
 * false 表示没有线路可提供——而**为什么**是三件不同的事实，不能当成一件说：关注集合还没作答、
 * 它的读取失败、或它已作答而什么都没关注。只有空的那种是关于用户存了什么，
 * 而下面的区块正是三种各自照原样陈述的地方。
 */
const hasLines = computed(() => props.lines.length > 0)

/** 关注集合完全读不到时，缺失的线路读作什么。 */
const noLinesUnreadable = followedLinesUnreadableText('暂时无法录入乘车段')
const atLegLimit = computed(() => draft.value.legs.length >= MAX_CHAIN_LEGS)

function addLeg(): void {
  if (atLegLimit.value) return
  draft.value.legs = [...draft.value.legs, emptyLegDraft()]
}

function removeLeg(index: number): void {
  // 最后一段不可移除——会触发此函数的那个控件是禁用的，
  // 故这个守卫是同一条规则在写数组之处的再陈述。
  if (draft.value.legs.length <= 1) return
  draft.value.legs = draft.value.legs.filter((_, at) => at !== index)
}

/**
 * 评判草稿，然后要么就地拒绝，要么把写入交上去。
 *
 * 拒绝渲染在控件旁，且**不发任何请求**——在此拦下的意义，
 * 就是服务端永远不必说出本屏已经知道的事。
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

    <!-- 无线路可提供：是哪一个成因决定措辞。读失败就说出并给出能改变它的重试；
         尚无任何作答就陈述这一点；只有**已作答的空列表**才措辞为「还没有关注线路」，
         那是对已存记录的断言，需要那个答案成立。 -->
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
      <!-- 起点不再是录入项：说出它由目的决定，比让使用者以为少填了一项更诚实。 -->
      <p class="text-xs text-slate-400">
        {{ ANCHOR_NOTE }}
      </p>
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

    <!-- 拒绝，按它本来的事实措辞：半截的链路存下去，链路页只能回 station-unset，
         故录入屏能就地敲定的就就地敲定。 -->
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
