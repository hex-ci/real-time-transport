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
 * F10's chain deduction — 我出门能不能赶上换乘点那班车, decided once, here.
 *
 * A chain is RECORDED by the user (line + board station + alight station, leg by
 * leg) and never planned by this app: no route planning, no external planning
 * API, no invented connection. What this file does is walk the recorded chain
 * against live readings and answer one question — how much slack is there at the
 * tightest boarding — plus the case where the honest answer is 「不给结论」.
 *
 * EVERY transfer point, and nothing past the last one. The product need is
 * 「在中间的某个换乘点，我能不能赶上这个换乘点的车」, so each ride leg's answer
 * stands on its own (which vehicle is boarded, how long the wait at that leg's
 * board station is, the margin for that boarding, and which vehicle the margin
 * measures) and the chain ENDS at its last alight station: there is no
 * destination, no walk past the end and no total arrival minute, because a chain
 * records an origin anchor and never a destination.
 *
 * 余量带位为主，分钟数同时给 (PRD F10). Both come from ONE quantity, computed once:
 * `marginMinutes`. The band is a function of it and so is the number the row
 * prints, so a row cannot say 充裕 beside 「余量 1 分钟」. The values are read from
 * the rounded whole minutes the row displays (F1's own rule), not from raw
 * seconds: a verdict drawn from seconds that the numbers beside it cannot show is
 * the same disagreement in a different unit.
 *
 * Pure and synchronous: `now` is a parameter, nothing here reads a clock, a
 * socket, a database or a distance. Walking and cycling times are priced by the
 * path service and arrive as inputs; the user's own parameters (the wait
 * tolerance, the cycling extra) are configurable with named defaults, because the
 * zero-fabrication rule constrains UPSTREAM data, not the user's own settings.
 *
 * 段时长全部可溯源. A leg's alight minute is THE VEHICLE'S OWN ETA at its alight
 * station — the same vehicle that reaches the board station, found by the
 * provider's stable id (`LiveBusSchema.id`) — so a bus leg's drop-off time is a
 * live prediction rather than a station count times an average. A subway leg has
 * no observable vehicle at all today: its trains are generated from the timetable
 * at 135 s per station, which is why its minute is marked 排班推演 through F4's own
 * `vehicleProvenanceOf`/`arrivalProvenanceOf` and can never read as 实时 here.
 */

/**
 * The connection leading into a ride leg — from the chain's origin anchor for the
 * first leg, and between two legs after that. The chain stores no mode (the
 * connection's duration is priced from the real station coordinates, and a stored
 * copy would drift into a second, contradictory fact), so it arrives as an input.
 */
export type ChainConnectionMode = 'walk' | 'cycle'

/**
 * Why a leg's connection has no priced duration, as the caller that tried to
 * price it knows the cause.
 *
 * The engine sees one fact — `connectionSeconds` is null — and cannot tell WHY:
 * a connection is priced outside it, from the real station coordinates of the
 * point the user sets off from (the chain's stored anchor for the first leg, and
 * the station the previous leg was left at after that), so the caller is the only
 * layer that ever knows which of these facts it hit. The cause therefore travels
 * in as a code and the engine maps it to the refusal the page reads.
 *
 * These are the caller's words, not the wire's, and each cause is named one by
 * one so that the set behind a refusal code is machine-stated rather than prose.
 * Four of them leave the user nothing to do and share one refusal code; the
 * fifth is the anchor, which the user can set. An unresolved origin is always
 * that anchor: a leg whose own alight station cannot be located is refused, and a
 * refusal ends the chain, so no leg after the first is ever assembled from an
 * unresolved point. A caller that cannot name the cause states none at all (see
 * {@link ChainLegInput.connectionUnpricedReason}).
 *
 * - `anchor-unset`       the chain's origin anchor was never saved, so there is no point to walk from at all
 * - `line-unavailable`   the leg's line detail could not be read, so its stored stations have no stop list to be located in
 * - `station-unlocated`  the leg's stored station is not in the stop list of the direction the leg runs in
 * - `station-without-coordinate` the direction's stop list carries the stored station but states no coordinate for it, so there is no point to walk to
 * - `route-unpriced`     both ends resolved and the path service priced no walking/cycling route between them
 */
export type ChainConnectionUnpricedReason
  = | 'anchor-unset'
    | 'line-unavailable'
    | 'station-unlocated'
    | 'station-without-coordinate'
    | 'route-unpriced'

/**
 * Minutes a cycling connection costs beyond the riding itself: finding a bike and
 * parking it. A named default of the same class as F1's T — the user's own
 * parameter, not a reading — and PRD F10 asks for it to be configurable with a
 * default, so every entry point can override it (`cycleExtraMinutes`, or a leg's
 * own `transferExtraMinutes`). Nothing derives it from upstream data.
 */
export const DEFAULT_CYCLE_EXTRA_MINUTES = 2

/**
 * The largest margin that still counts as 紧 rather than 充裕.
 *
 * It is F1's platform tolerance itself, not a second number: T is 「站台等待容忍值
 * … 同时是安全边际」, so a chain that leaves MORE slack than the user tolerates
 * waiting has slack to spare, and one that leaves no more than that is 紧 —
 * 「就这几分钟」, the tolerance itself included. With the default tolerance of 3
 * minutes the 紧 band is therefore margins 1–3 minutes, NOT 1–2: verified against
 * live readings (a margin of 4 bands 充裕, a margin of 3 bands 紧, and the boundary
 * is inclusive because 3 IS the tolerance). The boundary is on the tight side,
 * exactly as F1's `hurry` is, so a one-leg chain and F1 cannot draw two verdicts
 * from the same walk and the same ETA.
 */
