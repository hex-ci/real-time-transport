<script setup lang="ts">
/**
 * 一段乘车段的字段：乘坐的线路、上车站、下车站，以及接驳进这一段所花的额外分钟。
 *
 * 两件本组件拥有、规则模块看不到的事实：
 *
 * - 一个站是**一对**——站名与它在所选线路列表里的站序——故经选择器的一次选择同时设定两者，
 *   而换线路会丢掉站序、保留站名。站序在**一条**线路的编号里定位一个站（公交线路的两个方向
 *   是两个线路 id；地铁按方向对同一站反向编号），故换线路后幸存的站序会写入一个新线路
 *   在该编号上并不持有的站。站名留下，好让用户仍看得见他挑过什么，而保存会一直拒绝，
 *   直到重新挑定；
 * - 「未设置」不是 0。草稿持有 null 时分钟字段为空、持有 0 时读作 0，因为「没配」与
 *   「确实没有额外时间」是推导层区别对待的两个不同事实。
 */
import { computed, shallowRef } from 'vue'
import { Trash2 } from '@lucide/vue'
import type { Station } from '@real-time-transport/shared'
import StationPinPicker from './station-pin-picker.vue'
import {
  LAST_LEG_REASON,
  legPositionText,
  lineOptionLabel,
  optionOfLeg,
  stopsStateSentence,
} from '../chain-draft'
import type { ChainLegDraft } from '../chain-draft'
import type { ChainLineOption, StationChoice } from '../types'

const props = defineProps<{
  leg: ChainLegDraft
  /** 编辑器提供的每条线路+方向。 */
  lines: ChainLineOption[]
  /** 本段在链路中的位置。 */
  index: number
  /** 唯一一段时为 false：没有乘车段的链路给不出任何结论。 */
  removable: boolean
}>()

const emit = defineEmits<{
  (e: 'update:leg', leg: ChainLegDraft): void
  (e: 'remove'): void
}>()

const option = computed(() => optionOfLeg(props.leg, props.lines))

/** 本段线路提供的站点，以及它们是否可供挑选。 */
const stations = computed<Station[]>(() => option.value?.stations ?? [])
const pickable = computed(() => Boolean(option.value) && stations.value.length > 0
  && option.value!.stops === 'ready')

/** 站点为何不可挑选，用实际到达的那种状态的话。 */
const listSentence = computed(() => (pickable.value || !option.value
  ? null
  : stopsStateSentence(option.value!)))

/**
 * 屏上这些站点是否刚被一次换线路清空。
 *
 * 用户的挑选是他的，故它们的消失要被陈述而非无声——而站序在**一条**线路的编号里定位一个站，
 * 故这一对无法平移到新线路上。
 */
const clearedByLineChange = shallowRef(false)

/** 段的一端作为选择器自己的值：它持有的**那一对**；未设置时为 null。 */
function choiceOf(name: string | null, order: number | null): StationChoice | null {
  return name === null ? null : { name, order }
}

const boardChoice = computed(() => choiceOf(props.leg.boardStationName, props.leg.boardStationOrder))
const alightChoice = computed(() => choiceOf(props.leg.alightStationName, props.leg.alightStationOrder))

/**
 * 站的选择以用户点击的**那一对**到达——站名与站序一起——并照同一对写入。
 *
 * 此处绝不从站名解析：线上同名站不止一个，故对着本段列表做 `find(name)` 会记录**首个**
 * 「东大桥」，无论挑的是哪一个——而且触发器会显示同样错误的那一对，
 * 于是记录与屏幕会在一个没人选过的站上达成一致。
 */
function onStation(which: 'board' | 'alight', choice: StationChoice | null): void {
  const patch = which === 'board'
    ? { boardStationName: choice?.name ?? null, boardStationOrder: choice?.order ?? null }
    : { alightStationName: choice?.name ?? null, alightStationOrder: choice?.order ?? null }
  clearedByLineChange.value = false
  emit('update:leg', { ...props.leg, ...patch })
}

/**
 * 换线路会清空本段的站点。
 *
 * 站序在**一条**线路的编号里定位一个站（公交线路的两个方向是两个线路 id；地铁按方向对
 * 同一站反向编号），故把它带过去会记录新线路在该编号上并不持有的站——对地铁还会静默翻转
 * 本段方向。故站点作为一对被清空，这是「站名与站序要同时选定」的诚实读法，
 * 且清空被陈述，好让没有东西无声消失。
 */
function onLineChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const hadStations = props.leg.boardStationName !== null || props.leg.alightStationName !== null
  clearedByLineChange.value = hadStations && value !== (props.leg.lineKey ?? '')
  emit('update:leg', {
    ...props.leg,
    lineKey: value === '' ? null : value,
    boardStationName: null,
    boardStationOrder: null,
    alightStationName: null,
    alightStationOrder: null,
  })
}

