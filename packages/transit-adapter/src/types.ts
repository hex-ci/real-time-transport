import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveLineStatus,
} from '@real-time-transport/shared'

/**
 * 统一的交通数据源 provider 契约。
 *
 * cityCode 是车来了的城市 id（'027' = 北京，'034' = 上海 ...）。
 * 车来了实时数据未覆盖的城市（如广州 / 深圳），
 * 仍可用 `amap_<adcode>` 编码走高德静态数据的地铁推演。
 *
 * 重要（可插拔契约）：每个 provider 都必须优雅降级 ——
 * 网络失败 / 非法 id 返回 null 或 []，绝不抛异常，这样
 * TransitAggregator 才能透明地回退到下一个 provider。
 */
export interface ITransitProvider {
  readonly name: DataSourceType
  searchLines(keyword: string, cityCode?: string): Promise<LineSummary[]>
  getLineDetail(lineId: string, direction?: number, cityCode?: string): Promise<LineDetail | null>
  getLiveStatus(lineId: string, direction?: number, cityCode?: string, options?: { targetOrder?: number }): Promise<LiveLineStatus | null>
  isAvailable(): Promise<boolean>
}