export const CHAIN_TIGHT_MARGIN_MINUTES = DEFAULT_WAIT_TOLERANCE_MINUTES

/**
 * The smallest margin this deduction can resolve, in whole displayed minutes.
 *
 * 1 is forced by the cases this feature must cover, not chosen as a resolution.
 * The 紧 band runs from 1 minute up to the tolerance (`CHAIN_TIGHT_MARGIN_MINUTES`,
 * 3 by default), so a margin of 1 minute has to band as 紧 rather than as the
 * two-branch case — which leaves margin 0 as the ONLY margin that cannot be given
 * one answer (below it the vehicle has simply gone), and makes the width of the
 * unresolvable band exactly one whole minute. Narrowing it to 0 would print
 * 「就这几分钟」 beside a margin no reading can tell from −0.5 minutes; widening it
 * to 2 would swallow the 紧 case the plan requires.
 *
 * It is NOT the accuracy of the inputs, and it is not the resolution of a
 * displayed quantity either. A path-service duration carries no published
 * accuracy; a live reading may be up to `STALE_ARRIVAL_SECONDS` old when it is
 * judged; a subway minute is this app's own 135 s/station inference. None of that
 * is folded in here and none of it may be: that uncertainty is disclosed where it
 * is a fact about the data rather than about the row's arithmetic — the
 * provenance marks (`provenance`, per leg) say what KIND each minute is, and
 * `lastUpdatedAt` says how old the readings are. So a future reader must not
 * "fix" this constant by widening the band to cover them: the band states what
 * the row can distinguish, the marks state what the inputs are worth, and
 * merging the two would hide both.
 */
export const CHAIN_ERROR_MAGNITUDE_MINUTES = 1

/**
 * Which side of the tolerance a chain's margin falls on, as the row states it.
 *
 * - `comfortable`  充裕: more margin than the user tolerates waiting — 就是这班.
 * - `tight`        紧: inside the tolerance — the tolerance itself included, so
 *                  margins 1..3 分钟 with the default 3
 *                  (`CHAIN_TIGHT_MARGIN_MINUTES`) — 就这几分钟.
 * - `uncertain`    余量 below the resolution: two branches, no single answer.
 * - `insufficient` 不足: the vehicle the chain is timed against is gone — 实际是下一班.
 */
export type ChainMarginBand = 'comfortable' | 'tight' | 'uncertain' | 'insufficient'

