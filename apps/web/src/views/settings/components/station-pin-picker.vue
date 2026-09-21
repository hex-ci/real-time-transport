<script setup lang="ts">
/**
 * Searchable station picker for a favourite's pinned stop.
 *
 * A Combobox rather than a Select: 913 has 92 stops, so scrolling a plain list
 * is unusable — typing filters by name and by order.
 *
 * The parent supplies the stops, so this component stays a pure control: it
 * renders what it is given and reports the chosen name back.
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

const props = defineProps<{
  /** Stops of the direction this pin applies to, in travel order. */
  stations: Station[]
  /** Currently pinned stop name, or null when unpinned. */
  modelValue: string | null
  /** Which direction is being pinned — labels the trigger only. */
  directionLabel: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
}>()

const open = shallowRef(false)
/** Filter text; reka-ui keeps the input uncontrolled, so track it for filtering. */
const query = shallowRef('')

const selected = computed(() =>
  props.stations.find(s => s.name === props.modelValue) ?? null,
)

/**
 * An assigned stop that the current direction does not serve.
 *
 * Displayed by name without an order: the whole point is that there is no stop
 * number here, and showing "未设置" instead would contradict the mismatch warning
 * beside it while hiding the value the user still has stored.
 *
 * Requires a loaded stop list — an empty list means "not loaded yet", and
 * claiming the stop is unserved then would assert something we do not know.
 */
const unservedStop = computed(() =>
  props.modelValue && props.stations.length > 0 && !selected.value ? props.modelValue : null,
)

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

function choose(name: string): void {
  emit('update:modelValue', name)
  open.value = false
}

function clear(): void {
  emit('update:modelValue', null)
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <ComboboxRoot
      v-model:open="open"
      :model-value="modelValue ?? ''"
      :disabled="disabled"
      :ignore-filter="true"
      class="min-w-0 flex-1"
      @update:model-value="(v) => choose(String(v))"
    >
      <ComboboxAnchor as-child>
        <ComboboxTrigger
          class="flex min-h-[40px] w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-1.5 text-left text-xs transition hover:border-cyan-500/50 disabled:cursor-not-allowed disabled:opacity-50 lg:px-3.5 lg:gap-2.5 lg:text-base"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <MapPin class="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <span v-if="selected" class="truncate text-slate-100">
              {{ selected.name }}
              <span class="ml-1 font-mono text-xs text-slate-400">第{{ selected.order }}站</span>
            </span>
            <span v-else-if="unservedStop" class="truncate text-amber-400">
              {{ unservedStop }}
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
              :key="`${st.order}_${st.name}`"
              :value="st.name"
              class="flex min-h-[38px] cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 outline-none data-[highlighted]:bg-cyan-500/15 data-[highlighted]:text-cyan-200 lg:gap-2.5 lg:px-3 lg:py-2 lg:text-base"
              @select="choose(st.name)"
            >
              <span class="truncate">{{ st.name }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span class="font-mono text-xs text-slate-400">第{{ st.order }}站</span>
                <Check v-if="st.name === modelValue" class="h-3.5 w-3.5 text-cyan-400" />
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
      class="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-400 active:scale-95"
      @click="clear"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
