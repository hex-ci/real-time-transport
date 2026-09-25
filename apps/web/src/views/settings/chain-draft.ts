import type {
  CommuteChain,
  CommuteChainAnchor,
  CommuteChainLeg,
  CommuteChainPurpose,
} from '@real-time-transport/shared'
import type { ChainLineOption, ChainStopsState } from './types'

/**
 * F10's chain editor, as one place of judgement.
 *
 * 「链路由使用者录入，不由系统规划」 is the feature's premise, so the rules that make a
 * record readable live HERE, where the user's entry is, rather than at the write
 * boundary: `CommuteChainLegSchema` can check that a (station name, station order)
 * pair agrees with itself, but it cannot see a line's stop list, so 「这一对确实在站序
 * 里」 is only checkable while the list is on screen. Every rule below is therefore
 * the same predicate the schema states, applied to the draft, and each refusal is
 * worded as the fact it is — not as a generic 「输入有误」.
 *
 * Nothing here reads the clock, a vehicle or a timetable, and nothing computes a
 * duration: the editor records facts, and the chain page is where conclusions are
 * drawn (F10's 「不给点结论的判据不是段数，而是每一段的来源等级」).
 */

/**
 * Why a chain cannot be left without ride legs — the reason the last leg's remove
 * control is disabled with, and the substance of the refusal when a draft reaches
 * the save with none.
 */
export const LAST_LEG_REASON = '不能删除最后一段：没有乘车段的链路给不出任何结论'

/**
 * Ride legs one chain may carry in this version.
 *
 * The data model is N legs by design and the read side walks whatever it is given;
 * this is the entry screen's own bound, and the editor says so instead of silently
 * refusing the third one.
 */
export const MAX_CHAIN_LEGS = 2

/**
 * Whether a line id names a subway line.
 *
 * The project's own convention (`subway_` prefix), which is what routes a read to
 * the subway engine — the same test `CommuteChainLegSchema`'s refinement applies, so
 * the editor and the write boundary cannot disagree about a line.
 */
export function isSubwayLineId(lineId: string): boolean {
  return lineId.startsWith('subway_')
}

/** One ride leg while it is being filled in. A null value is 「未选」, never an empty string. */
export interface ChainLegDraft {
  /** The chosen line+direction, or null before one is chosen. */
  lineKey: string | null
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  /** null = the user configured nothing; 0 = they configured 「no extra time at all」. */
  transferExtraMinutes: number | null
}

/** A chain while it is being filled in. */
export interface ChainDraft {
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  legs: ChainLegDraft[]
}

/** A refusal, and which leg it is about — null when it is about the chain itself. */
export interface ChainRefusal {
  legIndex: number | null
  message: string
}

/** A leg to start from: no line chosen, no stations, nothing configured. */
export function emptyLegDraft(): ChainLegDraft {
  return {
    lineKey: null,
    boardStationName: null,
    boardStationOrder: null,
    alightStationName: null,
    alightStationOrder: null,
    transferExtraMinutes: null,
  }
}

/** A new chain's draft: one empty leg, so the shape is visible before anything is typed. */
export function emptyChainDraft(): ChainDraft {
  return { name: '', originAnchor: 'home', purpose: 'morning', legs: [emptyLegDraft()] }
}

/** 「第 2 段」 — the position word every sentence and label uses. */
export function legPositionText(index: number): string {
  return `第 ${index + 1} 段`
}

/** 「上班」 / 「下班」. */
export function purposeText(purpose: CommuteChainPurpose): string {
  return purpose === 'morning' ? '上班' : '下班'
}

/** 「家」 / 「公司」. */
export function anchorText(anchor: CommuteChainAnchor): string {
  return anchor === 'home' ? '家' : '公司'
}

/**
 * How an option is named wherever the user reads it: the line, then the direction's
 * own terminus label.
 *
 * The fallback is 「方向 N」 rather than a guessed terminus: an upstream that stated
 * no `directionName` has stated no terminus, and inventing one would label a leg
 * with a destination nobody reported.
 *
 * WHEN THE DIRECTION ITSELF CANNOT BE READ AT ALL (`direction === null`, which is what a
 * stored leg's line lands in once that line is no longer followed), the label says which
 * fact is actually missing — and that depends on the line:
 *
 * - a bus route's two directions are TWO upstream line ids, so the stored id has already
 *   fixed which way the leg runs. Its direction is known; what cannot be read is the stop
 *   list, so the label says 「站序未知」. Calling the direction unknown here would overstate:
 *   it would claim an ignorance the id itself rules out;
 * - a subway reuses ONE id for both directions and numbers the same stations oppositely, so
 *   which way a stored subway leg runs is genuinely not in the record — 「方向未知」 is the
 *   fact, and the read side resolves the direction from the stored orders.
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
 * The option a leg rides, or null while none is chosen.
 *
 * `lines` is the whole set the editor offers (the followed routes' directions, plus
 * the line a stored leg already names when that line is no longer followed), so a
 * lookup that fails means the leg genuinely names nothing this screen can offer.
 */
export function optionOfLeg(leg: ChainLegDraft, lines: ChainLineOption[]): ChainLineOption | null {
  if (leg.lineKey === null) return null
  return lines.find(option => option.key === leg.lineKey) ?? null
}

/**
 * The one sentence a leg's stop list state earns when it cannot be picked from.
 *
 * Each state is worded as the fact it is, and the three are different facts: a read
 * that is still coming, a read that answered with nothing, and a line that is no
 * longer followed and whose list this screen therefore cannot read at all. The last one
 * names the LINE rather than one direction, because which direction it was recorded
 * from is exactly what cannot be read.
 */
