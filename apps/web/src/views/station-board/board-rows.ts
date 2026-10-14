import type { CongestionLevel, StationBoard, StationBoardLine, UserFavoriteLine } from '@real-time-transport/shared'
import { arrivalMinutes, effectiveCommuteDirection } from '@real-time-transport/shared'
import { distanceTextOf } from '@/distance-copy'
import { detailHrefOf } from '@/line-detail-href'

/**
 * 电子站牌屏上的一行：**一条线路的一个方向**。
 *
 * 行的存在与否与「这条线路是否被关注」无关 —— 数据源按站台作答，站台上有的车都在这儿。
 */
export interface BoardRow {
  key: string
  lineName: string
  destination: string
  isSubway: boolean
  /** 这一行的详情页地址：点进去看这条线路这个方向的全线站牌。 */
  detailHref: string
  /**
   * 这一行服务哪几腿通勤；不是关注线路、或方向没配过时为空数组。
   *
   * 它与「线路自己的静态事实」不是一类：线路的静态事实（总站数、下一站名）不随车走也不随人走，
   * 故不上屏；而「这个方向是我上班要坐的那一个」是关于**使用者**的事实，正是他要挑行时用的。
   * 这里只存「哪一腿」——措辞与色调由 `purpose-badge` 一处给出（与详情页头部同一套）。
   */
  commutePurposes: Array<'morning' | 'evening'>
  /** 最快那班的剩余分钟（`0` 即正进站）；没有在途车时为 null。 */
  etaMinutes: number | null
  /** 最快那班的到站钟点（本地 `HH:mm`），来自数据源给的绝对时刻。 */
  firstArrivalClock: string | null
  /** 后面几班的剩余分钟与钟点，按到站先后。 */
  laterMinutes: number[]
  laterClocks: string[]
  /** 最快那班那辆车自己的事实；没有车时为 `unknown` 与空标签。 */
  congestion: CongestionLevel
  tags: string[]
  /**
   * 最快那班那辆车距**本站**还有多少米；数据源没给这个读数为 null。
   *
   * 它是这一行里唯一的车辆位置事实，与剩余分钟是两种用途：分钟答「来得及吗」，
   * 距离答「它现在到哪了」。两者都由同一份读数给出，故不会互相矛盾。
   */
  distanceToStationMeters: number | null
  /**
   * 此刻没有在途车时数据源给的发车间隔预报窗口原文（如 `16:41~16:51`）；没有时为 null。
   * 它与 `etaMinutes` 是两种东西，屏上分开说。
   */
  intervalForecast: string | null
  firstBusTime: string | null
  lastBusTime: string | null
}

/** 本地钟点 `HH:mm`；顶到上一个整点是显示分钟，不是推算到站时间。 */
function clockOf(epochMs: number): string {
  const at = new Date(epochMs)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 把一次站台读数铺成屏上的行。
 *
 * 分钟是**读取那一刻**的分钟（与首页、报站屏、链路页同一口径）：它由数据源给的剩余秒数一次算出，
 * 之后不随页面停留而改写 —— 这批数字的年龄由「最后更新」那一行披露，而那正是它该被读的地方。
 * 让数字自己走，等于让一个没人重读过的读数假装它还新鲜。
 *
 * 排序就是「哪趟先来」这件事本身：有车的按最快那班升序排在前，只有发车间隔预报的其次，
 * 两者都没有的最后；同一档内按线路名稳定排序 —— 故每 12 秒的重读不会让行随意跳位
 * （数据源没给新东西时，屏上的次序保持不变）。
 */
/**
 * 这一行服务哪几腿通勤。
 *
 * 判据只有一条：使用者自己存下来的方向选择（关注线路上的 `morningDirection` / `eveningDirection`，
 * 见 `effectiveCommuteDirection`）。线路按**它自己的 lineId** 对上 —— 同一条线的两个方向是两个不同的
 * lineId，故对得上哪一条就知道是哪个方向，不靠行自己的 `direction` 字段去猜。
 * 不是关注线路、或那个方向没配过时什么都不标：绝不替使用者声明一个他没选过的方向。
 */
export function commutePurposesOf(lineId: string, favorites: UserFavoriteLine[]): Array<'morning' | 'evening'> {
  const purposes: Array<'morning' | 'evening'> = []
  for (const favorite of favorites) {
    const direction = lineId === favorite.lineId
      ? 0
      : (favorite.reverseLineId && lineId === favorite.reverseLineId ? 1 : null)
    if (direction === null) continue
    for (const purpose of ['morning', 'evening'] as const) {
      if (effectiveCommuteDirection(favorite, purpose) === direction && !purposes.includes(purpose)) {
        purposes.push(purpose)
      }
    }
  }
  return purposes
}

export function boardRowsOf(board: StationBoard, cityCode: string, favorites: UserFavoriteLine[] = []): BoardRow[] {
  const rows = board.lines.map((line: StationBoardLine): BoardRow => {
    const [first, ...later] = line.arrivals
    return {
      key: `${line.lineId}_${line.direction}`,
      lineName: line.lineName,
      destination: line.destination,
      isSubway: line.isSubway,
      detailHref: detailHrefOf(line.lineId, line.direction === 1 ? 1 : 0, cityCode),
      commutePurposes: commutePurposesOf(line.lineId, favorites),
      etaMinutes: first ? arrivalMinutes(first.remainSeconds) : null,
      firstArrivalClock: first ? clockOf(first.arriveAt) : null,
      laterMinutes: later.map(arrival => arrivalMinutes(arrival.remainSeconds)),
      laterClocks: later.map(arrival => clockOf(arrival.arriveAt)),
      congestion: first ? first.congestion : 'unknown',
      tags: first ? first.tags : [],
      distanceToStationMeters: distanceToStationOf(line),
      intervalForecast: line.intervalForecast,
      firstBusTime: line.firstBusTime,
      lastBusTime: line.lastBusTime,
    }
  })

  return rows.sort(compareBoardRows)
}

/** 该车距本站还有多少米 —— 与分钟是两种用途，故单列一格。 */
function distanceToStationOf(line: StationBoardLine): number | null {
  return line.arrivals[0]?.distanceToStationMeters ?? null
}

function compareBoardRows(a: BoardRow, b: BoardRow): number {
  const rank = (row: BoardRow): number => {
    if (row.etaMinutes !== null) return 0
    if (row.intervalForecast) return 1
    return 2
  }
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a.etaMinutes !== null && b.etaMinutes !== null && a.etaMinutes !== b.etaMinutes) {
    return a.etaMinutes - b.etaMinutes
  }
  return a.lineName.localeCompare(b.lineName)
}

