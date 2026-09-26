import type {
  CommuteChain,
  CommuteChainAnchor,
  CommuteChainLeg,
  CommuteChainPurpose,
} from '@real-time-transport/shared'
import type { ChainLineOption, ChainStopsState } from './types'

/**
 * 通勤链路的编辑器，作为唯一的判断处。
 *
 * 一条链路不是每个事实都要录入的：起点由通勤目的决定（上班从家出发、下班从公司出发），
 * 故草稿里没有起点 —— 录入的是名称、目的与各段乘车段。
 *
 * 「链路由使用者录入，不由系统规划」是本特性的前提，故让一条记录可读的规则住在这里，
 * 也就是用户录入之处，而不是写入边界：`CommuteChainLegSchema` 能检查一对 (站名, 站序)
 * 自洽，但它看不到线路的站点列表，故「这一对确实在站序里」只有在列表在屏上时才可检查。
 * 故下面每条规则都是 schema 陈述的同一个谓词，作用在草稿上，而每条拒绝都按它本来的事实
 * 措辞——不是笼统的「输入有误」。
 *
 * 这里不读时钟、车辆或时刻表，也不计算任何时长：编辑器记录事实，
 * 链路页才是得出结论的地方。
 */

/**
 * 一条链路为何不能没有乘车段——最后一段的移除控件禁用的原因，
 * 也是草稿在无段时到达保存处那份拒绝的实质。
 */
export const LAST_LEG_REASON = '不能删除最后一段：没有乘车段的链路给不出任何结论'

/**
 * 本版本一条链路可以携带的乘车段数。
 *
 * 数据模型按设计允许 N 段，读侧照收到的走；这是录入屏自己的边界，
 * 且编辑器会说明，而不是静默拒绝第三段。
 */
export const MAX_CHAIN_LEGS = 2

/**
 * 线路 id 是否命名一条地铁线路。
 *
 * 本项目自己的约定（`subway_` 前缀），它把一次读取路由到地铁引擎——与
 * `CommuteChainLegSchema` 的细化所施加的同一个判断，
 * 故编辑器与写入边界不会对一条线路产生分歧。
 */
export function isSubwayLineId(lineId: string): boolean {
  return lineId.startsWith('subway_')
}

/** 一段正在填写的乘车段。null 值表示「未选」，绝不是空字符串。 */
export interface ChainLegDraft {
  /** 已选的线路+方向；还没选时为 null。 */
  lineKey: string | null
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  /** null = 用户什么都没配；0 = 他配了「完全没有额外时间」。 */
  transferExtraMinutes: number | null
  /**
   * 进入本段的接驳方式。`null` = 用户没选过 —— 它是真实状态，绝不默认成步行：
   * 默认值会把「没选过」与「选了步行」变成同一个值，而屏幕上显示的应是前者。
   */
  connectionMode: 'walk' | 'cycle' | null
}

/** 一条正在填写的链路。起点不在其中：它由 `purpose` 决定。 */
export interface ChainDraft {
  name: string
  purpose: CommuteChainPurpose
  legs: ChainLegDraft[]
}

/** 一次拒绝，以及它关于哪一段——关于链路本身时为 null。 */
export interface ChainRefusal {
  legIndex: number | null
  message: string
}

/** 起始的一段：没选线路、没有站点、什么都没配。 */
export function emptyLegDraft(): ChainLegDraft {
  return {
    lineKey: null,
    boardStationName: null,
    boardStationOrder: null,
    alightStationName: null,
    alightStationOrder: null,
    transferExtraMinutes: null,
    connectionMode: null,
  }
}

/** 新链路的草稿：一个空段，故在敲任何字之前形状就是可见的。 */
export function emptyChainDraft(): ChainDraft {
  return { name: '', purpose: 'morning', legs: [emptyLegDraft()] }
}

/** 「第 2 段」——每句话与每个标签所用的位置词。 */
export function legPositionText(index: number): string {
  return `第 ${index + 1} 段`
}

/** 「上班」 / 「下班」. */
export function purposeText(purpose: CommuteChainPurpose): string {
  return purpose === 'morning' ? '上班' : '下班'
}

/** 「家」 / 「公司」——`anchorForPurpose` 推出来的锚点就是这两个之一。 */
export function anchorText(anchor: CommuteChainAnchor): string {
  return anchor === 'home' ? '家' : '公司'
}

