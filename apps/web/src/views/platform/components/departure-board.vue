<script setup lang="ts">
import { RefreshCw, TriangleAlert } from '@lucide/vue'
import { computed } from 'vue'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import { followedLinesUnreadableText, type ReadState } from '@/read-state'
import { congestionChipClass, congestionLabel } from '../congestion'
import type { DepartureItem } from '../types'

const props = defineProps<{
  items: DepartureItem[]
  loading: boolean
  /**
   * The followed-lines read's own state, from the page that made it.
   *
   * The rows are built from the followed lines, so an empty board has three causes and this
   * is what tells them apart — 「该站台暂无已关注线路途经」 is true of the ANSWERED empty list
   * only. A read that failed leaves no station to show either, and saying the user follows
   * nothing then is a claim about their stored rows that nobody obtained.
   */
  favoritesRead: ReadState
  /**
   * True while a refresh is running over rows that stay on screen.
   *
   * The non-destructive half of the loading flag: the rows are kept and the
   * update is signalled here instead — the refresh control in its busy state,
   * the same word (「正在刷新…」) the refresh family already words this state
   * with. It never shows together with the loading body: the body appears
   * exactly when there is nothing to keep.
   */
  refreshing?: boolean
  /**
   * The freshness line for the read behind the rows on screen, as the page
   * reports it — `null` while the board holds nothing a read produced. The
   * instant is the response's own `updatedAt`, so this line keeps describing
   * the read the VISIBLE rows came from through a refresh, a failure
   * included: an update that died on the wire does not move it.
   */
  freshness?: { text: string } | null
}>()

defineEmits<{
  (e: 'retry'): void
  (e: 'refresh'): void
}>()

/**
 * Whether the last full read left every row with nothing to state — the shape a
 * refresh that failed end to end takes (each request died on the wire). The
 * freshness line then carries the failure beside the kept rows' own instant:
 * the rows stay, and what happened to them is stated where the user reads.
 */
const readFailed = computed(() =>
  props.items.length > 0 && props.items.every(item => item.unavailable))

/**
 * What the freshness line states. A failed refresh keeps BOTH facts: the rows'
 * own instant stays on screen (it still describes the visible rows) and the
 * failure rides beside it in the refresh family's own wording (「刷新失败 ·
 * 未能取到最新数据」, from `transit.store`) — never instead of it.
 */
const failureText = '刷新失败 · 未能取到最新数据'
const freshnessText = computed(() => {
  if (!readFailed.value) return props.freshness?.text ?? null
  return props.freshness?.text
    ? `${failureText} · ${props.freshness.text}`
    : failureText
})

/**
 * F4: the kind of number this row's arrival minute is, worded in the one place
 * that words marks.
 *
 * Read from the row's own provenance, which the view decided from the source the
 * payload declared — the board shows a row per line, so it cannot state one kind
 * for the list. A row that stated nothing yields null and renders no mark: 「没有来源」
 * must never read as 实时.
 */
