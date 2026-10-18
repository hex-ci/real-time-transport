import type { DayTimetable, DayType, StationTimetable } from './station-timetable.js'
import { serviceWindowOf } from './station-timetable.js'

/**
 * 一条线路、一个方向、一个日型的时刻表缓存载荷。
 *
 * 按线路整条存：引擎取一条线时要全部站点（站台列表、动画、到站预测），
 * 按站拆行只会让装载变成几十次小查询。
 */
export interface SubwayTimetableStation {
  name: string
  pStopId: number
  /** 小时（0-23，字符串键）→ 该小时的到站分钟 */
  departures: Record<string, number[]>
}

export interface SubwayTimetablePayload {
  lineName: string
  /** 该方向的终点，如「开往环球度假区」。 */
  directionName: string
  /** 按该方向的行车顺序排列。 */
  stations: SubwayTimetableStation[]
}

/** 与 `subway_timetable_cache` 一行同形；`fetchedAt` 为 epoch 毫秒。 */
export interface SubwayTimetableCacheRow {
  cityCode: string
  lineId: string
  subLineId: number
  /** 应用侧方向 0/1。 */
  direction: number
  dayType: DayType
  /** 抓取对应的运营日，YYYY-MM-DD。 */
  serviceDate: string
  payload: SubwayTimetablePayload
  fetchedAt: number
}

function isMinuteList(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every(m => Number.isInteger(m) && m >= 0 && m <= 59)
}

/**
 * 读回校验：缓存里的坏行不能被当成一张合法的表交给引擎。
 * 只判「形状与取值」，不判业务（不检查首末班、不检查车次连续性）。
 */
export function isSubwayTimetablePayload(value: unknown): value is SubwayTimetablePayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<SubwayTimetablePayload>
  if (typeof payload.lineName !== 'string' || payload.lineName.length === 0) return false
  if (typeof payload.directionName !== 'string' || payload.directionName.length === 0) return false
  if (!Array.isArray(payload.stations) || payload.stations.length === 0) return false

  return payload.stations.every((station) => {
    if (!station || typeof station !== 'object') return false
    const s = station as Partial<SubwayTimetableStation>
    if (typeof s.name !== 'string' || s.name.length === 0) return false
    if (!Number.isInteger(s.pStopId) || (s.pStopId as number) <= 0) return false
    if (!s.departures || typeof s.departures !== 'object' || Array.isArray(s.departures)) return false

    return Object.entries(s.departures).every(([hour, minutes]) => {
      const h = Number(hour)
      return Number.isInteger(h) && h >= 0 && h <= 23 && isMinuteList(minutes)
    })
  })
}

/**
 * 缓存行 → 引擎消费的 `StationTimetable[]`。
 *
 * 行是按「方向」存的，这里按线路 + 站名合并两个方向；只填该行自己的日型，
 * 另一个日型保持缺省（查询侧会回落到推演，绝不拿另一天顶替）。
 * 坏掉的行在这里丢弃，不进入内存索引。
 */
export function isCompleteSubwayTimetableRow(row: SubwayTimetableCacheRow): boolean {
  if (!isSubwayTimetablePayload(row.payload)) return false
  return row.payload.stations.every(station =>
    Object.values(station.departures).some(minutes => minutes.length > 0),
  )
}

export function timetablesFromCacheRows(rows: SubwayTimetableCacheRow[]): StationTimetable[] {
  const byStation = new Map<string, StationTimetable>()

  for (const row of rows) {
    // 一张有站点没有发车的表是残缺表（抓取时该站已收班），整行不用；
    // 让该方向回落到推演，而不是答「精确时刻表、今天没车」。
    if (!isCompleteSubwayTimetableRow(row)) continue

    for (const station of row.payload.stations) {
      const key = `${row.lineId}::${station.name}`
      let timetable = byStation.get(key)
      if (!timetable) {
        timetable = {
          lineId: row.lineId,
          lineName: row.payload.lineName,
          cityCode: row.cityCode,
          stationName: station.name,
          sourceNote: '车来了官方时刻表',
          directions: {},
        }
        byStation.set(key, timetable)
      }

      const directionKey = String(row.direction)
      const direction = timetable.directions[directionKey] ?? { name: row.payload.directionName }
      direction[row.dayType] = dayTimetableFromDepartures(station.departures)
      timetable.directions[directionKey] = direction
    }
  }

  return [...byStation.values()]
}

/** 由发车分钟反推首末班；空表返回空字符串，不发明时间。 */
export function dayTimetableFromDepartures(departures: Record<string, number[]>): DayTimetable {
  const day: DayTimetable = { first: '', last: '', note: '', departures }
  const window = serviceWindowOf(day)
  return { ...day, first: window.first, last: window.last }
}