/** 最快那班怎么说；没有车时 null —— 「没有这一行」由调用方决定说什么。 */
export function etaTextOf(row: BoardRow): string | null {
  if (row.etaMinutes === null) return null
  return row.etaMinutes === 0 ? '正进站' : `还有 ${row.etaMinutes} 分钟`
}

/**
 * 发车间隔预报：**标明它是预报**，且原文照说（窗口是数据源给的两个时刻，不是我们算的分钟）。
 *
 * 「多久一班」这个依据落在底下那行小字里，因为主位要留给「什么时候」—— 两件事挤在
 * 一行里，窄屏上会把左列（线路与开往）挤到折行。
 */
export function forecastTextOf(row: BoardRow): string | null {
  return row.intervalForecast ? `预报 ${row.intervalForecast}` : null
}

/**
 * 这趟车距本站还有多远 —— 与「还有几分钟」两种用途并列说。
 *
 * 措辞用项目里那一条距离规则（小于 1 公里说米、之上说公里一位小数），
 * 故它与线路详情的「最近站」、站台列表的「距你」是同一个尺度。
 */
export function distanceToStationTextOf(row: BoardRow): string | null {
  const meters = row.distanceToStationMeters
  return meters === null ? null : `距本站 ${distanceTextOf(meters)}`
}

/** 首末班：两个都给齐才说。 */
export function serviceTextOf(row: BoardRow): string | null {
  if (!row.firstBusTime || !row.lastBusTime) return null
  return `首末班 ${row.firstBusTime}–${row.lastBusTime}`
}

/**
 * 既没有在途车、又没有发车间隔预报时，主位说什么。
 *
 * 这里只说「没有可报的到站」，而这行自己的运营事实（首末班）由底下那行小字照说 ——
 * 「今天已收班」与「这一段还没发车」对等车的人是两件事，故首末班绝不缺席。
 */
export function quietTextOf(row: BoardRow): string | null {
  if (row.etaMinutes !== null || row.intervalForecast) return null
  return '暂无到站信息'
}

/**
 * 右列底下那行小字：有车时说到站钟点，没有车时（若数据源给了）说这条线自己的首末班。
 *
 * 两种内容互斥，因为它们在回答同一个问题的一半：什么时候来、以及这条线今天还开不开。
 * 只有预报的行把「多久一班」这个依据也放这儿 —— 它是预报成立的理由，与首末班同属运营事实。
 */
export function footnoteTextOf(row: BoardRow): string | null {
  if (row.etaMinutes !== null) return row.firstArrivalClock ? `${row.firstArrivalClock} 到站` : null
  const service = serviceTextOf(row)
  if (row.intervalForecast) return service ? `发车间隔 · ${service}` : '发车间隔'
  return service
}
