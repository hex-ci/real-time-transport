<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, Pin, PinOff } from '@lucide/vue'
import { statedArrivalMinutes } from '@real-time-transport/shared/departure'
import type { DepartureReference } from '@real-time-transport/shared/departure'
import { referenceLineOf } from '../reference-line'
import { cardRowProvenanceOf } from '../provenance'
import { commuteLegNoticeOf } from '../commute-leg'
import type { CommuteLegState } from '../commute-leg'
import { nearbyEmptyNoticeOf } from '../nearby-notice'
import type { NearbyLocationState } from '../nearby-notice'
import { operatingTextOf } from '@/operating-copy'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '@/arrival-copy'
import { provenanceLabelOf } from '@/provenance-copy'
import type { ArrivalsFeed, CardRowWithArrivals, OverviewMode } from '../types'

const props = defineProps<{
  lineName: string
  /**
   * Label of the direction whose terminal the card leads with. Comes from the
   * authoritative upstream `directionName`; rows carry their own, this covers
   * the case where no row resolved (no board stop set, or no platform here).
   */
  directionName: string
  /** The stop being reported on: a board stop (commute) or the located platform (nearby). */
  stopName: string | null
  /** GPS distance to that stop, metres — nearby mode only. */
  stopDistanceMeters: number | null
  /**
   * What the caller established about this commute leg from the favourite's own
   * board stop and direction — or null for the nearby view, which has no commute
   * leg, and while the chosen direction's stop list has not loaded.
   *
   * A state, not a symptom: every unreadable leg carries no row either, so the
   * card may not read one off the absence of a row.
   */
  legState: CommuteLegState | null
  /**
   * Whether the app has a position, as the location store reports it — the fact
   * this card may NOT infer. A nearby card with no rows is empty for more than one
   * reason (no fix at all, a fix nothing resolves from, a browser that cannot
   * locate), and an empty row list cannot tell them apart, so the state is GIVEN
   * here.
   */
  nearbyLocation: NearbyLocationState
  rows: CardRowWithArrivals[]
  mode: OverviewMode
  detailLoaded: boolean
  /** Subway routes are tinted amber, buses cyan — one accent rule for route type. */
  isSubway: boolean
  /**
   * This route is the pinned one. The pin is a state overlaid on the list order,
   * so the card carries a marker rather than being lifted out of the list, and the
   * marker never displaces the arrivals it exists to make readable.
   */
  isPinned: boolean
  /**
   * Which direction leads when a card carries both. The leading row is decided
   * by the caller (commute leg in season, or a manual pick) rather than by
   * arrival time: on a platform the two directions serve opposite kerbs, so a
   * faster bus across the road must not displace the one being waited for.
   */
  primaryDirection?: 0 | 1 | null
}>()

defineEmits<{
  (e: 'click'): void
  /** The user tapped the trailing direction to promote it. */
  (e: 'switch-direction', direction: 0 | 1): void
  /** The user tapped the pin control: pin this card, or un-pin it when it is the pinned one. */
  (e: 'toggle-pin'): void
}>()

/**
 * Accent palette, kept in one place so every tinted element on the card follows the
 * route type: subway = amber, bus = cyan.
 */
const accent = computed(() => (props.isSubway
  ? {
      badgeBorder: 'border-amber-500/20',
      badgeBg: 'bg-amber-500/10',
      badgeText: 'text-amber-400',
      badgeShadow: 'shadow-[0_0_12px_rgba(245,158,11,0.2)]',
      headingHover: 'group-hover:text-amber-300',
      etaText: 'text-amber-400',
      spinner: 'border-t-amber-400',
      hoverBorder: 'hover:border-amber-500/50',
    }
  : {
      badgeBorder: 'border-cyan-500/20',
      badgeBg: 'bg-cyan-500/10',
      badgeText: 'text-cyan-400',
      badgeShadow: 'shadow-[0_0_12px_rgba(6,182,212,0.2)]',
      headingHover: 'group-hover:text-cyan-300',
      etaText: 'text-cyan-400',
      spinner: 'border-t-cyan-400',
      hoverBorder: 'hover:border-cyan-500/50',
    }))

