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
 * F11 的刷新入口，如两个屏幕所渲染。
 *
 * 三件事必须可见：刷新正在进行、它被拒绝以及窗口关闭多久、以及它失败了。它们旁边是刷新所拥有的唯一
 * 事实——它取得的那次读数被取得的瞬间——而支配该事实的规则是本项目最严的：生成或降级的读数绝不得被
 * 呈现为平白取得的，而从未取得的读数根本不给时间。
 *
 * 措辞是纯逻辑，故在此测试而非浏览器（本应用无 DOM 测试台）。末尾的源码守卫钉单元测试看不到的接线：
 * 两个屏幕都按拥有冷却的那个端点，且它们渲染的倒计时在播报它的 live region 之外。
 */

/** 夹具报告为取得的瞬间。2023-11-14T22:13:20Z。 */
const OBTAINED_AT = 1_700_000_000_000

/**
 * 状态行，如屏幕所渲染：状态，然后是秒数。
 *
 * 两部分由两个屏幕从同一行渲染（下面的源码守卫守住这一点），故这是用户读到的文本——而文本正是评判措辞的依据。
 */
function lineOf(status: RefreshStatusText | null): string | null {
  return status === null ? null : status.announcement + status.detail
}

/** 一次读数，如刷新响应所上报：一个瞬间，及其种类。 */
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

/** 一次成功的刷新：取得了一次读数，窗口已关闭。 */
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

