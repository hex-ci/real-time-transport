import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { DEFAULT_USER_ID, vehicleProvenanceOf } from '@real-time-transport/shared'
import { provenanceLabelOf } from '@/provenance-copy'
import { lineLoadStateOf, type LineLoadState } from '@/line-load-state'
import type {
  CommuteChain,
  CommuteChainAnchor,
  CommuteChainPurpose,
  DataSourceType,
  LineDetail,
  LineGroup,
  LiveLineStatus,
  CommuteProfile,
  RefreshLiveResult,
  RefreshLiveTarget,
  UserFavoriteLine,
  WsServerMessage,
} from '@real-time-transport/shared'

/**
 * F11's manual refresh, as the two screens that each own an entry see it.
 *
 * Both entries call the one action below, and it spends its upstream read through
 * the server's own endpoint. The window itself is the SERVER's: this side never
 * decides whether a press is allowed, because a cooldown computed here would be a
 * second clock — and one that cannot refuse anything.
 */

/**
 * How one manual refresh attempt ended.
 *
 * - `ok`          a reading was obtained
 * - `throttled`   the window refused it: nothing was read for it
 * - `unavailable` the reads were made and the source answered nothing
 * - `offline`     the request never reached the server
 */
export type RefreshOutcome = 'ok' | 'throttled' | 'unavailable' | 'offline'

/**
 * One chain as a write carries it — the shape `CommuteChainSchema` /
 * `UpdateCommuteChainSchema` accept, minus what the server owns.
 *
 * `seq` is absent on purpose: a leg's position is the array's order, and the server
 * writes the number from it. The station fields are nullable because 「未选」 is a real
 * state of a draft (`null`, never an empty name), and `transferExtraMinutes` is
 * nullable because 「未设置」 and 「确实没有额外时间」 are different facts.
 */
export interface CommuteChainLegWrite {
  lineId: string
  lineName: string
  cityCode: string
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  transferExtraMinutes: number | null
}

/** A chain's substance as a write carries it, without the position the server can compute. */
export interface CommuteChainWrite {
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  legs: CommuteChainLegWrite[]
}

/**
 * The reading a manual refresh last obtained, with the KIND of value it is.
 *
 * The instant alone cannot say what kind of number it belongs to: a generated
 * reading is stamped with the instant it was produced exactly like an observed
 * one, so a screen holding only the instant would report a model output as a
 * plainly obtained reading.
 */
export interface RefreshReading {
  at: number
  dataSource: DataSourceType | null
  isDegraded: boolean | null
}

/** What the control states about the freshness of the reading it reports. */
export interface RefreshFreshness {
  /** The reading's own clock time, or null when none was obtained. */
  time: string | null
  /** F4's mark for the reading's kind — null when the reading states no source. */
  mark: string | null
  /** True when a fallback source produced the reading. */
  degraded: boolean
  /** The line the user reads. */
  text: string
}

/**
 * Seconds left on the server's window, from the deadline the server stated.
 *
 * The deadline is the only truth about when a refresh may happen again, and every
 * outcome carries it, so the wait is derived from it in all of them — a duration
 * invented on this side would be a second opinion about the server's own window.
 */
export function refreshWaitSeconds(nextAllowedAt: number | null, now: number): number {
  if (nextAllowedAt === null) return 0
  return Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
}

/**
 * The instant the stated window opens, as the later of the two clocks stating it.
 *
 * `nextAllowedAt` is the server's own instant, and comparing it against this
 * device's clock is the one comparison a skew can ruin: a press landing in the
 * window's last round trip computes 0 seconds left for a window that is genuinely
 * shut, and a device whose clock runs ahead computes 0 for the whole of it. The
 * wait is then stated as nothing at all, on a control whose whole job is to state
 * it.
 *
 * `retryAfterSeconds` is that same deadline expressed as a duration measured at
 * the source, so the difference between the two clocks does not enter it; aged
 * from the instant the answer arrived, it floors the wait. Both describe one
 * window, so the later of them is that window — and a refusal therefore always
 * has a wait to state. The duration rides with the deadline in one answer, so a
 * result carrying neither leaves both absent together.
 */
export function refreshWaitUntilOf(params: {
  nextAllowedAt: number | null
  retryAfterSeconds: number | null
  answeredAt: number | null
}): number | null {
  if (params.nextAllowedAt === null) return null
  if (params.retryAfterSeconds === null || params.answeredAt === null) {
    return params.nextAllowedAt
  }
  return Math.max(params.nextAllowedAt, params.answeredAt + params.retryAfterSeconds * 1000)
}

/**
 * The reading a refresh answer describes.
 *
 * The instant is the answer's own `lastUpdatedAt`, never the clock: the clock
 * would be true of every answer, including the ones that obtained nothing. The
 * kind comes from whichever line reports that instant, and a refusal reports no
 * line at all — so the kind recorded with the same instant earlier still stands,
 * because an instant identifies a reading and this one has not changed.
 *
 * Several lines sharing the newest instant with different kinds are not one
 * reading, so the instant is reported and no mark is: one word would be false
 * about part of it. An answer that obtained nothing clears the reading.
 */
