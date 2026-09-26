import { provenanceLabelOf } from '@/provenance-copy'
import { refreshFreshnessOf } from '@/stores/transit.store'
import type { DataProvenance } from '@real-time-transport/shared'
import type { ChainReadingView } from './types'

/**
 * 链路页上的 F4：链路陈述一个标记，或每段各陈述一个。
 *
 * 链路的答案从不是一个来源的一个数字：每段的下车分钟属于它自己的车辆，公交段可以是实时而地铁段是排班推演，
 * 引擎已按段决定。各段的种类一致时链路陈述那一个词且各段不重复；不一致时引擎对链路答 null
 * （一个词会对其中一部分为假），于是每段各述其类——一段的分钟绝不借用链路为别的段产出的数字所用的词。
 * 种类来自 shared，词来自 `@/provenance-copy`，时刻来自 store 自己的新鲜度行，
 * 故本页没有第二套来源词汇，也没有第二个时钟。
 */

/** 一段的行陈述的标记：它自己的种类，或链路已在说那个词时为 null。 */
export function legMarkOf(
  provenance: DataProvenance,
  chainProvenance: DataProvenance | null,
): string | null {
  if (chainProvenance !== null) return null
  return provenanceLabelOf(provenance)
}

/**
 * 读取行：这个答案背后的读取是何时取得的，以及它是哪种数字。
 *
 * 时刻由 F11 自己的新鲜度行措辞，故链路页与刷新控件不会把一个时刻印成两种样子。
 * 从未取得的读取没有这一行：时钟不是读取。
 */
export function chainReadingOf(params: {
  /** 引擎的 `lastUpdatedAt`；拒绝则取它被读取时的 `updatedAt`。 */
  lastUpdatedAt: number | null
  /** 引擎自己的链路级来源；各段不一致时为 null。 */
  provenance: DataProvenance | null | undefined
}): ChainReadingView | null {
  if (params.lastUpdatedAt === null) return null

  const freshness = refreshFreshnessOf({ at: params.lastUpdatedAt, dataSource: null, isDegraded: null })
  if (freshness.time === null) return null

  const mark = provenanceLabelOf(params.provenance)
  return {
    time: freshness.time,
    mark,
    text: `最后更新 ${freshness.time}${mark ? ` · ${mark}` : ''}`,
  }
}
