import type { CommuteChainAnchor, CommuteChainLeg, CommuteChainPurpose } from './schemas/api.js'
import type { DataProvenance, DataSourceType, OperatingStatus } from './schemas/transit.js'
import {
  DEFAULT_WAIT_TOLERANCE_MINUTES,
  arrivalMinutes,
  arrivalTrust,
} from './departure.js'
import {
  arrivalProvenanceOf,
  listProvenanceOf,
  vehicleProvenanceOf,
} from './data-provenance.js'
import type { ArrivalBasis } from './data-provenance.js'

/**
 * F10 的链路推演 —— 我出门能不能赶上换乘点那班车，只在这一处判定。
 *
 * 链由用户**记录**（线路 + 上车站 + 下车站，逐段），本应用从不规划它：
 * 没有路线规划、没有外部规划 API、也不发明接驳。本文件做的是把记录的链拿去对实时读数，
 * 回答一个问题：最紧的那次上车还剩多少余量；外加诚实答案是「不给结论」的情形。
 *
 * 覆盖每一个换乘点，且止于最后一个：故每段乘车的答案各自成立
 * （上哪辆车、在该段上车站等多久、那一次上车的余量、余量衡量的是哪辆车），
 * 而链**终止**于最后一个下车站 —— 没有目的地、没有终点之后的步行、也没有总到达时刻，
 * 因为链的起点由通勤目的决定（见 `anchorForPurpose`）而目的地从不记录。
 *
 * 以余量带位为主、分钟数同时给出（PRD F10）。两者同出一个只算一次的量 `marginMinutes`：
 * 带位是它的函数，行打印的数字也是，故一行不可能在「余量 1 分钟」旁边说 充裕。
 * 取值都用行展示的整分钟（F1 自己的规则），而不是原始秒：
 * 用旁边的数字显示不出的秒得出的结论，是同一种分歧换了个单位。
 *
 * 纯函数且同步：`now` 是参数，此处不读时钟、socket、数据库或距离。
 * 步行与骑行时长由路径服务计价并作为输入传入；用户自己的参数（等待容忍值、骑行附加）
 * 有具名默认值，因为零编造约束的是**上游数据**，不是用户自己的设置。
 *
 * 段时长全部可溯源：某路段的到达分钟是**同一辆车**在其下车站的 ETA
 * （按提供方稳定 id `LiveBusSchema.id` 找到），故公交的到达时刻是实时预测，而不是站数乘均值。
 * 地铁今天没有任何可观测车辆：其列车按时刻表以 135 秒 / 站推演，
 * 故经 F4 的 `vehicleProvenanceOf` / `arrivalProvenanceOf` 标记为 排班推演，在此永远读不成 实时。
 */

/**
 * F10：一条链的起点由通勤目的决定 —— 上班从家出发、下班从公司出发。
 *
 * 这是「起点在哪里」在本仓的**唯一**推导处：服务端按它取进入第一段的那次接驳的起点，
 * web 的空态与拒绝按它点名要在设置里修的那一行。起点因此不是链路的一列 ——
 * 一列可以被录成与目的矛盾的值（「上班·从公司出发」），而目的的函数不可能自相矛盾；
 * 服务端与页面读同一个函数，也就不会对同一条记录得出两个起点。
 */
export function anchorForPurpose(purpose: CommuteChainPurpose): CommuteChainAnchor {
  return purpose === 'morning' ? 'home' : 'work'
}

/**
 * 进入某乘车路段的接驳 —— 第一段来自链的起点（由通勤目的选定），其后是两段之间。
 * 链不存模式（接驳时长由真实站坐标计价，存一份副本只会漂移成第二个矛盾的事实），故它作为输入传入。
 */
export type ChainConnectionMode = 'walk' | 'cycle'

/**
 * 某路段的接驳没有计价时长的原因，由尝试计价而知道原因的调用方给出。
 * 引擎只见到一个事实 —— `connectionSeconds` 为 null —— 无法分辨为什么：
 * 接驳在引擎之外计价，依据的是用户出发点的真实站坐标（第一段是链的起点，即目的所定的锚点，
 * 其后是上一段离开的车站），故只有调用方能知道命中了哪一个事实。
 * 原因因此以代码传入，由引擎映射成页面读到的拒绝。
 *
 * 这些是调用方的词而不是线上的词，每个原因逐一举名，使某个拒绝码背后的集合由机器陈述而非散文。
 * 其中四个不给用户任何可做的事、共用同一个拒绝码；第五个是锚点，用户可以设置。
 * 未解析的起点永远是那个锚点：自身下车站无法定位的路段会被拒绝，而拒绝会终止链，
 * 故第一段之后的任何路段都不会由未解析的点装配而来。说不清原因的调用方就什么都不给
 * （见 `ChainLegInput.connectionUnpricedReason`）。
 *
 * - `anchor-unset`      链将要起步的那个锚点从未保存坐标，根本没有可出发的点
 * - `line-unavailable`  该路段的线路详情读不到，故其已存车站没有可定位的停靠列表
 * - `station-unlocated` 该路段已存的车站不在该路段所行方向的停靠列表中
 * - `station-without-coordinate` 该方向的停靠列表有该站但没给坐标，故没有可步行的目标点
 * - `route-unpriced`    两端都解析成功而路径服务没计价出两者之间的步行 / 骑行路线
 */
export type ChainConnectionUnpricedReason
  = | 'anchor-unset'
    | 'line-unavailable'
    | 'station-unlocated'
    | 'station-without-coordinate'
    | 'route-unpriced'

/**
 * 骑行接驳在骑行本身之外的花费：找车与停车。
 * 与 F1 的 T 同类，是用户的参数而不是读数，且 PRD F10 要求它可配置并有默认值，
 * 故每个入口都能覆盖它（`cycleExtraMinutes`，或某路段自己的 `transferExtraMinutes`）。
 * 没有任何东西从上游数据推导它。
 */
