import type {
  ChainMarginBand,
  CommuteChainDeduction,
  CommuteChainPurpose,
  DataProvenance,
} from '@real-time-transport/shared'

/**
 * 链路页自己的渲染模型。
 *
 * 引擎的答案是决定（从带符号余量读出的档位，或一个拒绝码），本页只读它：
 * 每个数字是引擎自己的，每个词是本页的，引擎未陈述值处模型带 null 而非替身。
 * 引擎内部的车辆 id 刻意缺席：它们决定余量属于哪一班车，那由 `margin.ts` 处理。
 */

export interface PurposeOption {
  purpose: CommuteChainPurpose
  label: string
}

/**
 * 一段换乘，如它的行所渲染。
 *
 * 这一行关于一班车，即正要上的那一班——`marginText` 除外，它只在所量的车仍在时才陈述。
 * 车已走时 `referenceGone` 为 true，`marginMinutes`/`marginText` 为 null，
 * 而 `basisText` 说明该行的数字属于下一班。
 */
export interface TransferRowView {
  seq: number
  /** 「第 2 段」——本行是哪一个换乘点。 */
  positionText: string
  lineName: string
  /** 本段余量的档位，与 `marginMinutes` 是同一个数字。 */
  band: ChainMarginBand
  bandLabel: string
  verdict: string
  /** 上的是哪一班，用使用者的说法：这一班，或下一班。 */
  vehicleText: string
  /** 要上的那班车在本站台的等待整分钟数，绝不为负。 */
  waitMinutes: number
  waitText: string
  /** 所印的余量，或不得印时的 null。 */
  marginMinutes: number | null
  marginText: string | null
  /** 本行的数字所对照之物，总是陈述。 */
  basisText: string
  referenceGone: boolean
  rideText: string
  alightText: string
  /** 本段自己数字的 F4 种类，直接来自引擎。 */
  provenance: DataProvenance
}

export interface BranchView {
  outcomeText: string
  /** 车辆与它的分钟，或两者之一的缺失——缺失也照实陈述。 */
  detailText: string
}

export interface ChainConclusionView {
  band: ChainMarginBand
  bandLabel: string
  verdict: string
  /** 链路最紧的余量，只在它量的车仍在时印。 */
  marginMinutes: number | null
  marginText: string | null
  /** 绑定余量所属的那一段。 */
  bindingSeq: number
  bindingText: string
  /** 恰在绑定余量不可解析时存在。 */
  branches: BranchView[] | null
  legs: TransferRowView[]
}

/**
 * 拒绝唯一能提供的动作，它落在设置的位置锚点行上。
 *
 * 锚点是唯一有屏幕在背后的拒绝成因，故这里是一个单成员类型：拒绝绝不提供链路录制页——
 * 拒绝不是缺失的链路，而是已记录且走不通的链路。
 */
export type RefusalAction = 'settings'

/**
 * 空态可以提供的页面，比拒绝多一个。
 *
 * 空时段有两个成因，各有自己的页面：从未保存的锚点在位置锚点页修，没人录过的链路在通勤链路页录。
 * `'chains'` 只因为那个页面存在才提供——空态不得承诺一个本构建没有的控件。
 */
export type EmptyStateAction = RefusalAction | 'chains'

export interface RefusalView {
  /** 引擎自己的码，逐字保留：本页绝不改词。 */
  reason: string
  sentence: string
  /** 「第 2 段 · 快线 1 路」；不点名任何一段的链路为 null。 */
  legText: string | null
  /** F3 的服务状态，措辞后；只给空答案关乎营运日的那些拒绝。 */
  serviceText: string | null
  action: RefusalAction | null
}

export interface ChainReadingView {
  time: string
  mark: string | null
  text: string
}

export interface ChainEmptyStateView {
  headline: string
  detail: string | null
  action: EmptyStateAction | null
}

export interface ChainCardView {
  chainId: string
  name: string
  /** 「从「家」出发」——链路自己存的起点。 */
  originText: string
  /** 有答案时的答案；链路拒绝时为 null。 */
  conclusion: ChainConclusionView | null
  /** 有拒绝时的拒绝；链路给出结论时为 null。 */
  refusal: RefusalView | null
  /**
 * F4 的链路级种类，逐字保留；各段不一致时为 null，于是每段改为陈述自己的标记。
 */
  chainProvenance: DataProvenance | null
  /** 本答案来自哪次读取；从未读取过的段为 null。 */
  reading: ChainReadingView | null
  /** 引擎的答案，逐字保留：本页自己的测试所对照之物。 */
  deduction: CommuteChainDeduction
}
