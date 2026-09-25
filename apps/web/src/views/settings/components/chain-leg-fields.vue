<script setup lang="ts">
/**
 * One ride leg's fields: the line it rides, the station boarded at and the station
 * alighted at, and the extra minutes the connection into it costs.
 *
 * Two facts this component owns and the rules module cannot see:
 *
 * - a station is a PAIR — its name and its order in the chosen line's list — so a
 *   choice through the picker sets both, and switching line drops the orders while
 *   keeping the names. An order locates a stop inside ONE line's numbering (a bus
 *   route's two directions are two line ids; a subway numbers the same station
 *   oppositely per direction), so an order that survived a line switch would write a
 *   station the new line does not have at that number. The name stays so the user can
 *   still see what they had picked, and the save refuses until it is picked again;
 * - 「未设置」 is not 0. The minutes field is empty when the draft holds null and reads
 *   0 when it holds 0, because 「没配」 and 「确实没有额外时间」 are different facts the
 *   deduction layer treats differently.
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
  /** Every line+direction the editor offers. */
  lines: ChainLineOption[]
  /** This leg's position in the chain. */
  index: number
  /** False for the only leg: a chain with no ride leg carries no conclusion. */
  removable: boolean
}>()

const emit = defineEmits<{
  (e: 'update:leg', leg: ChainLegDraft): void
  (e: 'remove'): void
}>()

const option = computed(() => optionOfLeg(props.leg, props.lines))

/** The stops this leg's line offers, and whether they are there to pick from at all. */
const stations = computed<Station[]>(() => option.value?.stations ?? [])
const pickable = computed(() => Boolean(option.value) && stations.value.length > 0
  && option.value!.stops === 'ready')

/** Why the stops cannot be picked from, in the words of the state actually reached. */
const listSentence = computed(() => (pickable.value || !option.value
  ? null
  : stopsStateSentence(option.value!)))

/**
 * Whether the stations on screen were just cleared by a line change.
 *
 * The user's picks are theirs, so their disappearance is stated rather than silent —
 * and a stop order locates a stop inside ONE line's numbering, so the pair cannot
 * simply travel to the new line.
 */
const clearedByLineChange = shallowRef(false)

/** One end of the leg as the picker's own value: the PAIR it holds, or null when unset. */
function choiceOf(name: string | null, order: number | null): StationChoice | null {
  return name === null ? null : { name, order }
}

const boardChoice = computed(() => choiceOf(props.leg.boardStationName, props.leg.boardStationOrder))
const alightChoice = computed(() => choiceOf(props.leg.alightStationName, props.leg.alightStationOrder))

/**
 * A station choice arrives as the PAIR the user clicked — name AND order together — and
 * is written as that same pair.
 *
 * Nothing is resolved from the name here: 线上同名站不止一个 (PRD), so a `find(name)`
 * against this leg's list would record the FIRST 「东大桥」 no matter which one was
 * picked — and the trigger would show that same wrong pair, so the record and the screen
 * would agree on a station nobody chose.
 */
function onStation(which: 'board' | 'alight', choice: StationChoice | null): void {
  const patch = which === 'board'
    ? { boardStationName: choice?.name ?? null, boardStationOrder: choice?.order ?? null }
    : { alightStationName: choice?.name ?? null, alightStationOrder: choice?.order ?? null }
  clearedByLineChange.value = false
  emit('update:leg', { ...props.leg, ...patch })
}

/**
 * Switching line clears this leg's stations.
 *
 * An order locates a stop in ONE line's numbering (a bus route's two directions are two
 * line ids; a subway numbers the same station oppositely per direction), so carrying it
 * across would record a stop the new line does not have at that number — and for a
 * subway it would silently flip the leg's direction. The stations are therefore
 * cleared as a pair, which is the honest reading of 「站名与站序要同时选定」, and the
 * clearing is stated so nothing vanishes without a word.
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
 * The extra minutes, as typed.
 *
 * An empty field is 「未设置」 and stays null; a typed 0 is a configured 「no extra time
 * at all」 and stays 0. Anything that is not a whole non-negative number is not a
 * value this field can hold, so the draft keeps what it had rather than reading a
 * typo as 「未设置」.
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

/** The words the remove control shows — and therefore the words its name must contain. */
const REMOVE_VISIBLE_LABEL = '删除该段'

/**
 * The remove control's accessible name and tooltip: the VISIBLE label first, then the leg
 * it removes or the reason it cannot be removed.
 *
 * WCAG 2.5.3 (Label in Name, Level A): the accessible name must contain the visible label,
 * because a name is what a voice-control user's spoken words are matched against — a name
 * that wholly replaced 「删除该段」 with 「删除第 1 段」 would leave the control unaddressable
 * by the text printed on it. The position (or the reason) is kept as the parenthetical,
 * so nothing this control already explained is lost.
 */
const removeName = computed(() => `${REMOVE_VISIBLE_LABEL}（${props.removable
  ? legPositionText(props.index)
  : LAST_LEG_REASON}）`)
</script>

<template>
  <div :data-chain-leg="index" class="space-y-2.5 rounded-xl border border-slate-800 bg-slate-950 p-3">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-slate-300">{{ legPositionText(index) }}</span>
      <!-- The last leg cannot be removed: 「一段车都没有的链路给不出任何结论」，and the
           way to drop the whole chain is the row's own 删除. A disabled control still
           owes its reason, which is the title and the label here — and the label keeps
           the visible 「删除该段」 inside it, so the words on the control are the words
           that address it (WCAG 2.5.3). -->
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
      <!-- A native select, not a hand-rolled picker: the choice is a bounded list of
           the user's own followed routes, and the platform header already uses one
           for its bounded choice. It also keeps the OS's own picker on a phone. -->
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
      <!-- Where the line is CHOSEN, the source of the list is stated — not only where it
           binds. This list is the followed routes (see `ChainLineOption`), so an
           unfollowed line is simply not among the options, and without this sentence
           nothing on screen would say why it is missing. -->
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
    <!-- With no line to choose from at all, the form above has already named that
         cause: repeating an instruction here would be one the user cannot follow. -->
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
