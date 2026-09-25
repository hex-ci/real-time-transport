import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RefreshLiveResult } from '@real-time-transport/shared'
import {
  refreshCountdownOpen,
  refreshFreshnessOf,
  refreshStatusTextOf,
  refreshWaitSeconds,
  useTransitStore,
} from '../stores/transit.store'
import type { RefreshReading, RefreshStatusText } from '../stores/transit.store'

/**
 * F11's refresh entry, as the two screens render it.
 *
 * Three things must be visible: that a refresh is running, that it was refused
 * and how long the window is shut for, and that it failed. Beside them sits the
 * one fact the refresh owns — the instant the reading it obtained was obtained —
 * and the rule that governs that fact is this project's strictest: a generated
 * or degraded reading must never be presented as a plainly obtained one, and a
 * reading that was never obtained gets no time at all.
 *
 * The wording is pure logic, so it is tested here rather than in a browser (this
 * app has no DOM test harness). The source guards at the end hold the wiring a
 * unit test cannot see: that both screens press the one endpoint that owns the
 * cooldown, and that the countdown they render is outside the live region that
 * announces it.
 */

/** The instant the fixtures report as obtained. 2023-11-14T22:13:20Z. */
const OBTAINED_AT = 1_700_000_000_000

/**
 * The state line as a screen renders it: the state, then the seconds.
 *
 * The two parts are rendered from one line by the two screens (the source guards
 * below hold that), so this is the text the user reads — and the text is what the
 * wording is judged by.
 */
function lineOf(status: RefreshStatusText | null): string | null {
  return status === null ? null : status.announcement + status.detail
}

/** A reading as the refresh response reports one: an instant, and its kind. */
function reading(
  at: number,
  dataSource: RefreshReading['dataSource'],
  isDegraded: boolean | null = false,
): RefreshReading {
  return { at, dataSource, isDegraded }
}

function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A successful refresh: a reading was obtained, and the window has closed. */
function okResult(overrides: Partial<RefreshLiveResult> = {}): RefreshLiveResult {
  return {
    dataClass: 'live',
    throttled: false,
    lastUpdatedAt: OBTAINED_AT,
    nextAllowedAt: OBTAINED_AT + 18_000,
    retryAfterSeconds: 18,
    lines: [{
      lineId: 'line_a',
      direction: 0,
      lastUpdatedAt: OBTAINED_AT,
      dataSource: 'chelaile',
      isDegraded: false,
    }],
    ...overrides,
  }
}

/** A refusal: nothing was read, and the window's deadline is still stated. */
function refusedResult(overrides: Partial<RefreshLiveResult> = {}): RefreshLiveResult {
  return {
    dataClass: 'live',
    throttled: true,
    lastUpdatedAt: OBTAINED_AT,
    nextAllowedAt: OBTAINED_AT + 18_000,
    retryAfterSeconds: 18,
    lines: [],
    ...overrides,
  }
}

/**
 * Reply to each fetch call in turn, recording what was sent. The last reply
 * repeats, so a test can state the one answer it cares about.
 */
function stubFetch(replies: Array<{ status: number, body: unknown }>): Array<[string, RequestInit]> {
  const sent: Array<[string, RequestInit]> = []
  let index = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push([url, init])
    const reply = replies[Math.min(index++, replies.length - 1)]!
    return { status: reply.status, json: async () => reply.body }
  })
  return sent
}