/**
 * Why no deduction was possible. A machine-readable code, never a sentence: the
 * web layer owns the zh-CN wording, and each of these is a DIFFERENT fact about
 * the data rather than a smaller version of one of the others.
 *
 * 「没有可乘的车」 is deliberately FOUR codes, not one. Three of them are facts
 * about the service and one is a fact about this app's own reading, and the four
 * are decided where each is actually known: an empty board read and a board read
 * whose two halves share no vehicle are the SAME empty candidate list, and a
 * vehicle that left during the connection and one that left before the connection
 * began are the SAME empty boarding — so a single code would let the chain page
 * describe the wrong thing in three of the four cases.
 *
 * `leg-recorded-backwards` is deliberately separate from `no-shared-vehicle`
 * because the two name different owners. An empty pair is normally either an
 * empty service or OUR two snapshots matching nothing; a leg that cannot be ridden
 * as recorded also makes the two reads disjoint, but the cause is the RECORD, which
 * the user can fix — and calling it 「两个读数没有对上的车」 would blame this app for
 * the user's own entry while quoting no fix. It is decided from the stored leg
 * itself, before any reading is looked at: nothing upstream can change it.
 *
 * A SUBWAY leg stored the other way round is deliberately NOT this code. Two
 * directions of a bus are two lineIds, but two directions of a subway share one,
 * numbering the same station oppositely — so a lesser alight order there is a real
 * ride the other way, which the assembly reads in the opposite direction with both
 * orders translated into it. Only a bus stored backwards, and a leg whose two ends
 * are the SAME station on any line, are records this code names.
 *
 * - `no-legs`                      the chain carries no ride leg at all
 * - `station-unset`                a leg's board or alight station was never chosen
 * - `leg-recorded-backwards`       a leg's two ends are the same station, or a bus leg's alight station is not downstream of its board station
 * - `anchor-unset`                 the chain's origin anchor was never saved: the first leg has no origin to walk from at all
 * - `connection-unpriced`          a connection into a leg has no priced duration
 * - `no-live`                      a leg's line has no live reading
 * - `no-vehicle`                   the board read carried nothing: nothing is on its way to this board station
 * - `no-shared-vehicle`            both reads answered, but share no vehicle id — a fact about OUR reading, not the service
 * - `no-vehicle-after-connection`  vehicles were still coming when the user set off, but none was left once the connection was walked
 * - `no-vehicle-at-departure`      every vehicle had already reached this board station before the user could set off toward it
 * - `stale`                        a reading is older than F1's freshness limit
 * - `degraded`                     a fallback source answered for a leg
 * - `provenance-unknown`           a reading declares no source this build knows
 * - `inconsistent-live`            a vehicle's alight minute precedes its own board minute
 *
 * The exact cause set of the two connection codes, stated once so the page author
 * never has to guess which fact is behind one:
 *
 *  - `anchor-unset` covers the chain's origin anchor and NOTHING else. It is the
 *    one cause of an unpriced connection the user can act on: a chain records an
 *    origin and never a destination, so an anchor that was never saved leaves no
 *    point to walk from at all, and the fix lives in 设置. The chain states it
 *    under the same word F1's own empty state uses for the same fact, and the
 *    page can render the same sentence with the same affordance. The converse
 *    holds too, and does so by precedence rather than by luck: the assembly asks
 *    for the anchor BEFORE it reads a leg's line or locates a station, so a chain
 *    whose anchor was never saved answers `anchor-unset` even when that leg's
 *    detail, its stop list or its route would also have failed. The user is told
 *    the cause they can repair rather than one they cannot.
 *  - `connection-unpriced` covers the four remaining causes, each of which leaves
 *    the user no action: the line's detail could not be read (`line-unavailable`)
 *    — an upstream read this app could not complete; a stored station is not in
 *    the direction's stop list (`station-unlocated`) — a record this build no
 *    longer reads that stop list with, and not something the page can repair. What
 *    keeps the stored pair in step on the way IN is the chain editor, where a
 *    station is chosen from the line's own stop list; the schema checks only the
 *    pair's own consistency (a name with its order, both or neither) and the leg's
 *    direction, and it never sees a stop list, so it cannot promise the pair is in
 *    one. Or the stop list does carry it there and states no coordinate for it
 *    (`station-without-coordinate`) — the record is intact and the position is
 *    what upstream never gave, so there is no point to walk to and no page can
 *    supply one. Or the path service priced no route between two ends that both
 *    resolved (`route-unpriced`). A caller that cannot name the cause at all
 *    states none and lands here too. Which cause fired is disclosed by a code,
 *    never by a quantity, and the page states one sentence for the code rather
 *    than pretending to know which of them fired.
 *
 *    That ONE sentence must promise no retryability, because these four causes do
 *    NOT share a permanence. An unplaced stop (`station-without-coordinate`) is a
 *    gap in what upstream STATES and not a transient failure of this read: the stop
 *    list carries the stored station but states no coordinate for it, so nothing in
 *    the answer tells the page that asking again would find one — while nothing in
 *    it proves one never will, either, since a later refresh of the stop list could
 *    place the stop. An unpriced route (`route-unpriced`) is transient: both ends
 *    resolved and the path service simply priced no route between them at that
 *    moment, which the next read may price. 「稍后重试」 would be true of the last and
 *    unsupported by the first, on a row that cannot tell the page which one it is.
 *    So the sentence states only the fact the code carries — this connection has no
 *    priced duration — and promises neither a retry nor that there is nothing left
 *    to wait for, and it offers no action, because for these causes there is none
 *    the user can take.
 *
 * `ChainConnectionUnpricedReason` is the caller's own vocabulary for those five
 * causes; the mapping from it to these codes is the engine's (see
 * `connectionRefusalCode`), so a cause can be stated precisely by the layer that
 * learned it without every precision becoming a wire code.
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
 * One candidate vehicle, as the server assembled it from the live reading.
 *
 * Both minutes belong to the SAME vehicle, which is why the provider's id is
 * carried: a board ETA and an alight ETA that merely look alike would make the
 * ride duration meaningless. The provider's ids are stable across reads —
 * `LiveBusSchema.id` for a real bus, a generated train's own id for a subway line
 * — so one vehicle is followable from the station it is boarded at to the station
 * it is left at.
 */
export interface ChainLegVehicle {
  /** `LiveBusSchema.id`. */
  vehicleId: string
  /** Seconds until this vehicle reaches the leg's BOARD station. */
  arrivalAtBoardSeconds: number
  /** Seconds until the SAME vehicle reaches the leg's ALIGHT station. */
  arrivalAtAlightSeconds: number
  /**
   * How the alight minute came to exist (F4's `ArrivalBasis`). It qualifies the
   * minute; it does not override the vehicle: a generated vehicle is 排班推演
   * whichever basis produced its number.
   */
  basis: ArrivalBasis
}

/**
 * A leg's live reading: the line's own status plus the vehicles on their way.
 *
 * `dataSource` / `updatedAt` / `isDegraded` are the reading's, not the row's —
 * they belong to the response that produced every vehicle in it, which is why
 * freshness is judged here rather than per candidate.
 */