/**
 * 一个选项在用户读到它之处的命名方式：先线路，再方向自己的终点站标签。
 *
 * 兜底是「方向 N」而不是猜一个终点站：没有陈述 `directionName` 的数据源就是没有陈述终点站，
 * 造一个会给一段贴上无人报告过的目的地。
 *
 * 方向**本身完全读不出来**时（`direction === null`，也就是一条已存链路的线路在被取消关注后
 * 落入的状态），标签说的是实际缺失的那个事实——而这取决于线路：
 *
 * - 公交线路的两个方向是**两个**线路 id，故已存的 id 已经定死了该段走哪边。它的方向是已知的；
 *   读不到的是站点列表，故标签说「站序未知」。把此处的方向称为未知会夸大：
 *   那会声称一种 id 本身就排除掉的无知；
 * - 地铁两个方向复用**一个** id，并对同一批站反向编号，故一条已存地铁段走哪边确实不在记录里
 *   ——「方向未知」就是那个事实，读侧从已存的站序解析方向。
 */
export function lineOptionLabel(option: ChainLineOption): string {
  if (option.directionLabel) return `${option.lineName} · ${option.directionLabel}`
  if (option.direction === null) {
    return isSubwayLineId(option.lineId)
      ? `${option.lineName} · 方向未知`
      : `${option.lineName} · 站序未知`
  }
  return `${option.lineName} · 方向 ${option.direction}`
}

/**
 * 一段所乘坐的选项；没选时为 null。
 *
 * `lines` 是编辑器提供的全集（已关注线路的各方向，加上一条已存段已命名、而该线路已不再被
 * 关注时的那个），故查不到意味着该段确实没有命名本屏能提供的任何东西。
 */
export function optionOfLeg(leg: ChainLegDraft, lines: ChainLineOption[]): ChainLineOption | null {
  if (leg.lineKey === null) return null
  return lines.find(option => option.key === leg.lineKey) ?? null
}

/**
 * 一段的站点列表状态在无法挑选时挣得的那一句话。
 *
 * 每种状态按它本来的事实措辞，而三者是不同的：仍在到来的读取、作答为空无的读取、
 * 以及一条不再被关注、其列表本屏因此完全读不到的线路。最后一种点名的是**线路**而非某个方向，
 * 因为它是从哪个方向记录的，正是读不出来的东西。
 */
export function stopsStateSentence(option: ChainLineOption): string | null {
  const label = lineOptionLabel(option)
  // 作答且一个站都没有的读取不是仍在途的读取：
  // 等它永远不会结束，故按它本来的缺失陈述。
  const state: ChainStopsState = option.stops === 'ready' && option.stations.length === 0
    ? 'unavailable'
    : option.stops
  switch (state) {
    case 'loading':
      return `「${label}」的站点还没读到：这一段的上下车站要等它出现才能选`
    case 'unavailable':
      return `「${label}」这个方向暂无站点数据，无法选上车站与下车站`
    case 'unfollowed':
      return `「${option.lineName}」已不在关注线路里，它的站序无从核对，请重新选择线路`
    default:
      return null
  }
}

/**
 * 一个已存的对是否原样落在某个站点列表里：该站名在该站序上。
 * 两者一起流动，故在另一个站序上找到的站名不是这一对——列表自那次记录以来被重编号过。
 */
function pairIsInList(stations: ChainLineOption['stations'], name: string | null, order: number | null): boolean {
  if (name === null || order === null) return false
  return stations.some(station => station.name === name && station.order === order)
}

/**
 * 一段已存链路的线路解析到的选项 key。
 *
 * 地铁线路 id 携带**两个**方向，故只有靠已存站序匹配的那套编号才能区分方向：其自己的站点
 * 列表原样持有那一对的选项，就是该段录自的那个。没有列表匹配时——公交的站在数据源侧被重编号，
 * 或线路的站点未加载——该段保留它命名的线路，稍后由配对规则拒绝保存，
 * 而不是把该段静默重编号到一个猜出的方向上。
 */