/**
 * The notice for a nearby card with no platform to report, or null.
 *
 * Worded from the position state the caller GAVE the card, never from the empty
 * row list: that list is empty both before a fix exists and after one arrives
 * that no stop of this line resolves near, and the two causes need different
 * words. The row count decides only WHETHER there is anything to report — which
 * is this card's own data — never why.
 */
const nearbyNotice = computed(() => (
  props.mode === 'nearby' && props.rows.length === 0
    ? nearbyEmptyNoticeOf(props.nearbyLocation)
    : null
))

/**
 * The notice for a commute leg the card cannot read, or null when there is none.
 *
 * Worded from the state the caller established from the favourite's own fields —
 * never from this card's row count, which cannot tell an unset board stop from an
 * unchosen direction.
 */
const legNotice = computed(() => {
  if (props.mode === 'nearby') return null
  return commuteLegNoticeOf(props.legState, props.mode)
})

function nextOf(feed: ArrivalsFeed | null) {
  return feed?.arrivals?.[0] ?? null
}

/**
 * Minutes until that row's next bus; 0 means it is pulling in now.
 *
 * `null` covers BOTH facts the card has to tell apart — there is no row, and the
 * row states no minute — which is why the branch that words the row asks whether a
 * row EXISTS as well: a vehicle upstream could not price is not an empty service.
 */
function minutesOf(feed: ArrivalsFeed | null): number | null {
  const a = nextOf(feed)
  if (!a) return null
  // One rule for the whole app, so the reference row's verdict is drawn from the
  // very minute this list shows — and a row that states no minute is an absence
  // rather than a number this card would have to invent.
  return statedArrivalMinutes(a)
}

function subsequentOf(feed: ArrivalsFeed | null) {
  return (feed?.arrivals ?? []).slice(1)
}

/**
 * The row to lead with.
 *
 * A single-row card (commute) leads with that row. A two-row card (nearby)
 * leads with `primaryDirection` when the caller supplies one, and otherwise
 * falls back to the lowest direction number — a stable choice, deliberately NOT
 * the soonest bus, which would let the opposite kerb steal the headline every
 * refresh. A row with no arrivals still leads when it is the chosen one: the
 * headline then states that direction's operating fact (F3), which is the honest
 * answer for the direction the user is actually waiting for.
 */
const primaryRow = computed<CardRowWithArrivals | null>(() => {
  const rows = props.rows
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0] ?? null

  const chosen = props.primaryDirection
  if (chosen !== null && chosen !== undefined) {
    const match = rows.find(r => r.direction === chosen)
    if (match) return match
  }
  // Stable fallback: lowest direction number, never arrival time.
  return [...rows].sort((a, b) => a.direction - b.direction)[0] ?? null
})

const primaryArrivals = computed(() => primaryRow.value?.arrivals ?? null)
const primarySubsequent = computed(() => subsequentOf(primaryArrivals.value))

/**
 * F4: what kind of minutes this row is showing.
 *
 * A single feed can mix kinds — the payload sends one real vehicle's own minute
 * and this app computes the next — so the list mark is only valid when every
 * classified row agrees, and the fallback is per row: each row then states its
 * own, which is what lets a live minute be told from a computed one in the same
 * list. Derived from the rows the server sent — never from `isExact`, never from
 * the route type, and never from this component's position. Null renders nothing
 * at all, because 「没有来源」 is not 实时.
 */
const primaryRows = computed(() => primaryArrivals.value?.arrivals ?? [])

/** The leading minute's mark: the feed's one word, or that row's own kind. */
const primaryMark = computed(() => provenanceLabelOf(cardRowProvenanceOf(primaryRows.value, 0)))

/**
 * A 后续 row's mark, or null. Stated only when the feed mixes kinds: when one
 * word is true of the whole list it already rides on the leading minute, and
 * repeating it down the sub-list would crowd the minutes it describes.
 */
function subsequentMarkOf(index: number): string | null {
  return provenanceLabelOf(cardRowProvenanceOf(primaryRows.value, index + 1))
}

/**
 * F3: what the leading row says when it has no minutes to show.
 *
 * That the list is empty is not the whole fact — service may not have started,
 * may have ended for the day, or may simply have no vehicle in range — so the
 * line comes from the operating status the server derived from this line's own
 * first/last departure, never from a clock read here.
 */
const primaryOperatingText = computed(() => operatingTextOf(primaryArrivals.value?.operatingStatus))