describe('the freshness line never dresses a reading as something it is not', () => {
  it('has no time to show when nothing was obtained', () => {
    const fresh = refreshFreshnessOf(null)
    // A clock is not a reading: before one is obtained there is no instant to
    // report, so the line says so instead of printing the current time.
    expect(fresh.time).toBeNull()
    expect(fresh.mark).toBeNull()
    expect(fresh.text).toBe('尚未获取到数据')
  })

  it('reports the instant the reading was obtained, and what kind of value it is', () => {
    const fresh = refreshFreshnessOf(reading(OBTAINED_AT, 'chelaile'))
    expect(fresh.time).toBe(clockOf(OBTAINED_AT))
    expect(fresh.text).toBe(`最后更新 ${clockOf(OBTAINED_AT)} · 实时`)
  })

  it('follows the reading rather than the clock it is rendered at', () => {
    const earlier = refreshFreshnessOf(reading(OBTAINED_AT, 'chelaile'))
    const later = refreshFreshnessOf(reading(OBTAINED_AT + 3_600_000, 'chelaile'))
    expect(later.time).not.toBe(earlier.time)
  })

  it('says a generated reading is generated, and never that it is live', () => {
    // The one confusion F4 exists to prevent: the timetable engine's trains are
    // stamped with the current time like any other reading.
    const generated = refreshFreshnessOf(reading(OBTAINED_AT, 'subway_schedule'))
    expect(generated.mark).toBe('排班推演')
    expect(generated.text).not.toContain('实时')
    // The instant is still a fact about when the reading was produced.
    expect(generated.time).toBe(clockOf(OBTAINED_AT))
  })

  it('does not present a degraded reading as a plainly obtained one', () => {
    const degraded = refreshFreshnessOf(reading(OBTAINED_AT, 'chelaile', true))
    expect(degraded.text).toContain('仅供参考')
    expect(degraded.degraded).toBe(true)
    // The kind is still stated: the caution is about the reading's trust, and
    // F4's mark is about the kind of number it is.
    expect(degraded.text).toContain('实时')
  })

  it('states no mark at all when the reading names no source it knows', () => {
    const unstated = refreshFreshnessOf(reading(OBTAINED_AT, null, null))
    expect(unstated.mark).toBeNull()
    expect(unstated.text).toBe(`最后更新 ${clockOf(OBTAINED_AT)}`)
    // `null` for an unstated kind — never rounded up to the flattering one.
    expect(unstated.text).not.toContain('实时')
  })
})

describe('the three states the control has to state', () => {
  const idle = { inFlight: false, outcome: null, waitSeconds: 0, wanted: 0, covered: 0, targetsRead: true }

  it('says a refresh is running', () => {
    expect(lineOf(refreshStatusTextOf({ ...idle, inFlight: true }))).toBe('正在刷新…')
  })

  it('says the refresh landed', () => {
    expect(lineOf(refreshStatusTextOf({ ...idle, outcome: 'ok', wanted: 1, covered: 1 })))
      .toBe('已刷新')
  })

  it('says how long the window stays shut, using the seconds it is handed', () => {
    expect(lineOf(refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 12, wanted: 1, covered: 1,
    }))).toBe('刷新太频繁 · 12 秒后可刷新')
    expect(lineOf(refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 7, wanted: 1, covered: 1,
    }))).toContain('7 秒')
  })

  it('states a refusal even when the seconds it is handed are 0', () => {
    // 0 seconds is what a device whose clock runs ahead of the server computes for
    // a window that is genuinely shut — and a press that is told nothing reads as
    // a button that does nothing. The refusal is the one answer it may not withhold.
    const refused = refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 0, wanted: 1, covered: 1,
    })
    expect(lineOf(refused)).toBe('刷新太频繁 · 请稍后再试')
  })

  it('reads a refused attempt, an upstream that answered nothing and a lost connection apart', () => {
    const refused = lineOf(refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 18, wanted: 1, covered: 1,
    }))
    const unavailable = lineOf(refreshStatusTextOf({ ...idle, outcome: 'unavailable', wanted: 1, covered: 1 }))
    const offline = lineOf(refreshStatusTextOf({ ...idle, outcome: 'offline', wanted: 1, covered: 1 }))
    expect(refused).not.toBe(unavailable)
    expect(unavailable).not.toBe(offline)
    expect(unavailable).toContain('失败')
    expect(offline).toContain('连接')
  })

  it('never lets a partial refresh read as a full one', () => {
    const covered = lineOf(refreshStatusTextOf({ ...idle, outcome: 'ok', wanted: 10, covered: 8 }))
    expect(covered).not.toBe(lineOf(refreshStatusTextOf({
      ...idle, outcome: 'ok', wanted: 8, covered: 8,
    })))
    expect(covered).toContain('10')
    expect(covered).toContain('8')
  })

  it('says nothing before the first attempt', () => {
    expect(lineOf(refreshStatusTextOf({ ...idle, wanted: 1, covered: 1 }))).toBeNull()
  })

  it('says there is nothing to re-read rather than sitting dead', () => {
    // A screen whose cards read no line at all (no board stop chosen yet) has
    // nothing to ask for, and a press that silently does nothing is the one
    // answer the control may not give.
    expect(lineOf(refreshStatusTextOf({ ...idle, wanted: 0, covered: 0 })))
      .toBe('暂无正在读取车况的线路')
  })

  it('names the list it is about — never the screen the control sits on', () => {
    // The sentence's subject is the list the targets are drawn from, not the
    // screen. 上班/下班 mode shows a card per followed line whether or not any of
    // them has an arrival row to re-read (no boarding stop chosen for that purpose
    // yet), so 「屏幕上暂无可刷新的线路」 claims the screen holds nothing while the
    // user is looking at four cards — a false sentence about a screen this page
    // cannot see.
    const line = lineOf(refreshStatusTextOf({ ...idle, wanted: 0, covered: 0 }))!
    expect(line).toBe('暂无正在读取车况的线路')
    expect(line, 'the sentence claims something about the screen').not.toContain('屏幕上')
  })

  it('says nothing when the list the targets come from was never read', () => {
    // A read that FAILED leaves the same empty array behind as an answered empty
    // one (read-state.ts), so nothing here may state 「no line is being read」: the
    // list that decides what there is to refresh was never obtained, and the
    // sentence would be a claim about rows nobody read. The screen states that
    // failure itself, with the retry that can change it.
    expect(lineOf(refreshStatusTextOf({
      ...idle, wanted: 0, covered: 0, targetsRead: false,
    }))).toBeNull()

    // An ANSWERED list that yielded no row still says so: that case is a fact about
    // what is stored, and it is the case the control has to explain.
    expect(lineOf(refreshStatusTextOf({
      ...idle, wanted: 0, covered: 0, targetsRead: true,
    }))).toBe('暂无正在读取车况的线路')
  })

  it('announces the state once, not once per second of the wait', () => {
    // A refusal is the one state whose line changes while it stands: the seconds
    // come off the countdown. They are carried outside the state a live region
    // reads, or a 13-second window queues thirteen announcements of one refusal.
    const twelve = refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 12, wanted: 1, covered: 1,
    })!
    const eleven = refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 11, wanted: 1, covered: 1,
    })!
    expect(twelve.announcement).toBe('刷新太频繁')
    expect(eleven.announcement).toBe(twelve.announcement)
    expect(eleven.announcement).not.toContain('11')
    // The visible line still moves, so the countdown is read even though it is
    // never announced.
    expect(eleven.detail).not.toBe(twelve.detail)
    expect(lineOf(eleven)).not.toBe(lineOf(twelve))
  })
})

