/**
 * 站点级精确时刻表叠加层（「增强层」）。
 *
 * 北京地铁的时刻表选择规则（官方做法）：
 *   周一至周五 → 工作日表；周六 / 周日 → 双休表。
 *   调休上班的周六/周日仍用双休表（地铁排班跟随周末客流），
 *   所以选择只看星期几，不看法定节假日状态。
 */

export interface DayTimetable {
  /** 当日首班，格式 "H:MM" 或 "HH:MM" */
  first: string
  last: string
  note: string
  /** { 小时（0-23，字符串键）: [分钟, ...] } 本站发车分钟 */
  departures: Record<string, number[]>
}

export interface DirectionTimetable {
  name: string
  workday: DayTimetable
  weekend: DayTimetable
}

export interface StationTimetable {
  lineId: string
  lineName: string
  cityCode: string
  stationName: string
  sourceNote: string
  /** 以方向字符串（"0" / "1"）为键 */
  directions: Record<string, DirectionTimetable>
}

export type DayType = 'workday' | 'weekend'

export function dayTypeForDate(d: Date): DayType {
  const day = d.getUTCDay()
  return day === 0 || day === 6 ? 'weekend' : 'workday'
}

export interface StationArrival {
  /** 发车时刻 "HH:MM"（24 小时制） */
  time: string
  secOfDay: number
  /** 相对 `nowSecOfDay` 的秒数（刚发车时可为负） */
  etaSeconds: number
}

export interface StationArrivalsResult {
  lineId: string
  stationName: string
  direction: number
  dayType: DayType
  isExact: boolean
  first: string
  last: string
  note: string
  arrivals: StationArrival[]
}

/**
 * 一个北京时间戳所属的运营日：地铁运营日
 * 从当日早班首车延续到跨 0 点的尾班，所以
 * 00:00-04:00 仍属于前一天，并选择前一天的运营表。
 */
export function operatingDateOf(bjNow: Date): Date {
  return new Date(bjNow.getTime() - 4 * 3600 * 1000)
}

/**
 * 一张表的发车时刻（按秒排序）。04:00 之前的条目是前一运营日的尾巴，
 * 统一 +24h，使时间轴连续。
 */
export function operatingDaySeconds(day: DayTimetable): number[] {
  const out: number[] = []
  for (const [hStr, mins] of Object.entries(day.departures)) {
    const h = Number(hStr)
    for (const m of mins) {
      out.push(h < 4 ? h * 3600 + m * 60 + 24 * 3600 : h * 3600 + m * 60)
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * 服务日的首班发车，按当日秒数。跨 0 点的尾班条目（hour < 4）
 * 不计入：它们属于前一个运营日，所以本日的服务
 * 从第一个早班开始。
 */
function serviceStartSeconds(day: DayTimetable): number {
  let min = Infinity
  for (const [hStr, mins] of Object.entries(day.departures)) {
    const h = Number(hStr)
    if (h < 4) continue
    for (const m of mins) min = Math.min(min, h * 3600 + m * 60)
  }
  return min
}

/**
 * 一张表自己的发车时刻所蕴含的服务窗口，用表内自己的
 * 「H:MM」写法。
 *
 * 声明的 `first` / `last` 只作为发车无法回答时的兜底：状态与到达行
 * 读的是同一批发车，二者就不可能互相矛盾。不发明任何东西 ——
 * 数值一致的表返回的正是它声明的时刻，转录数据永不改写。
 */
export function serviceWindowOf(day: DayTimetable): { first: string, last: string } {
  const times = operatingDaySeconds(day)
  const firstSec = serviceStartSeconds(day)
  const lastSec = times.length > 0 ? times[times.length - 1]! : Number.NaN

  if (!Number.isFinite(firstSec) || !Number.isFinite(lastSec)) {
    return { first: day.first, last: day.last }
  }

  return { first: clockOf(firstSec), last: clockOf(lastSec) }
}

const DAY_SECONDS = 24 * 3600

/** 运营日秒数还原为表内自己的 「H:MM」（小时不补零，与转录一致）。 */
function clockOf(sec: number): string {
  const daySec = ((sec % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS
  return `${Math.floor(daySec / 3600)}:${String(Math.floor((daySec % 3600) / 60)).padStart(2, '0')}`
}

/**
 * 只考虑当前运营日，且只在其实际运营期间。
 * 末班发出之后 —— 或首班之前 —— 结果为空：下一班属于另一个运营日，
 * 把它报成几百分之后会被读作有车在跑，而实际什么都没在跑。
 * 推演引擎在其服务窗口之外同样不报车，因此两条路径一致。
 */
export function queryStationArrivals(
  timetable: StationTimetable,
  direction: number,
  nowSecOfDay: number,
  opts: { count?: number, dayType?: DayType, now?: Date } = {},
): StationArrivalsResult | null {
  const count = opts.count ?? 6
  const dir = timetable.directions[String(direction)]
  if (!dir) return null

  const refDate = opts.now ? new Date(opts.now.getTime() + 8 * 3600 * 1000) : new Date(Date.now() + 8 * 3600 * 1000)
  const dayType = opts.dayType || dayTypeForDate(operatingDateOf(refDate))
  const day = dir[dayType]

  const arrivals: StationArrival[] = []
  const window = serviceWindowOf(day)
  if (nowSecOfDay >= serviceStartSeconds(day)) {
    for (const sec of operatingDaySeconds(day)) {
      // 30 秒宽限：刚离站的发车仍留在列表里。
      if (sec < nowSecOfDay - 30) continue
      arrivals.push(fmtSec(sec, nowSecOfDay))
      if (arrivals.length >= count) break
    }
  }

  return {
    lineId: timetable.lineId,
    stationName: timetable.stationName,
    direction,
    dayType,
    isExact: true,
    // 上面这批发车所蕴含的窗口，而不是表的声明摘要：
    // 调用方由这两个字段推导运营状态，不能与列表自相矛盾。
    // 见 `serviceWindowOf`。
    first: window.first,
    last: window.last,
    note: day.note,
    arrivals,
  }
}

function fmtSec(sec: number, nowSec: number): StationArrival {
  const daySec = sec % (24 * 3600)
  return {
    time: `${String(Math.floor(daySec / 3600)).padStart(2, '0')}:${String(Math.floor((daySec % 3600) / 60)).padStart(2, '0')}`,
    secOfDay: daySec,
    etaSeconds: Math.max(0, sec - nowSec),
  }
}

export function nextDepartureEtaSeconds(result: StationArrivalsResult | null): number | null {
  if (!result || result.arrivals.length === 0) return null
  const a = result.arrivals.find(x => x.etaSeconds > 0)
  return a ? a.etaSeconds : null
}