export const DEFAULT_CYCLE_EXTRA_MINUTES = 2

/**
 * 仍算 紧 而非 充裕 的最大余量。
 * 它就是 F1 的站台等待容忍值本身，不是第二个数字：容忍值同时是安全边际，
 * 故余量多于用户愿意等待的链有富余，余量不超过它的即为 紧（含容忍值本身）。
 * 默认容忍值 3 分钟时，紧 带为余量 1–3 分钟而**不是** 1–2，边界取闭区间因为 3 就是容忍值。
 * 边界偏紧的一侧，与 F1 的 `hurry` 完全一致，故单段链与 F1 不会从同一次步行和同一个 ETA 得出两种结论。
 */
export const CHAIN_TIGHT_MARGIN_MINUTES = DEFAULT_WAIT_TOLERANCE_MINUTES

/**
 * 本推演能分辨的最小余量，以整分展示。
 * 1 是由必须覆盖的情形逼出来的，不是选定的分辨率：紧 带从 1 分钟到容忍值
 * （`CHAIN_TIGHT_MARGIN_MINUTES`，默认 3），故 1 分钟必须归为 紧，
 * 于是余量 0 成为**唯一**无法给出单一答案的余量（低于它车就是走了），
 * 不可分辨带的宽度正好是一整分钟。
 *
 * 它**不是**输入的精度，也不是被展示量的分辨率：路径服务时长没有公布的精度，
 * 实时读数判定时可能已达 `STALE_ARRIVAL_SECONDS` 那么旧，地铁分钟是本应用自己的 135 秒 / 站推演。
 * 这些都不折进此处，也不得折进来 —— 那些不确定性在它是关于数据而非关于行的算术的地方披露：
 * 来源标记（每段的 `provenance`）说明每个分钟是**哪一种**，`lastUpdatedAt` 说明读数有多旧。
 * 故后来者不得为了覆盖它们而「修正」本常量把带位加宽：带位陈述行能分辨什么，
 * 标记陈述输入值多少，把两者合并会把两边都藏起来。
 */
export const CHAIN_ERROR_MAGNITUDE_MINUTES = 1

/**
 * 链的余量落在容忍值的哪一侧，按行陈述的方式。
 *
 * - `comfortable`  充裕：余量多于用户愿意等待的 —— 就是这班。
 * - `tight`        紧：在容忍值之内，含容忍值本身，即默认 3 时余量 1..3 分钟 —— 就这几分钟。
 * - `uncertain`    余量低于分辨率：两个分支，没有单一答案。
 * - `insufficient` 不足：链所对的那辆车已经走了 —— 实际是下一班。
 */
export type ChainMarginBand = 'comfortable' | 'tight' | 'uncertain' | 'insufficient'

/**
 * 为何无法推演。机器可读代码而非句子：中文措辞归 web 层，
 * 且每一个都是关于数据的**不同**事实，而不是另一些的较小版本。
 *
 * 「没有可乘的车」刻意是**四**个码而非一个：其中三个是关于服务的事实、一个是关于本应用自身读数的事实，
 * 且四者分别在各事实真正被知道的地方判定 —— 空的看板读数与「两半读数没有共同车辆」是同一个空候选列表，
 * 而「接驳期间走掉的车」与「接驳开始前就走掉的车」是同一个空上车集合，
 * 故单一代码会让链页面在其中三种情形下描述错东西。
 *
 * `leg-recorded-backwards` 刻意与 `no-shared-vehicle` 分开，因为两者指向不同的责任人：
 * 空配对通常是服务为空、或我们的两份快照对不上；而一段按记录无法乘坐的路段同样让两份读数不相交，
 * 但原因是**记录**，用户可以修 —— 把它叫做「两个读数没有对上的车」是用用户自己的录入责备本应用，
 * 且给不出任何修法。它由已存路段本身判定，在任何读数被查看之前：上游改变不了它。
 *
 * 地铁路段记录反了刻意**不是**这个码：公交两个方向是两个 lineId，地铁两个方向共用一个、
 * 对同一站反向编号 —— 故那里较小的下车站序是沿另一方向的真实乘车，
 * 装配层按相反方向读取，并把两个站序都翻译进该编号。只有记录反了的公交路段，
 * 以及任何线路上两端为**同一站**的路段，才是这个码所指的记录。
 *
 * - `no-legs`                      链没有任何乘车路段
 * - `station-unset`                某路段的上车或下车站从未选择
 * - `leg-recorded-backwards`       某路段两端是同一站，或公交路段的到达站不在上车站的下游
 * - `anchor-unset`                 链将要起步的那个锚点从未保存坐标：第一段根本没有可出发的起点
 * - `connection-unpriced`          进入某路段的接驳没有计价时长
 * - `no-live`                      某路段的线路没有实时读数
 * - `no-vehicle`                   看板读数什么都没带：没有车在开往这个上车站
 * - `no-shared-vehicle`            两份读数都作答了，但没有共同车辆 id —— 这是关于**我们读数**的事实，不是关于服务的
 * - `no-vehicle-after-connection`  用户出发时还有车要来，但接驳走完后一辆都不剩
 * - `no-vehicle-at-departure`      用户来得及出发之前，每辆车都已到过这个上车站
 * - `stale`                        某读数比 F1 的新鲜度上限更旧
 * - `degraded`                     某路段由兜底源作答
 * - `provenance-unknown`           某读数声明了本版本不认识的来源
 * - `inconsistent-live`            某车辆的下车分钟早于它自己的上车分钟
 *
 * 两个接驳码确切的原因集，陈述一次，使页面作者不必猜某个码背后是哪个事实：
 *
 *  - `anchor-unset` 只覆盖链将要起步的那个锚点，别无其他。它是接驳未计价中唯一用户可行动的原因：
 *    链的起点由目的决定而目的地从不记录，故那个锚点从未保存坐标时根本不留下可出发的点，修法在设置页。
 *    链用 F1 自己的空状态对同一事实所用的同一个词陈述它，页面可以给出同样的句子与同样的入口。
 *    反过来也成立，且靠的是**优先顺序**而不是运气：装配层在读取某路段的线路、
 *    定位车站**之前**先问锚点，故锚点从未保存的链即使其详情、停靠表或路线也会失败时仍答 `anchor-unset`。
 *    用户被告知的是他能修的原因，而不是他修不了的那个。
 *  - `connection-unpriced` 覆盖其余四个原因，每一个都不给用户任何动作：
 *    线路详情读不到（`line-unavailable`）—— 一次本应用无法完成的上游读取；
 *    已存车站不在该方向的停靠列表里（`station-unlocated`）—— 一份记录，本版本不再用那个停靠列表来读它，
 *    也不是页面能修的。让已存配对在**写入**时保持同步的是链编辑器（车站从线路自己的停靠列表里选），
 *    而 schema 只校验配对自身的一致（站名带站序，二者同在或同缺）与路段方向，
 *    它从来看不到停靠列表，故无法保证配对在列表里。
 *    或停靠列表确实有该站却没给坐标（`station-without-coordinate`）—— 记录完好，位置是上游从未给出的，
 *    故没有可步行的点，也没有任何页面能补上。或两端都解析成功而路径服务没计价出路线（`route-unpriced`）。
 *    完全说不清原因的调用方也落在这里。命中的是哪个原因由代码披露、绝不由数量披露，
 *    页面为该码写一句话，而不是假装知道是哪一个。
 *
 *    那一句话不得承诺可重试，因为这四个原因**不**共享同一持久性：
 *    未落点的站（`station-without-coordinate`）是上游**陈述**上的缺口，不是本次读取的暂时失败；
 *    而没计价出的路线（`route-unpriced`）是暂时的，下次读取可能就计价得出。
 *    「稍后重试」对后者为真、对前者没有依据，而这行无法告诉页面是哪一个。
 *    故那句话只陈述该码携带的事实 —— 这段接驳没有计价时长 —— 既不承诺重试，
 *    也不声称没有什么可等，且不给出动作，因为这些原因没有用户能做的事。
 *
 * `ChainConnectionUnpricedReason` 是调用方对这些原因的词汇；
 * 它到这些码的映射属于引擎（见 `connectionRefusalCode`），
 * 故知道原因的那一层可以精确陈述原因，而不必让每种精度都变成一个线上码。
 */
