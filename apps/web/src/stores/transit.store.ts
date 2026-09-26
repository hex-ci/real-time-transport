import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { DEFAULT_USER_ID, vehicleProvenanceOf } from '@real-time-transport/shared'
import { provenanceLabelOf } from '@/provenance-copy'
import { lineLoadStateOf, type LineLoadState } from '@/line-load-state'
import type {
  CommuteChain,
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
 * F11 的手动刷新，按各自拥有入口的两块界面看到的样子。
 *
 * 两个入口都调用下面那一个 action，它把这次读取花在服务端自己的端点上。窗口属于服务端：
 * 这一侧从不判断某次按压是否被允许 —— 在这里算冷却期就是第二个时钟，而且是一个什么都拒绝
 * 不了的时钟。
 */

/**
 * 一次手动刷新请求的结局。
 *
 * - `ok`          取到了一次读数
 * - `throttled`   窗口拒绝了它：什么都没为它读到
 * - `unavailable` 读取发生了，而来源什么都没答
 * - `offline`     请求没有到达服务端
 */
export type RefreshOutcome = 'ok' | 'throttled' | 'unavailable' | 'offline'

/**
 * 一次写入携带的链路，其形状即契约接受的那份，减去服务端自己拥有的部分。
 *
 * 刻意不带 `seq`：一段的位置就是数组的顺序，那个数字由服务端从它写出来。站字段可空，因为
 * 「未选」是草稿的真实状态（是 `null`，绝不是一个空名字）；`transferExtraMinutes` 与
 * `connectionMode` 可空，因为「未设置」与「确实没有额外时间」、「没选过」与「选了步行」
 * 是两对各自不同的事实。
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
  /** 进入本段的接驳方式；`null` = 用户没选过（服务端按步行计价）。 */
  connectionMode: 'walk' | 'cycle' | null
}

/** 一次写入携带的链路内容，不含服务端能算出的位置。起点也不在其中：它由 `purpose` 决定。 */
export interface CommuteChainWrite {
  name: string
  purpose: CommuteChainPurpose
  legs: CommuteChainLegWrite[]
}

/**
 * 上一次手动刷新取到的读数，连同它是哪一类值。
 *
 * 光有那个时刻说不出它属于哪一类数字：生成的一次读数与观测到的一次读数被盖上同一个时刻的戳，
 * 只有时刻的界面会把模型的产出报成一次平白取得的读数。
 */
export interface RefreshReading {
  at: number
  dataSource: DataSourceType | null
  isDegraded: boolean | null
}

export interface RefreshFreshness {
  time: string | null
  mark: string | null
  degraded: boolean
  text: string
}

/**
 * 服务端窗口上还剩多少秒，由服务端给出的截止时刻算出。
 *
 * 那个截止时刻是「何时可以再次刷新」唯一的事实，且每个结局都带着它，所以等待一律由它得出 ——
 * 在这一侧凭空造的时长是对服务端自己窗口的第二种意见。
 */
export function refreshWaitSeconds(nextAllowedAt: number | null, now: number): number {
  if (nextAllowedAt === null) return 0
  return Math.max(0, Math.ceil((nextAllowedAt - now) / 1000))
}

/**
 * 所述窗口打开的时刻，取陈述它的两个时钟里较晚的那个。
 *
 * `nextAllowedAt` 是服务端自己的时刻，拿它与本机时钟相比是唯一会被时钟偏差毁掉的比较；
 * `retryAfterSeconds` 是同一个截止时刻在来源处量成的时长，两个时钟之差进不去它，把它从
 * 答案到达时起计时，就为等待托底。
 *
 * 两者说的是同一个窗口，所以较晚的那个就是那个窗口 —— 于是拒绝总有一个等待可说。时长与截止
 * 时刻同在一个答案里，因此两者都缺的结果会让两者一起缺席。
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
 * 一次刷新应答所描述的读数。
 *
 * 时刻用应答自己的 `lastUpdatedAt`，绝不用本机时钟：本机时钟对每个应答都成立，包括什么都
 * 没取到的那些。种类取自报告了那个时刻的那一行，而一次拒绝不报告任何行 —— 于是先前记在同一
 * 时刻上的种类仍然成立，因为时刻标识着一次读数，而这一次没有变。
 *
 * 若干行共享最新时刻却种类各异，那就不是一次读数：报出时刻、不给标记，一个词会对它的一部分
 * 说假话。什么都没取到的应答清掉读数。
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

/** 「HH:MM:SS」，读表人自己的时区 —— 一个时刻，绝不是时长。 */
function clockTimeOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 一次 tick 是否还有窗口可数。
 *
 * 只有服务端已经关上的窗口值得数，所以一次没有截止时刻（或截止时刻已到）的 tick 无事可做，
 * 这也正是调用方停下 tick 的信号 —— 在刚花掉的窗口之外，它没有活干，于是不会变成一个常开的
 * 时钟。
 */