function lineKeyOfStoredLeg(leg: CommuteChainLeg, lines: ChainLineOption[]): string {
  const sameLine = lines.filter(option => option.lineId === leg.lineId)
  const exact = sameLine.find(option =>
    option.stops === 'ready'
    && pairIsInList(option.stations, leg.boardStationName, leg.boardStationOrder)
    && pairIsInList(option.stations, leg.alightStationName, leg.alightStationOrder))
  return (exact ?? sameLine[0])?.key ?? `stored:${leg.lineId}`
}

/**
 * 一段已存链路命名的线路，作为选项——用于它已不再被关注的情况，好让编辑器把该段持有的东西
 * 展示给用户，而不是静默丢掉它。它的站点列表完全读不到，由 `unfollowed` 说明。
 */
function storedLineOption(leg: CommuteChainLeg): ChainLineOption {
  return {
    key: `stored:${leg.lineId}`,
    direction: null,
    lineId: leg.lineId,
    lineName: leg.lineName,
    cityCode: leg.cityCode,
    directionLabel: null,
    stations: [],
    stops: 'unfollowed',
  }
}

/**
 * 一条链路的草稿所需的选项集：已关注线路的各方向，加上本链路任一段已命名、
 * 且已无法再从选项中选到的线路。
 */
export function editorOptionsFor(chain: CommuteChain | null, lines: ChainLineOption[]): ChainLineOption[] {
  if (!chain) return lines
  const known = new Set(lines.map(option => option.lineId))
  const extra = chain.legs
    .filter(leg => !known.has(leg.lineId))
    .map(storedLineOption)
  const seen = new Set<string>()
  return [...extra, ...lines].filter((option) => {
    if (seen.has(option.key)) return false
    seen.add(option.key)
    return true
  })
}

/**
 * 一条已存链路，作为编辑器打开的草稿。
 *
 * 已存的那一对**原样**沿用——站名与站序一起——因为那是用户已经做出的记录：拿新加载的列表
 * 给它重编号，会改写一段没人要求改动的行程。一段的线路靠同一对匹配到选项。
 */
export function chainDraftOf(chain: CommuteChain, lines: ChainLineOption[]): ChainDraft {
  return {
    name: chain.name,
    purpose: chain.purpose,
    legs: chain.legs.map(leg => ({
      lineKey: lineKeyOfStoredLeg(leg, lines),
      boardStationName: leg.boardStationName,
      boardStationOrder: leg.boardStationOrder,
      alightStationName: leg.alightStationName,
      alightStationOrder: leg.alightStationOrder,
      transferExtraMinutes: leg.transferExtraMinutes,
      connectionMode: leg.connectionMode,
    })),
  }
}

/** 写入所携带的一段：没有 `seq`，由服务端按数组顺序写入。 */
export interface ChainLegWrite {
  lineId: string
  lineName: string
  cityCode: string
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  transferExtraMinutes: number | null
  connectionMode: 'walk' | 'cycle' | null
}

/** 写入所携带的链路——创建与编辑同一个形状。起点由服务端按 `purpose` 推出。 */
export interface ChainWrite {
  name: string
  purpose: CommuteChainPurpose
  legs: ChainLegWrite[]
}

/**
 * 规则，作用于草稿：可以写入时为 null，否则是用户必须处理的那**一条**拒绝。
 *
 * 第一条失败的胜出，链路级检查先于逐段检查、段按自身顺序，故句子点名最早要修的东西而不是
 * 最晚的。每一条都是 `CommuteChainLegSchema` 的谓词，在录入之处再陈述一遍：
 *
 * 1. 公交段只沿下游运行——它已存的线路 id 已定死方向；
 * 2. 地铁段可以走另一边——一个 id 携带两个方向，站序说明是哪一个，故拒绝它会让一趟真实的
 *    乘车无法被记录；
 * 3. 一段不能始于并止于同一个站；
 * 4. 一个站是一对——站名与站序，或两者皆无；
 * 5. 一条链路至少有一段乘车段；
 * 6. 每段的站点在保存前都已选好。
 *
 * 每句话陈述的都是用户所处的事实。没有一句是「输入有误」，因为用户的录入总体上并不错——
 * 是其中某一处错了，而它有名字。
 */