export type ChainNoConclusionReason
  = | 'no-legs'
    | 'station-unset'
    | 'leg-recorded-backwards'
    | 'anchor-unset'
    | 'connection-unpriced'
    | 'no-live'
    | 'no-vehicle'
    | 'no-shared-vehicle'
    | 'no-vehicle-after-connection'
    | 'no-vehicle-at-departure'
    | 'stale'
    | 'degraded'
    | 'provenance-unknown'
    | 'inconsistent-live'

/**
 * 一辆候选车辆，由服务端从实时读数装配。
 * 两个分钟属于**同一辆**车，故携带提供方的 id：仅看似相配的上车 ETA 与下车 ETA
 * 会让乘车时长失去意义。提供方 id 跨读取稳定（真实公交用 `LiveBusSchema.id`，
 * 地铁用生成列车自己的 id），故一辆车可以从上车站一路跟到下车站。
 */
export interface ChainLegVehicle {
  /** 提供方稳定的车辆 id（即 `LiveBusSchema.id`）。 */
  vehicleId: string
  /** 本车抵达该段**上**车站的秒数。 */
  arrivalAtBoardSeconds: number
  /** **同一辆**车抵达该段**下**车站的秒数。 */
  arrivalAtAlightSeconds: number
  /**
   * 到达分钟是怎么来的（F4 的 `ArrivalBasis`）。它限定该分钟，但不覆盖车辆：
   * 生成的车无论哪个 basis 产生它的数，都是 排班推演。
   */
  basis: ArrivalBasis
}

/**
 * 某路段的实时读数：线路自己的状态，加上在途的车辆。
 * `dataSource` / `updatedAt` / `isDegraded` 属于读数而非行 ——
 * 它们属于产生其中每辆车的那个响应，故新鲜度在此判定而不是逐候选判定。
 */
export interface ChainLegLive {
  /** 作答的来源，按线路状态的声明。 */
  dataSource: DataSourceType | null
  /** 该读数取得的瞬间（epoch 毫秒）。 */
  updatedAt: number
  /** 聚合器对「兜底源作答」的标记。 */
  isDegraded: boolean
  /** 仍在开往上车站的车辆。顺序任意，使用前排序。 */
  vehicles: readonly ChainLegVehicle[]
  /**
   * 该路段自己的线路是否在运营，按 F3 推导（`operatingStatusOf`）。
   *
   * 这是「服务状态必须支配空答案」这条规则的 F10 情形：首班前、末班后与运营日中途的
   * 「暂无来车」是三件不同的事实，只有状态能分辨它们。
   *
   * 推导用的是站台看板那一个函数 `operatingStatusOf`，故本路径不会发明第二套状态模型；
   * 但**输入**不是同一个，故两者可能对同一条线路给出不同状态：
   *
   *  - 本路段的状态来自**线路**的服务时刻，即其详情携带的首末班时间；
   *  - 看板在官方站台时刻表覆盖该站台时，用那张表自己的首末班推导，因为那是它展示的列表。
   *
   * 故存在一段真实窗口，链与看板在其中不一致。这是如实说明而非隐藏：
   * 链报的是**线路**的时刻（关于线路的事实），站台自己的表是关于站台的事实，只有看板读它。
   * 推导不花上游调用：它是该路段自身详情与时钟的函数。
   */
  operatingStatus: OperatingStatus
  /**
   * **看板**读数在两次读数按 id 匹配**之前**携带了多少辆车。
   *
   * 精确等于看板站序的 `vehicleArrivals(board)` —— 上游过滤掉已过站之后，仍要抵达该站序的行。
   * 定向读数未发布到站时间的行**照样计入**：它是真实在途车辆，缺的只是分钟
   * （本应用不再外推），把它从这个计数里丢掉会把一个有车要来的站台报成服务为空。
   * 它**不是** payload 恰好携带的每一辆车，也**不是**下车读数的行数：
   * 前者会把已过看板站序的车算进来（于是看板没计价而 payload 仍持有它），
   * 后者会算进看板读数从未携带的车 —— 两者都会把空的**服务**翻成「两个读数没有对上的车」。
   *
   * 它是区分「没有可乘的车」与「两个读数没有对上的车」的**唯一**事实：
   * 空的 `vehicles` 且没有车在途是关于服务的话，同样的空 `vehicles` 旁边却有在途车辆则是关于本应用读数的话。
   * 当看板读数的行是下车读数行的子集时它至少为 `vehicles.length`，
   * 这对**下**车站位于该路段所读方向更下游的路段成立：已存下车站序在上车站序的下游，
   * 或 —— 对反向记录的地铁路段 —— 装配层按相反方向读取时翻译出的那两个站序。
   * 这条关系对 `leg-recorded-backwards` 拒绝的情形不成立，故那些先判定。
   */
  boardVehiclesOnTheWay: number
}

