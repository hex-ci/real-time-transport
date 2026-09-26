import type { ArrivalRow, DataProvenance } from '@real-time-transport/shared'
import { listProvenanceOf } from '@real-time-transport/shared'

/**
 * 站点面板到站列表里的 F4。
 *
 * 一个到站答案可以携带不同类型的行为：载荷送来真实车辆自己的分钟，排班引擎推演的列车紧邻。
 * `listProvenanceOf` 对此类列表答 null（一个词会对其中一部分为假），故列表什么都不陈述，
 * 而每一行各述其类；已分类的各行一致时，列表把这个词说一次（在「后续进站计划」旁）且各行不重复。
 *
 * 这两个函数与总览卡片用的是同一套回退：返回种类，措辞留在 `@/provenance-copy`，
 * 故本应用没有第二套来源词汇。
 */

/**
 * 这个列表能用一个词陈述的唯一一种类，或不能陈述时的 `null`——已分类的各行不一致，
 * 或其中没有任何一行陈述了。
 */
export function arrivalListProvenanceOf(rows: readonly ArrivalRow[]): DataProvenance | null {
  return listProvenanceOf(rows)
}

/**
 * 列表里某一行显示的种类。
 *
 * 列表已代它的已分类各行说话时为 `null`（词只在列表级显示一次）——行自己什么都没陈述时也是
 * `null`：没人分类的值绝不得借用那个漂亮的答案。
 */
export function arrivalRowProvenanceOf(
  rows: readonly ArrivalRow[],
  index: number,
): DataProvenance | null {
  if (arrivalListProvenanceOf(rows) !== null) return null
  return rows[index]?.provenance ?? null
}