describe('the wait is counted down from the deadline the server owns', () => {
  it('is the seconds left to that deadline, rounded up so a shut window never reads 0', () => {
    expect(refreshWaitSeconds(1_000_000, 998_600)).toBe(2)
    expect(refreshWaitSeconds(1_000_000, 1_000_000)).toBe(0)
  })

  it('never counts below zero once the window is open', () => {
    expect(refreshWaitSeconds(1_000_000, 1_005_000)).toBe(0)
  })

  it('has nothing to count before a deadline is known', () => {
    expect(refreshWaitSeconds(null, 1_000_000)).toBe(0)
  })
})

describe('one press, one request', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('asks the endpoint that owns the cooldown, naming its lines, as JSON', async () => {
    const store = useTransitStore()
    const sent = stubFetch([{ status: 200, body: { success: true, data: okResult() } }])

    const outcome = await store.refreshLive([{ lineId: 'line_a', direction: 0, cityCode: '001' }])

    expect(outcome).toBe('ok')
    // One press, one window: the manual refresh spends its upstream read through
    // the endpoint that owns the cooldown, never through a per-line read, which
    // would leave a press on this screen uncounted against the cooldown.
    expect(sent.map(([url]) => url)).toEqual(['/api/transit/refresh'])
    const [, init] = sent[0]!
    expect(init.method).toBe('POST')
    // A bodyless POST is refused by the server before the window is read, so the
    // body is part of the contract rather than a nicety.
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body)).lines)
      .toEqual([{ lineId: 'line_a', direction: 0, cityCode: '001' }])
  })

  it('keeps the instant and the kind of the reading the refresh obtained', async () => {
    const store = useTransitStore()
    stubFetch([{ status: 200, body: { success: true, data: okResult() } }])

    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])

    expect(store.refreshReading).toEqual({ at: OBTAINED_AT, dataSource: 'chelaile', isDegraded: false })
    expect(store.refreshNextAllowedAt).toBe(OBTAINED_AT + 18_000)
  })

  it('tells a refusal, an upstream that answered nothing and a lost connection apart', async () => {
    const refused = useTransitStore()
    stubFetch([{ status: 429, body: { success: false, error: '…', data: refusedResult() } }])
    expect(await refused.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('throttled')

    setActivePinia(createPinia())
    const empty = useTransitStore()
    stubFetch([{
      status: 502,
      body: { success: false, error: '…', data: okResult({ lastUpdatedAt: null, lines: [] }) },
    }])
    expect(await empty.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('unavailable')

    setActivePinia(createPinia())
    const offline = useTransitStore()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no connection')
    }))
    expect(await offline.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('offline')
  })

  it('still reports the instant already obtained when the window refuses the attempt', async () => {
    const store = useTransitStore()
    stubFetch([
      { status: 200, body: { success: true, data: okResult() } },
      { status: 429, body: { success: false, error: '…', data: refusedResult() } },
    ])

    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    expect(await store.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('throttled')

    // The refusal read nothing, so the reading is still the earlier one — and the
    // kind recorded with it still describes it.
    expect(store.refreshReading).toEqual({ at: OBTAINED_AT, dataSource: 'chelaile', isDegraded: false })
    expect(store.refreshOutcome).toBe('throttled')
  })

  it('clears the reading when an answer obtained none', async () => {
    const store = useTransitStore()
    stubFetch([{ status: 200, body: { success: true, data: okResult() } }])
    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    expect(store.refreshReading).not.toBeNull()

    // The endpoint reports `lastUpdatedAt: null` only when it has never obtained
    // a reading for this user, so a client that kept its own previous instant
    // would be holding a fact the server no longer has.
    stubFetch([{
      status: 502,
      body: { success: false, error: '…', data: okResult({ lastUpdatedAt: null, lines: [] }) },
    }])
    expect(await store.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('unavailable')
    expect(store.refreshReading).toBeNull()
  })

  it('spends one request per press, not one per tap', async () => {
    const store = useTransitStore()
    let settle!: (value: unknown) => void
    const open = new Promise((resolve) => {
      settle = resolve
    })
    const fetchMock = vi.fn(() => open)
    vi.stubGlobal('fetch', fetchMock)

    const first = store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    const second = await store.refreshLive([{ lineId: 'line_a', direction: 0 }])

    expect(second).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    settle({ status: 200, json: async () => ({ success: true, data: okResult() }) })
    expect(await first).toBe('ok')
  })

  it('sends nothing when the screen names no line', async () => {
    const store = useTransitStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await store.refreshLive([])).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has nothing to count outside a window the server has shut', () => {
    // The countdown is not an always-on clock: a tick that arrives with no window
    // open — or with the deadline already reached — has nothing left to count.
    expect(refreshCountdownOpen(null, 1_000_000)).toBe(false)
    expect(refreshCountdownOpen(1_000_000, 1_000_000)).toBe(false)
    expect(refreshCountdownOpen(1_000_000, 1_005_000)).toBe(false)
    // ...and while the window IS shut, it is exactly what the tick works for.
    expect(refreshCountdownOpen(1_000_000, 998_600)).toBe(true)
  })

  it('counts the window down from the server\u2019s deadline and ends the refusal at it', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const now = Date.now()
    stubFetch([{
      status: 429,
      body: {
        success: false,
        error: '…',
        // The duration the server states rides with the deadline it states: both
        // are that one window, and the countdown is counted from whichever runs
        // out later (they agree here, so the deadline is the binding one).
        data: refusedResult({ nextAllowedAt: now + 3000, retryAfterSeconds: 3 }),
      },
    }])

    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    expect(refreshWaitSeconds(store.refreshWaitUntil, store.refreshNow)).toBe(3)

    vi.advanceTimersByTime(2000)
    expect(refreshWaitSeconds(store.refreshWaitUntil, store.refreshNow)).toBe(1)

    vi.advanceTimersByTime(2000)
    // At the deadline the wait is over, and it is the deadline that says so rather
    // than a local guess: the countdown drops the refusal, so the state line has
    // nothing left to report and stops describing a window that is no longer shut.
    expect(refreshWaitSeconds(store.refreshWaitUntil, store.refreshNow)).toBe(0)
    expect(store.refreshOutcome).toBeNull()
    expect(lineOf(refreshStatusTextOf({
      inFlight: false,
      outcome: store.refreshOutcome,
      waitSeconds: store.refreshWaitSecondsLeft,
      wanted: 1,
      covered: 1,
      targetsRead: true,
    }))).toBeNull()
  })
})