export function refreshReadingOf(
  result: Pick<RefreshLiveResult, 'lastUpdatedAt' | 'lines'>,
  previous: RefreshReading | null,
): RefreshReading | null {
  const at = result.lastUpdatedAt
  if (at === null) return null

  const matching = result.lines.filter(line => line.lastUpdatedAt === at)
  if (matching.length === 0) {
    return previous && previous.at === at ? previous : { at, dataSource: null, isDegraded: null }
  }
  const leading = matching[0]!
  const agree = matching.every(line =>
    line.dataSource === leading.dataSource && line.isDegraded === leading.isDegraded)
  return agree
    ? { at, dataSource: leading.dataSource, isDegraded: leading.isDegraded }
    : { at, dataSource: null, isDegraded: null }
}

/** 「HH:MM:SS」 in the reader's own zone — an instant, never a duration. */
function clockTimeOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Whether a tick still has a window to count.
 *
 * Only a window the server has shut is worth counting, so a tick arriving with no
 * deadline — or with the deadline already reached — has nothing to do, which is
 * also the caller's signal to stop ticking. That is what keeps this from becoming
 * an always-on clock: outside a window a press just spent, it has no work.
 */
export function refreshCountdownOpen(nextAllowedAt: number | null, now: number): boolean {
  return nextAllowedAt !== null && now < nextAllowedAt
}

/**
 * The freshness line: what the control reports about the reading it holds.
 *
 * A reading that was never obtained reports no time at all. The clock is not a
 * reading, and printing it would dress an empty answer as a fresh one.
 *
 * A reading that WAS obtained reports the instant it was obtained together with
 * the kind of value it is, so a generated reading (the timetable engine's trains)
 * never reads as an observed one, and a reading whose source is unstated carries
 * no mark rather than borrowing the flattering one.
 *
 * 仅供参考 is not a kind word but the caution a fallback source earns. It rides
 * beside the mark because the two answer different questions: F4's mark says what
 * kind of number this is, and this says whether to lean on it.
 */
export function refreshFreshnessOf(reading: RefreshReading | null): RefreshFreshness {
  if (!reading) {
    return { time: null, mark: null, degraded: false, text: '尚未获取到数据' }
  }
  const time = clockTimeOf(reading.at)
  const mark = provenanceLabelOf(vehicleProvenanceOf(reading.dataSource))
  const degraded = reading.isDegraded === true
  const text = `最后更新 ${time}`
    + (mark ? ` · ${mark}` : '')
    + (degraded ? ' · 仅供参考' : '')
  return { time, mark, degraded, text }
}

/**
 * The state line, in the two parts a screen renders it from.
 *
 * `announcement` is the state itself and never carries the seconds: a live region
 * whose text changes every second announces a thirteen-second refusal thirteen
 * times. `detail` is that countdown, already worded, so the seconds ride OUTSIDE
 * the live region while still reading as one line. Both come from here rather
 * than from a screen, so neither screen words a state of its own.
 */
export interface RefreshStatusText {
  /** The coarse state, whole and without the seconds. */
  announcement: string
  /** The rest of the line — the seconds left on the window, or empty. */
  detail: string
}

/**
 * The one line the control states about the last attempt.
 *
 * Three outcomes must be visible and no two of them may read alike: a refusal
 * with the wait left on the window, an upstream that answered nothing, and a
 * request that never reached the server. The last two ARE the app's 「connection
 * is down」 report — it belongs on this control, where the user is looking, and
 * not in a console.
 *
 * A refusal is never silent. The seconds it states are floored by the duration
 * the server sent (`refreshWaitUntilOf`), so a window the local clock cannot see
 * is still a window the user is told about; when an answer refuses the press and
 * states no window at all, the refusal says so rather than vanishing. It stops
 * being reported the moment its window opens, which the countdown ends by
 * dropping the refusal (`refreshTick`) — the deadline has passed, and leaving it
 * up would describe a window that is no longer shut.
 *
 * `wanted` against `covered` keeps a capped refresh honest. The endpoint bounds
 * how many lines one attempt may name, so a screen reading more than that is
 * refreshed for its leading rows only, and saying so is the difference between a
 * partial refresh and a false claim of a complete one.
 *
 * `targetsRead` is the list's own state, not the screen's. An empty `wanted` has
 * two causes — the list ANSWERED and named no line to re-read, or nobody read the
 * list at all — and they are different facts: the first is what the control holds
 * for the user, the second is a claim about rows nobody obtained. `read-state.ts`
 * records the same distinction for the followed-lines list, so the screen that
 * made the read says which of the two it is in; a `false` here states nothing.
 * The sentence itself names the LIST (「暂无正在读取车况的线路」) rather than the
 * screen: 上班/下班 mode renders a card per followed line whether or not any of
 * them has an arrival row to re-read, and 「屏幕上…空」 would then be false about a
 * screen the store cannot see.
 */