/**
 * 额外分钟，按输入的原样。
 *
 * 空字段是「未设置」并保持 null；输入的 0 是已配置的「完全没有额外时间」并保持 0。
 * 不是非负整数的任何内容都不是本字段能持有的值，故草稿保持原值，
 * 而不是把一个错字读成「未设置」。
 */
function onExtraInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  if (raw === '') {
    emit('update:leg', { ...props.leg, transferExtraMinutes: null })
    return
  }
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) return
  emit('update:leg', { ...props.leg, transferExtraMinutes: Math.floor(minutes) })
}

const extraValue = computed(() => (props.leg.transferExtraMinutes === null
  ? ''
  : String(props.leg.transferExtraMinutes)))

/** 移除控件显示的文字——因此也是它的名字必须包含的文字。 */
const REMOVE_VISIBLE_LABEL = '删除该段'

/**
 * 移除控件的可访问名与提示：**可见**标签在前，随后是它移除的段或它不能移除的原因。
 *
 * 名字必须包含可见标签，因为语音控制用户念出的词正是与名字匹配的：一个用「删除第 1 段」
 * 完全替换掉「删除该段」的名字，会让该控件无法用印在它上面的文字寻址。
 * 位置（或原因）作为括号内容保留，故本控件已经说明过的东西一样不少。
 */
const removeName = computed(() => `${REMOVE_VISIBLE_LABEL}（${props.removable
  ? legPositionText(props.index)
  : LAST_LEG_REASON}）`)
</script>

<template>
  <div :data-chain-leg="index" class="space-y-2.5 rounded-xl border border-slate-800 bg-slate-950 p-3">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-slate-300">{{ legPositionText(index) }}</span>
      <!-- 最后一段不可移除：一段车都没有的链路给不出任何结论，而丢掉整条链路的方式是
           该行自己的 删除。禁用的控件仍欠它的原因，那就是此处的 title 与标签——而标签把
           可见的「删除该段」留在其中，故控件上的字就是能寻址它的字。 -->
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-300 transition hover:border-rose-500/40 hover:text-rose-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!removable"
        :aria-label="removeName"
        :title="removeName"
        @click="emit('remove')"
      >
        <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ REMOVE_VISIBLE_LABEL }}</span>
      </button>
    </div>

    <label class="block">
      <span class="text-xs text-slate-400">线路与方向</span>
      <!-- 原生 select，不是手搓选择器：这个选择是一份有界的、用户自己已关注线路的列表，
           而站台屏的表头也已经为它那个有界选择用了 select。手机上也保留系统自己的选择器。 -->
      <select
        :value="leg.lineKey ?? ''"
        class="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-slate-100 outline-none focus:border-cyan-500 lg:text-sm"
        @change="onLineChange"
      >
        <option value="">
          选择线路与方向
        </option>
        <option v-for="item in lines" :key="item.key" :value="item.key">
          {{ lineOptionLabel(item) }}
        </option>
      </select>
      <!-- 在**选择**线路之处就陈述列表的来源，而不是只在它绑住手之处。这份列表是已关注的
           线路，故未关注的线路干脆不在选项里，而没有这句话，
           屏上就没有东西说明它为何缺席。 -->
      <span class="mt-1 block text-xs text-slate-400">
        列表来自你关注的线路：没关注的线路要先关注，才能在这里选它的站序
      </span>
    </label>

    <p v-if="listSentence" class="text-xs text-slate-400">
      {{ listSentence }}
    </p>
    <template v-else-if="pickable">
      <div>
        <span class="text-xs text-slate-400">上车站</span>
        <StationPinPicker
          :model-value="boardChoice"
          :stations="stations"
          direction-label="上车站"
          aria-label="上车站"
          @update:model-value="(choice) => onStation('board', choice)"
        />
      </div>
      <div>
        <span class="text-xs text-slate-400">下车站</span>
        <StationPinPicker
          :model-value="alightChoice"
          :stations="stations"
          direction-label="下车站"
          aria-label="下车站"
          @update:model-value="(choice) => onStation('alight', choice)"
        />
      </div>
    </template>
    <p v-if="clearedByLineChange" class="text-xs text-slate-400">
      更换线路后已清空这一段的上车站与下车站，请重新选择
    </p>
    <!-- 完全没有线路可选时，上面的表单已经点名了那个成因：
         在此重复一条用户无法照做的指示。 -->
    <p v-else-if="!option && lines.length > 0" class="text-xs text-slate-400">
      请先选择线路与方向，再从它的站序里选上车站与下车站
    </p>

    <label class="block">
      <span class="text-xs text-slate-400">本段前的接驳额外时间（分钟）</span>
      <input
        type="number"
        min="0"
        step="1"
        inputmode="numeric"
        :value="extraValue"
        placeholder="未设置"
        class="mt-1 min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-slate-100 placeholder:text-slate-400 outline-none focus:border-cyan-500 lg:text-sm"
        @input="onExtraInput"
      >
      <span class="mt-1 block text-xs text-slate-400">
        留空表示未设置，与填 0（确实没有额外时间）不同
      </span>
    </label>
  </div>
</template>