/**
 * The state line the control renders, from the store's own clock: the wait is
 * derived the way both screens derive it, so this is what the user sees.
 */
function statusOf(store: ReturnType<typeof useTransitStore>): string | null {
  return lineOf(refreshStatusTextOf({
    inFlight: store.refreshInFlight,
    outcome: store.refreshOutcome,
    waitSeconds: store.refreshWaitSecondsLeft,
    wanted: 1,
    covered: 1,
    targetsRead: true,
  }))
}

/**
 * A refusal must always say something.
 *
 * The wait is derived from the deadline the server states, and the deadline is an
 * instant on the SERVER's clock compared against this device's — the one
 * comparison a skew can ruin. A press landing in the window's last round trip
 * computes no seconds left for a window that is genuinely shut, and a device
 * whose clock runs ahead computes the same for the whole of it. Either way the
 * user presses a button and is told nothing, which is the answer a refusal may
 * not give.
 */
describe('a refusal is never silent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('states the wait the server gave even when its own deadline has already passed', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const start = Date.now()
    const deadline = start + 17_500

    // The first press spends the window; its countdown runs from that deadline.
    stubFetch([{
      status: 200,
      body: { success: true, data: okResult({ nextAllowedAt: deadline, retryAfterSeconds: 18 }) },
    }])
    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    vi.advanceTimersByTime(17_000)
    expect(store.refreshNow).toBe(start + 17_000)

    // The second press leaves inside the window's last round trip. The countdown
    // reaches its deadline and stops while the answer is still travelling, so it
    // lands on a clock that has already passed the deadline it carries.
    vi.stubGlobal('fetch', async () => {
      vi.advanceTimersByTime(4_000)
      return {
        status: 429,
        json: async () => ({
          success: false,
          error: '…',
          data: refusedResult({ nextAllowedAt: deadline, retryAfterSeconds: 1 }),
        }),
      }
    })
    expect(await store.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('throttled')

    expect(store.refreshNextAllowedAt).toBe(deadline)
    expect(store.refreshNow).toBeGreaterThan(deadline)

    // The server stated a second of window left; the refusal says so rather than
    // leaving the press with no answer at all.
    expect(statusOf(store)).toBe('刷新太频繁 · 1 秒后可刷新')

    // …and that second is counted through and ends, rather than standing forever.
    vi.advanceTimersByTime(1_000)
    expect(statusOf(store)).toBeNull()
  })

  it('states the wait for a device whose clock runs ahead of the server', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const start = Date.now()
    const deadline = start + 18_000

    stubFetch([{
      status: 200,
      body: { success: true, data: okResult({ nextAllowedAt: deadline, retryAfterSeconds: 18 }) },
    }])
    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])

    // A phone with NTP off: the clock jumps forward past the deadline the server
    // stated, while the window that deadline describes is genuinely shut. The
    // countdown hand reads from this clock, so it lands past that deadline too.
    vi.setSystemTime(deadline + 5_000)
    vi.advanceTimersByTime(1_000)
    expect(store.refreshNow).toBeGreaterThan(deadline)

    stubFetch([{
      status: 429,
      body: {
        success: false,
        error: '…',
        data: refusedResult({ nextAllowedAt: deadline, retryAfterSeconds: 13 }),
      },
    }])
    expect(await store.refreshLive([{ lineId: 'line_a', direction: 0 }])).toBe('throttled')

    // The duration the server sent is unaffected by the difference, and the
    // refusal is stated from it instead of from the deadline this clock lost.
    expect(statusOf(store)).toBe('刷新太频繁 · 13 秒后可刷新')

    vi.advanceTimersByTime(13_000)
    expect(statusOf(store)).toBeNull()
  })
})

