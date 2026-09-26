<script setup lang="ts">
/**
 * 可搜索的站点选择器，其值是一**对**：站名**与**站序。
 *
 * 用 Combobox 而非 Select：一条公交线路可能有 90 多站，滚动纯列表不可用——
 * 打字按站名与站序过滤。
 *
 * 值为何是这一对：线上同名站不止一个，同一个站名在真实线路上会站在不止一个站序上。
 * 只报**站名**的控件会让调用方用 `find(name)` 解析回去，第二个「东大桥」会静默变成第一个
 * ——一对 (站名, 站序) 无人挑选，却被无声记录。故站名与站序一起流动，触发器逐字读回
 * 被选中的那一对，而不是列表里该站名碰巧持有的那个。
 *
 * 站点由父级提供，故本组件保持为纯控件：给它什么就渲染什么，并把选中的那一对报回去。
 */
import { computed, shallowRef, watch } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'
import { Check, ChevronDown, MapPin, X } from '@lucide/vue'
import type { Station } from '@real-time-transport/shared'
import type { StationChoice } from '../types'

const props = defineProps<{
  /** 本固定站点所属方向的站点，按行驶顺序。 */
  stations: Station[]
  /**
   * 选中的站作为**一对**——站名与站序一起——什么都没选时为 null。
   * 绝不是裸站名：站序才是把两个同名站区分开的东西。
   */
  modelValue: StationChoice | null
  /** 本控件是哪个站——只用于标注触发器。 */
  directionLabel: string
  disabled?: boolean
  /**
   * 控件自己的可访问名，用于周围文字不足以区分两个选择器之处。一段同时携带**两个**
   * 这样的控件（上车站与下车站）对着同一份站点列表，故需要一个名字为屏幕阅读器区分它们。
   */
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: StationChoice | null): void
}>()

const open = shallowRef(false)
/** 过滤文本；reka-ui 把输入框保持为非受控，故自行跟踪它以便过滤。 */
const query = shallowRef('')

/**
 * 选中的这一对是否真是本方向的列表所持有的。
 *
 * 由**另一个**方向服务的站、或编号已在数据源侧改变过的记录，都是列表不含的一对——
 * 它必须照其原样保持可见，而不是被匹配到另一个站序上的同名站。
 *
 * 需要一个已加载的列表：空列表意思是「还没读到」，
 * 此时把该选择判为无服务，会断言一件我们并不知道的事。
 */
const unserved = computed(() => props.modelValue !== null
  && props.stations.length > 0
  && !props.stations.some(station =>
    station.name === props.modelValue!.name && station.order === props.modelValue!.order))

/** 列表中某个站是否就是作为值持有的那一对——按这对打勾。 */
function isChosen(station: Station): boolean {
  return props.modelValue !== null
    && station.name === props.modelValue.name
    && station.order === props.modelValue.order
}

/**
 * 一个列表项携带的身份。
 *
 * reka-ui 用它自己的选择状态——每个选项上的 `aria-selected`、旁边的 `data-state`——
 * 以该项的 `value` 为键。此处**站名**不能是那个身份：线上同名站不止一个，故两个选项
 * 会共用一个值，挑第二个「东大桥」会把**两者**都宣布为选中。这一对写成一个字符串后
 * 每站唯一，选中状态就以它为键。
 */
function stationKey(stop: { name: string, order: number | null }): string {
  return `${stop.order}_${stop.name}`
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.stations
  return props.stations.filter(s =>
    s.name.toLowerCase().includes(q) || String(s.order) === q,
  )
})

// reka-ui 在关闭时重置输入框；让过滤器同步，
// 重新打开时才不会显示过期的过滤结果。
watch(open, (isOpen) => {
  if (!isOpen) query.value = ''
})

/** 点击一个列表项所意味的那一对：该项自己的站名**与**站序。 */
function choose(station: Station): void {
  emit('update:modelValue', { name: station.name, order: station.order })
  open.value = false
}