export function refreshCountdownOpen(nextAllowedAt: number | null, now: number): boolean {
  return nextAllowedAt !== null && now < nextAllowedAt
}

/**
 * 新鲜度那一行：控件对它持有的读数报告什么。
 *
 * 从未取到的读数不报任何时间 —— 本机时钟不是读数，印出来会把一个空答案装扮成新鲜的。
 *
 * 取到的读数报出取到它的时刻，连同它是哪一类值，使一次生成的读数永远不会读成一次观测到的
 * 读数；来源未声明的读数不带标记，而不是去借那个好听的。
 *
 * 「仅供参考」不是一个种类词，而是回退来源挣来的提醒。它与标记并排，因为两者答的是不同的
 * 问题：标记说这是哪一类数字，它说这个能不能靠。
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
 * 状态那一行，按界面渲染它所需的两段。
 *
 * `announcement` 是状态本身，永不携带秒数：文本每秒都变的 live region 会把一次十三秒的
 * 拒绝播报十三遍。`detail` 是那串倒计时、已经措辞好，使秒数留在 live region 之外，却仍读作
 * 一行。两者都出在这里而不是某个界面，于是没有哪个界面自己去措辞一个状态。
 */
export interface RefreshStatusText {
  announcement: string
  detail: string
}

/**
 * 控件就上一次尝试所说的那一行。
 *
 * 三个结局必须都看得见，且任两个读起来不能一样：窗口上还剩等待的拒绝、来源什么都没答、请求
 * 没有到达服务端。后两个就是本应用对「连接断了」的报告 —— 它属于这个控件、属于用户正在看的
 * 地方，而不属于控制台。
 *
 * 拒绝从不沉默。它说出的秒数被服务端送来的时长托底（`refreshWaitUntilOf`），所以本机时钟
 * 看不见的窗口仍是一个会被告知的窗口；当应答拒绝了这次按压却根本没有窗口，拒绝就照实说，而
 * 不是消失。窗口一开它就不再被报告，倒计时靠丢掉这次拒绝来结束它（`refreshTick`）。
 *
 * `wanted` 对 `covered` 使一次被截断的刷新保持诚实：端点限定了单次尝试能点名的线路条数，
 * 所以读得更多的界面只刷新了它最前面的几行，说出来就是「一次部分刷新」与「谎称一次完整刷新」
 * 的分别。
 *
 * `targetsRead` 是列表自己的状态，不是界面的：空的 `wanted` 既可能是列表答了却没点名任何
 * 可重读的线路，也可能是没人读过这个列表 —— 后者是关于没人取得过的行的主张。`false` 在这里
 * 什么都不陈述。
 */