export interface ChainLegLive {
  /** The source that answered, as the line's status declares it. */
  dataSource: DataSourceType | null
  /** When that reading was obtained, epoch ms. */
  updatedAt: number
  /** The aggregator's mark that a fallback source answered. */
  isDegraded: boolean
  /** Vehicles still to reach the board station. Any order; sorted before use. */
  vehicles: readonly ChainLegVehicle[]
  /**
   * Whether the leg's own line is running, as F3 derives it (`operatingStatusOf`).
   *
   * The F10 case of the rule that a service state must govern an empty answer:
   * 「暂无来车」 before the first departure, after the last one and in the middle
   * of a running day are three facts, and only the state tells them apart.
   *
   * The DERIVATION is the station board's — one function, `operatingStatusOf`, so
   * this path cannot invent a second status model — but the INPUT is not, and the
   * two can therefore state different states for one line:
   *
   *  - this leg's state is the LINE's service hours, the `firstBusTime` /
   *    `lastBusTime` its detail carries (`transit.service.ts`, `readChainLeg`);
   *  - the board, where an official station timetable covers the platform, derives
   *    its state from that TABLE's own first and last departure
   *    (`getStationArrivals`, the `exact` branch), because that is the list it
   *    shows.
   *
   * For the one station this repo ships a published table for, the two
   * values differ, so there is a real window in which the chain and the board
   * disagree. That is stated rather than hidden: the chain reports the LINE's
   * hours — a fact about the line — while a station's own table is a fact about the
   * platform, which only the board reads. Deriving it costs no upstream call: it is
   * a function of the leg's own detail and the clock.
   */
  operatingStatus: OperatingStatus
  /**
   * How many vehicles the BOARD read carried, before the two reads were matched
   * by id.
   *
   * Exactly `vehicleArrivals(board)` for the board order — the rows still to
   * reach that order, after upstream's already-passed filter. A row whose targeted
   * reading published no arrival time for it IS counted: it is a real vehicle on
   * its way, it is only its minute that is missing (this app no longer
   * extrapolates one), and dropping it from this count would report an empty
   * service for a platform that has a bus coming. It is NOT every bus the payload
   * happened to carry and NOT the alight read's row count: the first mutation would
   * count a vehicle that has already passed the board order (so the board read
   * priced nothing while the payload still held it), and the second would count a
   * vehicle the board read never carried — both flipping an empty SERVICE into
   * 「两个读数没有对上的车」.
   *
   * It is the ONE fact that separates 「没有可乘的车」 from 「两个读数没有对上的
   * 车」: an empty `vehicles` with nothing on the way is a statement about the
   * service, and the same empty `vehicles` beside vehicles that were on the way
   * is a statement about this app's own reading. It is at least `vehicles.length`
   * whenever the board read's rows are a subset of the alight read's, which holds
   * for a leg whose ALIGHT stop is further along in the direction the leg is READ:
   * the stored alight order downstream of the stored board order, or — for a subway
   * leg recorded the other way round — the two translated orders the assembly reads
   * in the opposite direction. The relation cannot hold for the cases
   * `leg-recorded-backwards` refuses (a bus leg stored backwards, a station-to-
   * itself leg), which is why those are decided first.
   */
  boardVehiclesOnTheWay: number
}

/** One ride leg as the deduction needs it: the stored leg plus what was resolved for it. */
export interface ChainLegInput {
  /** The stored leg: the line, and the board/alight stations (both nullable). */
  leg: CommuteChainLeg
  /**
   * Seconds of the connection leading INTO this leg, as the path service priced
   * it. `null` when it could not be priced — then nothing is deduced, because the
   * connection IS the comparison. (F10 stores no connection: it is derived from
   * the real station coordinates.)
   */
  connectionSeconds: number | null
  /**
   * Why the connection has no priced duration, as the caller that priced it knows
   * the cause.
   *
   * Meaningful exactly where `connectionSeconds` is null: a leg with a priced
   * connection has no missing fact to explain, so a reason stated beside one is
   * ignored. ABSENT when the caller cannot name the cause, which is a state of
   * its own rather than a reason — it is the only way to reach
   * `connection-unpriced` with no cause behind it.
   */
  connectionUnpricedReason?: ChainConnectionUnpricedReason
  /** How that connection is travelled. Defaults to walking. */
  connectionMode?: ChainConnectionMode
  /** The leg's live reading, or `null` when the line was not read. */
  live: ChainLegLive | null
}

/** Everything the deduction needs. All of it is a fact the caller obtained — no field is optional for convenience. */
export interface CommuteChainDeductionInput {
  /** The chain's ride legs, in order. */
  legs: readonly ChainLegInput[]
  /** Injected clock (epoch ms): freshness is judged against this, never against a clock read in here. */
  now: number
  /** Overrides F1's tolerance for the 充裕/紧 boundary. */
  tightMarginMinutes?: number
  /** Overrides {@link DEFAULT_CYCLE_EXTRA_MINUTES} for legs that configured no extra of their own. */
  cycleExtraMinutes?: number
}

