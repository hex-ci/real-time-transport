<script setup lang="ts">
/**
 * Searchable station picker whose value is a stop PAIR: the name AND its order.
 *
 * A Combobox rather than a Select: a bus route can have 90+ stops, so scrolling
 * a plain list is unusable — typing filters by name and by order.
 *
 * WHY THE VALUE IS THE PAIR. 线上同名站不止一个 (PRD): the same name stands at more
 * than one order on a real line. A control that reported the NAME alone would have its
 * caller resolve it back with a `find(name)`, and the second 「东大桥」 would silently
 * become the first — a (name, order) pair nobody picked, recorded without a word. So
 * the name and the order travel together, and the trigger reads back exactly what was
 * chosen rather than whatever the list happens to hold for that name.
 *
 * The parent supplies the stops, so this component stays a pure control: it renders
 * what it is given and reports the chosen pair back.
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
  /** Stops of the direction this pin applies to, in travel order. */
  stations: Station[]
  /**
   * The chosen stop as a PAIR — name and order together — or null when nothing is
   * chosen. Never a bare name: the order is what tells two same-named stops apart.
   */
  modelValue: StationChoice | null
  /** Which stop this control is — labels the trigger only. */
  directionLabel: string
  disabled?: boolean
  /**
   * The control's own accessible name, where the surrounding text is not enough to
   * tell one picker from another. A leg carries TWO of these (boarding and alighting)
   * over the same stop list, so a name is what keeps them apart for a screen reader.
   */
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: StationChoice | null): void
}>()

const open = shallowRef(false)
/** Filter text; reka-ui keeps the input uncontrolled, so track it for filtering. */
const query = shallowRef('')

/**
 * Whether the chosen pair is one this direction's list actually holds.
 *
 * A stop served by the OTHER direction, or a record whose numbering has changed
 * upstream, is a pair the list does not contain — and it must stay visible as what it
 * is rather than being matched to a same-named stop at another order.
 *
 * Requires a loaded list: an empty one means 「not read yet」, and calling the choice
 * unserved then would assert something we do not know.
 */
const unserved = computed(() => props.modelValue !== null
  && props.stations.length > 0
  && !props.stations.some(station =>
    station.name === props.modelValue!.name && station.order === props.modelValue!.order))

/** Whether one listed stop is the pair held as the value — the tick, by pair. */
function isChosen(station: Station): boolean {
  return props.modelValue !== null
    && station.name === props.modelValue.name
    && station.order === props.modelValue.order
}

/**
 * The identity one list item carries.
 *
 * reka-ui keys its own selection state — the `aria-selected` on each option, the
 * `data-state` beside it — by the item's `value`. A NAME cannot be that identity here:
 * 线上同名站不止一个 (PRD), so two options would share one value and picking the second
 * 「东大桥」 would announce BOTH of them as selected. The pair, written as one string, is
 * unique per stop and is what the selected state is keyed by.
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

// reka-ui resets the input on close; keep the filter in step so reopening does
// not show a stale filtered list.
watch(open, (isOpen) => {
  if (!isOpen) query.value = ''
})

/** The pair a click on a list item means: that item's own name AND order. */
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
    <!-- Selection is this component's own (`@select` carries the stop, not its name): reka-ui's
         root model-value can only hold the option's `value`, which a name cannot be when two
         stops share it — so it holds the pair's own key and no listener is bound to it. That
         keeps reka's `aria-selected` on the options agreeing with the pair that is selected. -->
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
            <!-- The pair as it is held, shown whole: 「东大桥 第4站」 is what was picked,
                 and a stop the list no longer holds keeps its own numbers. -->
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
            <!-- A plain input, not ComboboxInput: reka-ui focuses its input both on
                 content mount and on open, so the panel would always open with the
                 caret in the box. Filtering is this component's own `filtered`
                 computed (ignore-filter is on), so ComboboxInput bought nothing but
                 the stolen focus. A plain input leaves rootContext.inputElement
                 unset, so neither focus path fires — no blur hack needed. -->
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

    <!-- Clearing is a separate control: picking a stop and removing the pin are
         different intents, and reka-ui's combobox has no built-in clear. -->
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