/** 推演所需的一条乘车路段：已存的路段，加上为它解析出的东西。 */
export interface ChainLegInput {
  /** 已存的路段：线路，以及上 / 下车站（两者皆可空）。 */
  leg: CommuteChainLeg
  /**
   * 进入本路段的接驳秒数，由路径服务计价。无法计价时为 `null` —— 那时什么都不推演，
   * 因为接驳**就是**比较项。（F10 不存接驳：它由真实站坐标推导。）
   */
  connectionSeconds: number | null
  /**
   * 接驳为什么没有计价时长，由尝试计价的调用方给出原因。
   *
   * 只在 `connectionSeconds` 为 null 时才有意义：已计价接驳的路段没有缺失的事实要解释，
   * 故与它并列给出的原因会被忽略。调用方说不清原因时**缺省** ——
   * 那是它自己的一个状态而不是一个原因，也是在不带任何原因的情况下进入
   * `connection-unpriced` 的唯一途径。
   */
  connectionUnpricedReason?: ChainConnectionUnpricedReason
  /** 该接驳的出行方式。默认步行。 */
  connectionMode?: ChainConnectionMode
  /** 本路段的实时读数；线路未被读取时为 `null`。 */
  live: ChainLegLive | null
}

/** 推演所需的全部输入。每项都是调用方取得的事实 —— 没有字段为了便利而可选。 */
export interface CommuteChainDeductionInput {
  /** 链的乘车路段，按顺序。 */
  legs: readonly ChainLegInput[]
  /** 注入的时钟（epoch 毫秒）：新鲜度据此判定，绝不读此处的时钟。 */
  now: number
  /** 覆盖 F1 的容忍值，用于 充裕 / 紧 边界。 */
  tightMarginMinutes?: number
  /** 覆盖 `DEFAULT_CYCLE_EXTRA_MINUTES`，用于自身未配置附加时间的路段。 */
  cycleExtraMinutes?: number
}

/** 方案中的一段：所上的车，以及行展示的关于它的一切。 */
export interface ChainLegDeduction {
  /** 已存路段的 `seq`。 */
  seq: number
  lineId: string
  lineName: string
  /** 本段按方案所上的车。 */
  vehicleId: string
  /**
   * `marginMinutes` 所衡量的车辆 —— 用户出发时在该上车站**下一个**到的那辆车（参考车），
   * 单独点名是为了让余量不可能印在错误的公交旁边。
   *
   * 余量为零或正时它恰等于 `vehicleId`：参考车还没走，故它也是被上的那辆。
   * 两者在 `insufficient` 时不同 —— 参考车已走，方案是下一辆 ——
   * 而那正是否则会把「余量 -2 分」印在 `vehicleId` 旁边的行。
   *
   * 该等价关系需要就绪时刻（走完接驳后到达本段上车站）不**早于**出发时刻，即路段附加时间非负。
   * 附加时间为负会把用户放到他们出发之前的站台，让此前已走的车看起来赶得上，
   * 并把余量衡量到比它点名的车更晚的一辆上；故引擎把有效附加时间钳到 0（见 `extraMinutes`），
   * 使该等价对每个调用方都无条件成立 —— 而不只对 schema 守住了 `transferExtraMinutes` 的那些。
   */
  referenceVehicleId: string
  /** 本段到达分钟的 F4 标记。链一旦推演出来就绝不为 null。 */
  provenance: DataProvenance
  /**
   * 本路段线路的 F3 运营状态，由该段答案所依据的**同一个**读数导出：
   * 首班前 / 运营中 / 已过末班 / 未知。它随每段出行，
   * 使页面可以在几乎或完全没有来车的行旁陈述服务状态，而无需再读一次线路。
   */
  operatingStatus: OperatingStatus
  /**
   * **在上车站**的整分余裕：本车在那里自己的到达分钟，减去**用户**到那里的分钟。
   * 它是站台等待而不是「从现在起」—— 一个 5 分钟接驳后的首段、车在 12 分钟处上车，报 7；
   * 更靠后的路段报的是它前一段乘车（含其接驳）之后剩下的。永不为负：
   * 被上的车按构造就是这个用户尚未错过的第一辆（错过一辆由 `marginMinutes` 有符号陈述）。
   */
  waitMinutes: number
  /** 从现在到它抵达下车站的整分时长。 */
  alightMinutes: number
  /** 乘车的整分时长：本段到达分钟减其上车分钟。 */
  rideMinutes: number
  /**
   * 这次上车的带符号整分余量：用户出发去该站时下一个到的那辆车，减去用户到那里的时刻。
   * 负值表示那辆车已走、其下方案是下一辆；0 在误差量级之内，读作 `uncertain`。
   */
  marginMinutes: number
}

