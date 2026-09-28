/**
 * 一条关注线路的每个通勤目的（上班 / 下班）当前的取值：它乘坐的方向，以及它的上车点。
 *
 * 两个页面都要这套判断，且必须是**同一套**：列表行印出的摘要说的是这一对能不能定位到本方向的
 * 站点，而编辑页要就同一对说同一句话（同名站、站序已变、不在本方向停靠各说各的）。两处各写一遍
 * 会让摘要与它旁边的编辑区对同一份存储给出两种说法。
 *
 * 取值由调用方给：列表页给**已存**的那一个，编辑页给**草稿**优先、未选过时回落到线路唯一方向的
 * 那一个（见 `favorite-draft.ts`）。故这里没有一处自己决定「用户现在选的是哪个方向」。
 */
import {
  commuteDirectionFor,
  effectiveCommuteDirection,
  placeBoardStop,
  resolveBoardStopRef,
} from '@real-time-transport/shared/line-group'
import type { BoardStopPlacement, BoardStopRef } from '@real-time-transport/shared/line-group'
import type { Station, UserFavoriteLine } from '@real-time-transport/shared'
import type { ReadValue } from '@/read-state'
import type { useLineStops } from './line-stops'
import type { StationChoice } from './types'

/**
 * 本模块需要的那几样：站点读取与方向选项。
 *
 * 收窄成结构类型而不是整个 composable，故调用方可以只建**一份** `useLineStops()` 并把同一份
 * 交给两处 —— 建第二份会让每个方向各取两次站点列表。
 */
type StopsSource = Pick<
  ReturnType<typeof useLineStops>,
  'directionLabels' | 'pinKey' | 'stopsRead' | 'stopsOf' | 'directionOptions'
>

/** 两个通勤目的，按它们在屏上的先后。 */
export const COMMUTE_PURPOSES = ['morning', 'evening'] as const

export type CommutePurpose = typeof COMMUTE_PURPOSES[number]

/**
 * 一个目的当前的取值。
 *
 * `direction` 是**生效**的方向：草稿或已存的那个选择，未选过时是这条线路唯一的方向（单向线路上
 * 没有可做的选择）。双向线路上未选过时它是 null，而 null 的意思是「还没有人说过」，不是「方向 0」。
 * `stop` 是持有的那一对 (站名, 站序)；只留了站名的旧记录其站序为 null。
 */
export interface FavoriteSlotView {
  direction: 0 | 1 | null
  stop: BoardStopRef | null
}

