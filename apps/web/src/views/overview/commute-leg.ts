import { placeBoardStop, resolveBoardStopRef } from '@real-time-transport/shared/line-group'
import type { BoardStopRef } from '@real-time-transport/shared/line-group'

/**
 * 一块上车点与一个方向属于哪一段通勤。
 *
 * 两段独立存储：`morning` 是早上那次，`evening` 是下午那次。
 */
export type CommutePurpose = 'morning' | 'evening'

/**
 * 读出一段通勤所需的事实，都是关注行自己的。
 *
 * 三者中的任何一个都不能用「没有返回行」替代：行缺席正是下面每个状态从卡片看过去的样子。
 */
export interface CommuteLegFacts {
  /**
 * 这一段乘坐的方向，来自 `morningDirection` / `eveningDirection` —— 经
 * `effectiveCommuteDirection`（它解析只有单个方向的线路）。用户从未选过时为 null。
 */
  direction: 0 | 1 | null
  /**
 * 一段的上车点，以它被存储的那个身份：站名「与」站序（`resolveBoardStopRef`）。光有站名
 * 定位不了一个站 —— 同名站可以在一条线上站在两个站序上 —— 所以这里携带的是一对，不是名字。
 */
  stop: BoardStopRef | null
  /**
 * 所选方向自己的站表，或该方向详情尚未加载时为 undefined。空列表是第三种事实，与「上车点
 * 缺席」不同：那个方向答了「一个站都没有」，于是关于那个上车点什么都读不出来。
 */
  stops: Array<{ name: string, order: number }> | undefined
}

/**
 * 一段通勤可能处在的状态，按首页卡片必须陈述它们的方式。
 *
 * 每一个都是关于用户配置了什么的「事实」，而每个都有不同的东西要说 —— 所以措辞随状态走，
 * 而不是随卡片的行数走。
 */
export type CommuteLegState
  = | 'leg-unset'
  /** 上车点设了、方向没设：于是读不了任何站。 */
    | 'direction-unset'
    | 'stop-unset'
  /** 方向与上车点都设了，而该方向一个站都不停。 */
    | 'stops-unavailable'
  /** 方向与上车点都设了，而该方向不停这一站。 */
    | 'stop-unserved'
  /**
 * 存储的站序不在这个方向的列表里 —— 站被重新编号了，或那个站没有了。
 * 绝不能退回到站名：那会无声地挪动用户的上车站台。
 */
    | 'stop-stale'
  /**
 * 一行只留了站名，而在那个方向上该站名不止出现一次：用户指的是哪一个无法得知，所以这一段
 * 读不出来。
 */
    | 'stop-ambiguous'
    | 'ready'

/**
 * 这一段读出的上车点，以卡片与它请求到站数据所用的 (站名, 站序) 这一对 —— 存储的上车点在
 * 所选方向里定位不到时为 null。
 *
 * 这是卡片判定它是关于哪一个实体站的「唯一」地方，它拒绝两种错法：站名不止出现一次而没存
 * 站序（无从得知），以及存的站序列表里已经没有（过期）。两者都答 null —— 绝不是该站名下的
 * 第一站。用户选了第 36 站却拿到第 1 站的步行时间与到站分钟，就是这么来的。
 */
export function commuteStopOf(
  fav: {
    morningStopName?: string
    morningStopOrder?: number | null
    eveningStopName?: string
    eveningStopOrder?: number | null
  },
  purpose: CommutePurpose,
  stops: ReadonlyArray<{ name: string, order: number }> | undefined,
): { name: string, order: number } | null {
  const placement = placeBoardStop(stops, resolveBoardStopRef(fav, purpose))
  return placement.state === 'placed' ? { name: placement.name, order: placement.order } : null
}

/**
 * 这一段处在哪个状态，或者在建立不起来时为 null —— 该方向的站表还没加载，于是无论是那个
 * 上车点还是那个方向，都还不能对着它判断。
 *
 * 顺序是设置页自己的顺序：先选方向再选上车点（一个站的编号、甚至该方向是否停靠，都取决于
 * 方向），所以两者都缺的一段报告「方向」是要先选的东西。
 */
export function commuteLegStateOf(facts: CommuteLegFacts): CommuteLegState | null {
  if (facts.direction === null) {
    return facts.stop ? 'direction-unset' : 'leg-unset'
  }
  if (!facts.stop) return 'stop-unset'
  // 未加载：卡片还在加载，而从一个没人读过的列表里说不出「不匹配」。
  if (!facts.stops) return null
  if (facts.stops.length === 0) return 'stops-unavailable'

  const placement = placeBoardStop(facts.stops, facts.stop)
  if (placement.state === 'placed') return 'ready'
  if (placement.state === 'ambiguous') return 'stop-ambiguous'
  if (placement.state === 'stale') return 'stop-stale'
  if (placement.state === 'absent') return 'stop-unserved'
  // 'unset' 到不了（上车点已设），'not-loaded' 也到不了（列表在这里是有值的）；一段谁都
  // 判断不了的通勤什么都不说，而不是猜。
  return null
}

/**
 * 该状态作为卡片显示的那一行 —— 没有话说时为 null。
 *
 * 点名「设置」是因为那块界面拥有这两个字段；没有任何状态承诺一个应用没有的控件。唯一不带它的
 * 是「该方向根本没有站点数据」，那是任何界面上的任何设置都供不出的。
 *
 * 关于读不出的上车点的两个状态，各自说出它是「哪一种」原因：「不在本方向停靠」对一个该方向
 * 停了两次的站名是假话，「站序已变」对一个从未存过站序的行也是假话。错误的原因会送用户去修错
 * 的东西。
 */
export function commuteLegNoticeOf(
  state: CommuteLegState | null,
  purpose: CommutePurpose,
): string | null {
  if (state === null || state === 'ready') return null

  const leg = purpose === 'morning' ? '上班' : '下班'
  if (state === 'leg-unset') return `未设置${leg}方向和上车点 · 在「设置」中设置`
  if (state === 'direction-unset') return `未设置${leg}方向 · 在「设置」中设置`
  if (state === 'stop-unset') return `未设置${leg}上车点 · 在「设置」中设置`
  if (state === 'stops-unavailable') return '本方向暂无站点数据，无法显示到站时间'
  if (state === 'stop-ambiguous') return `${leg}上车点有两站同名 · 在「设置」中重选`
  if (state === 'stop-stale') return `${leg}上车点站序已变 · 在「设置」中重选`
  return `${leg}上车点不在本方向停靠 · 在「设置」中重选`
}