/** The state a live region carries, from the store's own state and nothing else. */
function announcementOf(store: ReturnType<typeof useTransitStore>): string | null {
  const status = refreshStatusTextOf({
    inFlight: store.refreshInFlight,
    outcome: store.refreshOutcome,
    waitSeconds: store.refreshWaitSecondsLeft,
    wanted: 1,
    covered: 1,
    targetsRead: true,
  })
  return status === null ? null : status.announcement
}

/**
 * One announcement per state change, never one per second.
 *
 * The countdown is the only part of the line that moves while a state stands, and
 * it sits outside the live region for exactly this reason: a 13-second refusal
 * announces thirteen times if the seconds ride inside the region, and the user
 * who most needs to hear the refusal is the one it talks over.
 */
describe('one state, one announcement', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('announces a refusal once across the whole window it counts down', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const start = Date.now()
    stubFetch([{
      status: 429,
      body: {
        success: false,
        error: '…',
        data: refusedResult({ nextAllowedAt: start + 5_000, retryAfterSeconds: 5 }),
      },
    }])

    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])

    // Sampled once a second for as long as the window is shut, the way a live
    // region re-reads its own text.
    const announced: Array<string | null> = [announcementOf(store)]
    for (let second = 0; second < 5; second++) {
      vi.advanceTimersByTime(1_000)
      announced.push(announcementOf(store))
    }

    // Two things said across a five-second refusal — it is refused, and it is over
    // — rather than a word per second of the wait.
    expect(announced.filter((text, index) => text !== announced[index - 1]))
      .toEqual(['刷新太频繁', null])
  })
})