/** One leg of the plan: the vehicle boarded and everything the row shows about it. */
export interface ChainLegDeduction {
  /** The stored leg's `seq`. */
  seq: number
  lineId: string
  lineName: string
  /** The vehicle this leg boards under the plan. */
  vehicleId: string
  /**
   * The vehicle `marginMinutes` is measured against — THE vehicle that was next
   * at this board station when the user set off (the reference), named so the
   * margin cannot be printed beside the wrong bus.
   *
   * It equals `vehicleId` exactly when the margin is zero or more: the reference
   * has not gone, so it is also the one boarded. They differ in `insufficient`,
   * where the reference has gone and the plan is the next vehicle — and that is
   * precisely the row that would otherwise state 「余量 -2 分」 beside `vehicleId`.
   *
   * The equivalence needs the ready moment (this leg's board station, once its
   * connection is walked) to be no EARLIER than the set-off moment — a
   * non-negative leg extra. A negative extra would put the user at the platform
   * before they set off, make a vehicle that left before that moment look
   * catchable, and measure the margin against a later vehicle than the one it
   * names; the engine therefore clamps the effective extra at zero (see
   * `extraMinutes`), so the equality is unconditional for every caller — not only
   * for the ones whose stored `transferExtraMinutes` the schema guards.
   */
  referenceVehicleId: string
  /** F4's mark for this leg's alight minute. Never null once a chain is deduced. */
  provenance: DataProvenance
  /**
   * F3's operating state for this leg's line, derived from the SAME reading the
   * leg's answer came from: 首班前 / 运营中 / 已过末班 / 未知. It travels with
   * every leg so a page can state the service state beside a row that has little
   * or nothing on the way, without a second read of the line.
   */
  operatingStatus: OperatingStatus
  /**
   * Whole minutes of slack AT THE BOARD STATION: this vehicle's own arrival
   * minute there, minus the minute the USER gets there. It is the platform wait,
   * not 「from now」 — a first leg behind a 5-minute connection whose vehicle
   * boards 12 minutes out states 7, and a later leg states what is left after
   * the ride before it (its connection included). Never negative: the boarded
   * vehicle is by construction the first one this user has NOT already missed
   * (`marginMinutes` is where missing one is stated, signed).
   */
  waitMinutes: number
  /** Whole minutes from now until it reaches the alight station. */
  alightMinutes: number
  /** Whole minutes the ride takes: this leg's alight minute minus its board minute. */
  rideMinutes: number
  /**
   * Signed slack at this boarding, in whole minutes: the vehicle that was next
   * when the user set off toward this station, minus the moment the user gets
   * there. Negative means that vehicle is gone and the plan below it is the next
   * one; zero is inside the error magnitude and is read as `uncertain`.
   */
  marginMinutes: number
}

/** One reading of an unresolved margin. */
export interface ChainBranch {
  /** The vehicle under this reading, or `null` when nothing follows. */
  vehicleId: string | null
  /** Whole minutes until that vehicle reaches the alight station, from now; `null` when it is not known. */
  alightMinutes: number | null
}

/** The two readings of a margin too small to resolve — 赶得上就是 A 班，赶不上就是 B 班. */
export interface ChainBranches {
  /** The vehicle the chain is timed against is made. */
  asPlanned: ChainBranch
  /** It is not, and the next vehicle is the one actually taken. */
  nextVehicle: ChainBranch
}

/**
 * A deduced chain: the band, the margin it came from, and the plan behind it.
 *
 * `marginMinutes` is the BINDING value — the smallest margin of the chain, the
 * one `band` is read from — and `legs` carries each leg's own margin beside it,
 * so the row can show which boarding is the tight one. `branches` is present
 * exactly when the margin is inside the error magnitude and is the only case
 * where the row states two outcomes instead of one.
 */
export interface ChainDeduction {
  status: 'deduced'
  band: ChainMarginBand
  /** The tightest margin of the chain, in whole minutes, signed. */
  marginMinutes: number
  /** The `seq` of the leg that margin belongs to. */
  bindingSeq: number
  legs: readonly ChainLegDeduction[]
  /**
   * One mark for the whole chain, and `null` when its legs do not agree: one
   * word would then be false about part of the chain, so each leg's own mark is
   * what the row states.
   */
  provenance: DataProvenance | null
  /** The oldest reading this deduction used, epoch ms. */
  lastUpdatedAt: number
  /** Present only when `band` is `uncertain`. */
  branches?: ChainBranches
}

/**
 * Which recorded leg a refusal is about: the sequence the chain stores it under,
 * the line's stored id and its stored name.
 *
 * These travel together because they are one identity — 「哪一段、哪条线」 — and
 * each alone is useless to a page: a bare `seq` names no line, and a name could be
 * repeated on a chain. `lineId` is here so a refusal row can offer the SAME line
 * affordance a deduced row does (`ChainLegDeduction.lineId`): opening the line the
 * refusal is about needs its id, and without it the page would have to fetch the
 * chain again just to learn what its own refusal already named.
 *
 * None of the three is a fact about a READING; all are facts of the RECORD, which
 * is why they can be stated for a refusal whose leg was never read.
 */
export interface ChainNoConclusionLeg {
  /** The stored leg's `seq`, 0-based, exactly as the chain holds it. */
  seq: number
  /** The leg's stored `lineId` — the line the refusal is about. */
  lineId: string
  /** The leg's stored line name — what the row calls the line that refused. */
  lineName: string
}

/**
 * No deduction is possible, and which fact prevented it.
 *
 * A refusal is a code plus WHICH leg produced it, never a quantity about the
 * answer. The rule that nothing may sit beside a refusal is about numbers that
 * could be mistaken for an answer — a margin, a minute, a vehicle — and
 * `leg` is not one of those: it names the transfer point that refused (「第三段换
 * 乘点」) and the line there, which a two-leg chain cannot otherwise state at all.
 * The distinction is kept deliberately: `leg` carries no station, no minute and
 * no count, and a reader must not "complete" it into one.
 *
 * `updatedAt` and `operatingStatus` are the refusing leg's own reading — its
 * obtained-at and its F3 service state — and are absent when that leg was never
 * read (`no-live`, and every reason decided before a reading is needed). They
 * describe the data rather than the answer: F11's 最后更新时间 can sit beside the
 * refusal, and 首班前 / 已过末班 can govern an empty one, without a second read.
 */
export interface ChainNoConclusion {
  status: 'no-conclusion'
  reason: ChainNoConclusionReason
  /** The leg this refusal is about. Absent only for `no-legs`, which names no leg. */
  leg?: ChainNoConclusionLeg
  /** When the refusing leg's reading was obtained, epoch ms. Absent when it was not read. */
  updatedAt?: number
  /** The refusing leg's line service state. Absent when it was not read. */
  operatingStatus?: OperatingStatus
}

