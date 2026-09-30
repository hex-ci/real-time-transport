<script setup lang="ts">
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
import { Check, ChevronDown, MapPin } from '@lucide/vue'
import type { ComboboxOption, OptionsMatch, SelectedText } from './types'

/**
 * 下拉：触发器与面板同「设置」页的选站器一套（同配色、同圆角、44 高、`MapPin`+`ChevronDown`），
 * 通用的只有两段文字、过滤谓词，以及面板顶上要不要那个搜索框。
 *
 * 为什么是 Combobox 而不是原生 select：量大的列表（一条线路 90 多站）靠滚动挑不出来，得按文字缩。
 * 面板顶上是一个**普通 input**而非 ComboboxInput：reka 在面板挂载与打开时都会聚焦它自己的输入框，
 * 而过滤是本组件的 `filtered`（已开 `ignore-filter`）——普通 input 不设置 `inputElement`，
 * 两条聚焦路径都不触发。
 *
 * 值是一个不透明的 key，且可以不在 `options` 里，故触发器显示的那两段由 `selected` 给出，
 * 而不是去列表里找一个碰巧同名的主文本。可访问名由调用方给：周围文字区分不开两个同类控件时，
 * 只有调用方知道该叫它什么。
 *
 * 键盘在两种焦点位置都能用（触发器与搜索框）：面板打开后焦点仍停在触发器（上面那一条），
 * 故上/下、回车、Escape 由本组件自己处理，不依赖焦点落进面板。
 */
const props = withDefaults(defineProps<{
  /**
   * 控件自己的可访问名，落在触发器的 `aria-label` 上（同 `refresh-control` 的 `label`）。
   * 由调用方给：周围文字区分不开两个同类控件时，只有调用方知道该叫它什么。它不是一个由值算出来的
   * 名字——名字随选中值变，读屏会把同一个值念两遍。不给就无名。
   */
  label?: string
  /** 全部选项，按调用方自己的顺序——本组件不排序。 */
  options: ComboboxOption[]
  /** 选中的那一个的 key；什么都没选为 null。 */
  modelValue?: string | null
  /** 触发器显示的两段；null 时显示 `placeholder`。 */
  selected?: SelectedText | null
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** 选中的值不在 `options` 里——触发器的文字要说这件事。 */
  warning?: boolean
  disabled?: boolean
  /** 某条文字缩不缩这一项；缺省按两段文字包含。只对带搜索框的那种有意义。 */
  matches?: OptionsMatch
  /**
   * 面板顶上要不要那个搜索框。
   *
   * false 留给一眼看得完的短列表：面板打开即列出全部选项，顶上那层容器也不渲染。搜索框自己的
   * `role="combobox"`/`aria-autocomplete` 与它带来的聚焦路径都是「按文字缩」这件事的一部分，
   * 不渲染它就不该留着——留一个够不着的输入框，等于对外声称一个并不存在的组合框。
   * 因此过滤无从发生：`matches` 与 `emptyText` 在无搜索时都不生效。
   */
  searchable?: boolean
}>(), {
  modelValue: null,
  selected: null,
  placeholder: '未设置',
  searchPlaceholder: '搜索…',
  emptyText: '未找到匹配项',
  warning: false,
  disabled: false,
  matches: undefined,
  searchable: true,
})

const emit = defineEmits<{
  (e: 'update:modelValue', key: string): void
  (e: 'select', option: ComboboxOption): void
}>()

const open = shallowRef(false)
/** 过滤文字；reka-ui 把输入框保持为非受控，故自行跟踪它以便过滤。 */
const query = shallowRef('')
/** 键盘高亮的那一项在 `filtered` 里的下标；-1 表示没有。 */
const activeIndex = shallowRef(-1)

function matchesBothSegments(option: ComboboxOption, text: string): boolean {
  return option.primary.toLowerCase().includes(text)
    || (option.secondary?.toLowerCase().includes(text) ?? false)
}

const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return props.options
  const match = props.matches ?? matchesBothSegments
  return props.options.filter(option => match(option, text))
})

// 列表或过滤文字变了：高亮回到第一个候选，没有候选就没有。
watch([query, () => props.options], () => {
  activeIndex.value = filtered.value.length > 0 ? 0 : -1
})

