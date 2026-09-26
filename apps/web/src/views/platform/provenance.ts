import type { DataProvenance, DataSourceType } from '@real-time-transport/shared'
import { arrivalProvenanceOf, vehicleProvenanceOf } from '@real-time-transport/shared'

/**
 * 一行站台行携带的是哪一类数字。
 *
 * 每行各陈自己的来源：一块屏同时混着不同来源的行，列表级的词说不了几个不同的答案。
 * 没有分钟就没有标记——无分钟的行报的是运营事实，未知来源不归类，两者都返回 null，
 * 故「没有来源」绝不会读成实时。
 */
export function platformRowProvenanceOf(params: {
  dataSource: DataSourceType | null | undefined
  hasMinute: boolean
}): DataProvenance | null {
  if (!params.hasMinute) return null
  return arrivalProvenanceOf({
    vehicle: vehicleProvenanceOf(params.dataSource),
    basis: 'upstream',
  })
}
