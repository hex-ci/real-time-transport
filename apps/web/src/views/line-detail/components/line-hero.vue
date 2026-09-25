<script setup lang="ts">
import { computed } from 'vue'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { operatingDaySecondsOf, operatingStatusOf, vehicleProvenanceOf } from '@real-time-transport/shared'
import { operatingBadgeOf } from '@/operating-copy'
import { provenanceLabelOf } from '@/provenance-copy'

const props = defineProps<{
  detail: LineDetail
  liveStatus: LiveLineStatus | null
  /** Subway vs bus accent classes, resolved by the view (one rule, one place). */
  accent: { lineName: string, stops: string }
}>()

/**
 * F4: what kind of vehicle reading this banner sits above, taken from the source
 * that answered rather than from the route type.
 *
 * `detail.type === 'subway'` used to decide the wording here, which is the same
 * answer only while the timetable engine is the one that replies — and it is
 * wrong the moment the aggregator fails over, or the day a bus line is served by
 * a source that models its vehicles. Null (no reading yet, or a source this build
 * does not know) renders no mark at all, never 实时.
 */
const dataMark = computed(() => provenanceLabelOf(vehicleProvenanceOf(props.liveStatus?.dataSource)))

/**
 * F3: whether a REAL vehicle is on the line, from the payload's own declared
 * source — never from the size of the list.
 *
 * The engine places generated trains inside an internal simulation window, so a
 * non-empty list on its own says nothing about the line running: a subway line
 * whose hours are unknown can show movement while its state is 运营时间未知.
 */
const hasRealVehicle = computed(() =>
  (props.liveStatus?.buses.length ?? 0) > 0
  && vehicleProvenanceOf(props.liveStatus?.dataSource) === 'live')

/**
 * F3: the line's service state, from the first/last departure the header already
 * shows two lines above — 「待发车/停运」 was one label for two opposite facts, and
 * it never said which one applied.
 *
 * A real vehicle actually on the line outranks the schedule; a generated one does
 * not, so a state known to be unknown keeps its say. Only with nothing from a real
 * source in range does the state from the line's own hours get to speak.
 *
 * Read at call time through a function, not cached in a computed: the state is
 * derived from the wall clock (`operatingDaySecondsOf`) as well as from
 * `props.detail`, and the clock is a reactive dependency of neither. A computed
 * keyed on props would hold whatever clock reading the last prop-changing render
 * saw and hand that back on later renders, while this call re-reads the clock
 * every time it runs. Neither recomputes by itself as the clock advances, so with
 * no re-render the badge is as old as the render either way — the difference is
 * that the call never carries a stale clock reading across a render that happened.
 */
function operatingBadge(): string {
  return operatingBadgeOf(hasRealVehicle.value, operatingStatusOf({
    firstDeparture: props.detail.firstBusTime,
    lastDeparture: props.detail.lastBusTime,
    nowSecOfDay: operatingDaySecondsOf(),
  }))
}
</script>

<template>
  <div class="hidden md:block shrink-0 overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 p-5 shadow-xl">
    <div class="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
      <div class="flex items-center gap-2.5 sm:gap-3.5">
        <div
          class="flex h-11 shrink-0 items-center justify-center rounded-xl border px-3 font-mono font-black whitespace-nowrap sm:h-14 sm:rounded-2xl sm:px-3.5"
          :class="[
            accent.lineName,
            detail.lineName.length > 4 ? 'text-base min-w-[74px] sm:text-lg sm:min-w-[88px]' : detail.lineName.length > 3 ? 'text-lg min-w-[62px] sm:text-xl sm:min-w-[76px]' : 'text-xl min-w-[54px] sm:text-2xl sm:min-w-[64px]',
          ]"
        >
          {{ detail.lineName }}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="min-w-0 truncate text-base font-bold text-white sm:text-2xl">
              {{ detail.directionName }}
            </h2>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold border" :class="accent.stops">
              {{ detail.stops.length }} 站
            </span>
          </div>
          <p class="mt-0.5 text-xs text-slate-400 font-mono">
            首末班：{{ detail.firstBusTime || '--:--' }} - {{ detail.lastBusTime || '--:--' }}
            <span v-if="dataMark" class="ml-2 text-slate-400"><span aria-hidden="true">·</span> {{ dataMark }}</span>
          </p>
        </div>
      </div>

      <!-- Metric Badges -->
      <div class="flex shrink-0 items-center gap-2 text-xs">
        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">当前在途</span>
          <span class="font-mono text-sm font-bold text-emerald-400 sm:text-base">
            {{ liveStatus?.buses.length || 0 }}
          </span>
          <span class="text-slate-400 text-xs leading-none"> 辆</span>
        </div>

        <div class="flex flex-1 flex-col items-center rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-1.5 sm:block sm:flex-none sm:px-3.5 sm:py-2">
          <span class="text-slate-400 block text-center text-xs leading-tight">运行状态</span>
          <span
            class="font-mono text-xs font-semibold"
            :class="hasRealVehicle ? 'text-emerald-400' : 'text-slate-400'"
          >
            {{ operatingBadge() }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
