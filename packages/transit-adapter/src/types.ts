import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveLineStatus,
} from '@real-time-transport/shared'

/**
 * Unified transport provider contract.
 *
 * cityCode is the chelaile city id ('027' = Beijing, '034' = Shanghai ...).
 * For cities not covered by chelaile realtime data (e.g. Guangzhou / Shenzhen),
 * subway simulation via Amap static data still works with `amap_<adcode>` codes.
 *
 * IMPORTANT (pluggability contract): every provider must degrade gracefully —
 * network failures / invalid ids return null or [] instead of throwing, so the
 * TransitAggregator can transparently fall back to the next provider.
 */
export interface ITransitProvider {
  readonly name: DataSourceType
  searchLines(keyword: string, cityCode?: string): Promise<LineSummary[]>
  getLineDetail(lineId: string, direction?: number, cityCode?: string): Promise<LineDetail | null>
  getLiveStatus(lineId: string, direction?: number, cityCode?: string): Promise<LiveLineStatus | null>
  isAvailable(): Promise<boolean>
}