/**
 * The other direction, shown compactly. Kept even when it has no arrivals, so
 * the user can still see (and switch to) the opposite kerb.
 */
const secondaryRow = computed<CardRowWithArrivals | null>(() =>
  props.rows.find(r => r !== primaryRow.value) ?? null)

/** Only a two-row card can be switched; a single-row card has nothing to trade. */
const canSwitch = computed(() => props.rows.length > 1 && secondaryRow.value !== null)

/** The opposite direction is worth tapping only when it actually has a bus. */
const secondaryHasArrivals = computed(() => nextOf(secondaryRow.value?.arrivals ?? null) !== null)

/** F3 for the trailing row: the same operating fact, in the same words. */
const secondaryOperatingText = computed(() =>
  operatingTextOf(secondaryRow.value?.arrivals?.operatingStatus))

/** F4 for the trailing row: its own feed, its own authority to state a mark. */
const secondaryRows = computed(() => secondaryRow.value?.arrivals?.arrivals ?? [])

/**
 * The trailing row's mark. Same fallback as the leading one: the feed's single
 * word when the rows agree, otherwise the row being shown states its own kind.
 */
const secondaryMark = computed(() => provenanceLabelOf(cardRowProvenanceOf(secondaryRows.value, 0)))

/** Every future bus across all rows — the honest "how many are coming" count. */
const aheadCount = computed(() =>
  props.rows.reduce((sum, r) => sum + (r.arrivals?.arrivals?.length ?? 0), 0))

const modeLabel = computed(() => (props.mode === 'morning'
  ? '🏠 上班'
  : props.mode === 'evening' ? '🏢 下班' : '📍 附近'))

/**
 * F1's reference for the leading row, or null.
 *
 * Commute legs only. There 家 / 公司 really is 「where you are」, which is what
 * makes 「锚点 → 站台」 a walk the user is about to take; in the nearby view the
 * platform shown is simply the closest one to a live fix, so the same walk would
 * be a number about a trip nobody is taking.
 */
const reference = computed<DepartureReference | null>(() => {
  if (props.mode === 'nearby') return null
  return primaryArrivals.value?.reference ?? null
})

/**
 * The reference line's text, or null when there is nothing honest to say.
 *
 * It is a REFERENCE, not a replacement: the arrival minutes above stay complete
 * and this line can only ever add one to the panel — never hide, shrink or
 * truncate a single one of them.
 */
const referenceLine = computed(() => referenceLineOf(reference.value))
</script>