/** 不可分辨余量的一种读法。 */
export interface ChainBranch {
  /** 该读法下的车辆；后面没有车时为 `null`。 */
  vehicleId: string | null
  /** 从现在到该车抵达下车站的整分时长；未知时为 `null`。 */
  alightMinutes: number | null
}

/** 小到无法分辨的余量的两种读法 —— 赶得上就是 A 班，赶不上就是 B 班。 */
export interface ChainBranches {
  /** 链所对的那辆车赶上了。 */
  asPlanned: ChainBranch
  /** 没赶上，实际乘的是下一辆。 */
  nextVehicle: ChainBranch
}

/**
 * 推演出的链：带位、它出自的余量，以及其后的方案。
 *
 * `marginMinutes` 是**决定性**的值 —— 链中最小的余量，`band` 由它读出 ——
 * 而 `legs` 每段各自携带自己的余量，使行能指出哪次上车是紧的。
 * `branches` 恰在余量落在误差量级内时出现，也是行给出两种结果而非一种的唯一情形。
 */
export interface ChainDeduction {
  status: 'deduced'
  band: ChainMarginBand
  /** 链中最紧的余量，整分且带符号。 */
  marginMinutes: number
  /** 该余量所属路段的 `seq`。 */
  bindingSeq: number
  legs: readonly ChainLegDeduction[]
  /**
   * 整条链的一个标记；各段不一致时为 `null`，
   * 因为那时一个词会对链的一部分说谎，行改为陈述各段自己的标记。
   */
  provenance: DataProvenance | null
  /** 本推演所用的最旧读数的瞬间（epoch 毫秒）。 */
  lastUpdatedAt: number
  /** 仅当 `band` 为 `uncertain` 时出现。 */
  branches?: ChainBranches
}

/**
 * 一次拒绝是关于哪一条已记录的路段：链存它的序号、线路的已存 id 与已存名。
 *
 * 三者同行，因为它们是一个身份 ——「哪一段、哪条线」——
 * 单独任何一个对页面都无用：裸 `seq` 说不出线路，而名字在同一条链上可能重复。
 * `lineId` 在此是为了拒绝行能提供与已推演行相同的线路入口
 * （`ChainLegDeduction.lineId`）：打开被拒绝的那条线路需要它的 id，
 * 否则页面得为了知道它自己的拒绝已经点出的东西而重取一次链。
 *
 * 三者都不是关于**读数**的事实，都是关于**记录**的事实，故能为一段从未被读取的路段陈述。
 */
export interface ChainNoConclusionLeg {
  /** 已存路段的 `seq`（0 基），与链持有的完全一致。 */
  seq: number
  /** 该路段已存的 `lineId` —— 拒绝所针对的线路。 */
  lineId: string
  /** 该路段已存的线路名 —— 行用来称呼那条拒绝的线路。 */
  lineName: string
}

/**
 * 无法推演，以及是哪个事实阻止了它。
 *
 * 一次拒绝是一个码加上**哪一段**产生了它，绝不是关于答案的数量。
 * 「拒绝旁边不放任何东西」这条规则针对的是会被误认成答案的数字 —— 余量、分钟、车辆 ——
 * 而 `leg` 不是其中之一：它点出拒绝的那个换乘点（「第三段换乘点」）与其线路，
 * 两段链否则根本陈述不了它。该区分是刻意保留的：
 * `leg` 不带车站、不带分钟、不带计数，读者不得把它「补全」成那样。
 *
 * `updatedAt` 与 `operatingStatus` 是拒绝路段的自身读数 —— 它的取得时刻与 F3 服务状态 ——
 * 该路段从未被读取时缺省（`no-live`，以及每个在需要读数之前就判定出的原因）。
 * 它们描述数据而非答案：F11 的最后更新时间可以并列在拒绝旁，
 * 首班前 / 已过末班 也可以支配一个空答案，而无需第二次读取。
 */
export interface ChainNoConclusion {
  status: 'no-conclusion'
  reason: ChainNoConclusionReason
  /** 拒绝所针对的路段。仅 `no-legs` 缺省，它不点任何路段。 */
  leg?: ChainNoConclusionLeg
  /** 拒绝路段读数取得的瞬间（epoch 毫秒）；该段未被读取时缺省。 */
  updatedAt?: number
  /** 拒绝路段的线路服务状态；该段未被读取时缺省。 */
  operatingStatus?: OperatingStatus
}

export type CommuteChainDeduction = ChainDeduction | ChainNoConclusion

/**
 * 一条已记录的链及其自己的推演 —— 链页面读到的形状。
 *
 * `deduction` 是引擎自己的 `CommuteChainDeduction`，原样穿出：
 * 带位、分钟与每条「不给结论」的原因都是码，用户读到的每个字归 web 层。
 * 此处不加任何东西，因为服务端必须解释的任何东西都是对同一批读数的第二种意见。
 *
 * 链的起点刻意不出现在这里：它由 `purpose` 推出，那个用途值已随链路出行，
 * 再送一个起点字段就是同一个事实的第二个副本 —— 副本会漂移成一条「上班·从公司出发」的链。
 *
 * 链的路段行刻意**不**并列回显：每段的答案在 `deduction.legs` 里，
 * 再携带一次已存车站会诱使页面把一个记录下来的站台与一个实时分钟渲染成来自同一处。
 * 标识字段在此，因为一个答案必须说明它属于哪条已记录的链。
 */
export interface CommuteChainDeductionView {
  chainId: string
  name: string
  purpose: CommuteChainPurpose
  deduction: CommuteChainDeduction
}

/**
 * 某个通勤用途的答案：服务它的每条链，各自对同一批读数推演。
 *
 * 一次响应而非每条链一次：页面展示用户所处用途的多条链，N 个请求可能由 N 个轮询窗口服务 ——
 * 页面随后就会比较由不同新旧度读数算出的余量，而那是 PRD 排除的跳变。
 * 它也把整个用途保持在同几份 18 秒缓存上。
 *
 * `chains: []` 是真实答案 —— 该用户没有为此用途记录任何链 —— 不是错误。
 */