export function useFavoriteSlots(stops: StopsSource) {
  const { directionLabels, pinKey, stopsRead, stopsOf } = stops

  function slotView(
    fav: UserFavoriteLine,
    purpose: CommutePurpose,
    chosen: 0 | 1 | null,
  ): FavoriteSlotView {
    return {
      direction: chosen ?? effectiveCommuteDirection(fav, purpose),
      stop: resolveBoardStopRef(fav, purpose),
    }
  }

  /** 已存的那一个取值：列表行印出的摘要按它算。 */
  function storedSlot(fav: UserFavoriteLine, purpose: CommutePurpose): FavoriteSlotView {
    return slotView(fav, purpose, commuteDirectionFor(fav, purpose))
  }

  /** 某个目的乘坐的方向，由用户选定；在他们挑之前为 null。 */
  function chosenDirection(fav: UserFavoriteLine, purpose: CommutePurpose): 0 | 1 | null {
    return commuteDirectionFor(fav, purpose)
  }

  /** 某个目的所乘坐方向的站点；该方向作答前为空。 */
  function purposeStations(fav: UserFavoriteLine, slot: FavoriteSlotView): Station[] {
    return stopsOfSlot(fav, slot) ?? []
  }

  /**
   * 这个目的所要的那个方向的读取状态，或 null（还没选方向：没有请求，也没有结果）。
   *
   * 面板的三种说法都从这里来，不再从「站表长不长」推：读在路上、读了但没有站、没答上来是三个
   * 不同的事实，各自的句子不同。先前用「长度是 0」当加载中，于是一个真的答了空表的方向永远停在
   * 「正在加载站点…」上 —— 那句话是关于读取的，不是关于这个方向的。
   */
  function purposeStopsRead(fav: UserFavoriteLine, slot: FavoriteSlotView): ReadValue<Station[]> | null {
    return slot.direction === null ? null : stopsRead(fav, slot.direction)
  }

  /** API 为该方向**作答**出的站点；尚未作答时为 null。 */
  function stopsOfSlot(fav: UserFavoriteLine, slot: FavoriteSlotView): Station[] | null {
    return slot.direction === null ? null : stopsOf(fav, slot.direction)
  }

  /**
   * 该目的的方向是否没有站点可提供——因为 API 已作答且一个都没列。
   *
   * 只有**答案**为真：仍在途的读取与完全没作答的读取各保留自己的措辞。「这个方向暂无站点数据」
   * 是对该方向的断言，而在它线路的详情带着空站点列表到达之前，没人做过这个断言。
   */
  function stationsUnavailable(fav: UserFavoriteLine, slot: FavoriteSlotView): boolean {
    const list = stopsOfSlot(fav, slot)
    return list !== null && list.length === 0
  }

  /**
   * 该目的已存的站落在选择器正在展示的那个方向的何处——或为何无法放在那里。
   *
   * 该站按它存储的那一对读取（站名 + 站序），并由唯一那条共享规则定位：已存的站序只定位它
   * 自己的站；而只留了站名的旧记录，仅当该站名在本方向只出现一次时才能定位，否则**不可用**
   * （绝不取首个匹配，那正是 第36站 变成 第1站 的来路）。
   * `undefined` 表示列表还没读到，那是未知而非无服务。
   */
  function boardStopPlacement(fav: UserFavoriteLine, slot: FavoriteSlotView): BoardStopPlacement {
    if (slot.direction === null || !fav.id) return placeBoardStop(undefined, slot.stop)
    // 该方向作答且没有站点：面板自己会这么说，
    // 故此处不是声称该站无服务的地方。
    if (stationsUnavailable(fav, slot)) return placeBoardStop(undefined, slot.stop)
    // 读取没答上来时 `stopsOf` 给 null，`placeBoardStop` 把它读成 not-loaded（还没有这份事实），
    // 只有真的答了才拿它那张表去定位这一对。
    return placeBoardStop(stopsOf(fav, slot.direction) ?? undefined, slot.stop)
  }

  /**
   * 面板必须就这个已存的站说什么；没有可说时为 null。
   *
   * 每个原因一句话，因为它们是不同的原因，而其中只有一个是本方向不服务的站：出现两次的站名
   * **不是**用「不在本方向停靠」来回答的（它确实停那里——两次），而列表不再持有的已存站序
   * 是一次重编号，不是无服务的站。错误的原因会把用户送去修错的东西。
   */
  function boardStopNotice(fav: UserFavoriteLine, slot: FavoriteSlotView): string | null {
    const placement = boardStopPlacement(fav, slot)
    if (placement.state === 'absent') return `「${placement.name}」不在本方向停靠，请重选`
    if (placement.state === 'stale') {
      return `「${placement.name} 第${placement.order}站」在本方向已不存在，请重选`
    }
    if (placement.state === 'ambiguous') {
      return `「${placement.name}」在本方向有 ${placement.orders.length} 站同名，无法确定是哪一站，请重选`
    }
    return null
  }

  /**
   * 已存的站作为选择器自己的值：该行持有的那一对。
   *
   * 是这一对而不是站名：仅站名无法解析回列表，而选择器的触发器读站序来说**两个**同名站里被
   * 固定的是哪一个。旧记录的站序为 null，触发器就只渲染站名——而该站名出现两次时，渲染为
   * 琥珀色，并在旁边由 `boardStopNotice` 说明原因。
   */
  function pinnedChoice(slot: FavoriteSlotView): StationChoice | null {
    return slot.stop
  }

  /**
   * 两个目的乘坐**同一**物理方向时的中性提示。
   *
   * 允许，而非阻止：线性线路上不可能（不能同时往两个方向走），但环线存在、用户可能有理由，
   * 而且下游没有东西假设两者不同。点名方向让这种重叠一眼可见，
   * 而不是留给用户去比对两个区块。
   *
   * 只有两个方向可选时才有此提示：单方向线路上同一个值就是唯一的值，
   * 故「选另一个方向」会是用户无法照做的建议。
   */
  function sameDirectionNote(
    fav: UserFavoriteLine,
    directions: Record<CommutePurpose, 0 | 1 | null>,
  ): string | null {
    if (stops.directionOptions(fav).length < 2) return null
    const { morning, evening } = directions
    if (morning === null || morning !== evening) return null
    const label = directionLabels.value[pinKey(fav.id!, morning)]
    return label
      ? `上班和下班都是「${label}」，返程通常应选另一个方向`
      : '上班和下班是同一方向，返程通常应选另一个方向'
  }

  /**
   * 每个目的一行，使列表行仍回答它存在的那个问题：首页卡会报哪几个站。
   *
   * 它**不得**做的，是把本行自己的方向定位不到的站当成已定来印：「🏠 和平东桥」放在该站名
   * 出现两次的方向旁，会在卡片说不出可行动内容时告诉用户某个站已就绪。每个原因读作它自己，
   * 而这一对只在列表确实定位到它时才印出。
   */
  function stopSummaryPart(fav: UserFavoriteLine, purpose: CommutePurpose): string | null {
    const mark = purpose === 'morning' ? '🏠' : '🏢'
    const slot = storedSlot(fav, purpose)
    if (!slot.stop) return null
    const placement = boardStopPlacement(fav, slot)
    if (placement.state === 'placed') return `${mark} ${placement.name} 第${placement.order}站`
    if (placement.state === 'ambiguous') return `${mark} ${placement.name}（同名${placement.orders.length}站）`
    if (placement.state === 'stale') return `${mark} ${placement.name} 第${placement.order}站（站序已变）`
    if (placement.state === 'absent') return `${mark} ${placement.name}（不在本方向）`
    // 还没读到：站名是该行持有的内容，而它落在哪里一无所知。
    return `${mark} ${slot.stop.name}`
  }

  /** 列表行印出的那一句：两个目的各自的一半，一个都没设置时明说。 */
  function stopSummary(fav: UserFavoriteLine): string {
    const parts = COMMUTE_PURPOSES
      .map(purpose => stopSummaryPart(fav, purpose))
      .filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(' · ') : '未设置上车点'
  }

  return {
    storedSlot,
    chosenDirection,
    purposeStations,
    purposeStopsRead,
    stationsUnavailable,
    boardStopPlacement,
    boardStopNotice,
    pinnedChoice,
    sameDirectionNote,
    stopSummaryPart,
    stopSummary,
  }
}