describe('both screens come through the one request that owns the window', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** The file with its explanatory prose removed, so code is what is asserted. */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  const store = read('../stores/transit.store.ts')
  const overview = read('../views/overview/index.vue')
  const detail = read('../views/line-detail/index.vue')

  it('posts the manual refresh to the endpoint that owns the cooldown, with a JSON body', () => {
    const request = codeOf(store)
    expect(request).toContain(`'/api/transit/refresh'`)
    // One endpoint means one window per user: a second URL would be a second
    // cooldown, and the two screens would stop sharing it.
    expect(request.match(/\/api\/transit\/refresh/g)).toHaveLength(1)
    expect(request).toMatch(/\/api\/transit\/refresh'[\s\S]{0,600}'Content-Type': 'application\/json'/)
  })

  it('names the lines it wants re-read, from each screen', () => {
    // The request reads what it is asked for, so an entry that names nothing is
    // asking for nothing: the line page hands over the line it shows, the home
    // screen the lines its cards read. Both go through the same action.
    for (const [name, source] of Object.entries({ overview, detail })) {
      const code = codeOf(source)
      expect(code, `${name} has no refresh entry`).toContain('refreshLive(')
      expect(code, `${name} presses a refresh without naming a line`)
        .not.toMatch(/refreshLive\(\s*\)/)
    }
    // ...and the per-line read is only ever what follows it, never the entry.
    expect(codeOf(detail)).toContain('reloadLiveStatus')
  })

  it('declares the countdown paused, so a page left open gains no ticker', () => {
    // The wait is the server's `nextAllowedAt` and the hand that reads it must not
    // run on its own; only a press resumes it, and only while that deadline is in
    // the future. A source assertion rather than a runtime one: under vitest there
    // is no client, so an un-paused interval would be inert there either way, and
    // the consequence is a browser fact.
    expect(codeOf(store)).toContain('{ immediate: false }')
  })

  it('words the states in one place, so the two screens cannot drift', () => {
    for (const [name, source] of Object.entries({ overview, detail })) {
      expect(codeOf(source), `${name} words a refresh state itself`).not.toContain('刷新太频繁')
    }
    expect(store).toContain('刷新太频繁')
    // The same for the freshness line's own vocabulary.
    expect(store).toContain('尚未获取到数据')
  })

  it('hands the read state in, so an unreadable list states nothing about itself', () => {
    // Whether the list the targets are drawn from was READ is a fact only the
    // screen holds (read-state.ts), so the screen hands it over rather than the
    // store assuming it: the home screen says so from its own tri-state, and the
    // chain page from its own load. A screen that stopped passing it would answer
    // 「no line is being read」 over a list nobody read.
    expect(codeOf(overview)).toContain('targetsRead: favouritesRead.value === \'read\'')
    const chain = read('../views/commute-chain/index.vue')
    expect(codeOf(chain)).toContain('targetsRead: !loading.value')
  })

  it('renders a live region that stands before its state, with the seconds outside it', () => {
    for (const [name, source] of Object.entries({ overview, detail })) {
      const code = codeOf(source)
      const container = code.match(/<p[^>]*id="refresh-status"[^>]*>/)
      expect(container, `${name} has no state line`).not.toBeNull()
      // A live region created together with its first word is not announced at all
      // by some screen readers, so the element carrying role="status" is rendered
      // whether or not there is a state to state.
      expect(container![0], `${name} renders its state line only once it has one`)
        .not.toContain('v-if')

      const line = code.match(/<p[^>]*id="refresh-status"[\s\S]*?<\/p>/)![0]
      const region = line.match(/<span[^>]*role="status"[^>]*>([\s\S]*?)<\/span>/)
      expect(region, `${name} announces its state from a live region`).not.toBeNull()
      // Only the coarse state is in the region: the seconds sit in a sibling, so
      // the region's text does not change while the countdown ticks.
      expect(region![1], `${name} announces its countdown`).toContain('announcement')
      expect(region![1], `${name} announces its countdown`).not.toContain('detail')
      expect(line, `${name} does not render the countdown`).toContain('refreshStatus?.detail')
    }
  })
})