export interface CommuteChainDeductions {
  purpose: CommuteChainPurpose
  chains: CommuteChainDeductionView[]
}

/**
 * 余量落入的带位。
 * 导出是因为该映射**就是**行的契约：带位与印在它旁边的分钟必须是同一个数字的两种视图，
 * 持有该数字的调用方（或测试）据此校验，而不必重新推导阈值。
 */
export function chainMarginBandOf(
  marginMinutes: number,
  tightMarginMinutes: number = CHAIN_TIGHT_MARGIN_MINUTES,
): ChainMarginBand {
  // 低于该量自身的分辨率：符号无从得知。
  if (Math.abs(marginMinutes) < CHAIN_ERROR_MAGNITUDE_MINUTES) return 'uncertain'
  // 链所对的那辆车已经走了。
  if (marginMinutes < 0) return 'insufficient'
  // 在容忍值之内，F1 自己的边界：现在就走，否则赶不上。
  if (marginMinutes <= tightMarginMinutes) return 'tight'
  return 'comfortable'
}

/**
 * 把已记录的链拿去对实时读数推演，或说明为何推演不了。同步且无 I/O；规则见文件头。
 */
export function deduceCommuteChain(input: CommuteChainDeductionInput): CommuteChainDeduction {
  if (input.legs.length === 0) return noConclusion('no-legs')

  const tightMarginMinutes = input.tightMarginMinutes ?? CHAIN_TIGHT_MARGIN_MINUTES
  const cycleExtraMinutes = input.cycleExtraMinutes ?? DEFAULT_CYCLE_EXTRA_MINUTES

  const plans: LegPlan[] = []
  /** 用户可以开始本段接驳的瞬间：先是现在，其后是各下车时刻。 */
  let atSeconds = 0

  for (const [index, item] of input.legs.entries()) {
    const leg = item.leg
    /** 此处拒绝关于哪一段：已存 seq，以及线路自己的 id 与名。 */
    const who: ChainNoConclusionLeg = { seq: leg.seq ?? index, lineId: leg.lineId, lineName: leg.lineName }
    // 未设置的站是已记录链的合法状态，不是要糊过去的错误：
    // 本路段没有任何东西能在某条线路的停靠列表里定位。
    if (
      leg.boardStationName === null || leg.boardStationOrder === null
      || leg.alightStationName === null || leg.alightStationOrder === null
    ) {
      return noConclusion('station-unset', who)
    }
    // 没有接驳就没有可与出发比较的东西。它为什么缺失在此无从得知 —— 引擎从不计价接驳 ——
    // 故由尝试过的那一位陈述原因，这里把它映射成页面读到的码（见 `ChainConnectionUnpricedReason`）。
    if (item.connectionSeconds === null) {
      return noConclusion(connectionRefusalCode(item.connectionUnpricedReason), who)
    }
    // 路段必须沿线路的**一个**方向运行，只有 lineId 说明哪个方向是下游。
    // 公交两个方向是两条不同的 lineId，故已存的 `lineId` 已指明其一，下车站序低于上车站序就是用户录入反了。
    // 必须在下面空配对检查**之前**判定：上游在车辆越过请求站序后会丢掉它，
    // 故这种路段的两份定向读数没有共同 id，把它报成「两个读数没有对上的车」
    // 是用用户自己的录入责备本应用的读数，且给不出修法（见 `ChainNoConclusionReason`）。
    // 地铁上一条 lineId 承载两个方向并对同一站反向编号，故 alight < board 是沿另一方向的真实乘车：
    // 装配层按这两个站序解析出该方向，读取反方向的停靠表与实时数据并把两个站序翻译进它的编号，
    // 交到这里的读数已经是本路段自己的 —— 没有什么可拒绝的。
    // （地铁判定用的是项目自身约定而非第二个谓词：`subway_` id 前缀正是把读取路由到地铁引擎
    // 的那个约定，故两层对同一字段问同一个问题。）
    // 任何线路上在同一站上下车都不是一次乘车：公交与地铁都拒绝相等。
    // 它刻意排在接驳检查**之后**：已计价的接驳意味着两个已存车站都在停靠列表里定位到，
    // 故两个站序比较的是这条线上真实的站台。接驳无法计价的路段因此由其原因映射成的码作答
    // （见 `connectionRefusalCode`）—— 对没能定位的已存配对就是通用的 `connection-unpriced` ——
    // 那才是该路段诚实的诊断，把两端对调不是修法。
    // schema 在写入时拒绝坏记录；这里是同一条规则在读取端，针对一行已经存下来的数据。
    const runsDownstream = leg.alightStationOrder > leg.boardStationOrder
    const reverseSubway = leg.alightStationOrder < leg.boardStationOrder
      && leg.lineId.startsWith('subway_')
    if (!runsDownstream && !reverseSubway) {
      return noConclusion('leg-recorded-backwards', who)
    }

    const live = item.live
    if (live === null) return noConclusion('no-live', who)

    // F1 的新鲜度规则，复用而不重述：超过上限或由兜底源作答的读数不支持结论。
    const trust = arrivalTrust({ isDegraded: live.isDegraded, updatedAt: live.updatedAt, now: input.now })
    if (trust !== 'ok') return noConclusion(trust, who, live)

    // F4 从作答的来源判定车辆的**种类**。未知来源不产生标记，而没有标记的路段无法给出结论。
    const vehicle = vehicleProvenanceOf(live.dataSource)
    if (vehicle === null) return noConclusion('provenance-unknown', who, live)

    const candidates = [...live.vehicles].sort(byBoardArrival)
    // 没有任何配对 —— 而这一个空列表由两个不同的事实产生：看板读数什么都没带
    // （没有车在开往这个站），或它带了车而两份定向读数没有共同 id
    // （这是关于**我们读数**的事实，不是关于服务的）。它也覆盖车在但没人发布它们的时间这一情形：
    // 它们被计入了、无法计价，而「暂时无法确认可乘的班车」才是诚实的答案
    // （「暂时没有开往这一站的车」不是）。`boardVehiclesOnTheWay` 是看板读数自己的携带计数，
    // 故两者被区分开而不是塌成「没有可乘的车」。
    if (candidates.length === 0) {
      return noConclusion(live.boardVehiclesOnTheWay === 0 ? 'no-vehicle' : 'no-shared-vehicle', who, live)
    }

    // 路段自己的附加时间适用于它的接驳，无论何种方式：已存字段是该路段的 `transfer_extra_minutes` ——
    // 加在**进入**该路段的接驳上的分钟 —— 而该字段与链都不命名方式，
    // 故引擎无法知道配置的附加时间是为骑行准备的。把它也应用到步行接驳是刻意的读法，
    // 且它只会收紧余量：用户自己的数字被尊重，而不是因为它所针对的方式没有存储就被丢掉。
    // 默认附加时间则是按方式区分的 —— 只为骑行接驳加上，别无他者，因为找车与停车是骑行的成本。
    // 钳到零，因为它是成本、只会把就绪时刻推**晚**。负值会把用户放到他们出发之前的站台上，
    // 让此前已走的车看起来赶得上，并把 `marginMinutes` 衡量到一个比它点名的 `referenceVehicleId`
    // 更晚的车上 —— 破坏 `ChainLegDeduction` 陈述的那种等价。已存字段由 schema（`min(0)`）守住，
    // 但 `cycleExtraMinutes` 与直接调用方没有，故该不变量不得依赖某个调用方的 schema。
    const configuredExtraMinutes = leg.transferExtraMinutes
      ?? ((item.connectionMode ?? 'walk') === 'cycle' ? cycleExtraMinutes : 0)
    const extraMinutes = Math.max(0, configuredExtraMinutes)
    const readySeconds = atSeconds + item.connectionSeconds + extraMinutes * 60
    const atMinutes = minutesUntil(atSeconds)
    const readyMinutes = minutesUntil(readySeconds)

    // 用户出发时这个上车站下一个到的那辆车 —— F10 真正的问题（「我出门能不能赶上换乘点那班车」）
    // 针对的是它，而不是慢走后恰好赶得上的某一班。
    const referenceIndex = candidates.findIndex(v => minutesUntil(v.arrivalAtBoardSeconds) >= atMinutes)
    // 到用户出发那一刻已经没有车要来了：每一辆都已到过此站。只有用户并非从站出发的路段会是这种情形
    // （第 0 段在 0 分钟出发，故那里总有未来的车）—— 这是「都走了」的事实，不是负余量。
    if (referenceIndex < 0) return noConclusion('no-vehicle-at-departure', who, live)

    // 实际乘上的车：到用户抵达时尚未走掉的第一辆，按行展示的分钟判定。
    const boardedIndex = candidates.findIndex(v => minutesUntil(v.arrivalAtBoardSeconds) >= readyMinutes)
    // 参考车存在（上面刚断言过），故这只可能意味着它 —— 以及它后面的一切 —— 都在接驳走完前到过该站：
    // 「连走过去的那趟都赶不上」，与 'no-vehicle-at-departure' 是不同的事实。
    if (boardedIndex < 0) return noConclusion('no-vehicle-after-connection', who, live)

    const reference = candidates[referenceIndex]!
    const boarded = candidates[boardedIndex]!
    // 下车分钟不在上车分钟的下游，意味着这两个数并不描述同一趟行程；无法从它们为任何路段定价。
    if (boarded.arrivalAtAlightSeconds < boarded.arrivalAtBoardSeconds) {
      return noConclusion('inconsistent-live', who, live)
    }

    const provenance = arrivalProvenanceOf({ vehicle, basis: boarded.basis })
    // 仅为类型收窄，且不可能触发：此处 `vehicle` 非空（未知来源已在上文返回），
    // 而 `arrivalProvenanceOf` 只在 vehicle 为 null 时答 null。
    // 故 `provenance-unknown` 在此不可能出现 —— 它是上面那个来源检查的码。
    if (provenance === null) return noConclusion('provenance-unknown', who, live)

    const boardMinutes = minutesUntil(boarded.arrivalAtBoardSeconds)
    const alightMinutes = minutesUntil(boarded.arrivalAtAlightSeconds)

    plans.push({
      seq: leg.seq ?? index,
      lineId: leg.lineId,
      lineName: leg.lineName,
      boarded,
      reference,
      // 只有当方案**就是**参考车时才有意义：那是「下一辆车是不可分辨余量的第二种读法」的唯一情形。
      following: boardedIndex === referenceIndex ? (candidates[referenceIndex + 1] ?? null) : null,
      provenance,
      waitMinutes: boardMinutes - readyMinutes,
      alightMinutes,
      rideMinutes: alightMinutes - boardMinutes,
      marginMinutes: minutesUntil(reference.arrivalAtBoardSeconds) - readyMinutes,
      alightSeconds: boarded.arrivalAtAlightSeconds,
      updatedAt: live.updatedAt,
      operatingStatus: live.operatingStatus,
    })

    atSeconds = boarded.arrivalAtAlightSeconds
  }

  // 链的余量是最紧的那次上车，而不是第一次：一条链的好坏取决于它最可能错过的那个接驳。
  // 并列时保留更早的路段，故同样的输入总是指出同一次上车。
  let binding = plans[0]!
  for (const plan of plans) {
    if (plan.marginMinutes < binding.marginMinutes) binding = plan
  }

  const band = chainMarginBandOf(binding.marginMinutes, tightMarginMinutes)
  const oldest = plans.reduce((oldest, plan) => Math.min(oldest, plan.updatedAt), plans[0]!.updatedAt)

  return {
    status: 'deduced',
    band,
    marginMinutes: binding.marginMinutes,
    bindingSeq: binding.seq,
    legs: plans.map(plan => ({
      seq: plan.seq,
      lineId: plan.lineId,
      lineName: plan.lineName,
      vehicleId: plan.boarded.vehicleId,
      referenceVehicleId: plan.reference.vehicleId,
      provenance: plan.provenance,
      waitMinutes: plan.waitMinutes,
      alightMinutes: plan.alightMinutes,
      rideMinutes: plan.rideMinutes,
      marginMinutes: plan.marginMinutes,
      operatingStatus: plan.operatingStatus,
    })),
    provenance: listProvenanceOf(plans.map(plan => ({ provenance: plan.provenance }))),
    lastUpdatedAt: oldest,
    branches: band === 'uncertain' ? branchesOf(binding) : undefined,
  }
}