/** 一次拒绝：什么都没读到，且窗口的截止时刻仍被陈述。 */
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
 * 依次回复每次 fetch 调用，并记录发送了什么。最后一次回复重复，使测试能只陈述它关心的那一个答案。
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
    // 时钟不是读数：取得之前没有瞬间可报，故该行如实陈述而非印出当前时间。
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
    // F4 存在所要防止的那一种混淆：时刻表引擎的列车与其他读数一样盖着当前时间。
    const generated = refreshFreshnessOf(reading(OBTAINED_AT, 'subway_schedule'))
    expect(generated.mark).toBe('排班推演')
    expect(generated.text).not.toContain('实时')
    // 该瞬间仍是关于读数何时产生的事实。
    expect(generated.time).toBe(clockOf(OBTAINED_AT))
  })

  it('does not present a degraded reading as a plainly obtained one', () => {
    const degraded = refreshFreshnessOf(reading(OBTAINED_AT, 'chelaile', true))
    expect(degraded.text).toContain('仅供参考')
    expect(degraded.degraded).toBe(true)
    // 类型仍被陈述：那条告诫关乎读数的可信度，而 F4 的标记关乎它是哪种数字。
    expect(degraded.text).toContain('实时')
  })

  it('states no mark at all when the reading names no source it knows', () => {
    const unstated = refreshFreshnessOf(reading(OBTAINED_AT, null, null))
    expect(unstated.mark).toBeNull()
    expect(unstated.text).toBe(`最后更新 ${clockOf(OBTAINED_AT)}`)
    // 未陈述类型时为 `null`——绝不被四舍五入到好看的那一个。
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
    // 0 秒是时钟快于服务端的设备为真正关闭的窗口算出的结果——而被什么都不告知的按下会被读成一个
    // 什么都不做的按钮。拒绝是它不得扣留的那一个答案。
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
    // 卡片完全不读任何线路的屏幕（尚未选上车点）没有可请求的东西，
    // 而一次静默什么都不做的按下是控件不得给出的那一个答案。
    expect(lineOf(refreshStatusTextOf({ ...idle, wanted: 0, covered: 0 })))
      .toBe('暂无正在读取车况的线路')
  })

  it('names the list it is about — never the screen the control sits on', () => {
    // 句子的主语是目标所取自的列表，不是屏幕。上班/下班模式为每条关注线路显示一张卡，无论它们是否
    // 已有可重读的到站行（尚未为该用途选上车点），故「屏幕上暂无可刷新的线路」在本页看不见的屏幕上
    // 声称什么都没有，而用户正看着四张卡。
    const line = lineOf(refreshStatusTextOf({ ...idle, wanted: 0, covered: 0 }))!
    expect(line).toBe('暂无正在读取车况的线路')
    expect(line, 'the sentence claims something about the screen').not.toContain('屏幕上')
  })

  it('says nothing when the list the targets come from was never read', () => {
    // **失败**的读取留下与已作答空读取相同的空数组（read-state.ts），故此处不得陈述「没有线路在被读取」：
    // 决定有何可刷新的那个列表从未取得，而该句子会是关于没人读过的行的断言。
    // 该失败由屏幕自己陈述，并附能改变它的重试。
    expect(lineOf(refreshStatusTextOf({
      ...idle, wanted: 0, covered: 0, targetsRead: false,
    }))).toBeNull()

    // 已**作答**却未产出行的列表仍如此陈述：那种情形是关于已存内容的事实，也是控件必须解释的那一种。
    expect(lineOf(refreshStatusTextOf({
      ...idle, wanted: 0, covered: 0, targetsRead: true,
    }))).toBe('暂无正在读取车况的线路')
  })

  it('announces the state once, not once per second of the wait', () => {
    // 拒绝是唯一一个站立期间其行会改变的已陈述状态：秒数取自倒计时。它们被携带在 live region 所读取的
    // 状态**之外**，否则一个 13 秒的窗口会把一次拒绝排入十三条播报。
    const twelve = refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 12, wanted: 1, covered: 1,
    })!
    const eleven = refreshStatusTextOf({
      ...idle, outcome: 'throttled', waitSeconds: 11, wanted: 1, covered: 1,
    })!
    expect(twelve.announcement).toBe('刷新太频繁')
    expect(eleven.announcement).toBe(twelve.announcement)
    expect(eleven.announcement).not.toContain('11')
    // 可见行仍会移动，故倒计时即便从不被播报也仍被读到。
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
    // 一次按下、一个窗口：手动刷新经由拥有冷却的那个端点花掉它的上游读取，绝不经逐线路读取
    // ——那会让本屏的一次按下不被计入冷却。
    expect(sent.map(([url]) => url)).toEqual(['/api/transit/refresh'])
    const [, init] = sent[0]!
    expect(init.method).toBe('POST')
    // 无 body 的 POST 会在窗口被读取之前被服务端拒绝，故 body 是契约的一部分而非锦上添花。
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

    // 拒绝什么都没读到，故读数仍是早先那一次——而与它一起记录的类型仍描述它。
    expect(store.refreshReading).toEqual({ at: OBTAINED_AT, dataSource: 'chelaile', isDegraded: false })
    expect(store.refreshOutcome).toBe('throttled')
  })

  it('clears the reading when an answer obtained none', async () => {
    const store = useTransitStore()
    stubFetch([{ status: 200, body: { success: true, data: okResult() } }])
    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    expect(store.refreshReading).not.toBeNull()

    // 端点只在本用户从未取得过读数时上报 `lastUpdatedAt: null`，
    // 故保留自己先前瞬间的客户端会持有一个服务端已不再持有的事实。
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
    // 倒计时不是常开时钟：在没有打开窗口时（或截止时刻已过时）到达的一次 tick 已无可计数。
    expect(refreshCountdownOpen(null, 1_000_000)).toBe(false)
    expect(refreshCountdownOpen(1_000_000, 1_000_000)).toBe(false)
    expect(refreshCountdownOpen(1_000_000, 1_005_000)).toBe(false)
    // ……而窗口**确实**关闭期间，它正是 tick 所为之工作的东西。
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
        // 服务端陈述的时长与它陈述的截止时刻同行：两者是那一个窗口，而倒计时按较晚耗尽的
        // 那个计（此处两者一致，故截止时刻是约束性的那个）。
        data: refusedResult({ nextAllowedAt: now + 3000, retryAfterSeconds: 3 }),
      },
    }])

    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    expect(refreshWaitSeconds(store.refreshWaitUntil, store.refreshNow)).toBe(3)

    vi.advanceTimersByTime(2000)
    expect(refreshWaitSeconds(store.refreshWaitUntil, store.refreshNow)).toBe(1)

    vi.advanceTimersByTime(2000)
    // 到截止时刻等待结束，而说明这一点的是截止时刻而非本地猜测：倒计时丢弃该拒绝，
    // 故状态行再无可报，并停止描述一个不再关闭的窗口。
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
 * 控件渲染的状态行，取自 store 自己的时钟：等待按两个屏幕派生它的方式派生，故这是用户所见的。
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
 * 一次拒绝必须有话可说。
 *
 * 等待取自服务端陈述的截止时刻，而该截止时刻是**服务端**时钟上的瞬间、与本设备时钟相比——一个会被
 * 时差毁掉的比较。落在窗口最后一个往返中的按下会为真正关闭的窗口算出零秒剩余，而时钟跑快的设备会在
 * 整个窗口期间算出同样的结果。无论哪种，用户按下一个按钮却被告知什么都没有，
 * 这是拒绝不得给出的答案。
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

    // 第一次按下花掉窗口；其倒计时从那个截止时刻开始。
    stubFetch([{
      status: 200,
      body: { success: true, data: okResult({ nextAllowedAt: deadline, retryAfterSeconds: 18 }) },
    }])
    await store.refreshLive([{ lineId: 'line_a', direction: 0 }])
    vi.advanceTimersByTime(17_000)
    expect(store.refreshNow).toBe(start + 17_000)

    // 第二次按下在窗口最后一个往返内离开。倒计时到达其截止时刻并在答案仍在路上时停下，
    // 故它落在一个已越过它所携带截止时刻的时钟上。
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

    // 服务端陈述了还剩 1 秒窗口；拒绝如实陈述，而非让这次按下完全没有答案。
    expect(statusOf(store)).toBe('刷新太频繁 · 1 秒后可刷新')

    // ……而那一秒被数过并结束，而非永远站着。
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

    // 关掉 NTP 的手机：时钟向前跳过服务端陈述的截止时刻，而该截止时刻所描述的窗口确实关闭。
    // 倒计时的指针从此时钟读，故它也落在该截止时刻之后。
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

    // 服务端发送的时长不受该差异影响，故拒绝由它陈述，而非由这个时钟丢失的截止时刻陈述。
    expect(statusOf(store)).toBe('刷新太频繁 · 13 秒后可刷新')

    vi.advanceTimersByTime(13_000)
    expect(statusOf(store)).toBeNull()
  })
})

