import type { Station } from '@real-time-transport/shared'

/**
 * 设置 的视图模型，供通勤链路的编辑器使用。
 *
 * 引擎自己的答案类型（`CommuteChain*`）属于契约，留在原处；这里只有编辑器提供选择
 * 与回读一条已存链路所需的东西。
 */

/**
 * 所选线路的站点列表为何不在可选之列——三种不同的事实，不能措辞成同一种：
 *
 * - `ready`       列表在此，一对 (站名, 站序) 可对着它核对
 * - `loading`     还没读到，仍可能到达
 * - `unavailable` API 为本方向作答，且一个站都没列
 * - `unfollowed`  线路不在已关注线路中，故无从读到任何列表——已存链路的一段在其线路
 *                 被取消关注后落入的状态，也是唯一不会靠等待自愈的成因
 */
export type ChainStopsState = 'ready' | 'loading' | 'unavailable' | 'unfollowed'

/**
 * 一个方向被使用者声明为哪个通勤用途的方向。
 *
 * 两个用途各自一个方向，可以落在同一个方向上（同一条线路两个方向朝同一处走的走法确实存在），
 * 故三种标识都是完整的事实；`null` 是**没有这个声明**，不是「未确定」。
 */
export type CommuteRole = 'morning' | 'evening' | 'both'

/**
 * 作为**选择**的站点：它的站名**与**它在被选中的那一个线路+方向里的站序。
 *
 * 两半俱全才是一个站。线上同名站不止一个，故仅有站名定位不到某一站：以名字携带、
 * 再用 `find(name)` 解析回列表的值会静默变成该名字的**首个**出现——用户在选择器里看到
 * 他挑的那一对，而记录里是另一个，屏上也没有任何东西反驳它。故凡是选择站点之处，
 * 值都是这一对。
 */
export interface StationChoice {
  name: string
  /**
   * 该站在那一个线路+方向自己的编号里的位置；这一对只记了一半（有站名无站序）时为 null。
   * 绝不靠猜测填补。
   */
  order: number | null
}

/**
 * 站点选择器里每个站量到的**参考点**：一个已知的坐标，或为什么量不出距离。
 *
 * 参考点由链路的目的与这一段的位置决定（见 `station-distance.ts`），故本类型只说「从哪儿量」
 * 与「量不出来是哪一种不可知」，不说距离。`from` 是要印在数字里的名字（家 / 公司 /
 * 第 2 段上车站），故读法是「离{from}直线 320 米」。
 */
export type StationReference
  = | { state: 'known', from: string, lat: number, lng: number }
    | { state: 'unknown', sentence: string }

/** 一段的两个选择器各自的参考点：上车站一个、下车站一个，两者可以不同。 */
export interface StationReferences {
  board: StationReference
  alight: StationReference
}

/**
 * 一段行程可命名的线路+方向，来源是当前城市已关注的线路，逐方向一条：
 * 公交两向是两个 lineId，地铁两向对同一批站反向编号，必须逐方向挑。
 * 未关注的线路录不了 —— 刻意的边界，见 PRD F10。
 */
export interface ChainLineOption {
  /** 标识这个选项：已关注线路的 id 加上它行驶的方向。 */
  key: string
  /** 同一关注线路的两个方向共享它：排序据此成组，组内先后由链路目的决定，组间不动。 */
  lineGroupKey: string
  /** 该选项的站点列表为其编号的方向；线路已被取消关注时读不出来，为 null。 */
  direction: 0 | 1 | null
  lineId: string
  lineName: string
  cityCode: string
  /** 数据源为该方向给出的「开往 X」；它没有陈述时为 null。 */
  directionLabel: string | null
  /**
   * 使用者在关注行上为该方向声明的通勤用途。
   *
   * 只读 `morningDirection` / `eveningDirection` 这两个已存字段——没声明过就是 null，
   * 绝不从站点、编号或 `preferredDirection` 推导：那会把一个任意的物理方向冒充成他声明的走法。
   */
  commuteRole: CommuteRole | null
  /** 该方向的站点，按行驶顺序。`stops` 不为 `ready` 时为空。 */
  stations: Station[]
  stops: ChainStopsState
}
