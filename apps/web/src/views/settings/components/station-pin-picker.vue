<script setup lang="ts">
/**
 * 可搜索的站点选择器，其值是一**对**：站名**与**站序。
 *
 * 值为何是这一对：线上同名站不止一个，同一个站名在真实线路上会站在不止一个站序上。
 * 只报**站名**的控件会让调用方用 `find(name)` 解析回去，第二个「东大桥」会静默变成第一个
 * ——一对 (站名, 站序) 无人挑选，却被无声记录。故站名与站序一起流动，触发器逐字读回
 * 被选中的那一对，而不是列表里该站名碰巧持有的那个。
 *
 * 选单本身是共用的带搜索的下拉（`@/components/searchable-combobox`）：一条公交线路可能有 90 多站，
 * 滚动纯列表不可用，打字按站名与站序缩。本组件在它之上只加两件这里才有的事——按**站身份**
 * 报回那一对，以及给每个站标注到参考点的距离。
 *
 * 站点由父级提供，故本组件保持为纯控件：给它什么就渲染什么，并把选中的那一对报回去。
 * 它多做了**一件标注**：给了参考点时，每个站旁边带上到那个点的直线距离，最近的那一个带
 * 「最近」标记——使用者要认的就是这一件事。标注只加在已有顺序上：选择器的顺序是线路的站序，
 * 站序是「只能顺行」的凭据，故这里没有排序，也没有一个站因为远而被隐去（见 `station-distance.ts`）。
 * 没有参考点就不标，参考点不可知时由它带出的那句话说出为什么——那也是一句要印出来的话。
 */
import { computed } from 'vue'
import { X } from '@lucide/vue'
import { SearchableCombobox } from '@/components/searchable-combobox'
import type { ComboboxOption } from '@/components/searchable-combobox'
import type { Station } from '@real-time-transport/shared'
import {
  NEAREST_STATION_MARK,
  STATIONS_WITHOUT_COORDS_SENTENCE,
  stationDistances,
  stationIdentity,
  type StationDistance,
} from '../station-distance'
import type { StationChoice, StationReference } from '../types'

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
  /**
   * 本列表每个站量到的参考点——链路的起点/目的锚点，或相邻段已经选好的那一站。
   * 本控件不在链路录入里时不给（没有参考点可说），参考点不可知时它是一个 `unknown`：
   * 两种情形都一个距离都不标，后者由它自己的句子说明原因。
   */
  reference?: StationReference | null
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

/** 站点按自己的身份——两条记录可能同名，站序才是它们的区别。 */
const byIdentity = computed(() =>
  new Map(props.stations.map(station => [stationIdentity(station), station])))

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
  && !byIdentity.value.has(stationIdentity(props.modelValue)))

/**
 * 每个站的标注，按站自己的身份。参考点不可知时是空表：一个数字都不标。
 *
 * 它按**整份列表**算，故搜索框里敲了什么不影响「最近」指的是哪一个——最小值是这条线路自己的
 * 事实。选项的身份与这里的键是同一个（`stationIdentity`），故选项的选中状态与它下面的距离
 * 说的是同一个站。
 */
const distances = computed(() => stationDistances(props.stations, props.reference ?? null))

/** 某个站旁边的标注；没有就是没有。 */
function markOf(station: Station): StationDistance | null {
  return distances.value.get(stationIdentity(station)) ?? null
}

/** 某个选项旁边的标注：选项只带身份，站才是量出来的那个。 */
function markOfOption(option: ComboboxOption): StationDistance | null {
  const station = byIdentity.value.get(option.key)
  return station ? markOf(station) : null
}

/** 参考点不可知时的那句话——它也是这一列没有数字的原因。 */
const referenceSentence = computed(() =>
  (props.reference?.state === 'unknown' ? props.reference.sentence : null))

/**
 * 参考点有了、本方向的站点却一个坐标都没有：数字一个都量不出来，而缺东西的是站点这一边。
 * 不标也不说明，会让「没有数字」与「这一列本来就没有数字」混成一件事。
 */
const coordsSentence = computed(() => (props.reference?.state === 'known'
  && props.stations.length > 0
  && distances.value.size === 0
  ? STATIONS_WITHOUT_COORDS_SENTENCE
  : null))

/** 选项：主文本是站名，次要细节是站序——挑中的是这两者合起来的那一个站。 */
const options = computed<ComboboxOption[]>(() => props.stations.map(station => ({
  key: stationIdentity(station),
  primary: station.name,
  secondary: `第${station.order}站`,
})))

/**
 * 触发器显示的是**持有的那一对**，不是列表里找出来的同名站：列表已不再持有它时
 * （另一个方向服务的站），它照自己的原样显示，只是换成告警色。
 */
const selected = computed(() => (props.modelValue === null
  ? null
  : {
      primary: props.modelValue.name,
      secondary: props.modelValue.order === null ? null : `第${props.modelValue.order}站`,
    }))

/**
 * 打字按站名与站序过滤。站序是**整段相等**：敲 `3` 找的是第 3 站，不该把第 13 站也算进来。
 */
function matchesStation(option: ComboboxOption, query: string): boolean {
  const station = byIdentity.value.get(option.key)
  if (!station) return false
  return station.name.toLowerCase().includes(query) || String(station.order) === query
}

/** 选中的那一个选项所意味的一对：该项自己的站名**与**站序。 */
function choose(option: ComboboxOption): void {
  const station = byIdentity.value.get(option.key)
  if (!station) return
  emit('update:modelValue', { name: station.name, order: station.order })
}

function clear(): void {
  emit('update:modelValue', null)
}
</script>

<template>
  <div>
    <div class="flex items-center gap-1.5">
      <SearchableCombobox
        :model-value="modelValue ? stationIdentity(modelValue) : null"
        :selected="selected"
        :options="options"
        :matches="matchesStation"
        :label="ariaLabel"
        :disabled="disabled"
        :warning="unserved"
        placeholder="未设置"
        search-placeholder="搜索站点名或站序…"
        empty-text="未找到匹配站点"
        class="min-w-0 flex-1"
        @select="choose"
      >
        <!-- 到参考点的**直线**距离：只说直线，读起来才不会被当成步行或路线的长度。
             「最近」标在整份站表里真正最近的那一个上，故一眼认得出要的那一站。 -->
        <template #option-detail="{ option }">
          <span v-if="markOfOption(option)" class="mt-0.5 flex items-center gap-1.5">
            <span class="font-mono text-xs text-slate-400">{{ markOfOption(option)!.text }}</span>
            <span v-if="markOfOption(option)!.nearest" class="rounded border border-cyan-500/40 bg-cyan-500/15 px-1 text-xs font-medium text-cyan-200">{{ NEAREST_STATION_MARK }}</span>
          </span>
        </template>
      </SearchableCombobox>

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

    <!-- 参考点不可知（锚点没存下来、没读到，或相邻段的站还没选）与站点没有坐标，各说各的原因；
         两句话都在选择器外面，故面板没打开时也读得到它们。 -->
    <p v-if="referenceSentence" class="mt-1 text-xs text-slate-400">
      {{ referenceSentence }}
    </p>
    <p v-else-if="coordsSentence" class="mt-1 text-xs text-slate-400">
      {{ coordsSentence }}
    </p>
  </div>
</template>