export type CommuteChainDeduction = ChainDeduction | ChainNoConclusion

/**
 * One recorded chain, with its own deduction — the shape the chain page reads.
 *
 * `deduction` is the engine's own {@link CommuteChainDeduction}, sent through
 * unchanged: the band, the minute and every 「不给结论」 reason are codes, and the
 * web layer owns every word the user reads. Nothing is added to it here, because
 * anything the server had to explain would be a second opinion about the same
 * readings.
 *
 * The chain's leg rows are deliberately NOT echoed beside it: each leg's answer
 * is in `deduction.legs`, and carrying the stored stations again would invite a
 * page to render a recorded platform and a live minute as if they came from one
 * place. The identifying fields are here because an answer has to say WHICH
 * recorded chain it belongs to.
 */
export interface CommuteChainDeductionView {
  chainId: string
  name: string
  originAnchor: CommuteChainAnchor
  purpose: CommuteChainPurpose
  deduction: CommuteChainDeduction
}

/**
 * The answer for one commute purpose: every chain serving it, each walked against
 * the same readings.
 *
 * One response rather than one per chain. The page shows the several chains of
 * the purpose the user is in, and N requests could be served from N poll windows
 * — the page would then compare 余量 computed from readings of different ages,
 * which is the 跳变 the PRD rules out. It also keeps the whole purpose on one set
 * of 18 s cache entries.
 *
 * `chains: []` is a real answer — this user has recorded none for this purpose —
 * and not an error.
 */
export interface CommuteChainDeductions {
  purpose: CommuteChainPurpose
  chains: CommuteChainDeductionView[]
}

/**
 * The band a margin falls in.
 *
 * Exported because the mapping IS the row's contract: the band and the minutes
 * printed beside it must be two views of one number, and a caller (or a test)
 * holding the number can check that without re-deriving the thresholds.
 */
export function chainMarginBandOf(
  marginMinutes: number,
  tightMarginMinutes: number = CHAIN_TIGHT_MARGIN_MINUTES,
): ChainMarginBand {
  // Below the resolution of the quantity itself: the sign is not knowable.
  if (Math.abs(marginMinutes) < CHAIN_ERROR_MAGNITUDE_MINUTES) return 'uncertain'
  // The vehicle the chain is timed against has already gone.
  if (marginMinutes < 0) return 'insufficient'
  // Inside the tolerance, on F1's own boundary: leave now or lose it.
  if (marginMinutes <= tightMarginMinutes) return 'tight'
  return 'comfortable'
}

/**
 * Walk the recorded chain against the live readings, or say why it cannot be
 * walked. Synchronous and without I/O; see the file header for the rules.
 */
