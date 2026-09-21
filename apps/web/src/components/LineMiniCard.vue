<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight } from '@lucide/vue'

/** Which home-tab view this card renders for. */
type OverviewMode = 'morning' | 'evening' | 'nearby'

/** Arrival feed shape returned by the station-arrivals endpoint. */
interface ArrivalsFeed {
  isExact: boolean
  arrivals: Array<{
    time: string
    etaSeconds: number
    stopsAway?: number
    distanceMeters?: number
    isAtStation?: boolean
  }>
}

/**
 * One direction row. Each row carries its OWN stop order for the displayed
 * stop, because the two directions number the same named stop differently.
 */
interface CardRow {
  lineId: string
  direction: 0 | 1
  stopOrder: number | null
  /** Destination-board label for this direction (「开往 X」). */
  directionName: string
  arrivals: ArrivalsFeed | null
}

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
  rows: CardRow[]
  mode: OverviewMode
  detailLoaded: boolean
  /** Subway routes are tinted amber, buses cyan — same rule as the kiosk board. */
  isSubway: boolean
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
}>()

/**
 * Accent palette, kept in one place so every tinted element on the card follows the
 * route type. Mirrors KioskView: subway = amber, bus = cyan.
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

/** Nearby mode before a fix anchors the platform: an honest locate-first state. */
const awaitingLocation = computed(() => props.mode === 'nearby' && props.rows.length === 0)

/** Commute mode with no board stop set: point the user at the settings screen. */
const awaitingBoardStop = computed(() =>
  props.mode !== 'nearby' && props.detailLoaded && props.rows.length === 0)

function nextOf(feed: ArrivalsFeed | null) {
  return feed?.arrivals?.[0] ?? null
}

/** Minutes until that row's next bus; 0 means it is pulling in now. */
function minutesOf(feed: ArrivalsFeed | null): number | null {
  const a = nextOf(feed)
  if (!a) return null
  return a.isAtStation ? 0 : Math.max(1, Math.round(a.etaSeconds / 60))
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
 * headline then reads "本站暂无来车", which is the honest answer for the
 * direction the user is actually waiting for.
 */
const primaryRow = computed<CardRow | null>(() => {
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
 * The other direction, shown compactly. Kept even when it has no arrivals, so
 * the user can still see (and switch to) the opposite kerb.
 */
const secondaryRow = computed<CardRow | null>(() =>
  props.rows.find(r => r !== primaryRow.value) ?? null)

/** Only a two-row card can be switched; a single-row card has nothing to trade. */
const canSwitch = computed(() => props.rows.length > 1 && secondaryRow.value !== null)

/** The opposite direction is worth tapping only when it actually has a bus. */
const secondaryHasArrivals = computed(() => nextOf(secondaryRow.value?.arrivals ?? null) !== null)

/** Every future bus across all rows — the honest "how many are coming" count. */
const aheadCount = computed(() =>
  props.rows.reduce((sum, r) => sum + (r.arrivals?.arrivals?.length ?? 0), 0))

const modeLabel = computed(() => (props.mode === 'morning'
  ? '🏠 上班'
  : props.mode === 'evening' ? '🏢 下班' : '📍 附近'))
</script>

<template>
  <div
    class="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg backdrop-blur-md transition hover:bg-slate-900"
    :class="accent.hoverBorder"
    @click="$emit('click')"
  >
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
    </div>

    <!-- Loading state: detail not yet resolved from the API -->
    <div v-if="!detailLoaded" class="my-3.5 flex items-center justify-center rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-400 lg:px-3.5 lg:py-2 lg:text-base">
      <span class="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600" :class="accent.spinner"></span>
      正在加载线路数据...
    </div>

    <template v-else>
      <!-- Honest empty states, one per cause -->
      <div v-if="awaitingLocation" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
        开启定位后显示离你最近的站点车辆
      </div>
      <div v-else-if="awaitingBoardStop" class="my-3.5 rounded-lg bg-slate-950/80 px-3 py-2.5 text-xs text-slate-400 text-center lg:px-3.5 lg:py-3 lg:text-base">
        未设置{{ mode === 'morning' ? '上班' : '下班' }}上车点 · 在「管理关注」中设置
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

        <!-- Primary ETA: real upstream travel time, never fabricated -->
        <div v-if="nextOf(primaryArrivals)?.isAtStation" class="flex items-baseline gap-2">
          <span class="font-mono text-xl font-black tracking-tight" :class="accent.etaText">正在进站</span>
        </div>
        <div v-else-if="minutesOf(primaryArrivals) !== null" class="flex items-baseline gap-2">
          <span class="font-mono text-2xl font-black tracking-tight" :class="accent.etaText">
            {{ minutesOf(primaryArrivals) }}
          </span>
          <span class="text-xs font-semibold" :class="accent.etaText">分钟后到站</span>
          <span class="ml-auto font-mono text-xs text-slate-400">
            {{ nextOf(primaryArrivals)?.time }}<template v-if="nextOf(primaryArrivals)?.stopsAway !== undefined"> · 距 {{ nextOf(primaryArrivals)?.stopsAway }} 站</template><template v-if="nextOf(primaryArrivals)?.distanceMeters"> · {{ ((nextOf(primaryArrivals)!.distanceMeters!) / 1000).toFixed(1) }}km</template>
          </span>
        </div>
        <div v-else class="text-xs text-slate-400 lg:text-base">
          本站暂无来车
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
              <span class="font-mono font-bold" :class="accent.etaText">
                {{ minutesOf(secondaryRow.arrivals) }}分
              </span>
              <span class="font-mono text-slate-400">{{ nextOf(secondaryRow.arrivals)?.time }}</span>
            </template>
            <span v-else class="text-slate-400">暂无来车</span>
          </span>
        </button>

        <!-- Follow-up buses on the leading row -->
        <div v-if="primarySubsequent.length > 0" class="flex items-center gap-2 border-t border-slate-800/60 pt-2 text-xs">
          <span class="shrink-0 text-slate-400">后续</span>
          <span
            v-for="a in primarySubsequent"
            :key="`${a.time}_${a.etaSeconds}`"
            class="flex items-baseline gap-1"
          >
            <span class="font-mono font-bold text-slate-300">{{ Math.max(1, Math.round(a.etaSeconds / 60)) }}分</span>
            <span class="font-mono text-slate-400">{{ a.time }}</span>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