export function refreshStatusTextOf(params: {
  inFlight: boolean
  outcome: RefreshOutcome | null
  waitSeconds: number
  wanted: number
  covered: number
  /** 这些目标所依据的列表是否真的被读过。 */
  targetsRead: boolean
}): RefreshStatusText | null {
  if (params.inFlight) return { announcement: '正在刷新…', detail: '' }
  // 列表里没有可重读的东西：控件照实说，而不是干占位置。
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
 * 两种排序的最终决胜：创建时刻，升序。
 *
 * ISO-8601 字符串按字典序即时间序，所以不需要解析日期。决胜只与字段一样好：没有日期的行键
 * 到 ''，排在每个真实时刻之前，而 PostgreSQL 的 `ASC` 把 NULL 放在最后。
 */
function compareCreatedAt(a: UserFavoriteLine, b: UserFavoriteLine): number {
  const left = a.createdAt ?? ''
  const right = b.createdAt ?? ''
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 首页列表的唯一顺序：置顶胜出，然后是存储位置，最后是创建时刻。与服务端的
 * `ORDER BY is_pinned DESC, display_order ASC, created_at ASC` 逐关键字一致，使一次乐观
 * 写入把卡片放在下一次拉取会放的地方。
 *
 * 置顶是铺在这个顺序「之上」的一种状态，绝不是顺序里的一个位置：这里不重写 `displayOrder`，
 * 所以取消置顶会把该行放回它自己的格子，而不是重排到最前面。
 */
function orderFavorites(rows: UserFavoriteLine[]): UserFavoriteLine[] {
  return [...rows].sort((a, b) =>
    Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))
    || (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    || compareCreatedAt(a, b))
}

/**
 * 存储顺序：位置决定，然后是创建时刻。置顶在这里根本不是关键字。
 *
 * 刻意与 `orderFavorites` 分开 —— 两者答的是不同的问题。这个是用户编辑过、设置页显示的顺序；
 * 那个是首页列表呈现它的方式。由 store 数组推出设置页的列表，会把置顶的覆盖层显示成位置。
 *
 * `(displayOrder ASC, createdAt ASC)` 恰是服务端 `ORDER BY` 与置顶无关的那一段尾巴。两个
 * 关键字都必要：位置并不唯一（重新关注会复用一个），而没有时刻时并列会继承输入顺序 —— 即
 * 服务端交来的置顶优先数组 —— 于是在一个纯粹的顺序编辑器里，置顶会决定一个位置。
 */
function orderByPosition(rows: UserFavoriteLine[]): UserFavoriteLine[] {
  return [...rows].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    || compareCreatedAt(a, b))
}