/** 已推演过的一段：上了什么车，以及行展示的关于它的数字。 */
interface LegPlan {
  seq: number
  lineId: string
  lineName: string
  /** 按方案所上的车。 */
  boarded: ChainLegVehicle
  /** 用户出发时上车站下一个到的那辆车 —— `marginMinutes` 所衡量的。 */
  reference: ChainLegVehicle
  following: ChainLegVehicle | null
  provenance: DataProvenance
  waitMinutes: number
  alightMinutes: number
  rideMinutes: number
  marginMinutes: number
  alightSeconds: number
  updatedAt: number
  operatingStatus: OperatingStatus
}

/**
 * 不可分辨余量的两种读法。第二种点名错过第一种时实际会乘的车，
 * 并在该读数之后没有车时什么都不说 —— 其中若有一个编造的「下一班」，
 * 正是本情形存在所要避免的虚假确定性。
 */
function branchesOf(plan: LegPlan): ChainBranches {
  const following = plan.following
  return {
    asPlanned: { vehicleId: plan.boarded.vehicleId, alightMinutes: plan.alightMinutes },
    nextVehicle: following === null
      ? { vehicleId: null, alightMinutes: null }
      : { vehicleId: following.vehicleId, alightMinutes: alightMinutesOf(following) },
  }
}

