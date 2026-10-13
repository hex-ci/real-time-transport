import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveLineStatus,
  NearbyStop,
  StationBoardLine,
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
  /**
   * 按**站台**读取到站：一个站台上全部经过线路的到站时刻（含没被关注的线路）。
   *
   * 可选能力：只有能按站台作答的 provider 实现它。没实现的 provider 让这条能力为空，
   * 服务端据此如实说「这座城市读不了站台」，而不是拿别处的数字拼一个出来。
   */
  /**
   * 我附近的站台（按坐标问数据源要的那一份，站 id 由数据源给出）。
   *
   * 与 `getStationBoard` 一样是可选的：没有这项能力的数据源，站牌列表就只列关注线路的站表。
   * 读不到时答 null（「这座城市没有这项能力」与「这附近确实没有站台」是两件事）。
   */
  getNearbyStops?(cityCode: string, lng: number, lat: number): Promise<NearbyStop[] | null>

  getStationBoard?(stationId: string, cityCode?: string): Promise<StationBoardLine[] | null>
  isAvailable(): Promise<boolean>
}