export function stopsStateSentence(option: ChainLineOption): string | null {
  const label = lineOptionLabel(option)
  // A read that answered with no stops at all is not a read still on its way: waiting
  // for it would never end, so it is told as the absence it is.
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
 * Whether a stored pair sits in a stop list exactly as stored: the name at that
 * order. The two travel together, so a name found at a different order is not this
 * pair — the list has been renumbered since it was recorded.
 */
function pairIsInList(stations: ChainLineOption['stations'], name: string | null, order: number | null): boolean {
  if (name === null || order === null) return false
  return stations.some(station => station.name === name && station.order === order)
}

/**
 * The option key a stored leg's line resolves to.
 *
 * A subway line id carries BOTH directions, so the direction is only told apart by
 * the numbering the stored orders match: the option whose own stop list holds the
 * stored pair verbatim is the one the leg was recorded from. When no list matches —
 * a bus whose stops were renumbered upstream, or a line whose stops are not loaded —
 * the leg keeps the line it names, and the save is refused later by the pair rule
 * rather than the leg being silently re-numbered onto a guessed direction.
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
 * The line a stored leg names, as an option — for the case where it is no longer
 * followed, so the editor can show the user what the leg holds instead of dropping
 * it silently. Its stop list is not readable at all, which `unfollowed` says.
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
 * The option set one chain's draft needs: the followed routes' directions, plus a
 * line any of this chain's legs already names and can no longer be chosen from.
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
 * A stored chain, as the draft the editor opens on.
 *
 * The stored pair is carried over VERBATIM — name and order together — because it is
 * the record the user already made: renumbering it from a freshly loaded list would
 * rewrite a leg nobody asked to change. A leg's line is matched to an option by that
 * same pair.
 */
export function chainDraftOf(chain: CommuteChain, lines: ChainLineOption[]): ChainDraft {
  return {
    name: chain.name,
    originAnchor: chain.originAnchor,
    purpose: chain.purpose,
    legs: chain.legs.map(leg => ({
      lineKey: lineKeyOfStoredLeg(leg, lines),
      boardStationName: leg.boardStationName,
      boardStationOrder: leg.boardStationOrder,
      alightStationName: leg.alightStationName,
      alightStationOrder: leg.alightStationOrder,
      transferExtraMinutes: leg.transferExtraMinutes,
    })),
  }
}

/** One leg as the write carries it: no `seq`, which the server writes from the array's order. */
export interface ChainLegWrite {
  lineId: string
  lineName: string
  cityCode: string
  boardStationName: string | null
  boardStationOrder: number | null
  alightStationName: string | null
  alightStationOrder: number | null
  transferExtraMinutes: number | null
}

/** The chain as the write carries it — the same shape for a create and an edit. */
export interface ChainWrite {
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  legs: ChainLegWrite[]
}

/**
 * The rules, applied to the draft: null when the draft can be written, or the ONE
 * refusal the user has to deal with.
 *
 * The first rule that fails wins, chain-level checks before per-leg ones and the legs
 * in their own order, so the sentence names the earliest thing to fix rather than the
 * last. Each is the predicate of `CommuteChainLegSchema`, stated here at the point of
 * entry:
 *
 * 1. a bus leg runs downstream only — its stored line id already fixes the direction;
 * 2. a subway leg may run the other way — one id carries both directions and the
 *    orders say which, so refusing it would make a real ride unrecordable;
 * 3. a leg cannot start and end at the same stop;
 * 4. a station is a pair — name AND order, or neither;
 * 5. a chain has at least one ride leg;
 * 6. every leg's stations are chosen before the save.
 *
 * Every sentence states the fact the user is in. None of them is 「输入有误」, because
 * the user's entry is not wrong in general — one particular thing about it is, and it
 * has a name.
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

    // The list the pair must be checked against is not there: which of the three
    // reasons it is decides the sentence, and none of them is 「输入有误」.
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

    // From one stop to itself is not a ride at all — neither a shorter leg nor a
    // legitimate reverse one.
    if (leg.boardStationOrder === leg.alightStationOrder) {
      return {
        legIndex: index,
        message: `${position}的上车站与下车站是同一站「${leg.boardStationName}」（第 ${leg.boardStationOrder} 站）：从一站到它自己不是乘车段`,
      }
    }

    // Downstream only on a bus, either way on a subway. The line id is what decides
    // which of the two this is: a bus route's two ways are two ids, so a lesser alight
    // order on a stored id is this leg entered backwards; a subway reuses one id while
    // numbering the same station oppositely, so the same descending pair is a real ride
    // the other way — and both layers read the direction from the orders themselves.
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
 * The draft as the write carries it. Call only on a draft `refuseChainDraft` passed —
 * the rules are what guarantee the option and the pair are there.
 *
 * `seq` is absent by design: the array's order IS the sequence, and the server writes
 * the number from it.
 */
export function chainBodyOf(draft: ChainDraft, lines: ChainLineOption[]): ChainWrite {
  return {
    name: draft.name.trim(),
    originAnchor: draft.originAnchor,
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
      }
    }),
  }
}

/** 「上车站 东大桥 第 3 站 → 下车站 建国门 第 4 站」, with an unchosen half left absent. */
export function stationPairText(name: string | null, order: number | null): string {
  if (name === null) return '未设置'
  if (order === null) return name
  return `${name} 第${order}站`
}