export function refreshStatusTextOf(params: {
  inFlight: boolean
  outcome: RefreshOutcome | null
  waitSeconds: number
  wanted: number
  covered: number
  /** Whether the list the targets are drawn from has actually been read. */
  targetsRead: boolean
}): RefreshStatusText | null {
  if (params.inFlight) return { announcement: '正在刷新…', detail: '' }
  // Nothing in the list to re-read: the control says so rather than sitting dead.
  if (params.outcome === null && params.wanted === 0) {
    return params.targetsRead
      ? { announcement: '暂无正在读取车况的线路', detail: '' }
      : null
  }
  switch (params.outcome) {
    case 'ok':
      return {
        announcement: params.covered < params.wanted
          ? `已刷新 · ${params.wanted} 条线路中刷新 ${params.covered} 条`
          : '已刷新',
        detail: '',
      }
    case 'throttled':
      return {
        announcement: '刷新太频繁',
        detail: params.waitSeconds > 0 ? ` · ${params.waitSeconds} 秒后可刷新` : ' · 请稍后再试',
      }
    case 'unavailable':
      return { announcement: '刷新失败 · 未能取到最新数据', detail: '' }
    case 'offline':
      return { announcement: '连接已断开 · 请检查网络', detail: '' }
    default:
      return null
  }
}

/**
 * Final tiebreak of both orderings: the creation instant, ascending.
 *
 * ISO-8601 strings compare lexicographically in chronological order, so no date
 * parsing is needed. The tiebreak is only as good as the field: an undated row
 * keys to '', which sorts before every real instant where PostgreSQL's `ASC`
 * puts NULLs last, and two undated rows tie back into the array's incoming
 * pin-first order. That gap is a deploy where the browser leads the API — the
 * column is NOT NULL and both server branches emit it.
 */
