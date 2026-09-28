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
 * F11 的刷新入口，如三页所渲染。
 *
 * 四件事必须可见：刷新被拒以及窗口关闭多久、它失败了、连接断了、以及它成功了。它们旁边是刷新所拥有
 * 的唯一留在屏幕上的事实——它取得的那次读数被取得的瞬间——而支配该事实的规则是本项目最严的：生成或
 * 降级的读数绝不得被呈现为平白取得的，而从未取得的读数根本不给时间。
 *
 * 措辞是纯逻辑，故在此测试而非浏览器（本应用无 DOM 测试台）。一次按下的结局如何被推给用户由
 * `refresh-toast.test.ts` 评判；此处评判的是那句话本身，以及末尾那些单元测试看不到的接线：三页都按
 * 拥有冷却的那一个端点，且覆盖范围由 store 决定。
 */

/**
 * 本文件评判的是那句话与那次请求。提示那一侧（推几条、什么身份、驻留多久）由 `refresh-toast.test.ts`
 * 评判，故此处把库换成空实现 —— 本应用没有 DOM 测试台，而它的撤销要用到 `requestAnimationFrame`。
 */
vi.mock('vue-sonner', () => ({
  toast: Object.assign(() => {}, { dismiss: () => {}, custom: () => {} }),
}))

/** 夹具报告为取得的瞬间。2023-11-14T22:13:20Z。 */
const OBTAINED_AT = 1_700_000_000_000

/** 一句话，如提示所读出的：状态，然后是随附的那一段。 */
function lineOf(status: RefreshStatusText): string {
  return status.announcement + status.detail
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

describe('the conclusion the store has to state', () => {
  const idle = { waitSeconds: 0, wanted: 1, covered: 1 }

  it('says the refresh landed', () => {
    expect(lineOf(refreshStatusTextOf({ ...idle, outcome: 'ok' })))
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

  it('keeps the countdown out of the state word', () => {
    // 冷却那条在窗口关闭期间一直站着，而它每秒都在改写自己：状态词是同一个，动的只有秒数那一段。
    const twelve = refreshStatusTextOf({ ...idle, outcome: 'throttled', waitSeconds: 12 })
    const eleven = refreshStatusTextOf({ ...idle, outcome: 'throttled', waitSeconds: 11 })
    expect(twelve.announcement).toBe('刷新太频繁')
    expect(eleven.announcement).toBe(twelve.announcement)
    expect(eleven.announcement).not.toContain('11')
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
    // 窗口开了就再没有等待可说，故提示也不会留在屏幕上。
    expect(wordingOf(store)).toBeNull()
  })
})

/**
 * store 现在会说出的那句话：结局取自它，等待取自它自己的时钟。没有结局可陈述时为 null。
 */
function wordingOf(store: ReturnType<typeof useTransitStore>): string | null {
  if (store.refreshOutcome === null) return null
  return lineOf(refreshStatusTextOf({
    outcome: store.refreshOutcome,
    waitSeconds: store.refreshWaitSecondsLeft,
    wanted: 1,
    covered: 1,
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
    expect(wordingOf(store)).toBe('刷新太频繁 · 1 秒后可刷新')

    // ……而那一秒被数过并结束，而非永远站着。
    vi.advanceTimersByTime(1_000)
    expect(wordingOf(store)).toBeNull()
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
    expect(wordingOf(store)).toBe('刷新太频繁 · 13 秒后可刷新')

    vi.advanceTimersByTime(13_000)
    expect(wordingOf(store)).toBeNull()
  })
})

/**
 * 冷却那条站立期间每秒都改写自己，而它的**身份**不变。
 *
 * 同一条提示改说下一秒，而不是每秒新推一条：屏幕上是一条在数，不是一叠各说一个秒数的通知。
 * （它逐秒改写的后果由 `refresh-toast.test.ts` 从提示那一侧评判。）
 */
describe('the countdown rewrites one statement, not one per second', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('says the same state word all the way down the window it counts', async () => {
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

    // 在窗口关闭期间每秒采样一次，即那条提示改写自己的方式。
    const words: Array<string | null> = []
    const seconds: number[] = []
    for (let second = 0; second <= 5; second++) {
      const outcome = store.refreshOutcome
      if (outcome === null) {
        words.push(null)
      }
      else {
        words.push(refreshStatusTextOf({
          outcome,
          waitSeconds: store.refreshWaitSecondsLeft,
          wanted: 1,
          covered: 1,
        }).announcement)
        seconds.push(store.refreshWaitSecondsLeft)
      }
      if (second < 5) vi.advanceTimersByTime(1_000)
    }

    // 一次五秒拒绝期间状态词只说两件事——被拒，以及窗口开了——而不是等待中每秒钟一个词。
    expect(words.filter((word, index) => word !== words[index - 1])).toEqual(['刷新太频繁', null])
    // 而被改写的那个数确实在往下走，故它读起来是一个倒计时。
    expect(seconds).toEqual([5, 4, 3, 2, 1])
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
  const chain = read('../views/commute-chain/index.vue')
  const control = read('../components/refresh-control/main.vue')

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

  it('decides the coverage itself, from every target the screen hands in', () => {
    // 端点限定了单次尝试能点名的条数，故「这一次刷新了几条」是 store 的事实：由它切片与计数，
    // 界面只交上来屏幕上有什么。把切片留在页面的那一版会让两个数字从两处漂开。
    const request = codeOf(store)
    expect(request).toContain('REFRESH_MAX_LINES')
    expect(request).toMatch(/slice\(0, REFRESH_MAX_LINES\)/)
    for (const [name, source] of Object.entries({ overview, detail, chain })) {
      const code = codeOf(source)
      expect(code, `${name} slices its targets itself`).not.toContain('REFRESH_MAX_LINES')
      expect(code, `${name} presses a refresh without naming a line`)
        .not.toMatch(/refreshLive\(\s*\)/)
    }
  })

  it('leaves no state line behind in the control', () => {
    // 一次按下的结局由全局提示承载，故控件里不再有那一行，也不再有一条常驻的 live region：
    // 两处都留着会让一次拒绝同时被说两遍。
    const code = codeOf(control)
    expect(code).not.toContain('refresh-status')
    expect(code).not.toContain('role="status"')
    expect(code).not.toContain('announcement')
    // 它仍旧不改写一个字：新鲜度行的词来自 store。
    expect(code, 'the control words a state itself').not.toContain('刷新太频繁')
    expect(code, 'the control words a freshness line itself').not.toContain('最后更新')
    // 而两半都还在，且由共用的那一个前缀说明它们是一件事。
    expect(code).toContain('refresh-freshness')
    expect(code).toContain(`'full'`)
    expect(code).toContain(`'button'`)
    expect(code).toContain(`'reading'`)
  })
})