/** 该车自己的到达分钟；两种读法互相矛盾时为 `null`。 */
function alightMinutesOf(vehicle: ChainLegVehicle): number | null {
  return vehicle.arrivalAtAlightSeconds < vehicle.arrivalAtBoardSeconds
    ? null
    : minutesUntil(vehicle.arrivalAtAlightSeconds)
}

/**
 * 接驳未计价时各原因所走的拒绝码 —— 调用方能命名的每个原因一条。
 *
 * 是 `ChainConnectionUnpricedReason` 上的**全量** `Record` 而非一串比较，而这份全量**就是**契约：
 * 往该词汇里加了原因却没在此加条目是**编译**错误，而不是悄悄不再成立的散文。
 * 某个码背后的原因集因此从这张表读出（测试用 `Object.keys` 推导它），绝不手数 ——
 * 手写在 union 旁边的计数只能是一份没人校验的副本。
 *
 * 链自身起点所在的锚点（由目的决定）是用户唯一可行动的原因，故只有它走自己的码 ——
 * 与 F1 的空状态对同一事实所用的同一个词。其余每个原因
 * （今天四个：此处除 `anchor-unset` 之外的每个键），以及说不清原因的调用方，
 * 都是通用的 `connection-unpriced`：命中哪一个不改变页面能诚实写下的字，也不改变它能给出的动作；
 * 它们确切的原因集陈述在 `ChainNoConclusionReason` 上，连同支配该码那句话的持久性约束。
 */
export const CONNECTION_REFUSAL_CODES: Record<ChainConnectionUnpricedReason, ChainNoConclusionReason> = {
  'anchor-unset': 'anchor-unset',
  'line-unavailable': 'connection-unpriced',
  'station-unlocated': 'connection-unpriced',
  'station-without-coordinate': 'connection-unpriced',
  'route-unpriced': 'connection-unpriced',
}

/**
 * 接驳没有计价时长时的拒绝码。
 * 说不清原因的调用方就什么都不给，落到 `connection-unpriced` ——
 * 那是进入该码唯一不自带原因的途径。每个具名原因都由上面的 `CONNECTION_REFUSAL_CODES` 解析。
 */
function connectionRefusalCode(reason?: ChainConnectionUnpricedReason): ChainNoConclusionReason {
  return reason === undefined ? 'connection-unpriced' : CONNECTION_REFUSAL_CODES[reason]
}

/**
 * 距 `seconds` 秒之后的某个时刻还有多少整分 —— F1 自己的到车规则（`arrivalMinutes`），
 * 应用于推演中的**每一个**时刻：车抵达上车站、用户抵达上车站、车抵达下车站。
 * 对它们用同一条规则，才使余量、由它读出的带位与印在旁边的数字不会在同一行里互相矛盾。
 */
function minutesUntil(seconds: number): number {
  return arrivalMinutes(seconds)
}

/** 先按上车站到达时间、再按车辆 id 排序，使并列不取决于 payload 恰好使用的顺序。 */
function byBoardArrival(a: ChainLegVehicle, b: ChainLegVehicle): number {
  return a.arrivalAtBoardSeconds - b.arrivalAtBoardSeconds || a.vehicleId.localeCompare(b.vehicleId)
}

/**
 * 一次拒绝，带上它关于哪一段，以及 —— 该段被读过时 —— 该读数自己的取得时刻与 F3 服务状态。
 *
 * `reading` 是该路段完整的实时读数，故这两个事实作为一个整体出行，不可能从别处填进来：
 * 它们属于那个读数，不属于行。
 */
function noConclusion(
  reason: ChainNoConclusionReason,
  leg?: ChainNoConclusionLeg,
  reading?: ChainLegLive,
): ChainNoConclusion {
  return {
    status: 'no-conclusion',
    reason,
    ...(leg ? { leg } : {}),
    ...(reading ? { updatedAt: reading.updatedAt, operatingStatus: reading.operatingStatus } : {}),
  }
}