function clear(): void {
  emit('update:modelValue', null)
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <!-- 选中状态是本组件自己的（`@select` 携带站，而不是它的名字）：reka-ui 的根
         model-value 只能持有选项的 `value`，而两个站共用站名时它不能是站名——故它持有这一对
         自己的 key，且没有监听器绑在它上面。这让 reka 选项上的 `aria-selected`
         与选中的那一对保持一致。 -->
    <ComboboxRoot
      v-model:open="open"
      :model-value="modelValue ? stationKey(modelValue) : ''"
      :disabled="disabled"
      :ignore-filter="true"
      class="min-w-0 flex-1"
    >
      <ComboboxAnchor as-child>
        <ComboboxTrigger
          :aria-label="props.ariaLabel"
          class="flex min-h-[44px] w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-left text-xs transition hover:border-cyan-500/50 disabled:cursor-not-allowed disabled:opacity-50 lg:px-3.5 lg:gap-2.5 lg:text-base"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <!-- 按持有的原样整对显示：「东大桥 第4站」就是被挑中的那个，
                 而列表已不再持有的站保留它自己的编号。 -->
            <span v-if="modelValue" class="min-w-0 truncate" :class="unserved ? 'text-amber-400' : 'text-slate-100'">
              {{ modelValue.name }}
              <span v-if="modelValue.order !== null" class="ml-1 font-mono text-xs" :class="unserved ? '' : 'text-slate-400'">第{{ modelValue.order }}站</span>
            </span>
            <span v-else class="truncate text-slate-400">
              未设置
            </span>
          </span>
          <ChevronDown class="h-3.5 w-3.5 shrink-0 text-slate-400" />
        </ComboboxTrigger>
      </ComboboxAnchor>

      <ComboboxPortal>
        <ComboboxContent
          position="popper"
          :side-offset="6"
          class="z-50 max-h-[300px] w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-xl border border-cyan-500/30 bg-slate-900 shadow-2xl"
        >
          <div class="border-b border-slate-800 p-2">
            <!-- 普通 input，不是 ComboboxInput：reka-ui 在内容挂载时与打开时都会聚焦它的
                 输入框，故面板每次打开光标都在框里。过滤是本组件自己的 `filtered` computed
                 （已开启 ignore-filter），故 ComboboxInput 除了抢焦点别无所得。普通 input
                 不设置 rootContext.inputElement，两条聚焦路径都不触发——无需模糊 hack。 -->
            <input
              v-model="query"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="open"
              placeholder="搜索站点名或站序…"
              class="min-h-[36px] w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 md:text-xs lg:px-3 lg:text-base"
            >
          </div>
          <ComboboxViewport class="max-h-[240px] overflow-y-auto p-1">
            <ComboboxEmpty class="px-3 py-4 text-center text-xs text-slate-400 lg:px-3.5 lg:py-5 lg:text-base">
              未找到匹配站点
            </ComboboxEmpty>
            <ComboboxItem
              v-for="st in filtered"
              :key="stationKey(st)"
              :value="stationKey(st)"
              class="flex min-h-[38px] cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 outline-none data-[highlighted]:bg-cyan-500/15 data-[highlighted]:text-cyan-200 lg:gap-2.5 lg:px-3 lg:py-2 lg:text-base"
              @select="choose(st)"
            >
              <span class="truncate">{{ st.name }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span class="font-mono text-xs text-slate-400">第{{ st.order }}站</span>
                <Check v-if="isChosen(st)" class="h-3.5 w-3.5 text-cyan-400" />
              </span>
            </ComboboxItem>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>

    <!-- 清除是独立控件：挑一个站与取消固定是两个不同的意图，
         而 reka-ui 的组合框没有内置清除。 -->
    <button
      v-if="modelValue"
      type="button"
      :aria-label="`清除${directionLabel}固定站点`"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-400 active:scale-95"
      @click="clear"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
