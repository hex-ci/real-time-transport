import type { LocationQuery, LocationQueryRaw } from 'vue-router'

/**
 * 电子站牌的「临时站台」只由 URL 参数携带，不落任何存储。
 *
 * 参数是站台自身的身份（id/name/坐标），不是用户定位；城市沿用当前城市，
 * 与其它页面「当前城市」的含义一致。参数不全或非法时返回 null，页面走原有
 * 的 remembered 站台逻辑，绝不把半条记录当成一个站。
 */
const STATION_ID = 'stationId'
const STATION_NAME = 'stationName'
const LAT = 'lat'
const LNG = 'lng'

export interface TemporaryStationQuery {
  stationId: string
  stationName: string
  lat: number | null
  lng: number | null
}

export interface TemporaryStationSource {
  id: string
  name: string
  lat?: number | null
  lng?: number | null
}

const TEMPORARY_KEYS = [STATION_ID, STATION_NAME, LAT, LNG] as const

function firstText(value: LocationQuery[string] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? '').trim()
  return typeof value === 'string' ? value.trim() : ''
}

function coordinate(value: LocationQuery[string] | undefined): number | null {
  const text = firstText(value)
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** 从 `window.location.search` 读；电子站牌不依赖 Vue Router 的注入。 */
export function temporaryStationFromSearch(search: string): TemporaryStationQuery | null {
  return temporaryStationFromQuery(Object.fromEntries(new URLSearchParams(search)) as LocationQuery)
}

/** 构造临时站台的查询串；用于保留地址栏里的其它参数后写回。 */
export function temporaryStationSearchParamsOf(station: TemporaryStationSource): URLSearchParams {
  const params = new URLSearchParams()
  params.set(STATION_ID, station.id)
  params.set(STATION_NAME, station.name)
  if (typeof station.lat === 'number' && Number.isFinite(station.lat)) {
    params.set(LAT, String(station.lat))
  }
  if (typeof station.lng === 'number' && Number.isFinite(station.lng)) {
    params.set(LNG, String(station.lng))
  }
  return params
}

/** 去掉临时站台参数，保留地址栏里其它查询参数。 */
export function withoutTemporaryStationSearch(search: string): URLSearchParams {
  const params = new URLSearchParams(search)
  for (const key of TEMPORARY_KEYS) params.delete(key)
  return params
}

export function temporaryStationFromQuery(query: LocationQuery): TemporaryStationQuery | null {
  const stationId = firstText(query[STATION_ID])
  const stationName = firstText(query[STATION_NAME])
  if (!stationId || !stationName) return null
  return {
    stationId,
    stationName,
    lat: coordinate(query[LAT]),
    lng: coordinate(query[LNG]),
  }
}

export function temporaryStationQueryOf(station: TemporaryStationSource): LocationQueryRaw {
  const query: LocationQueryRaw = {
    [STATION_ID]: station.id,
    [STATION_NAME]: station.name,
  }
  if (typeof station.lat === 'number' && Number.isFinite(station.lat)) {
    query[LAT] = String(station.lat)
  }
  if (typeof station.lng === 'number' && Number.isFinite(station.lng)) {
    query[LNG] = String(station.lng)
  }
  return query
}

/** 去掉临时站台的四个参数，保留地址栏里其它查询参数。 */
export function withoutTemporaryStation(query: LocationQuery): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query }
  for (const key of TEMPORARY_KEYS) delete next[key]
  return next
}