// 关着时清空输入（reka 会重置它自己那个输入框，本组件自己重置），重新打开才不会显示过期的过滤结果；
// 打开时高亮落到已选的那一项上。
watch(open, (isOpen) => {
  if (isOpen) {
    activeIndex.value = filtered.value.findIndex(option => option.key === props.modelValue)
    return
  }
  query.value = ''
  activeIndex.value = -1
})

/**
 * 选中一项。
 *
 * 先写值、再报选项：调用方自己的重读处理器读的是它持有的那个值，故那次重读必须问的是**刚选中**的
 * 这一个，而不是上一个。
 */
function choose(option: ComboboxOption): void {
  emit('update:modelValue', option.key)
  emit('select', option)
  open.value = false
}

/**
 * 上/下、回车、Escape。挂在触发器与搜索框两处：面板打开后焦点在哪一个上都能用。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open.value = false
    event.stopPropagation()
    return
  }
  if (!open.value) {
    // 关着时下键就是开：只用键盘也能进到列表里。
    if (event.key === 'ArrowDown') {
      open.value = true
      event.preventDefault()
    }
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1
    const last = Math.max(filtered.value.length - 1, 0)
    activeIndex.value = Math.min(Math.max(activeIndex.value + step, 0), last)
    event.preventDefault()
    return
  }
  if (event.key === 'Enter') {
    const option = filtered.value[activeIndex.value]
    if (!option) return
    // 这一次回车由本组件兑现，故不再让它冒泡：reka 自己还有一条「对高亮项按下点击」的路径。
    event.preventDefault()
    event.stopPropagation()
    choose(option)
  }
}
</script>

<template>
  <ComboboxRoot
    v-model:open="open"
    :model-value="modelValue ?? ''"
    :disabled="disabled"
    :ignore-filter="true"
  >
    <ComboboxAnchor as-child>
      <ComboboxTrigger
        :aria-label="label"
        class="flex min-h-[44px] w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-left text-xs transition hover:border-cyan-500/50 lg:px-3.5 lg:gap-2.5 lg:text-base"
        @keydown="onKeydown"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          <span v-if="selected" class="min-w-0 truncate" :class="warning ? 'text-amber-400' : 'text-slate-100'">
            {{ selected.primary }}
            <span v-if="selected.secondary" class="ml-1 font-mono text-xs" :class="warning ? '' : 'text-slate-400'">{{ selected.secondary }}</span>
          </span>
          <span v-else class="truncate text-slate-400">
            {{ placeholder }}
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
        <div v-if="searchable" class="border-b border-slate-800 p-2">
          <input
            v-model="query"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            :aria-expanded="open"
            :placeholder="searchPlaceholder"
            class="min-h-[36px] w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-base text-white placeholder:text-slate-400 outline-none focus:border-cyan-500 md:text-xs lg:px-3 lg:text-base"
            @keydown="onKeydown"
          >
        </div>
        <ComboboxViewport class="max-h-[240px] overflow-y-auto p-1">
          <!-- 「没匹配上」是过滤这件事的结论，故只跟着搜索框一起出现：无搜索时列表就是全部选项。 -->
          <ComboboxEmpty
            v-if="searchable"
            class="px-3 py-4 text-center text-xs text-slate-400 lg:px-3.5 lg:py-5 lg:text-base"
          >
            {{ emptyText }}
          </ComboboxEmpty>
          <ComboboxItem
            v-for="(option, index) in filtered"
            :key="option.key"
            :value="option.key"
            class="flex min-h-[38px] cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none data-[highlighted]:bg-cyan-500/15 data-[highlighted]:text-cyan-200 lg:gap-2.5 lg:px-3 lg:py-2 lg:text-base"
            :class="index === activeIndex ? 'bg-cyan-500/15 text-cyan-200' : 'text-slate-200'"
            @select="choose(option)"
            @pointermove="activeIndex = index"
          >
            <span class="min-w-0">
              <span class="block truncate">{{ option.primary }}</span>
              <slot name="option-detail" :option="option"></slot>
            </span>
            <span class="flex shrink-0 items-center gap-1.5">
              <span v-if="option.secondary" class="font-mono text-xs text-slate-400">{{ option.secondary }}</span>
              <Check v-if="option.key === modelValue" class="h-3.5 w-3.5 text-cyan-400" />
            </span>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