/** live region 所携带的状态，仅取自 store 自己的状态，别无其他。 */
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
 * 每次状态变化一次播报，绝不每秒一次。
 *
 * 倒计时是状态站立期间行中唯一会移动的部分，它坐在 live region 之外正因如此：若秒数在区域内同行，
 * 一次 13 秒的拒绝会播报十三次，而最需要听到该拒绝的用户正是它不停打断的那位。
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

    // 在窗口关闭期间每秒采样一次，即 live region 重读自身文本的方式。
    const announced: Array<string | null> = [announcementOf(store)]
    for (let second = 0; second < 5; second++) {
      vi.advanceTimersByTime(1_000)
      announced.push(announcementOf(store))
    }

    // 一次五秒拒绝期间只说了两件事——它被拒绝，以及它结束了——而非等待中每秒一个词。
    expect(announced.filter((text, index) => text !== announced[index - 1]))
      .toEqual(['刷新太频繁', null])
  })
})

describe('both screens come through the one request that owns the window', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** 去掉说明性文字的文件，故被断言的是代码。 */
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
    // 一个端点意味着每个用户一个窗口：第二个 URL 会是第二个冷却，两个屏幕就不再共享它。
    expect(request.match(/\/api\/transit\/refresh/g)).toHaveLength(1)
    expect(request).toMatch(/\/api\/transit\/refresh'[\s\S]{0,600}'Content-Type': 'application\/json'/)
  })

  it('names the lines it wants re-read, from each screen', () => {
    // 请求读取它所索要的内容，故什么都没点名的条目什么都没索要：线路页交出它显示的线路，
    // 首页交出它卡片所读的线路。两者经同一个 action。
    for (const [name, source] of Object.entries({ overview, detail })) {
      const code = codeOf(source)
      expect(code, `${name} has no refresh entry`).toContain('refreshLive(')
      expect(code, `${name} presses a refresh without naming a line`)
        .not.toMatch(/refreshLive\(\s*\)/)
    }
    // ……而逐线路读取永远只是它之后的东西，绝不是入口。
    expect(codeOf(detail)).toContain('reloadLiveStatus')
  })

  it('declares the countdown paused, so a page left open gains no ticker', () => {
    // 等待是服务端的 `nextAllowedAt`，而读取它的指针不得自行运行；只有一次按下恢复它，
    // 且只在那个截止时刻仍在未来时。这是源码断言而非运行时断言：在 vitest 下没有客户端，
    // 故未暂停的 interval 在那里无论如何都是惰性的，而其后果是浏览器事实。
    expect(codeOf(store)).toContain('{ immediate: false }')
  })

  it('words the states in one place, so the two screens cannot drift', () => {
    for (const [name, source] of Object.entries({ overview, detail })) {
      expect(codeOf(source), `${name} words a refresh state itself`).not.toContain('刷新太频繁')
    }
    expect(store).toContain('刷新太频繁')
    // 新鲜度行自己的词汇同理。
    expect(store).toContain('尚未获取到数据')
  })

  it('hands the read state in, so an unreadable list states nothing about itself', () => {
    // 目标所取自的列表是否被**读取**，是只有屏幕持有的事实（read-state.ts），故由屏幕交出而非 store 假定：
    // 首页从它自己的三态说明，链路页从它自己的加载说明。停止传递它的屏幕会对一个没人读过的列表
    // 答「没有线路在被读取」。
    expect(codeOf(overview)).toContain('targetsRead: favouritesRead.value === \'read\'')
    const chain = read('../views/commute-chain/index.vue')
    expect(codeOf(chain)).toContain('targetsRead: !loading.value')
  })

  it('renders a live region that stands before its state, with the seconds outside it', () => {
    for (const [name, source] of Object.entries({ overview, detail })) {
      const code = codeOf(source)
      const container = code.match(/<p[^>]*id="refresh-status"[^>]*>/)
      expect(container, `${name} has no state line`).not.toBeNull()
      // 与其第一个词一同创建的 live region 在某些屏幕阅读器上根本不被播报，
      // 故携带 role="status" 的元素无论有没有状态可陈述都被渲染。
      expect(container![0], `${name} renders its state line only once it has one`)
        .not.toContain('v-if')

      const line = code.match(/<p[^>]*id="refresh-status"[\s\S]*?<\/p>/)![0]
      const region = line.match(/<span[^>]*role="status"[^>]*>([\s\S]*?)<\/span>/)
      expect(region, `${name} announces its state from a live region`).not.toBeNull()
      // 区域内只有粗粒度状态：秒数坐在兄弟节点上，故倒计时跳动时区域文本不变。
      expect(region![1], `${name} announces its countdown`).toContain('announcement')
      expect(region![1], `${name} announces its countdown`).not.toContain('detail')
      expect(line, `${name} does not render the countdown`).toContain('refreshStatus?.detail')
    }
  })
})