/**
 * 移动一行，并给整个列表盖上连续的位置（0..n-1）—— 被置顶的行也在内，因为置顶是铺在顺序上
 * 的状态，绝不是对它的豁免。
 *
 * `from` 与 `to` 索引的是移动之前的列表，这也正是一次拖拽所报告的：`to` 是被移动行占据
 * 的格子，中间的行随之顺移。每行都以新对象返回，只重写它的位置；置顶与其余内容原样随行。
 *
 * 越界的索引返回原样的副本，所以一次坏调用绝不会给已经存对位置的行重新编号。
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
  const isRefreshingLive = shallowRef(false)
  /**
 * 上一次线路读取落在两种缺席中的哪一种，或在线路加载成功时为 null。
 *
 * 一个具名状态，不是服务端自己的错误串：显示它的那个页面才是措辞它的地方
 * （`line-load-state.ts`）—— 而且「没有这条线路」与「这次加载失败了」是两个事实，其中只有
 * 一个配得上重试。
 */
  const loadFailure = shallowRef<LineLoadState | null>(null)
  /**
 * 服务端模拟开关（`TRANSIT_SIMULATION`）。为真时牌子上渲染的是生成的车，所以每个界面都
 * 必须把它标注出来。
 */
  const simulationEnabled = shallowRef(false)
  /**
 * F10 记录的链路，按服务端存储它们的顺序（`display_order ASC, created_at ASC`）。设置页的
 * 链路编辑器读写；链路页的结论来自它自己的端点，所以这份列表是记录本身，而不是从记录得出的
 * 任何答案。
 */
  const commuteChains = shallowRef<CommuteChain[]>([])

  const refreshInFlight = shallowRef(false)
  const refreshOutcome = shallowRef<RefreshOutcome | null>(null)
  const refreshNextAllowedAt = shallowRef<number | null>(null)
  const refreshRetryAfterSeconds = shallowRef<number | null>(null)
  const refreshAnsweredAt = shallowRef<number | null>(null)
  const refreshReading = shallowRef<RefreshReading | null>(null)
  const refreshNow = shallowRef(Date.now())

  /**
 * 所述窗口打开的时刻 —— 服务端的截止时刻与它送来的时长里较晚的那个，使一个与服务端不一致的
 * 时钟不能把一个关着的窗口变成「无需等待」。
 */
  const refreshWaitUntil = computed(() => refreshWaitUntilOf({
    nextAllowedAt: refreshNextAllowedAt.value,
    retryAfterSeconds: refreshRetryAfterSeconds.value,
    answeredAt: refreshAnsweredAt.value,
  }))

  const refreshWaitSecondsLeft = computed(() =>
    refreshWaitSeconds(refreshWaitUntil.value, refreshNow.value))

  /**
 * 只推动倒计时的那根指针，别的什么都不做。
 *
 * 不是数据定时器：它不取任何东西，只在用户刚花掉的那个窗口倒计时期间运行，并在窗口打开的那
 * 一刻停掉自己 —— 所以它永远不会变成产品排除的那种常开 tick。
 */
  const refreshTick = useIntervalFn(() => {
    const now = Date.now()
    // 每次 tick 都推动指针，等待不会冻在一个过期的秒数上。
    refreshNow.value = now
    if (refreshCountdownOpen(refreshWaitUntil.value, now)) return
    // 没有可数的了：窗口已开，所以 ticker 停下，而不是空转到下一次按压重启它。拒绝只在窗口
    // 关着时报告，所以是这里结束它 —— 读数结束不了，因为「已刷新」说的是界面仍持有的数据。
    refreshTick.pause()
    if (refreshOutcome.value === 'throttled') refreshOutcome.value = null
  }, 1000, { immediate: false })

  /**
 * 把倒计时对准这次按压刚收到的应答，并且只在它所述窗口仍关着时才数。
 *
 * 不管还有没有窗口可数，指针都要动：一个在它所带截止时刻已过之后才到的拒绝 —— 也就是落在
 * 窗口最后一趟往返里的按压 —— 否则会从上一个倒计时停下的时刻、或本 store 首次绘制起算，那
 * 是一个用户的按压没有设定的第二个时钟。
 */
  function resumeRefreshTick(): void {
    const now = Date.now()
    refreshNow.value = now
    if (refreshCountdownOpen(refreshWaitUntil.value, now)) refreshTick.resume()
  }

  /**
 * 手动刷新（F11）。两个入口都调用这一个 action：首页点名它每张卡片正在读的线路，线路页点名
 * 它显示的那一条。
 *
 * 解析为「这一次调用」是怎么结束的，或在一次请求都没发出时为 null —— 已经有一次在进行，或
 * 界面没有点名任何可重读的线路。
 *
 * 窗口是服务端的，所以一次被拒的按压像其他答案一样被报告，而不是在这里被拦下。没有读数会不
 * 经端点自己的说明就到达这一侧：时刻与种类都来自应答，到达时什么都不盖本机时钟的戳。
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
      // 什么都没读到，窗口也无从得知：控件报连接断开，而不是报一个它看不见的状态。
      refreshOutcome.value = 'offline'
    }
    finally {
      refreshInFlight.value = false
    }
    return refreshOutcome.value
  }

  /**
 * 每一条关注线路，按存储顺序 —— 一份所有城市共用的列表，置顶刻意不施加于它。
 *
 * 这是设置页显示与编辑的顺序。store 的 `favorites` 数组携带的是首页列表的呈现（置顶在前），
 * 渲染那个数组的界面会把置顶的覆盖层读成位置，并与一次拖拽即将写入的东西不一致。
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
      // 让标志保持关闭：一次失败的探测不能声称实时数据是模拟的。
    }
  }

  let socket: WebSocket | null = null
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
 * 把存储的关注线路读进 store。只有服务端确实交回了一个列表时才解析为 true，使一个不能丢掉
 * 手上列表的调用方能分辨真答案与一次失败的探测。
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
      // 落空：没有可信任的列表。
    }
    return false
  }

  /**
 * 读取存储的关注线路，并回答服务端是否确实交回了一个列表。
 *
 * 读取失败时数组依然是空的 —— 一份读不到的列表留下的就是这个 —— 但这次失败除了被记下也被
 * 返回了：设置页的索引行把本域的当前条数当事实陈述，而取自一份读不到的列表的条数会是没人取得
 * 过的数字。`fetchCommuteChains` 已经是这样回答的，于是设置页索引需要的两次读取自我报告的
 * 方式一致。
 */
  async function fetchFavorites(): Promise<boolean> {
    const answered = await loadFavorites()
    if (!answered) {
      favorites.value = []
    }
    return answered
  }

  /**
 * 搜索按「线路」返回条目，两个方向都挂在上面 —— 用户关注的是线路，不是一个方向。
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
 * 清掉线路详情界面的数据。
 *
 * isLoading 刻意留为 true：界面下次挂载时，首次绘制读到 detail=null + isLoading=true 而显示
 * 加载态，而不是在 loadLine() 完成前闪一下「线路不存在」那个分支。
 *
 * 切换上/下行不会卸载界面（同一个路由记录，Vue Router 沿用实例），这正是这段代码不进那次
 * 转换的原因。
 */
  function resetLineData(): void {
    currentLineDetail.value = null
    currentLiveStatus.value = null
    loadFailure.value = null
    isLoading.value = true
  }

  /**
 * 重新读取当前在屏线路的实时状态。
 *
 * 一次读取，不是一个刷新入口：它要的是服务端已经持有的东西，缓存尚温时不花自己的调用。它跟
 * 随着一次手动刷新（端点重读来源，这里显示结果），也是点按一站所触发的东西 —— 连静态详情一
 * 起重取会重建报站板，扰动用户正在看的那张图。
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
      // 刷新失败时保留现有数据，而不是把界面清空。
      if (json.success && json.data) {
        currentLiveStatus.value = json.data
      }
    }
    catch {
      // 忽略：WS 推送本来就会让界面保持新鲜。
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
      // 详情读取的 HTTP 状态被保留下来，而不只是它的正文：它是唯一能把「线路不存在」（404，
      // 路由自己的拒绝）与「一次失败、可能稍后成功的读取」分开的东西。所以随行的是状态，
      // 措辞来自 `@/line-load-state`。
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
        // 没有详情回来：要么线路不存在，要么读取失败。这是两个事实，页面把它们分开措辞，所以是哪
        // 一种以状态随行，而不是用一句话盖住两者。
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
          // 同时匹配 lineId 与 direction：一条地铁线在一个 lineId 下服务两个方向，只匹配 lineId
          // 会把反方向的车画到当前界面上。
          if (msg.lineId !== detail.lineId) return
          const msgDir = typeof msg.direction === 'number' ? msg.direction : detail.direction
          if (msgDir !== detail.direction) return
          currentLiveStatus.value = msg.status
        }
        catch {
          // 忽略畸形的 WS 帧。
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
      // WS 错误。
    }
  }

  function sendUnsubscribe(lineId: string, direction: number): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: 'unsubscribe', lineId, direction }))
    }
  }

  function subscribeWs(lineId: string, direction: number = 0, cityCode?: string): void {
    // 离开另一条线路/另一个方向：停掉它在服务端的轮询，免得继续为一个用户已经离开的界面推更新。
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
 * 关注一条线路，并回答「这一次调用」是不是关注它的那一次。
 *
 * `false` 意为该线路已被关注：服务端以 `alreadyFollowed` 连同持有它的那一行作答（同一条
 * 线路的两个方向是一个关注，所以第二次关注不是一张新卡片，也绝不能被报成一张）。那一行仍会
 * 被就地调谐 —— 界面上自己的「已关注」标签就是这样变正确的 —— 但不追加任何东西，也不声称
 * 成功。
 */
  async function addFavorite(item: {
    lineId: string
    lineName: string
    preferredDirection?: number
    reverseLineId?: string
    cityCode?: string
  }): Promise<boolean> {
    // 下一个空位是「持有的最高位置」再往前一个，而不是「行数」再往前一个：一旦有行被取消关注，
    // 位置就不再连续，用行数会重发一个别的行还占着的位置，把两者并列。
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

    // 服务端把重新关注的线路并进已有的行，所以就地替换而不是追加一张重复的卡片。重新赋值数组：
    // `favorites` 是 shallowRef，改元素或就地 push 不会触发任何订阅者。
    const reconcile = (saved: UserFavoriteLine): void => {
      const idx = favorites.value.findIndex(f => f.id === saved.id)
      favorites.value = idx >= 0
        ? favorites.value.map((f, i) => (i === idx ? saved : f))
        : [...favorites.value, saved]
    }

    if (json.alreadyFollowed) {
      // 一次不是失败的拒绝：该线路确实被关注了，被服务端点名的那一行关注着它。没有 `data` 就
      // 没有可调谐的东西，于是结局保持未知，而不是往哪边假设。
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
 * 修改一个关注的一个通勤口（早/晚）。
 *
 * `undefined` 不动某个字段，`null` 清掉它 —— 服务端把同一个区分映射到它的 SQL 上。一个口
 * 同时携带它的方向与它的上车点；在某个方向在屏时设置上车点的调用方（线路详情弹层）一次写两
 * 者，于是一个上车点永远不会没有给它站序的那个方向。
 *
 * 上车点以 (站名, 站序) 这一「对」写入 —— 服务端拒绝落单的一半，因为光有站名定位不回某个方向
 * 的站表（同名站可以站在不止一个站序上）。清除时两半一起送 null，行就不能在清掉的名字旁边留
 * 一个孤儿站序。
 */
  async function updateCommuteSlot(
    favoriteId: string,
    purpose: 'morning' | 'evening',
    patch: { direction?: number | null, stop?: { name: string, order: number } | null },
  ): Promise<void> {
    const target = favorites.value.find(f => f.id === favoriteId)
    if (!target) return

    const body: Record<string, string | number | null> = {}
    if (patch.direction !== undefined) {
      const key = purpose === 'morning' ? 'morningDirection' : 'eveningDirection'
      body[key] = patch.direction
    }
    if (patch.stop !== undefined) {
      const nameKey = purpose === 'morning' ? 'morningStopName' : 'eveningStopName'
      const orderKey = purpose === 'morning' ? 'morningStopOrder' : 'eveningStopOrder'
      // 两半一起走，清除时也一样：那两列是一个站的同一身份，只写其中一个正是这段代码关掉的缺陷。
      body[nameKey] = patch.stop === null ? null : patch.stop.name
      body[orderKey] = patch.stop === null ? null : patch.stop.order
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
    // 重新赋值而不是就地修改：`favorites` 是 shallowRef。
    favorites.value = favorites.value.map(f => (f.id === saved.id ? saved : f))
  }

  /**
 * 只设置或清除一个通勤口的上车点（方向原样）。
 *
 * 值是选择器自己的形状：一个站名与它的站序，或 null 表示清除。没有站序的选择在这里就被拒绝，
 * 而不是送出去：在那个方向上同名站不止一个时，一个站名什么都定位不了，服务端也会（理应）拒绝
 * 这次写入 —— 与其把 400 往返进面板，不如先说明原因。
 */
  async function setBoardStop(
    favoriteId: string,
    purpose: 'morning' | 'evening',
    stop: { name: string, order: number | null } | null,
  ): Promise<void> {
    if (stop === null) {
      await updateCommuteSlot(favoriteId, purpose, { stop: null })
      return
    }
    const { name, order } = stop
    if (order === null) {
      throw new Error('该站名在本方向有多个同名站，无法确定是哪一站，请选择一个具体的站点')
    }
    await updateCommuteSlot(favoriteId, purpose, { stop: { name, order } })
  }

  /**
 * 把一条线路钉到首页列表顶部，或取消钉住 —— 首页的入口、标记与取消控件都搭在这一个动作上。
 *
 * 乐观：写入落定之前卡片已在点按所说的位置，写入失败时原样恢复先前的列表，并原样重抛服务端
 * 自己的消息，让界面能说明原因。
 *
 * 只允许一条线路被钉住（该列上的部分唯一索引），所以一次钉住在同一趟里清掉上一条 —— 与服务端
 * 跑的是同一个单钉事务。取消钉住只动那个标志，这也正是让该行落回它自己 `displayOrder` 的原因。
 */
  async function togglePin(favoriteId: string): Promise<void> {
    const target = favorites.value.find(f => f.id === favoriteId)
    // 我们没持有的 id 是空操作：绝不 PATCH 一个列表显示不出来的行。
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
      // 重新赋值而不是就地修改：`favorites` 是 shallowRef。
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
 * 持久化一次拖放：`movedId` 占据 `anchorId` 所在的格子。
 *
 * 两者用名字而非下标，因为顺序是一份横跨每个城市每条关注线路的「一份」列表。只显示一个城市的
 * 界面报告的是它看得见的两行之间的一次拖放，而把这两行对着整份列表解析，正是让它看不见的行保
 * 持相对位置、而不是被一个城市内编号覆盖的原因。
 *
 * 位置真的变了的行各来一个 PATCH，全部同时在途；已经存对位置的行不重发。
 *
 * 这一批是「落定」而不是「赛跑」，失败时与服务端对账而不是恢复快照：逐行的 PATCH 在服务端不是
 * 原子的，所以第一次拒绝可能已经让相邻行写进去了。那时快照会报出一个服务端并不持有的顺序 ——
 * 恢复本身就是那个缺陷。重读存储顺序使「看到的」就是「存着的」；快照只是一个重读也没拿到列表
 * 时的兜底。两条路都原样重抛服务端的原因。
 *
 * 留在身后的东西按首页列表排序（置顶在前，其余由位置与创建时刻决定）；`favoriteOrder` 则单独
 * 报告位置与时刻。
 */
  async function moveFavorite(movedId: string, anchorId: string): Promise<void> {
    const ordered = orderByPosition(favorites.value)
    const from = ordered.findIndex(f => f.id === movedId)
    const to = ordered.findIndex(f => f.id === anchorId)
    if (from < 0 || to < 0 || from === to) return

    const next = reorder(ordered, from, to)
    const was = new Map(ordered.map(f => [f.id, f.displayOrder ?? 0]))
    const changed = next.filter(f => f.id !== undefined && was.get(f.id) !== f.displayOrder)
    // 每一行都已经带着它要落到的位置：没有要写的。
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
      // 重新赋值而不是就地修改：`favorites` 是 shallowRef。
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
 * F10 的链路记录（见 `GET /api/transit/commute-chains`）。
 *
 * 只有服务端确实交回了一个列表时才解析为 true，使调用方能分辨一个真（可能为空的）答案与一次
 * 失败的探测 —— 设置页的卡片对后者显示「读取失败」、对前者显示「还没有录入」，两者不能并成
 * 一个。
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
      // 落空：没有可信任的列表。
    }
    return false
  }

  /**
 * 写一条链路 —— 没给 id 是新建，否则是编辑。
 *
 * `legs` 作为一个值写入，与请求携带它的方式完全一致：一条链路就是它的几段，所以替换它们就是
 * 替换它的实质。数组自己的顺序就是次序 —— `seq` 是服务端的，从它收到的顺序写出，编辑器从不
 * 发送它。
 *
 * 拒绝是服务端自己的消息，原样重抛而不是替换掉：这份契约的 400 会点名它没过的规则。
 */
  async function saveCommuteChain(
    id: string | null,
    write: CommuteChainWrite,
  ): Promise<CommuteChain> {
    // 新建的链路取「持有的最高位置」再往前一个，绝不是「行数」再往前一个 —— 后者会重发一个被删行
    // 的后继还占着的位置。
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
    // 重新赋值而不是就地修改：`commuteChains` 是 shallowRef。
    const index = commuteChains.value.findIndex(chain => chain.id === saved.id)
    commuteChains.value = index >= 0
      ? commuteChains.value.map((chain, at) => (at === index ? saved : chain))
      : [...commuteChains.value, saved]
    return saved
  }

  /**
 * 删掉一条链路记录。
 *
 * 刻意不做乐观更新：这一行是少数几行之一，请求只有一趟往返，而一次「删了又恢复」的行会闪一下
 * 链路页唯一的事实来源。
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
