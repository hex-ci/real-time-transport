<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useIntervalFn } from '@vueuse/core'
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { RefreshCw, TriangleAlert } from '@lucide/vue'
import { DEFAULT_USER_ID, REFRESH_MAX_LINES } from '@real-time-transport/shared'
import type {
  CommuteChainDeductions,
  CommuteChainPurpose,
  RefreshLiveTarget,
  UserSettings,
} from '@real-time-transport/shared'
import { refreshFreshnessOf, refreshStatusTextOf, useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'
import { ChainEmptyState, ChainLoadState, TransferCard } from './components'
import { chainCardOf } from './card'
import { anchorForPurpose, emptyStateOf } from './empty-state'
import type { PurposeOption } from './types'

/**
 * F10's chain page: the chains the user recorded, each walked by the engine against
 * live readings, answering one question per transfer — 「能不能赶上换乘点那班车」.
 *
 * It is a first-level entry of its own rather than a block on the home screen: the
 * home screen is a list of followed lines, and mixing transfer conclusions into it
 * would make one surface out of two. Nothing here concludes anything either — the
 * band, the margin and every 「不给结论」 code are the engine's, and this page only
 * chooses words (`margin.ts`, `refusal.ts`) and states what each answer is worth
 * (`provenance.ts`).
 *
 * The chain ENDS at its last leg's alight station. There is no destination, no walk
 * past the end and no total arrival minute: a chain records where it starts from and
 * never where it goes, so a total would be a number nobody measured. This page
 * computes none and adds none up.
 *
 * One purpose at a time. The endpoint answers a purpose's chains from ONE set of
 * readings, so N requests could be served from N poll windows and the page would be
 * comparing margins computed from readings of different ages — the jumpiness the
 * product rules out. The purpose on screen is therefore always the purpose the
 * answer belongs to (`hasFeed`), and it is switched in front of the user.
 */

const transitStore = useTransitStore()
const cityStore = useCityStore()

const { commuteProfile } = storeToRefs(transitStore)
const {
  refreshInFlight,
  refreshOutcome,
  refreshWaitSecondsLeft,
  refreshReading,
} = storeToRefs(transitStore)

/** The two purposes a chain is recorded under, in the words the home screen uses. */
const PURPOSES: PurposeOption[] = [
  { purpose: 'morning', label: '上班' },
  { purpose: 'evening', label: '下班' },
]

/** Which purpose is on screen. */
const purpose = shallowRef<CommuteChainPurpose>('morning')
/** A pick the user made on this visit; null while the page follows the commute window. */
const manualPurpose = shallowRef<CommuteChainPurpose | null>(null)

/**
 * The purpose the configured commute window implies: 上班 while the profile reports
 * the work leg, 下班 while it reports the way home, and 上班 outside both windows —
 * there is no window to follow then, and the chip shows which purpose is on screen
 * rather than the page hiding a choice behind a default.
 *
 * With NO stored window the same default applies and the LABEL says why: this chip
 * used to read 「默认按通勤时段选定」 for a user who had never saved any hours, which
 * credits a window that does not exist.
 */
const autoPurpose = computed<CommuteChainPurpose>(() =>
  (commuteProfile.value?.mode === 'home' ? 'evening' : 'morning'))

const autoPurposeLabel = computed(() => {
  const follow = autoPurpose.value === 'evening' ? '下班' : '上班'
  const windowState = commuteProfile.value?.windowState
  // Four facts, four sentences, and the last two are not decoration: a profile nobody
  // has read may not credit the commute window either — 「默认按通勤时段选定」 is a
  // claim about a stored row, and only an ANSWER can support it. The payload carries
  // which of them it is (`windowState`), so this chip never infers it from the
  // mode: 'auto' is shared by 「outside the configured window」 and 「no window
  // configured」, and a page that could not tell them apart printed the first for the
  // second. `unchosen` is the third of those answers — the row exists but its four
  // times were never chosen — and it owes the same sentence as `unset`: there is no
  // window for the page to have followed.
  if (windowState === 'stored') return `默认按通勤时段选定：${follow}`
  if (windowState === 'unset' || windowState === 'unchosen') return `通勤时段未设置，默认：${follow}`
  return `默认：${follow}`
})

function onPickPurpose(value: unknown): void {
  const picked: CommuteChainPurpose = value === 'evening' ? 'evening' : 'morning'
  manualPurpose.value = picked
  purpose.value = picked
}

/** The chains as the endpoint answered them, and the purpose they answer for. */
const chains = shallowRef<CommuteChainDeductions['chains']>([])
const feedPurpose = shallowRef<CommuteChainPurpose | null>(null)
const loading = shallowRef(true)
/** The read that failed with nothing on screen for this purpose. */
const loadError = shallowRef<string | null>(null)
/** A re-read that failed while an older answer is still on screen. */
const reloadError = shallowRef<string | null>(null)
/** The anchor's own state, as 设置's row holds it; null while it has not been read. */
const anchorSaved = shallowRef<boolean | null>(null)

/** True only once the answers on screen belong to the purpose on screen. */
const hasFeed = computed(() => feedPurpose.value === purpose.value)
const cards = computed(() => (hasFeed.value ? chains.value.map(chainCardOf) : []))
const emptyState = computed(() => emptyStateOf({ purpose: purpose.value, anchorSaved: anchorSaved.value }))

/**
 * Read the purpose's chains, each already walked against live readings.
 *
 * A read that fails is reported differently depending on what the page is holding:
 * with nothing for this purpose it is the page's own load failure (stated, with the
 * retry that is the only thing that can fix it); with an older answer still on
 * screen it keeps that answer and says the read failed — blanking it would take
 * away the reading the user is looking at, and what is on screen is still dated by
 * each card's own 最后更新, so its age is visible rather than implied.
 *
 * LATEST READ WINS. More than one read can be open at once — the interval's
 * re-read and a purpose switch, or the interval's re-read and a press's re-read —
 * and HTTP answers do not come back in the order they were asked. An older answer
 * landing last would replace an answer the page has already shown, which is the
 * jump F10 rules out (「不允许…跳变」): margins computed from readings of two
 * different ages would then be on screen as one set. So each read takes a sequence
 * number and only the newest one may write. That also covers the answer for a
 * purpose the user has left while it was in flight: it is not this page's answer,
 * and rendering it under the new chip would state one purpose's margins as
 * another's.
 */
let readSequence = 0

async function loadChains(): Promise<void> {
  const requested = purpose.value
  const hadFeed = feedPurpose.value === requested
  const sequence = ++readSequence
  loading.value = true

  let feed: CommuteChainDeductions | null = null
  try {
    const qs = new URLSearchParams({ purpose: requested, userId: DEFAULT_USER_ID })
    const res = await fetch(`/api/transit/commute-chains/deductions?${qs.toString()}`)
    const json = await res.json()
    if (json.success && Array.isArray(json.data?.chains)) feed = json.data as CommuteChainDeductions
  }
  catch {
    // Reported below, in the state the page can honestly show for it.
  }

  // A read that has been superseded — by a newer read of the same purpose, or by
  // the purpose having changed under it — states nothing at all.
  if (sequence !== readSequence) return
  loading.value = false

  if (feed) {
    chains.value = feed.chains
    feedPurpose.value = requested
    loadError.value = null
    reloadError.value = null
    return
  }
  if (hadFeed) {
    reloadError.value = '换乘链更新失败 · 下面显示的是上一次读取的结果'
    return
  }
  chains.value = []
  feedPurpose.value = null
  loadError.value = '换乘链数据读取失败'
}

/**
 * Whether the anchor this purpose's chains start from has a saved coordinate.
 *
 * Read for exactly one reason: the page's empty state has to name a cause the user
 * can act on, and an anchor that was never saved is the only cause on this page with
 * a screen behind it (设置). A read that fails leaves the state UNKNOWN, and an
 * unknown is neither saved nor missing — the page then claims nothing about a row
 * nobody read rather than sending the user to repair something that may be in place.
 *
 * A settings row that was never saved is NOT an unknown: an anchor is a column of
 * that row, so 「no row」 means 「no anchor stored」 as a fact, and the state below is
 * `false` — the actionable one. The endpoint states which fact it is
 * (`settingsState`), so this page does not have to guess it from a null.
 */
async function loadAnchorState(): Promise<void> {
  anchorSaved.value = null
  try {
    const res = await fetch('/api/transit/settings')
    const json = await res.json()
    if (json.settingsState === 'unset') {
      anchorSaved.value = false
      return
    }
    const settings: UserSettings | undefined = json.success ? json.data : undefined
    if (!settings) return

    const anchor = anchorForPurpose(purpose.value)
    const lng = anchor === 'home' ? settings.homeLng : settings.workLng
    const lat = anchor === 'home' ? settings.homeLat : settings.workLat
    anchorSaved.value = typeof lng === 'number' && typeof lat === 'number'
  }
  catch {
    // Unknown, and stated as unknown.
  }
}

/**
 * The lines this page's answers are read from — F11's entry names them.
 *
 * The ANSWERS name them and nothing else does: a deduced chain names every leg it
 * walked, and a refused chain names exactly the leg it refused on (a refusal
 * carries no earlier leg's answer, so nothing else on screen is reading anything).
 * A line this page shows nothing about is not named, because the endpoint reads
 * what it is asked for and a number nobody sees is an upstream read spent for
 * nothing.
 *
 * A SUBWAY id carries both directions while an answer does not say which way its
 * leg runs, so both of that line's directions are named: naming one would leave the
 * leg's own direction un-refreshed while the control still reported 已刷新.
 *
 * The city is the one being browsed, which is the only value this page has: the
 * answer deliberately does not echo the legs it was walked from, so a chain recorded
 * in another city is a mismatch this side cannot see (the server reads each leg in
 * the city the leg was stored with; only this request's city would be the page's).
 */
const refreshTargets = computed<RefreshLiveTarget[]>(() => {
  const seen = new Set<string>()
  const targets: RefreshLiveTarget[] = []

  for (const chain of cards.value) {
    const lineIds = chain.deduction.status === 'deduced'
      ? chain.deduction.legs.map(leg => leg.lineId)
      : chain.deduction.leg ? [chain.deduction.leg.lineId] : []

    for (const lineId of lineIds) {
      const directions: Array<0 | 1> = lineId.startsWith('subway_') ? [0, 1] : [0]
      for (const direction of directions) {
        const key = `${lineId}_${direction}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ lineId, direction, cityCode: cityStore.currentCode })
      }
    }
  }
  return targets
})

/** The lines one press may actually name: the endpoint bounds how many a single attempt covers. */
const refreshNamed = computed(() => refreshTargets.value.slice(0, REFRESH_MAX_LINES))

/**
 * The state line under the button — the store's own words, plus this page's one
 * rule about them.
 *
 * The targets are drawn from the chains this page read, so whether that read has
 * ANSWERED is this page's fact to hand over (`targetsRead`): while the chains are
 * still arriving this page has not learned what it is showing, and the store's
 * 「暂无正在读取车况的线路」 is a claim about a list nobody obtained yet. Every
 * other state the store reports — a refusal with its remaining seconds, an
 * upstream that answered nothing, a connection that is gone — is rendered as it
 * comes, so a press is never answered with silence.
 */
const refreshStatus = computed(() => refreshStatusTextOf({
  inFlight: refreshInFlight.value,
  outcome: refreshOutcome.value,
  waitSeconds: refreshWaitSecondsLeft.value,
  wanted: refreshTargets.value.length,
  covered: refreshNamed.value.length,
  targetsRead: !loading.value,
}))

/** The reading the last press obtained, as the freshness line reports it. */
const refreshFreshness = computed(() => refreshFreshnessOf(refreshReading.value))

/**
 * Tone of the state line. The words carry the state; the tone only backs them up,
 * so nothing here is the only signal of anything.
 */
const refreshStatusClass = computed(() => {
  if (refreshOutcome.value === 'throttled') return 'text-amber-400'
  if (refreshOutcome.value === 'unavailable' || refreshOutcome.value === 'offline') {
    return 'text-rose-400'
  }
  if (refreshOutcome.value === 'ok') return 'text-emerald-400'
  return 'text-slate-400'
})

/** Ids the button points at, so the state is read out together with the control. */
const refreshDescribedBy = computed(() => refreshStatus.value
  ? 'refresh-freshness refresh-status'
  : 'refresh-freshness')

/**
 * True for the whole of a press: the request that spends the window, and the
 * re-read that shows what it obtained. A press landing between the two would ask
 * the server a second time inside the window the first one just spent.
 */
const refreshing = shallowRef(false)

/**
 * Pressed: ask through the ONE request that owns the cooldown, then re-read the
 * answers so they show what that request obtained.
 *
 * Only a press that obtained a reading re-reads them: a refusal or a failure
 * carried nothing, and re-reading then would only ask for the numbers already on
 * screen.
 */
async function onRefresh(): Promise<void> {
  refreshing.value = true
  try {
    const outcome = await transitStore.refreshLive(refreshNamed.value)
    if (outcome === 'ok') await loadChains()
  }
  finally {
    refreshing.value = false
  }
}

/**
 * Keep the answers moving without being a second refresh entry.
 *
 * This asks for what the server already holds and spends no upstream read of its
 * own while the server's reading cache is warm, which is why the cadence is longer
 * than that cache rather than shorter. The manual entry above is what spends a real
 * re-read, through the one window both screens share.
 */
useIntervalFn(() => {
  void loadChains()
}, 20_000)

// The purpose drives both reads: the chains of that purpose, and that purpose's own anchor.
watch(purpose, () => {
  loadError.value = null
  reloadError.value = null
  void loadChains()
  void loadAnchorState()
}, { immediate: true })

onMounted(() => {
  // Which window the user is in decides the purpose this page opens on.
  transitStore.fetchCommuteProfile()
})
</script>

<template>
  <div class="space-y-2.5 pb-12 sm:space-y-5">
    <!-- What this page answers, and where it stops: the chain ends at its last leg's
         alight station, so there is no destination and no total arrival minute, and
         saying so is the difference between a page that is missing a number and one
         that does not have it. -->
    <div class="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-900 via-slate-900/90 to-cyan-950/30 p-3.5 shadow-2xl backdrop-blur-xl sm:rounded-3xl sm:p-5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-xs font-semibold text-cyan-400">
          <span class="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
          换乘链路
        </span>
        <span class="text-xs text-slate-400">{{ cityStore.currentCityName }}</span>
      </div>
      <h2 class="mt-1.5 text-lg font-bold tracking-tight text-white sm:text-xl">
        能不能赶上换乘点那班车
      </h2>
      <p class="mt-1 text-xs text-slate-400 lg:text-base">
        逐段给出站台等待与余量，到末段下车站为止
      </p>

      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        <RadioGroupRoot
          aria-label="通勤目的"
          :model-value="purpose"
          class="flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 p-1"
          @update:model-value="onPickPurpose"
        >
          <RadioGroupItem
            v-for="option in PURPOSES"
            :key="option.purpose"
            :value="option.purpose"
            class="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-slate-300 transition data-[state=checked]:bg-cyan-500/20 data-[state=checked]:text-cyan-300"
          >
            {{ option.label }}
          </RadioGroupItem>
        </RadioGroupRoot>
        <span id="purpose-default" class="text-xs text-slate-400">{{ autoPurposeLabel }}</span>
      </div>
    </div>

    <!-- F11's entry on this page. Both screens ask through the same request, so the
         window a press spends is shared rather than one per screen; the state line
         is this control's other job, and a refusal is never silent. -->
    <section
      aria-label="数据刷新"
      class="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:rounded-3xl sm:p-4"
    >
      <div class="min-w-0">
        <p id="refresh-freshness" class="text-xs text-slate-400 lg:text-base">
          {{ refreshFreshness.text }}
        </p>
        <!-- The state line. Only the coarse state sits inside the live region: the
             seconds are rendered beside it, because a countdown in a live region
             queues one announcement per second of the wait. The region is rendered
             before it has anything to say — one created together with its first
             word is not announced at all by some screen readers. -->
        <p
          id="refresh-status"
          class="text-xs lg:text-base"
          :class="[refreshStatusClass, refreshStatus ? 'mt-0.5' : '']"
        >
          <span role="status" aria-live="polite">{{ refreshStatus?.announcement }}</span><span>{{ refreshStatus?.detail }}</span>
        </p>
      </div>
      <button
        class="flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-xs font-semibold text-cyan-400 transition active:scale-95 disabled:opacity-60 sm:w-auto sm:px-4 lg:min-h-11 lg:text-base"
        :disabled="refreshing || refreshNamed.length === 0"
        :aria-describedby="refreshDescribedBy"
        @click="onRefresh"
      >
        <RefreshCw
          class="h-3.5 w-3.5 shrink-0"
          :class="refreshing ? 'animate-spin' : ''"
          aria-hidden="true"
        />
        <span>刷新最新车况</span>
      </button>
    </section>

    <!-- A re-read that failed while an older answer is still on screen: the answer
         stays, and the failure is stated rather than the page going blank. -->
    <p
      v-if="reloadError"
      role="alert"
      class="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400 lg:gap-2 lg:text-base"
    >
      <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{{ reloadError }}</span>
    </p>

    <!-- The three states of having nothing to show: still reading, the read failed,
         or this purpose genuinely has no chain recorded. -->
    <ChainLoadState
      v-if="!hasFeed && loading"
      :loading="true"
      :load-error="null"
      @retry="loadChains"
    />
    <ChainLoadState
      v-else-if="!hasFeed && loadError"
      :loading="false"
      :load-error="loadError"
      @retry="loadChains"
    />
    <ChainEmptyState v-else-if="cards.length === 0" :view="emptyState" />

    <div v-else class="space-y-2.5 sm:space-y-5">
      <TransferCard v-for="card in cards" :key="card.chainId" :card="card" />
    </div>
  </div>
</template>
