import type { OperatingState, OperatingStatus } from './schemas/transit.js'

/**
 * F3：「今天还有没有车」，以状态而非句子表达。
 * 三态（首班前 / 运营中 / 已过末班）只由线路**真实**的首末班时刻判定，别无其他依据：
 * 不用任何时钟假设（本文件没有内建的 05:30 或 23:00，时刻未知即 `unknown`，
 * 由调用方渲染该状态而不是 运营中 加一句免责）；也不猜另一端
 * （半截服务窗口仍为 `unknown`，缺失的那一端绝不用默认值补上）。
 * 运营日模型与时刻表已用的 `operatingDateOf` 同一（即 bjNow - 4h）：
 * 00:00–03:59 仍属前一运营日，时间轴为 00:00–28:00；04:00 即新运营日起点，两者必须一致。
 */

/** 运营日边界（北京时间 04:00），与 `operatingDateOf` 的 -4h 同源。 */
const OPERATING_DAY_START_SEC = 4 * 3600

const DAY_SEC = 24 * 3600

/**
 * 某瞬间落在北京运营日里的秒数（00:00–28:00）。
 * 按北京时间读取，故边界归网络而非手机时区；00:00–03:59 偏移 +24h，与该日所属的晚间连续。
 */
export function operatingDaySecondsOf(now: Date = new Date()): number {
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000)
  const secOfDay = beijing.getUTCHours() * 3600 + beijing.getUTCMinutes() * 60 + beijing.getUTCSeconds()
  return secOfDay < OPERATING_DAY_START_SEC ? secOfDay + DAY_SEC : secOfDay
}

/**
 * 上游「HH:MM」发车时刻，给出运营日秒数与 API 携带的归一化标签。
 * 非时刻一律 `null` —— 不可解析即未知，不做部分解析。
 */
function parseDeparture(time: string | null | undefined): { seconds: number, label: string } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  // 「24:00」是运营日终点（跨零点的末班如此打印），仅接受恰好 24:00：
  // 24:30 是本模型无法定位的时刻，仍算非法。
  const isDayEnd = hours === 24 && minutes === 0
  if ((hours > 23 && !isDayEnd) || minutes > 59) return null

  const seconds = hours * 3600 + minutes * 60
  return {
    // 零点后的发车属于本运营日的尾段。
    seconds: seconds < OPERATING_DAY_START_SEC ? seconds + DAY_SEC : seconds,
    label: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  }
}

export interface OperatingStatusInput {
  /** 线路（或站台）首班，「HH:MM」；未知为 '' 或 null。 */
  firstDeparture?: string | null
  /** 线路末班，「HH:MM」，可能晚于零点。 */
  lastDeparture?: string | null
  /** 当前时刻的运营日秒数，取自 `operatingDaySecondsOf`。 */
  nowSecOfDay: number
}

/**
 * 运营状态，以及据以判定它的时刻。
 * 两端边界都为闭区间：恰在首班即运营中（那趟车正在发出），恰在末班亦然。
 * `firstDeparture` / `lastDeparture` 只要已知就回报 —— 含 `unknown` 状态（其中一端可能已知）；
 * 未知时为 null，绝不用默认时刻顶替。
 */
export function operatingStatusOf(input: OperatingStatusInput): OperatingStatus {
  const first = parseDeparture(input.firstDeparture)
  const last = parseDeparture(input.lastDeparture)

  // 只有一端已知说明不了什么（服务窗口是一对）：回报已持有的值，但拒绝给出状态。
  if (!first || !last) {
    return {
      state: 'unknown',
      firstDeparture: first?.label ?? null,
      lastDeparture: last?.label ?? null,
    }
  }

  // 窗口终点不晚于起点是自相矛盾的数据，不是运营日：
  // 报 运营中 等于断言两个不可能同时为真的时刻。
  if (first.seconds >= last.seconds) {
    return { state: 'unknown', firstDeparture: first.label, lastDeparture: last.label }
  }

  const state: OperatingState = input.nowSecOfDay < first.seconds
    ? 'before_first'
    : input.nowSecOfDay > last.seconds ? 'after_last' : 'operating'

  return { state, firstDeparture: first.label, lastDeparture: last.label }
}