export function deduceCommuteChain(input: CommuteChainDeductionInput): CommuteChainDeduction {
  if (input.legs.length === 0) return noConclusion('no-legs')

  const tightMarginMinutes = input.tightMarginMinutes ?? CHAIN_TIGHT_MARGIN_MINUTES
  const cycleExtraMinutes = input.cycleExtraMinutes ?? DEFAULT_CYCLE_EXTRA_MINUTES

  const plans: LegPlan[] = []
  /** The instant the user is free to start this leg's connection: now, then each alight moment. */
  let atSeconds = 0

  for (const [index, item] of input.legs.entries()) {
    const leg = item.leg
    /** WHICH leg a refusal here is about: the stored seq and the line's own id and name. */
    const who: ChainNoConclusionLeg = { seq: leg.seq ?? index, lineId: leg.lineId, lineName: leg.lineName }
    // An unset station is a legitimate state of a recorded chain, not an error to
    // paper over: nothing about this leg can be located in a line's stop list.
    if (
      leg.boardStationName === null || leg.boardStationOrder === null
      || leg.alightStationName === null || leg.alightStationOrder === null
    ) {
      return noConclusion('station-unset', who)
    }
    // Without the connection there is nothing to compare a departure against.
    // WHY it is missing is not knowable in here — the engine never prices a
    // connection — so the caller that tried states the cause and this maps it to
    // the code the page reads (see `ChainConnectionUnpricedReason`).
    if (item.connectionSeconds === null) {
      return noConclusion(connectionRefusalCode(item.connectionUnpricedReason), who)
    }
    // A leg must run in ONE direction of its line, and only the lineId says which
    // way is downstream. On a bus the two ways are two distinct lineIds, so a stored
    // `lineId` names one of them and an alight order below the board order is the
    // user's own entry the wrong way round. It must be decided HERE, ahead of the
    // empty-pair check below: upstream drops a vehicle once it is past the requested
    // order, so such a leg's two targeted reads share no id, and reporting that as
    // 「两个读数没有对上的车」 would blame this app's reading for the user's entry
    // while quoting no fix (see `ChainNoConclusionReason`).
    //
    // On a subway the ONE lineId carries both ways while numbering the same station
    // oppositely, so `alight < board` is a real ride the other way. The assembly
    // resolves that direction from these very orders, reads the opposite direction's
    // stop list and live data with both orders translated into its numbering, and
    // the reading handed here is already the leg's own — there is nothing to refuse.
    // (The subway test is the project's own convention rather than a second
    // predicate: the `subway_` id prefix is what routes a read to the subway engine
    // — `subway-router.ts`, `universal-subway.ts`, `transit.service.ts` — so both
    // layers ask the same question of the same field.)
    //
    // Boarding and alighting at ONE station is not a ride on any line, whatever the
    // mode: equality is refused for a bus and a subway alike.
    //
    // It sits AFTER the connection check on purpose: a PRICED connection means both
    // stored stations located in a stop list, so the two orders compare real
    // platforms on this line. A leg whose connection could not be priced is
    // therefore answered for by the code its cause maps to (see
    // `connectionRefusalCode`) — for a stored pair that did not locate, the generic
    // `connection-unpriced` — which is that leg's honest diagnosis, and flipping
    // its two ends would not be the fix. The schema rejects a bad record on write;
    // this is the same rule at the read end, for a row that is already stored.
    const runsDownstream = leg.alightStationOrder > leg.boardStationOrder
    const reverseSubway = leg.alightStationOrder < leg.boardStationOrder
      && leg.lineId.startsWith('subway_')
    if (!runsDownstream && !reverseSubway) {
      return noConclusion('leg-recorded-backwards', who)
    }

    const live = item.live
    if (live === null) return noConclusion('no-live', who)

    // F1's freshness rule, reused rather than restated: a reading past its limit
    // or served by a fallback source supports no conclusion.
    const trust = arrivalTrust({ isDegraded: live.isDegraded, updatedAt: live.updatedAt, now: input.now })
    if (trust !== 'ok') return noConclusion(trust, who, live)

    // F4 decides the KIND of vehicle, from the source that answered. An unknown
    // source yields no mark, and a leg with no mark cannot be concluded on.
    const vehicle = vehicleProvenanceOf(live.dataSource)
    if (vehicle === null) return noConclusion('provenance-unknown', who, live)

    const candidates = [...live.vehicles].sort(byBoardArrival)
    // Nothing paired — and TWO different facts produce this one empty list. The
    // board read carried nothing (nothing is on the way to this station), or it
    // carried vehicles and the two targeted reads share none of their ids — a
    // fact about our OWN reading, not about the service. It also covers the case
    // where the vehicles are there but nobody published a time for them: they were
    // counted, they could not be priced, and 「暂时无法确认可乘的班车」 is the
    // truthful answer (「暂时没有开往这一站的车」 would not be).
    // `boardVehiclesOnTheWay` is the board read's own carried count, so the two
    // are told apart rather than collapsed into 「没有可乘的车」.
    if (candidates.length === 0) {
      return noConclusion(live.boardVehiclesOnTheWay === 0 ? 'no-vehicle' : 'no-shared-vehicle', who, live)
    }

    // A leg's OWN extra applies to its connection whatever the mode: the stored
    // field is that leg's `transfer_extra_minutes` — minutes added to the
    // connection leading INTO the leg — and neither the field nor the chain
    // names a mode, so the engine cannot know a configured extra was meant for
    // cycling. Applying it to a walking connection too is the intended reading,
    // and it only ever tightens the margin: the user's own number is honoured
    // rather than dropped because the mode that motivated it is not stored. The
    // DEFAULT extra is the mode-specific one — added for a cycling connection
    // and nothing else, because 找车与停车 is a cost of cycling and of no other
    // mode.
    //
    // CLAMPED at zero, because it is a cost and can only move the ready moment
    // LATER. A negative one would put the user at the platform before they set
    // off, let a vehicle that left before that moment look catchable, and then
    // measure `marginMinutes` against a vehicle later than the one it names
    // `referenceVehicleId` — breaking the tie `ChainLegDeduction` states. The
    // stored field is guarded by the schema (`min(0)`), but `cycleExtraMinutes`
    // and a direct caller are not, and the invariant must not depend on a
    // caller's schema.
    const configuredExtraMinutes = leg.transferExtraMinutes
      ?? ((item.connectionMode ?? 'walk') === 'cycle' ? cycleExtraMinutes : 0)
    const extraMinutes = Math.max(0, configuredExtraMinutes)
    const readySeconds = atSeconds + item.connectionSeconds + extraMinutes * 60
    const atMinutes = minutesUntil(atSeconds)
    const readyMinutes = minutesUntil(readySeconds)

    // The vehicle that is next at this board station when the user sets off —
    // F10's actual question (「我出门能不能赶上换乘点那班车」) is about this one, not
    // about whichever bus happens to be catchable after a slow walk.
    const referenceIndex = candidates.findIndex(v => minutesUntil(v.arrivalAtBoardSeconds) >= atMinutes)
    // No vehicle still to come by the moment the user sets off: every one of them
    // had already reached this station. Only a leg the user does not start out
    // from can be here (leg 0 sets off at minute 0, so a future vehicle always
    // exists there) — the fact is 「都走了」, not a negative margin.
    if (referenceIndex < 0) return noConclusion('no-vehicle-at-departure', who, live)

    // The vehicle actually boarded: the first one that has not already gone by
    // the time the user gets there, decided on the minutes the row displays.
    const boardedIndex = candidates.findIndex(v => minutesUntil(v.arrivalAtBoardSeconds) >= readyMinutes)
    // The reference existed (asserted just above), so this can only mean it — and
    // everything behind it — reached the station before the connection was walked:
    // 「连走过去的那趟都赶不上」, a different fact from 'no-vehicle-at-departure'.
    if (boardedIndex < 0) return noConclusion('no-vehicle-after-connection', who, live)

    const reference = candidates[referenceIndex]!
    const boarded = candidates[boardedIndex]!
    // A drop-off minute that is not downstream of the boarding minute means the
    // two numbers do not describe one journey; no leg can be priced from them.
    if (boarded.arrivalAtAlightSeconds < boarded.arrivalAtBoardSeconds) {
      return noConclusion('inconsistent-live', who, live)
    }

    const provenance = arrivalProvenanceOf({ vehicle, basis: boarded.basis })
    // Type narrowing only, and it cannot fire: `vehicle` is non-null here (an
    // unknown source returned above), and `arrivalProvenanceOf` answers null only
    // for a null vehicle. `provenance-unknown` cannot arise at this point, whatever
    // a reader might expect — it is the code for the source check above it.
    if (provenance === null) return noConclusion('provenance-unknown', who, live)

    const boardMinutes = minutesUntil(boarded.arrivalAtBoardSeconds)
    const alightMinutes = minutesUntil(boarded.arrivalAtAlightSeconds)

    plans.push({
      seq: leg.seq ?? index,
      lineId: leg.lineId,
      lineName: leg.lineName,
      boarded,
      reference,
      // Only meaningful while the plan IS the reference: that is the one case
      // where the next vehicle is the second reading of an unresolved margin.
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

  // The chain's margin is its tightest boarding, not its first: a chain is only
  // as good as the connection it is most likely to miss. Ties keep the earlier
  // leg, so the same inputs always name the same boarding.
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

/** A leg once it has been walked: what was boarded, and the numbers the row shows about it. */
interface LegPlan {
  seq: number
  lineId: string
  lineName: string
  /** The vehicle boarded under the plan. */
  boarded: ChainLegVehicle
  /** The vehicle that was next at the board station when the user set off — what `marginMinutes` measures. */
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
 * The two readings of an unresolved margin. The second one names the vehicle that
 * would actually be taken when the first is missed, and states nothing when the
 * reading carries no vehicle after it — a branch with an invented 「下一班」 in it
 * would be exactly the false certainty this case exists to avoid.
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

/** The vehicle's own alight minute, or `null` when the two readings contradict each other. */
function alightMinutesOf(vehicle: ChainLegVehicle): number | null {
  return vehicle.arrivalAtAlightSeconds < vehicle.arrivalAtBoardSeconds
    ? null
    : minutesUntil(vehicle.arrivalAtAlightSeconds)
}

/**
 * The refusal code each cause of an unpriced connection travels under — one entry
 * per cause the caller can name.
 *
 * A TOTAL `Record` over `ChainConnectionUnpricedReason` rather than a chain of
 * comparisons, and that totality IS the contract: a cause added to that vocabulary
 * and left without an entry here is a COMPILE error, not prose that quietly stops
 * being true. The cause set behind a code is therefore read off this table — the
 * suite derives it with `Object.keys` — and never counted by hand, where a count
 * written down beside the union can only ever be a second copy of it that nothing
 * checks.
 *
 * The chain's own origin anchor is the ONE cause the user can act on, so it is the
 * only cause that travels under its own code — the same word F1's empty state uses
 * for the same fact. Every other cause — four today: every key here except
 * `anchor-unset` — and a caller that names none, is the generic
 * `connection-unpriced`: which of them fired changes no word the page can honestly
 * write and no action it can offer, and their exact cause set is stated on
 * `ChainNoConclusionReason`, together with the permanence constraint that governs
 * the one sentence a page writes for that code.
 */
export const CONNECTION_REFUSAL_CODES: Record<ChainConnectionUnpricedReason, ChainNoConclusionReason> = {
  'anchor-unset': 'anchor-unset',
  'line-unavailable': 'connection-unpriced',
  'station-unlocated': 'connection-unpriced',
  'station-without-coordinate': 'connection-unpriced',
  'route-unpriced': 'connection-unpriced',
}

/**
 * The refusing code for a connection that has no priced duration.
 *
 * A caller that names no cause states none at all and reaches
 * `connection-unpriced`, the only way into that code that carries no cause of its
 * own. Every named cause is resolved by `CONNECTION_REFUSAL_CODES` above.
 */
function connectionRefusalCode(reason?: ChainConnectionUnpricedReason): ChainNoConclusionReason {
  return reason === undefined ? 'connection-unpriced' : CONNECTION_REFUSAL_CODES[reason]
}

/**
 * Whole minutes until a moment `seconds` from now — F1's own arrival rule
 * (`arrivalMinutes`), applied to EVERY moment in the deduction: a vehicle reaching
 * a board station, the user reaching a board station, a vehicle reaching an alight
 * station. One rule for all of them is what keeps a margin, the band read from it
 * and the numbers printed beside it from disagreeing in the same row.
 */
function minutesUntil(seconds: number): number {
  return arrivalMinutes(seconds)
}

/** Board-station arrival first, then the vehicle id, so ties do not depend on the order the payload happened to use. */
function byBoardArrival(a: ChainLegVehicle, b: ChainLegVehicle): number {
  return a.arrivalAtBoardSeconds - b.arrivalAtBoardSeconds || a.vehicleId.localeCompare(b.vehicleId)
}

/**
 * A refusal, with WHICH leg it is about and — when that leg was read — the
 * reading's own obtained-at and F3 service state.
 *
 * `reading` is the leg's whole live reading, so the two facts travel as one and
 * cannot be filled in from anywhere else: they are that reading's, not the row's.
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