function markOf(item: DepartureItem): string | null {
  return provenanceLabelOf(item.provenance)
}
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
    <!-- The read behind the rows on screen, stated as the refresh family words it.
         Rendered whenever there is one — a refresh running over kept rows does not
         replace it (the instant still describes the visible rows), and a refresh
         that failed states that here, in the family's own wording. -->
    <div
      v-if="freshnessText"
      class="border-b border-slate-800/60 px-3 py-2 text-xs text-slate-400 lg:px-4 lg:text-base"
      :class="readFailed ? 'text-rose-400' : ''"
    >
      {{ freshnessText }}
    </div>

    <!-- Desktop header: hidden on mobile, where the two-row card layout needs no headings -->
    <div class="hidden grid-cols-12 border-b border-slate-800 bg-slate-900/90 px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider md:grid">
      <div class="col-span-3">线路 / 始发</div>
      <div class="col-span-4">开往方向</div>
      <div class="col-span-3 text-right">预计到站</div>
      <div class="col-span-2 text-right">车况</div>
    </div>

    <!-- The loading body and the rows are now separate states, not v-if/v-else:
         the body appears only when there is nothing on screen to keep, and rows
         stay rendered straight through a refresh (signalled on the control). -->
    <div v-if="loading && items.length === 0" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      正在加载车况数据...
    </div>

    <!-- An empty board has THREE causes, and each is worded as itself: the read failed (say
         so, and offer the read again), nothing has answered yet, or the list answered and no
         followed line passes this platform. Only the last one is a fact about what is stored. -->
    <div
      v-else-if="items.length === 0 && favoritesRead === 'unreadable'"
      class="flex flex-wrap items-center justify-center gap-2 p-8 text-center lg:p-8.5"
    >
      <p class="flex items-center gap-1.5 text-xs text-rose-400 lg:text-base">
        <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{{ followedLinesUnreadableText('暂时无法判断该站台是否有已关注线路途经') }}</span>
      </p>
      <button
        type="button"
        class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 transition hover:border-cyan-500/40 active:scale-95 lg:text-base"
        :disabled="loading"
        @click="$emit('retry')"
      >
        <RefreshCw class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>重试</span>
      </button>
    </div>

    <div v-else-if="items.length === 0 && favoritesRead === 'reading'" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      正在读取关注线路…
    </div>

    <div v-else-if="items.length === 0" class="p-8 text-center text-xs text-slate-400 lg:p-8.5 lg:text-base">
      该站台暂无已关注线路途经，请在「设置」中关注经过此站的线路
    </div>

    <div v-else class="divide-y divide-slate-800/60">
      <div
        v-for="item in items"
        :key="item.id"
        class="px-3 py-3 transition hover:bg-slate-900/50 md:grid md:grid-cols-12 md:items-center md:px-4 md:py-3.5"
      >
        <!-- Row 1 (mobile): line badge + direction -->
        <div class="flex items-center gap-2.5 md:col-span-4 md:col-start-1 md:row-start-1">
          <span
            class="flex h-7 shrink-0 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 font-mono font-bold text-cyan-400 whitespace-nowrap"
            :class="item.lineName.length > 4 ? 'text-xs min-w-[58px]' : 'text-xs min-w-[44px]'"
          >
            {{ item.lineName }}
          </span>
          <span class="min-w-0 truncate text-xs font-medium text-slate-200 lg:text-base">{{ item.terminal }}</span>
        </div>

        <!-- Row 2 (mobile): ETA + status, right-aligned against row 1's badge column -->
        <div class="mt-2 flex items-end justify-between md:col-span-6 md:col-start-7 md:row-start-1 md:mt-0 md:justify-end md:gap-4">
          <div class="font-mono">
            <template v-if="item.etaMinutes !== null">
              <span class="text-base font-bold text-cyan-400">{{ item.etaMinutes }}</span>
              <span class="text-xs text-slate-400"> 分钟</span>
              <!-- F4: the kind of number the minute is, from this row's own
                   provenance. A row that stated none renders no mark at all, so
                   an unclassified minute never borrows the flattering word, and
                   the mark stays quieter than the number it describes. -->
              <span v-if="markOf(item)" class="ml-1 text-xs font-normal text-slate-400"><span aria-hidden="true">·</span> {{ markOf(item) }}</span>
              <span v-if="item.stopsAway !== null" class="block text-xs text-slate-400">距 {{ item.stopsAway }} 站</span>
            </template>
            <!-- F3: with no vehicle carrying an ETA, state the operating fact —
                 service has ended, has not started, or is running with nothing
                 in range. The pair that used to sit here claimed to cover both
                 「waiting to depart」 and 「out of service」 at once, which is the
                 conflation F3 removes. -->
            <template v-else-if="item.operatingText">
              <span class="text-xs font-normal text-slate-400">{{ item.operatingText }}</span>
            </template>
            <!-- The request failed: this row has no vehicle and no service day to
                 report. Keyed off the named state, never a rendered word — and the
                 crowding chip says nothing about it, so the failure is stated once. -->
            <template v-else-if="item.unavailable">
              <span class="text-xs font-normal text-slate-400">无法获取</span>
              <span class="block text-xs text-slate-400">数据暂不可用</span>
            </template>
            <template v-else>
              <!-- Vehicle en route but upstream provides no ETA. The token comes
                   from `@/arrival-copy`, the one place that words this state, so
                   every surface that shows it shows the same sentence. -->
              <span class="text-xs font-normal text-slate-400">无法估算</span>
              <span class="block text-xs text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
            </template>
          </div>

          <!-- The crowding chip is a verdict, in word and in colour: both come
               from the level alone, never from whether a minute exists and never
               from a failure the numbers column already states. A row can hold a
               genuine verdict while its minute is uncomputable, so gating either
               on the minute would grey — or mute — exactly the verdict that IS
               known. An unknown level keeps the neutral chip, so neither the
               colour nor the word claims a verdict. -->
          <span
            class="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
            :class="congestionChipClass(item.congestion)"
          >
            {{ congestionLabel(item.congestion) }}
          </span>
        </div>
      </div>

      <!-- The refresh control, rendered only over rows it can re-read: a busy
           refresh disables it and states the update with the family's own word
           (「正在刷新…」) — the non-destructive signal, beside rows that stay.
           It is disabled on the prop rather than hidden, so the control the user
           pressed stays under their eyes while it works. -->
      <div class="flex justify-center border-t border-slate-800/60 p-2.5">
        <button
          type="button"
          class="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-xs font-medium whitespace-nowrap text-cyan-400 transition hover:bg-cyan-500/20 active:scale-95 disabled:opacity-60 lg:text-base"
          :disabled="refreshing"
          @click="$emit('refresh')"
        >
          <RefreshCw class="h-3.5 w-3.5 shrink-0" :class="refreshing ? 'animate-spin' : ''" aria-hidden="true" />
          <span>{{ refreshing ? '正在刷新…' : '刷新车况数据' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
