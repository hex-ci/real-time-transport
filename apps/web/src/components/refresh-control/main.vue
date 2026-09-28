<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw } from '@lucide/vue'

const {
  refreshing,
  freshness = '',
  disabled = false,
  label,
  idPrefix = '',
  hasReading = true,
  variant = 'full',
} = defineProps<{
  /** 页面自己算好的按下状态：在途的请求，或展示它取得之物的那次回读。 */
  refreshing: boolean
  /** store 算好的读数行全文，本组件不改写一个字，也不拆它。只有渲染读数那一半时才用得上。 */
  freshness?: string
  /** 页面自己的禁用条件（例如没有可重读的线路）——它不等于「正在刷新」。 */
  disabled?: boolean
  /** 按钮的可访问名：本控件是图标按钮，没有可见文字，故词由页面给出。 */
  label: string
  /** 同页出现第二个入口时传一个前缀，使两个实例的 id 不重、各自描述自己那一行读数。 */
  idPrefix?: string
  /**
   * 读数那一半是否还渲染在页面上（本实例里，或页面别处的那一个实例里）。
   * 不渲染时按钮不得指向一个屏幕上不存在的 id —— 那是描述到了一处虚空。
   */
  hasReading?: boolean
  /**
   * 本控件的两半常分处页面上两处（按钮在工具栏那一行、读数在行尾或下一行），故按 `variant` 只渲染一半：
   * `full`（默认）一次渲染读数与按钮；`button` 只出按钮；`reading` 只出那一行读数。
   * 两半分处两处时**必须**共用同一个 `idPrefix`，否则按钮描述的是另一处的字，或什么也描述不到。
   */
  variant?: 'full' | 'button' | 'reading'
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

/** 读数那一行的 id：分处两处时，它就是按钮与它那一半之间唯一的约定。 */
const freshnessId = computed(() => `${idPrefix}refresh-freshness`)

/** 只有那一枚按钮时容器退回普通块：没有可点之物的区域只会让同一个名字被念两遍。 */
const full = computed(() => variant === 'full')
const wrapperTag = computed(() => (full.value ? 'section' : 'div'))
const wrapperAttrs = computed(() => (full.value ? { 'aria-label': '数据刷新' } : {}))
const wrapperClass = computed(() => (full.value ? 'flex min-w-0 items-center gap-2 lg:gap-3' : ''))
/** 与按钮同处一块时读数吃余量，使按钮停在那一块的右端。 */
const readingClass = computed(() => (full.value
  ? 'min-w-0 flex-1 text-xs text-slate-400 lg:text-base'
  : 'min-w-0 text-xs text-slate-400 lg:text-base'))
/** 屏幕上没有读数那一半时，按钮不带这个指向：一个指向虚空的描述不比没有描述更好。 */
const describedBy = computed(() => (hasReading ? freshnessId.value : undefined))
</script>

<template>
  <!-- 只有那一行读数时，它的根就是这一行字：页面给的类（例如让它停在行尾的 `ml-auto`）落在它身上。 -->
  <p
    v-if="variant === 'reading'"
    :id="freshnessId"
    :class="readingClass"
  >
    {{ freshness }}
  </p>

  <component
    v-else
    :is="wrapperTag"
    v-bind="wrapperAttrs"
    :class="wrapperClass"
  >
    <!-- 读数自己的时刻与种类。从未取得的读数不给时间，故这一行说的是它拿到的字。 -->
    <p
      v-if="variant !== 'button'"
      :id="freshnessId"
      :class="readingClass"
    >
      {{ freshness }}
    </p>

    <!-- 44px 的图标按钮：与同一个应用里其他同类控件同大。状态不在这里 —— 一次按下的结局由提示承载。 -->
    <button
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 transition active:scale-95"
      :aria-label="label"
      :aria-busy="refreshing"
      :disabled="refreshing || disabled"
      :aria-describedby="describedBy"
      @click="emit('refresh')"
    >
      <RefreshCw
        class="h-4 w-4 shrink-0"
        :class="refreshing ? 'animate-spin' : ''"
        aria-hidden="true"
      />
    </button>
  </component>
</template>