export function refuseChainDraft(draft: ChainDraft, lines: ChainLineOption[]): ChainRefusal | null {
  if (draft.name.trim() === '') {
    return { legIndex: null, message: '请先给这条链路起个名字' }
  }
  if (draft.legs.length === 0) {
    return { legIndex: null, message: '链路至少需要一段乘车段：没有乘车段的链路给不出任何结论' }
  }

  for (const [index, leg] of draft.legs.entries()) {
    const position = legPositionText(index)
    const option = optionOfLeg(leg, lines)
    if (!option) {
      return { legIndex: index, message: `${position}还没选线路与方向：每一段都要先选一条线路` }
    }

    // 那一对必须对着核对的列表不在此：是三种原因中的哪一种决定句子，
    // 而没有一种是「输入有误」。
    const stateSentence = stopsStateSentence(option)
    if (stateSentence) {
      return { legIndex: index, message: `${position}的${stateSentence}` }
    }

    for (const end of ['board', 'alight'] as const) {
      const name = end === 'board' ? leg.boardStationName : leg.alightStationName
      const order = end === 'board' ? leg.boardStationOrder : leg.alightStationOrder
      const endText = end === 'board' ? '上车站' : '下车站'
      if (name === null && order === null) {
        return { legIndex: index, message: `${position}的${endText}还没选：选完上车站与下车站才能保存` }
      }
      if (order === null) {
        return {
          legIndex: index,
          message: `${position}的${endText}「${name}」没有站序：站名与站序要同时选定，单独一半定位不到车站`,
        }
      }
      if (name === null) {
        return {
          legIndex: index,
          message: `${position}的${endText}只有第 ${order} 站这个站序、没有站名：站名与站序要同时选定，单独一半定位不到车站`,
        }
      }
      if (!option.stations.some(s => s.name === name && s.order === order)) {
        return {
          legIndex: index,
          message: `${position}的${endText}「${name}」第 ${order} 站不在「${lineOptionLabel(option)}」的站序里，请重新选择这一站`,
        }
      }
    }

    // 从一个站到它自己根本不是乘车——
    // 既不是更短的一段，也不是合法的反向一段。
    if (leg.boardStationOrder === leg.alightStationOrder) {
      return {
        legIndex: index,
        message: `${position}的上车站与下车站是同一站「${leg.boardStationName}」（第 ${leg.boardStationOrder} 站）：从一站到它自己不是乘车段`,
      }
    }

    // 公交只沿下游，地铁可以走任一边。线路 id 决定这是哪一种：公交线路的两条路是两个 id，
    // 故已存 id 上较小的下车站序说明这段录反了；地铁复用一个 id 而对同一站反向编号，
    // 故同样降序的一对是真实的反向一程——
    // 而两层都从站序本身读方向。
    if (option.stops === 'ready' && !isSubwayLineId(option.lineId)
      && leg.alightStationOrder! < leg.boardStationOrder!) {
      return {
        legIndex: index,
        message: `${position}的公交「${option.lineName}」只沿站序递增运行：上车站「${leg.boardStationName}」在第 ${leg.boardStationOrder} 站、下车站「${leg.alightStationName}」在第 ${leg.alightStationOrder} 站，方向录反了`,
      }
    }
  }

  return null
}

/**
 * 草稿作为写入所携带的样子。只在 `refuseChainDraft` 通过的草稿上调用——
 * 是规则保证选项与那一对都在。
 *
 * `seq` 按设计缺席：数组顺序**就是**段序，服务端据此写入编号。
 */
export function chainBodyOf(draft: ChainDraft, lines: ChainLineOption[]): ChainWrite {
  return {
    name: draft.name.trim(),
    purpose: draft.purpose,
    legs: draft.legs.map((leg) => {
      const option = optionOfLeg(leg, lines)!
      return {
        lineId: option.lineId,
        lineName: option.lineName,
        cityCode: option.cityCode,
        boardStationName: leg.boardStationName,
        boardStationOrder: leg.boardStationOrder,
        alightStationName: leg.alightStationName,
        alightStationOrder: leg.alightStationOrder,
        transferExtraMinutes: leg.transferExtraMinutes,
        connectionMode: leg.connectionMode,
      }
    }),
  }
}

/** 「上车站 东大桥 第 3 站 → 下车站 建国门 第 4 站」，未选的那一半留为空缺。 */
export function stationPairText(name: string | null, order: number | null): string {
  if (name === null) return '未设置'
  if (order === null) return name
  return `${name} 第${order}站`
}
