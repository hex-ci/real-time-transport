import type { ArrivalRow, DataProvenance } from '@real-time-transport/shared'
import { listProvenanceOf } from '@real-time-transport/shared'

/**
 * 总览卡片到站 feed 上的 F4。
 *
 * 一张卡片每个方向一个 feed，而一个 feed 可以携带不同种类的行：payload 送了真实车辆自己的
 * 分钟，而这个应用算出了下一辆。`listProvenanceOf` 对这样的列表答 `null` —— 一个词会对它的
 * 一部分说假话 —— 所以只渲染列表标记的卡片会什么都不显示，而实时的一分钟读起来会和算出来的
 * 一模一样。
 *
 * 这两个函数与站台弹层用的是同一套兜底：分类过的行全都一致时用列表标记，否则用每一行自己的。
 * 它们返回「种类」；措辞留在 `@/provenance-copy`，所以应用里不存在第二套来源词汇。
 */

/**
 * 这个 feed 能用词说出的那一个种类，或说不出时为 `null` —— 分类过的行不一致，或它们什么都
 * 没声明。
 */
export function cardListProvenanceOf(rows: readonly ArrivalRow[]): DataProvenance | null {
  return listProvenanceOf(rows)
}

/**
 * 列表里某一行显示的种类。
 *
 * 整个 feed 一致时，那一个词搭在「首行」（下标 0）上，那里它已经被说过一次 —— 在后续子列表
 * 里逐行重复会挤掉它本要解释的那些分钟。它搭在那里有两个条件：那一行声明了自己的种类，并且
 * 声明了一个数字。少了第一个条件，这个词会被借给唯一没说自己数字的那一行；少了第二个，它会
 * 被停在一次「正在进站」的观测上 —— 卡片对那个分支不渲染任何标记，于是这个词哪儿都到不了
 * 屏幕，而它下面编号的行全都没被解释。首行带不了它时 —— 它什么都没声明、feed 混了种类、或
 * 它是一次观测 —— 每一行都退回自己的种类，什么都没声明的行得到 `null`，绝不是那个好听的
 * 答案。
 */
export function cardRowProvenanceOf(
  rows: readonly ArrivalRow[],
  index: number,
): DataProvenance | null {
  const list = cardListProvenanceOf(rows)
  const lead = rows[0]
  if (list && lead?.provenance && !lead.isAtStation) return index === 0 ? list : null
  return rows[index]?.provenance ?? null
}