function compareCreatedAt(a: UserFavoriteLine, b: UserFavoriteLine): number {
  const left = a.createdAt ?? ''
  const right = b.createdAt ?? ''
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The home list's one ordering: the pin wins, then the stored position, then the
 * creation instant. Mirrors the server's `ORDER BY is_pinned DESC, display_order
 * ASC, created_at ASC` keyword for keyword, so an optimistic write places a card
 * exactly where the next fetch would.
 *
 * The pin is a state laid OVER this order, never a position inside it: nothing
 * here rewrites `displayOrder`, so un-pinning drops the row back into its own
 * slot instead of re-sorting it to the front.
 */
function orderFavorites(rows: UserFavoriteLine[]): UserFavoriteLine[] {
  return [...rows].sort((a, b) =>
    Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))
    || (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    || compareCreatedAt(a, b))
}

/**
 * The stored order: the position decides, then the creation instant. The pin is
 * not a keyword here at all.
 *
 * Deliberately separate from `orderFavorites` — the two answer different
 * questions. This one is the order the user edited and the settings screen
 * shows; that one is how the home list presents it. Deriving the settings list
 * from the store array instead would show the pin's overlay as if it were a
 * position.
 *
 * `(displayOrder ASC, createdAt ASC)` is exactly the pin-independent tail of the
 * server's `ORDER BY`. Both keywords are needed: positions are not unique (a
 * re-follow can reuse one), and without the instant a tie would inherit the
 * INPUT order — the pin-first array the server hands over — so a pin would
 * decide a position in a pure order editor.
 */
function orderByPosition(rows: UserFavoriteLine[]): UserFavoriteLine[] {
  return [...rows].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    || compareCreatedAt(a, b))
}

/**
 * Move one row and stamp a contiguous run of positions (0..n-1) over the WHOLE
 * list — the pinned row included, because a pin is a state laid over the order
 * and never an exemption from it.
 *
 * `from` and `to` index the list as it stood BEFORE the move, which is what a
 * drag reports: `to` is the slot of the row the moved row takes, and the rows
 * between shift along. Every row comes back as a new object with only its
 * position rewritten; the pin and the rest ride along untouched.
 *
 * An index outside the list returns a copy as it was, so a bad call can never
 * renumber rows that are already stored where they belong.
 */
export function reorder(
  favorites: UserFavoriteLine[],
  from: number,
  to: number,
): UserFavoriteLine[] {
  if (from < 0 || to < 0 || from >= favorites.length || to >= favorites.length) {
    return [...favorites]
  }
  const next = [...favorites]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next.map((row, index) => ({ ...row, displayOrder: index }))
}

export const useTransitStore = defineStore('transit', () => {
  const currentLineDetail = shallowRef<LineDetail | null>(null)
  const currentLiveStatus = shallowRef<LiveLineStatus | null>(null)
  const commuteProfile = shallowRef<CommuteProfile | null>(null)
  const favorites = shallowRef<UserFavoriteLine[]>([])
  const wsConnected = shallowRef(false)
  const isLoading = shallowRef(false)
  /** True while a station tap triggers a live-status refetch. */
  const isRefreshingLive = shallowRef(false)
  /**
   * Which of the two absences the last line read ended in, or null when the line loaded.
   *
   * A NAMED STATE, not the server's own error string: the page that shows this is the one
   * that words it (`line-load-state.ts`), because a raw payload string rendered as a
   * heading is how 「Line not found」 reached a zh-CN screen — and because 「no such line」
   * and 「the load failed」 are two facts, one of which does not deserve a retry.
   */
  const loadFailure = shallowRef<LineLoadState | null>(null)
  /**
   * Server-side simulation switch (`TRANSIT_SIMULATION`). When true the board
   * renders generated vehicles, so every view must label them as such.
   */
  const simulationEnabled = shallowRef(false)
  /**
   * F10's recorded commute chains, in the order the server stores them
   * (`display_order ASC, created_at ASC`). Read and written from 设置's chain
   * editor; the chain page reads its conclusions from its own endpoint, so this
   * list is the RECORDS rather than any answer drawn from them.
   */
  const commuteChains = shallowRef<CommuteChain[]>([])

  /** True while a manual refresh request is open. */
  const refreshInFlight = shallowRef(false)
  /** How the last manual refresh ended, or null before one has been made. */
  const refreshOutcome = shallowRef<RefreshOutcome | null>(null)
  /** The deadline the server stated for the next allowed refresh. */
  const refreshNextAllowedAt = shallowRef<number | null>(null)
  /** The wait the server stated with that deadline, in the seconds it stated. */
  const refreshRetryAfterSeconds = shallowRef<number | null>(null)
  /** The instant that answer arrived on this device, which ages the wait above. */
  const refreshAnsweredAt = shallowRef<number | null>(null)
  /** The reading the last manual refresh obtained, with the kind of value it is. */
  const refreshReading = shallowRef<RefreshReading | null>(null)
  /** The clock the countdown is rendered against. */
  const refreshNow = shallowRef(Date.now())

  /**
   * When the stated window opens — the later of the server's deadline and the
   * duration it sent, so a clock that disagrees with the server cannot turn a shut
   * window into no wait at all.
   */
  const refreshWaitUntil = computed(() => refreshWaitUntilOf({
    nextAllowedAt: refreshNextAllowedAt.value,
    retryAfterSeconds: refreshRetryAfterSeconds.value,
    answeredAt: refreshAnsweredAt.value,
  }))

  /** Seconds left on that window: the one number both screens count down. */
  const refreshWaitSecondsLeft = computed(() =>
    refreshWaitSeconds(refreshWaitUntil.value, refreshNow.value))

  /**
   * Moves the hand of the countdown, and nothing else.
   *
   * Not a data timer: it fetches nothing, it runs only while a window the user
   * just spent is counting down, and it stops itself the moment that window
   * opens — so it can never become the always-on tick the product excludes.
   */
  const refreshTick = useIntervalFn(() => {
    const now = Date.now()
    // The hand moves on every tick, so the wait never freezes on a stale second.
    refreshNow.value = now
    if (refreshCountdownOpen(refreshWaitUntil.value, now)) return
    // Nothing left to count: the window is open, so the ticker stops rather than
    // idling until the next press restarts it. A refusal is only ever reported
    // while a window is shut, so this is what ends it — a reading is not, because
    // 「已刷新」 describes data the screen still holds.
    refreshTick.pause()
    if (refreshOutcome.value === 'throttled') refreshOutcome.value = null
  }, 1000, { immediate: false })

  /**
   * Point the countdown at the answer this press just received, and count only
   * while the window it stated is still shut.
   *
   * The hand moves whether or not there is a window left to count. A refusal that
   * arrives after the deadline it carries has already passed — a press in the
   * window's last round trip — would otherwise be counted from whatever instant
   * the previous countdown stopped at, or from this store's first paint: a second
   * clock that the user's press did not set.
   */
  function resumeRefreshTick(): void {
    const now = Date.now()
    refreshNow.value = now
    if (refreshCountdownOpen(refreshWaitUntil.value, now)) refreshTick.resume()
  }

  /**
   * The manual refresh (F11). Both entries call this one action: the home screen
   * names every line its cards are reading, the line page names the one it shows.
   *
   * Resolves to how THIS call ended, or null when it made no request at all —
   * one was already open, or the screen named no line to re-read.
   *
   * The window is the server's, so a refused press is reported like any other
   * answer instead of being prevented here. No reading reaches this side without
   * the endpoint's own account of it: the instant and the kind both come from the
   * response, and nothing is stamped with the clock on arrival.
   */
  async function refreshLive(targets: RefreshLiveTarget[]): Promise<RefreshOutcome | null> {
    if (refreshInFlight.value) return null
    if (targets.length === 0) return null
    refreshInFlight.value = true
    try {
      const res = await fetch('/api/transit/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: DEFAULT_USER_ID, lines: targets }),
      })
      const json = await res.json() as { success: boolean, data?: RefreshLiveResult }
      const result = json.data ?? null
      if (result) {
        refreshNextAllowedAt.value = result.nextAllowedAt
        refreshRetryAfterSeconds.value = result.retryAfterSeconds
        refreshAnsweredAt.value = Date.now()
        refreshReading.value = refreshReadingOf(result, refreshReading.value)
        resumeRefreshTick()
      }
      refreshOutcome.value = json.success ? 'ok' : res.status === 429 ? 'throttled' : 'unavailable'
    }
    catch {
      // Nothing was read and nothing is known about the window: the control says
      // the connection is down rather than reporting a state it cannot see.
      refreshOutcome.value = 'offline'
    }
    finally {
      refreshInFlight.value = false
    }
    return refreshOutcome.value
  }

  /**
   * Every followed line in STORED order — one list shared by all cities, with
   * the pin deliberately not applied to it.
   *
   * This is the order the settings screen shows and edits. The store's
   * `favorites` array carries the home list's presentation instead (pin first),
   * so a screen that rendered that array would read a pin overlay as a
   * position and could disagree with what a drag is about to write.
   */
  const favoriteOrder = computed(() => orderByPosition(favorites.value))

  async function fetchRuntimeFlags(): Promise<void> {
    try {
      const res = await fetch('/api/transit/runtime-flags')
      const json = await res.json()
      if (json.success) {
        simulationEnabled.value = Boolean(json.data?.simulation)
      }
    }
    catch {
      // Leave the flag off: a failed probe must not claim live data is simulated.
    }
  }

  let socket: WebSocket | null = null
  /** Line+direction currently subscribed, so a switch can unsubscribe cleanly. */
  let activeSubLineId: string | null = null
  let activeSubDirection: number | null = null
  let reconnectTimer: any = null

  async function fetchCommuteProfile(): Promise<void> {
    try {
      const res = await fetch('/api/transit/commute-profile')
      const json = await res.json()
      if (json.success) {
        commuteProfile.value = json.data
      }
    }
    catch (err) {
      console.warn('Failed to load commute profile:', err)
    }
  }

  /**
   * Read the stored favourites into the store. Resolves true only when the
   * server actually handed back a list, so a caller that must not lose the list
   * it already holds can tell a real answer from a failed probe.
   */
  async function loadFavorites(): Promise<boolean> {
    try {
      const res = await fetch('/api/transit/favorites')
      const json = await res.json()
      if (json.success && Array.isArray(json.data)) {
        favorites.value = json.data
        return true
      }
    }
    catch {
      // Fall through: there is no list to trust.
    }
    return false
  }

  /**
   * Read the stored favourites, answering whether the server actually handed back a list.
   *
   * The array still ends up empty when the read fails — that is what an unreadable list
   * leaves behind — but the FAILURE is now returned as well as recorded: 设置's index row
   * states this domain's current count as a fact, and a count taken from an unreadable
   * list would be a number nobody obtained. `fetchCommuteChains` already answers this way,
   * so the two reads a settings index needs report themselves alike.
   *
   * Nothing else about the read changed: a caller that ignores the answer (`header-nav`,
   * on a city switch) sees exactly the list it saw before.
   */
  async function fetchFavorites(): Promise<boolean> {
    const answered = await loadFavorites()
    if (!answered) {
      favorites.value = []
    }
    return answered
  }

  /**
   * Search returns one entry per ROUTE with both directions attached — the user
   * follows a route, not a direction.
   */
  async function searchLines(keyword: string, cityCode: string = '027'): Promise<LineGroup[]> {
    try {
      const qs = new URLSearchParams({ keyword, cityCode })
      const res = await fetch(`/api/transit/lines/search?${qs.toString()}`)
      const json = await res.json()
      return json.success ? json.data : []
    }
    catch {
      return []
    }
  }

  /**
   * Clear the line-detail view's data. Called when LineDetailView unmounts, so
   * view-scoped state does not outlive the view (the root cause of briefly
   * seeing the previous line when opening a different one from home).
   *
   * isLoading is left true on purpose: the next time the view mounts, its first
   * paint reads detail=null + isLoading=true and shows the loading state, rather
   * than flashing the "line not found" error branch before loadLine() resolves.
   *
   * Switching up/down direction does NOT unmount the view (same route record, so
   * Vue Router reuses the instance), which is exactly why this stays out of that
   * transition and its smooth, stable behaviour is untouched.
   */
  function resetLineData(): void {
    currentLineDetail.value = null
    currentLiveStatus.value = null
    loadFailure.value = null
    isLoading.value = true
  }

  /**
   * Read back the live status of the line currently on screen.
   *
   * A READ, not a refresh entry: it asks for what the server already holds, and
   * spends no upstream call of its own when the cache is warm. It is what follows
   * a manual refresh (the endpoint re-reads upstream, this shows the result) and
   * what a station tap triggers — refetching the static detail too would rebuild
   * the board and disturb the map they are looking at.
   */
  async function reloadLiveStatus(): Promise<void> {
    const detail = currentLineDetail.value
    if (!detail) return
    isRefreshingLive.value = true
    try {
      const qs = new URLSearchParams({
        direction: String(detail.direction),
        cityCode: detail.cityCode,
      })
      const res = await fetch(`/api/transit/lines/${encodeURIComponent(detail.lineId)}/live?${qs.toString()}`)
      const json = await res.json()
      // Keep the existing data on a failed refresh rather than blanking the view.
      if (json.success && json.data) {
        currentLiveStatus.value = json.data
      }
    }
    catch {
      // Ignore: WS pushes will keep the view fresh anyway.
    }
    finally {
      isRefreshingLive.value = false
    }
  }

  async function loadLine(lineId: string, direction: number = 0, cityCode?: string): Promise<void> {
    isLoading.value = true
    loadFailure.value = null
    try {
      const qs = new URLSearchParams({ direction: String(direction) })
      if (cityCode) qs.set('cityCode', cityCode)
      const query = qs.toString()

      const readLive = async (url: string) => (await fetch(url)).json()
      // The detail read's HTTP STATUS is kept, not just its body: it is the only thing
      // that tells a line that does not exist (404, the route's own refusal) from a read
      // that failed and may succeed later. The body's `error` string used to be rendered
      // as the page's heading, which is how an English 「Line not found」 reached a zh-CN
      // screen — so the status is what travels, and the wording comes from
      // `@/line-load-state`.
      const readDetail = async () => {
        const res = await fetch(`/api/transit/lines/${encodeURIComponent(lineId)}?${query}`)
        return { status: res.status, body: await res.json() as { success?: boolean, data?: unknown } }
      }
      const [detailRes, liveRes] = await Promise.allSettled([
        readDetail(),
        readLive(`/api/transit/lines/${encodeURIComponent(lineId)}/live?${query}`),
      ])

      if (detailRes.status === 'fulfilled' && detailRes.value.body.success) {
        currentLineDetail.value = detailRes.value.body.data as typeof currentLineDetail.value
      }
      else {
        // No detail came back: either the line does not exist or the read failed. The
        // two are different facts and the page words them apart, so which one it is
        // travels as a state rather than as one sentence covering both.
        currentLineDetail.value = null
        currentLiveStatus.value = null
        loadFailure.value = detailRes.status === 'fulfilled'
          ? lineLoadStateOf(detailRes.value.status)
          : 'unavailable'
      }
      if (liveRes.status === 'fulfilled' && liveRes.value.success) {
        currentLiveStatus.value = liveRes.value.data
      }

      if (currentLineDetail.value) {
        subscribeWs(lineId, direction, cityCode)
      }
    }
    finally {
      isLoading.value = false
    }
  }

  function initWs(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`

    try {
      socket = new WebSocket(wsUrl)
      socket.onopen = () => {
        wsConnected.value = true
        if (activeSubLineId && currentLineDetail.value) {
          subscribeWs(activeSubLineId, currentLineDetail.value.direction, currentLineDetail.value.cityCode)
        }
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage
          if (msg.type !== 'line_update') return
          const detail = currentLineDetail.value
          if (!detail) return
          // Match lineId AND direction: a subway line serves both directions
          // under one lineId, so matching lineId alone could paint the opposite
          // direction's vehicles onto the current view.
          if (msg.lineId !== detail.lineId) return
          const msgDir = typeof msg.direction === 'number' ? msg.direction : detail.direction
          if (msgDir !== detail.direction) return
          currentLiveStatus.value = msg.status
        }
        catch {
          // Ignore malformed WS frame
        }
      }

      socket.onclose = () => {
        wsConnected.value = false
        socket = null
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => initWs(), 3000)
      }

      socket.onerror = () => {
        socket?.close()
      }
    }
    catch {
      // WS error
    }
  }

  function sendUnsubscribe(lineId: string, direction: number): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'unsubscribe', lineId, direction }))
    }
  }

  function subscribeWs(lineId: string, direction: number = 0, cityCode?: string): void {
    // Leaving a different line/direction: stop its server-side polling so we do
    // not keep pushing updates for a view the user already left.
    if (activeSubLineId !== null && activeSubDirection !== null) {
      const changedLine = activeSubLineId !== lineId
      const changedDir = activeSubDirection !== direction
      if (changedLine || changedDir) {
        sendUnsubscribe(activeSubLineId, activeSubDirection)
      }
    }

    activeSubLineId = lineId
    activeSubDirection = direction
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        action: 'subscribe',
        lineId,
        direction,
        cityCode: cityCode || '027',
      }))
    }
  }

  /**
   * Follow a route, and answer whether THIS call is what followed it.
   *
   * `false` means the route was already followed: the server answered
   * `alreadyFollowed` with the row that holds it (the two directions of one route
   * are one favourite, so a second follow is not a new card and must never be
   * reported as one). The row is still reconciled in place — that is how the
   * screen's own 「已关注」 label becomes correct — but nothing is appended and no
   * success is claimed.
   */
  async function addFavorite(item: {
    lineId: string
    lineName: string
    preferredDirection?: number
    reverseLineId?: string
    cityCode?: string
  }): Promise<boolean> {
    // The next slot is one past the highest position held — NOT past the row
    // count: positions stop being dense once a row is unfollowed, so the count
    // would reissue a position another row still holds and tie the two.
    const nextPosition = favorites.value
      .reduce((max, f) => Math.max(max, f.displayOrder ?? 0), -1) + 1
    const res = await fetch('/api/transit/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: DEFAULT_USER_ID,
        cityCode: item.cityCode || '027',
        lineId: item.lineId,
        lineName: item.lineName,
        preferredDirection: item.preferredDirection ?? 0,
        reverseLineId: item.reverseLineId,
        displayOrder: nextPosition,
      }),
    })
    const json = await res.json()

    // The server merges a re-followed route into the existing row, so replace it
    // in place instead of appending a duplicate card. Reassign the array:
    // `favorites` is a shallowRef, so mutating an element or pushing in place
    // would not trigger any subscriber.
    const reconcile = (saved: UserFavoriteLine): void => {
      const idx = favorites.value.findIndex(f => f.id === saved.id)
      favorites.value = idx >= 0
        ? favorites.value.map((f, i) => (i === idx ? saved : f))
        : [...favorites.value, saved]
    }

    if (json.alreadyFollowed) {
      // A refusal that is not a failure: the line IS followed, by the row the
      // server names. Without `data` there is nothing to reconcile, so the
      // outcome stays unknown rather than being assumed either way.
      if (json.data) {
        reconcile(json.data as UserFavoriteLine)
        return false
      }
    }
    else if (json.success && json.data) {
      reconcile(json.data as UserFavoriteLine)
      return true
    }
    throw new Error(json.error || '关注失败')
  }

  /**
   * Patch one commute slot (morning/evening) of a favourite.
   *
   * `undefined` leaves a field untouched, `null` clears it — the server maps the
   * same distinction onto its SQL. A slot carries both its direction and its
   * board stop; callers that set a stop while a direction is on screen (the route
   * detail popover) write both at once, so a stop never exists without the
   * direction that gives it its stop numbering.
   */
  async function updateCommuteSlot(
    favoriteId: string,
    purpose: 'morning' | 'evening',
    patch: { direction?: number | null, stopName?: string | null },
  ): Promise<void> {
    const target = favorites.value.find(f => f.id === favoriteId)
    if (!target) return

    const body: Record<string, string | number | null> = {}
    if (patch.direction !== undefined) {
      const key = purpose === 'morning' ? 'morningDirection' : 'eveningDirection'
      body[key] = patch.direction
    }
    if (patch.stopName !== undefined) {
      const key = purpose === 'morning' ? 'morningStopName' : 'eveningStopName'
      body[key] = patch.stopName
    }
    if (Object.keys(body).length === 0) return

    const res = await fetch(`/api/transit/favorites/${encodeURIComponent(favoriteId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!json.success || !json.data) {
      throw new Error(json.error || '上车点保存失败')
    }
    const saved: UserFavoriteLine = json.data
    // Reassign rather than mutate in place: `favorites` is a shallowRef.
    favorites.value = favorites.value.map(f => (f.id === saved.id ? saved : f))
  }

  /** Set or clear just the stop of a commute slot (direction left as-is). */
  async function setBoardStop(
    favoriteId: string,
    purpose: 'morning' | 'evening',
    stationName: string | null,
  ): Promise<void> {
    await updateCommuteSlot(favoriteId, purpose, { stopName: stationName })
  }

  /**
   * Pin one route to the top of the home list, or un-pin it — the single action
   * the home screen's entry point, marker and cancel control all ride on.
   *
   * Optimistic: the card is where the tap says it is before the write settles,
   * and the previous list is restored verbatim when the write fails, with the
   * server's own message rethrown so the surface can show the reason.
   *
   * Only one route may be pinned (a partial unique index on the column), so a
   * pin clears the previous one in the same pass — the same single-pin
   * transaction the server runs. Un-pinning touches nothing but the flag, which
   * is what lands the row back on its own `displayOrder`.
   */
  async function togglePin(favoriteId: string): Promise<void> {
    const target = favorites.value.find(f => f.id === favoriteId)
    // An id we do not hold is a no-op: never PATCH a row the list cannot show.
    if (!target) return

    const pinned = !target.isPinned
    const previous = favorites.value
    favorites.value = orderFavorites(previous.map(f => (f.id === favoriteId
      ? { ...f, isPinned: pinned }
      : (pinned ? { ...f, isPinned: false } : f))))

    try {
      const res = await fetch(`/api/transit/favorites/${encodeURIComponent(favoriteId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: pinned }),
      })
      const json = await res.json()
      if (!json.success || !json.data) {
        throw new Error(json.error || '置顶设置失败')
      }
      const saved: UserFavoriteLine = json.data
      // Reassign rather than mutate in place: `favorites` is a shallowRef.
      favorites.value = orderFavorites(favorites.value.map(f => (f.id === saved.id
        ? saved
        : (pinned ? { ...f, isPinned: false } : f))))
    }
    catch (err) {
      favorites.value = previous
      throw err instanceof Error ? err : new Error('置顶设置失败')
    }
  }

  /**
   * Persist a drop: `movedId` takes the slot `anchorId` holds.
   *
   * Both are named — not indexed — because the order is ONE list over every
   * followed line of every city. A screen that shows a single city reports a
   * drop between two rows it can see, and resolving those two against the whole
   * list is what leaves the rows it does not show in their relative places
   * instead of overwriting them with a city-local numbering.
   *
   * One PATCH per row whose position actually changed, all in flight together;
   * a row already stored where it belongs is not re-sent.
   *
   * The batch is settled rather than raced, and a failure reconciles with the
   * server instead of restoring the snapshot: the per-row PATCHes are NOT atomic
   * server-side, so the first rejection can leave sibling rows already written.
   * The snapshot would then report an order the server does not hold — the
   * restore would itself be the bug. Re-reading the stored order makes what the
   * user sees what is stored; the snapshot is only the fallback for a re-read
   * that yields no list. Either way the server's reason is rethrown.
   *
   * What stays behind is ordered for the home list (pin first, positions then
   * creation instants deciding the rest); `favoriteOrder` reports the positions
   * and instants on their own.
   */
  async function moveFavorite(movedId: string, anchorId: string): Promise<void> {
    const ordered = orderByPosition(favorites.value)
    const from = ordered.findIndex(f => f.id === movedId)
    const to = ordered.findIndex(f => f.id === anchorId)
    if (from < 0 || to < 0 || from === to) return

    const next = reorder(ordered, from, to)
    const was = new Map(ordered.map(f => [f.id, f.displayOrder ?? 0]))
    const changed = next.filter(f => f.id !== undefined && was.get(f.id) !== f.displayOrder)
    // Every row already carries the position it is landing on: nothing to write.
    if (changed.length === 0) return

    const previous = favorites.value
    favorites.value = orderFavorites(next)

    try {
      const settled = await Promise.allSettled(changed.map(async (row) => {
        const res = await fetch(`/api/transit/favorites/${encodeURIComponent(row.id!)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayOrder: row.displayOrder }),
        })
        const json = await res.json()
        if (!json.success || !json.data) {
          throw new Error(json.error || '顺序保存失败')
        }
        return json.data as UserFavoriteLine
      }))

      const failure = settled.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw failure.reason instanceof Error ? failure.reason : new Error('顺序保存失败')
      }

      const saved = new Map(settled.flatMap(result => (result.status === 'fulfilled'
        ? [[result.value.id as string, result.value] as const]
        : [])))
      // Reassign rather than mutate in place: `favorites` is a shallowRef.
      favorites.value = orderFavorites(favorites.value.map(f => (f.id ? saved.get(f.id) ?? f : f)))
    }
    catch (err) {
      if (!await loadFavorites()) {
        favorites.value = previous
      }
      throw err instanceof Error ? err : new Error('顺序保存失败')
    }
  }

  async function removeFavorite(idOrIndex: string | number): Promise<void> {
    let target: UserFavoriteLine | undefined
    if (typeof idOrIndex === 'number') {
      target = favorites.value[idOrIndex]
    }
    else {
      target = favorites.value.find(f => f.id === idOrIndex || f.lineId === idOrIndex)
    }

    if (target?.id) {
      const res = await fetch(`/api/transit/favorites/${target.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) {
        throw new Error(json.error || '取消关注失败')
      }
    }

    favorites.value = favorites.value.filter(f => f !== target)
  }

  /**
   * F10's chain records (see `GET /api/transit/commute-chains`).
   *
   * Resolves true only when the server actually handed back a list, so a caller can
   * tell a real (possibly empty) answer from a failed probe — 设置's card shows
   * 「读取失败」 for the latter and 「还没有录入」 for the former, and the two must not
   * be collapsed into one.
   */
  async function fetchCommuteChains(): Promise<boolean> {
    try {
      const qs = new URLSearchParams({ userId: DEFAULT_USER_ID })
      const res = await fetch(`/api/transit/commute-chains?${qs.toString()}`)
      const json = await res.json()
      if (json.success && Array.isArray(json.data)) {
        commuteChains.value = json.data as CommuteChain[]
        return true
      }
    }
    catch {
      // Fall through: there is no list to trust.
    }
    return false
  }

  /**
   * Write one chain — a create when no id is given, an edit otherwise.
   *
   * `legs` is written as one value, exactly as the request carries it: a chain IS its
   * legs, so replacing them replaces its substance. The array's own order is the
   * sequence — `seq` is the server's, written from the order it receives, and the
   * editor never sends one.
   *
   * The refusal is the server's own message, rethrown rather than replaced: a 400
   * from this contract names the rule it failed (F10's 「服务端拒绝时如实报错」).
   */
  async function saveCommuteChain(
    id: string | null,
    write: CommuteChainWrite,
  ): Promise<CommuteChain> {
    // A new chain takes the next slot past the highest position held — never past the
    // row count, which would reissue a position a removed row's successor still holds.
    const body = id === null
      ? { ...write, userId: DEFAULT_USER_ID, displayOrder: commuteChains.value.reduce((max, chain) => Math.max(max, chain.displayOrder ?? 0), -1) + 1 }
      : write
    const res = await fetch(
      id === null ? '/api/transit/commute-chains' : `/api/transit/commute-chains/${encodeURIComponent(id)}`,
      {
        method: id === null ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    const json = await res.json()
    if (!json.success || !json.data) {
      throw new Error(json.error || '链路保存失败')
    }
    const saved = json.data as CommuteChain
    // Reassign rather than mutate in place: `commuteChains` is a shallowRef.
    const index = commuteChains.value.findIndex(chain => chain.id === saved.id)
    commuteChains.value = index >= 0
      ? commuteChains.value.map((chain, at) => (at === index ? saved : chain))
      : [...commuteChains.value, saved]
    return saved
  }

  /**
   * Remove one chain record.
   *
   * Deliberately not optimistic: the row is one of a handful, the request is a single
   * round trip, and a removed-then-restored row would flash the chain page's only
   * source of truth about what is recorded.
   */
  async function removeCommuteChain(id: string): Promise<void> {
    const res = await fetch(`/api/transit/commute-chains/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const json = await res.json()
    if (!json.success) {
      throw new Error(json.error || '链路删除失败')
    }
    commuteChains.value = commuteChains.value.filter(chain => chain.id !== id)
  }

  return {
    currentLineDetail,
    currentLiveStatus,
    commuteProfile,
    favorites,
    commuteChains,
    fetchCommuteChains,
    saveCommuteChain,
    removeCommuteChain,
    favoriteOrder,
    wsConnected,
    isLoading,
    isRefreshingLive,
    loadFailure,
    simulationEnabled,
    refreshInFlight,
    refreshOutcome,
    refreshNextAllowedAt,
    refreshRetryAfterSeconds,
    refreshAnsweredAt,
    refreshWaitUntil,
    refreshWaitSecondsLeft,
    refreshReading,
    refreshNow,
    fetchCommuteProfile,
    fetchFavorites,
    fetchRuntimeFlags,
    searchLines,
    loadLine,
    refreshLive,
    reloadLiveStatus,
    resetLineData,
    initWs,
    addFavorite,
    moveFavorite,
    setBoardStop,
    togglePin,
    updateCommuteSlot,
    removeFavorite,
  }
})