<template>
  <div
    class="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 shadow-lg backdrop-blur-md transition hover:bg-slate-900"
    :class="accent.hoverBorder"
    @click="$emit('click')"
  >
    <!-- Pinned marker: a strip on the card's own top edge. Neutral by design — the
         cyan/amber accent means route TYPE, so a state marker borrowing either would
         read as a different kind of line. -->
    <div
      v-if="isPinned"
      class="flex items-center gap-1.5 bg-slate-800/90 px-4 py-1.5 text-xs font-semibold text-slate-100"
    >
      <Pin class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>置顶</span>
    </div>

    <div class="p-4">
      <!-- Card Header -->
      <div class="flex items-center justify-between">
        <div class="flex min-w-0 items-center gap-2.5">
          <span
            class="flex h-9 shrink-0 items-center justify-center rounded-xl border px-2.5 font-mono font-bold whitespace-nowrap"
            :class="[accent.badgeBorder, accent.badgeBg, accent.badgeText, accent.badgeShadow, lineName.length > 4 ? 'text-xs min-w-[64px]' : lineName.length > 3 ? 'text-sm min-w-[52px]' : 'text-base min-w-[44px]']"
          >
            {{ lineName }}
          </span>
          <div class="min-w-0">
            <h3 class="line-clamp-2 text-sm font-semibold text-slate-100 transition lg:text-base" :class="accent.headingHover">
              {{ primaryRow?.directionName || directionName }}
            </h3>
            <p class="truncate text-xs text-slate-400">
              {{ modeLabel }}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <!-- Ahead-vehicles badge: future buses only, honest zero -->
          <span
            class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
            :class="aheadCount > 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/60 text-slate-400'"
          >
            <span
              v-if="aheadCount > 0"
              class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
            ></span>
            {{ aheadCount > 0 ? `前方 ${aheadCount} 辆` : '前方暂无来车' }}
          </span>

          <!-- Pin entry + cancel, both on the card: the toggle names the action it
               performs, so a pinned card offers its own way back off the top. Held at
               the project's 40px floor for a secondary control — the card body opens
               the detail view, so an undersized target costs a wrong navigation. -->
          <button
            type="button"
            class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition"
            :class="isPinned
              ? 'border-slate-600 bg-slate-800 text-slate-100'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-700 hover:text-slate-100'"
            :aria-label="isPinned ? '取消置顶' : '置顶此线路'"
            :title="isPinned ? '取消置顶' : '置顶此线路'"
            :aria-pressed="isPinned"
            @click.stop="$emit('toggle-pin')"
          >
            <PinOff v-if="isPinned" class="h-4 w-4" aria-hidden="true" />
            <Pin v-else class="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- Loading state: detail not yet resolved from the API -->
      <div v-if="!detailLoaded" class="my-3.5 flex items-center justify-center rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-400 lg:px-3.5 lg:py-2 lg:text-base">
        <span class="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600" :class="accent.spinner"></span>
        正在加载线路数据...
      </div>

      <template v-else>
        <!-- Honest empty states, one per cause -->
        <div v-if="nearbyNotice" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
          {{ nearbyNotice }}
        </div>
        <div v-else-if="legNotice" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
          {{ legNotice }}
        </div>

        <div v-else-if="stopName" class="my-3.5 space-y-2.5 rounded-xl bg-slate-950/80 p-3">
          <!-- The stop this card reports on -->
          <div class="flex items-center justify-between text-xs lg:text-base">
            <span class="min-w-0 truncate text-slate-300">
              {{ stopName }}<span v-if="primaryRow?.stopOrder" class="ml-1.5 text-slate-400">第 {{ primaryRow.stopOrder }} 站</span>
            </span>
            <!-- Nearby mode adds the GPS distance; commute mode already names the
                 leg under the heading, so the right side stays empty there. -->
            <span v-if="stopDistanceMeters !== null" class="shrink-0 font-mono text-slate-400">
              {{ stopDistanceMeters }}m
            </span>
          </div>

          <!-- Primary ETA. The minute comes from whatever the server could honestly
               produce; the mark beside it says which kind of number that is (F4).
               `flex-wrap` so the trailing metadata — which now ends with the mark —
               moves to its own line on a 375px phone instead of squeezing the
               minutes, and `ml-auto` keeps it right-aligned when it does. -->
          <div v-if="nextOf(primaryArrivals)?.isAtStation" class="flex items-baseline gap-2">
            <!-- An observation of where a vehicle is, not a number: the row behind
                 this state carries its kind (the server prices it as `live`), but a
                 mark answers 「this number came from where」 and this claim states no
                 minute — the line-detail panel renders none for the same state. -->
            <span class="font-mono text-xl font-black tracking-tight" :class="accent.etaText">正在进站</span>
          </div>
          <div v-else-if="minutesOf(primaryArrivals) !== null" class="flex flex-wrap items-baseline gap-2">
            <span class="font-mono text-2xl font-black tracking-tight" :class="accent.etaText">
              {{ minutesOf(primaryArrivals) }}
            </span>
            <span class="text-xs font-semibold" :class="accent.etaText">分钟后到站</span>
            <span class="ml-auto font-mono text-xs text-slate-400">
              {{ nextOf(primaryArrivals)?.time }}<template v-if="nextOf(primaryArrivals)?.stopsAway !== undefined"> <span aria-hidden="true">·</span> 距 {{ nextOf(primaryArrivals)?.stopsAway }} 站</template><template v-if="nextOf(primaryArrivals)?.distanceMeters"> <span aria-hidden="true">·</span> {{ ((nextOf(primaryArrivals)!.distanceMeters!) / 1000).toFixed(1) }}km</template><template v-if="primaryMark"> <span aria-hidden="true">·</span> {{ primaryMark }}</template>
            </span>
          </div>
          <!-- F-E: the row exists but states no minute — upstream carried the
               vehicle and published no arrival time for it, and this app no
               longer estimates one. The absence is stated HERE and not left to
               the fallback below, which claims something different: that no
               vehicle is in range at all. -->
          <div v-else-if="nextOf(primaryArrivals)" class="text-xs text-slate-400 lg:text-base">
            {{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}<template v-if="nextOf(primaryArrivals)?.stopsAway !== undefined"> <span aria-hidden="true">·</span> 距 {{ nextOf(primaryArrivals)?.stopsAway }} 站</template>
          </div>
          <div v-else class="text-xs text-slate-400 lg:text-base">
            {{ primaryOperatingText }}
          </div>

          <!-- The opposite direction at the same platform. Tapping it promotes that
               direction to the headline; the label names where it goes, so the two
               rows are never ambiguous. -->
          <button
            v-if="secondaryRow"
            type="button"
            class="flex w-full items-center justify-between gap-2 border-t border-slate-800/60 pt-2 text-left text-xs transition lg:gap-2.5 lg:pt-2.5 lg:text-base"
            :class="canSwitch ? 'cursor-pointer hover:opacity-80 active:scale-[0.99]' : 'cursor-default'"
            :disabled="!canSwitch"
            :aria-label="canSwitch
              ? `切换到${secondaryRow.directionName}方向`
              : undefined"
            @click.stop="canSwitch && $emit('switch-direction', secondaryRow.direction)"
          >
            <span class="flex min-w-0 items-center gap-1 text-slate-400">
              <ArrowLeftRight v-if="canSwitch" class="h-3 w-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ secondaryRow.directionName }}</span>
            </span>
            <span class="flex shrink-0 items-baseline gap-1.5">
              <template v-if="secondaryHasArrivals">
                <template v-if="minutesOf(secondaryRow.arrivals) !== null">
                  <span class="font-mono font-bold" :class="accent.etaText">
                    {{ minutesOf(secondaryRow.arrivals) }}分
                  </span>
                  <span class="font-mono text-slate-400">{{ nextOf(secondaryRow.arrivals)?.time }}</span>
                  <!-- The trailing row is a second feed: it states its own kind (F4). -->
                  <span v-if="secondaryMark" class="text-xs text-slate-400"><span aria-hidden="true">·</span> {{ secondaryMark }}</span>
                </template>
                <!-- A row that states no minute: the absence, not the operating
                     fact — that other direction does have a vehicle coming. -->
                <span v-else class="text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
              </template>
              <span v-else class="text-slate-400">{{ secondaryOperatingText }}</span>
            </span>
          </button>

          <!-- Follow-up buses on the leading row. Each states its own kind when the
               feed mixes kinds (F4); when one word is true of the whole list it
               already rides on the leading minute above. `flex-wrap` so a mark
               never squeezes the minutes on a 375px phone. -->
          <div v-if="primarySubsequent.length > 0" class="flex flex-wrap items-center gap-2 border-t border-slate-800/60 pt-2 text-xs">
            <span class="shrink-0 text-slate-400">后续</span>
            <span
              v-for="(a, i) in primarySubsequent"
              :key="a.busId || i"
              class="flex items-baseline gap-1"
            >
              <!-- A subsequent row states its own minute or none — same rule as
                   the leading one, and its own mark is `null` when it has no
                   number for a mark to qualify. -->
              <template v-if="statedArrivalMinutes(a) !== null">
                <span class="font-mono font-bold text-slate-300">{{ statedArrivalMinutes(a) }}分</span>
                <span class="font-mono text-slate-400">{{ a.time }}</span>
              </template>
              <span v-else class="text-slate-400">{{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT }}</span>
              <span v-if="subsequentMarkOf(i)" class="text-slate-400">{{ subsequentMarkOf(i) }}</span>
            </span>
          </div>

          <!-- F1's reference line: the anchor's real walking time and the
               conclusion the server drew from it. Secondary by design — a step
               smaller and quieter than the minutes above — and additive by
               constraint: it can only ever add a line to this panel, never hide
               or compress one of the arrival minutes it is a reference to. -->
          <div
            v-if="referenceLine"
            class="flex flex-wrap items-baseline gap-x-1.5 border-t border-slate-800/60 pt-2 text-xs lg:text-base"
          >
            <template v-if="referenceLine.walk">
              <span class="text-slate-400">{{ referenceLine.walk }}</span>
              <span class="text-slate-400" aria-hidden="true">·</span>
            </template>
            <span class="text-slate-300">{{ referenceLine.conclusion }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
