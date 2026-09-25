import type {
  ChainMarginBand,
  CommuteChainDeduction,
  CommuteChainPurpose,
  DataProvenance,
} from '@real-time-transport/shared'

/**
 * F10's chain page, as its own render models.
 *
 * The engine's answer is a DECISION — a band read from a signed margin, or a
 * refusal code — and this page only reads it. Nothing below adds a fact to that
 * decision: every number is the engine's own, every word is the page's
 * (`margin.ts`, `refusal.ts`), and where the engine stated no value the model
 * carries null rather than a stand-in. The engine's internal vehicle ids are
 * deliberately absent: they decide WHICH vehicle a margin belongs to, which
 * `margin.ts` settles, and no screen in this app prints one.
 */

/** One purpose chip's own identity. */
export interface PurposeOption {
  purpose: CommuteChainPurpose
  label: string
}

/**
 * One transfer, as its row renders it.
 *
 * The row is about ONE vehicle — the one being boarded — except for `marginText`,
 * which is stated only while the vehicle it measures is still there. In the case
 * where it is not, `referenceGone` is true, `marginMinutes`/`marginText` are null
 * (a negative margin beside the vehicle about to be boarded is the failure this
 * model exists to prevent) and `basisText` says the row's numbers belong to the
 * next vehicle.
 */
export interface TransferRowView {
  /** The stored leg's `seq`. */
  seq: number
  /** 「第 2 段」 — the transfer point this row is. */
  positionText: string
  lineName: string
  /** The band of THIS leg's margin — the same number `marginMinutes` carries. */
  band: ChainMarginBand
  bandLabel: string
  verdict: string
  /** Which vehicle is taken, in the user's terms: this one, or the next one. */
  vehicleText: string
  /** Whole minutes of platform wait for the boarded vehicle. Never negative. */
  waitMinutes: number
  waitText: string
  /** The margin printed, or null when it must not be printed. */
  marginMinutes: number | null
  marginText: string | null
  /** What the row's numbers are measured against. Always stated. */
  basisText: string
  referenceGone: boolean
  rideText: string
  alightText: string
  /** F4's kind for this leg's own numbers, straight from the engine. */
  provenance: DataProvenance
}

/** One reading of a margin too small to resolve. */
export interface BranchView {
  outcomeText: string
  /** The vehicle and its minute, or the absence of either — stated as absent. */
  detailText: string
}

/** A deduced chain, as its card renders it. */
export interface ChainConclusionView {
  band: ChainMarginBand
  bandLabel: string
  verdict: string
  /** The chain's tightest margin, printed only while its vehicle is still there. */
  marginMinutes: number | null
  marginText: string | null
  /** The transfer the binding margin belongs to. */
  bindingSeq: number
  bindingText: string
  /** Present exactly when the binding margin is unresolvable. */
  branches: BranchView[] | null
  legs: TransferRowView[]
}

/**
 * The one action a refusal can offer. It lives on 设置's anchor card.
 *
 * The anchor is the only refusal cause with a screen behind it, so this stays a one-member
 * type: a refusal never offers the chain-recording page, because a refusal is not an absent
 * chain — one is recorded and cannot be walked.
 */
export type RefusalAction = 'settings'

/**
 * The screen an empty state may offer, which is one more than a refusal has.
 *
 * An empty purpose has two causes and each has its own page: an anchor the user never saved
 * is repaired on 设置's 位置锚点 page (`'settings'`), and a chain nobody has recorded is
 * recorded on its 通勤链路 page (`'chains'`). `'chains'` is offered BECAUSE that surface
 * exists — an empty state that named a screen the build does not have would promise a
 * control nobody can press.
 */
export type EmptyStateAction = RefusalAction | 'chains'

/** A refusal, as its card renders it: a code, its one sentence, and the transfer. */
export interface RefusalView {
  /** The engine's own code, verbatim — the page never re-words it. */
  reason: string
  sentence: string
  /** 「第 2 段 · 快线 1 路」, or null for a chain that names no leg. */
  legText: string | null
  /** F3's service state, worded, for the refusals whose empty answer is about the service day. */
  serviceText: string | null
  action: RefusalAction | null
}

/** A reading's own instant, with the kind of value the answer is. */
export interface ChainReadingView {
  time: string
  mark: string | null
  text: string
}

/** The page's empty state, when nothing is recorded for the purpose on screen. */
export interface ChainEmptyStateView {
  headline: string
  detail: string | null
  action: EmptyStateAction | null
}

/** One chain, as its card is rendered. */
export interface ChainCardView {
  chainId: string
  name: string
  /** 「从「家」出发」 — the chain's own stored start. */
  originText: string
  /** The answer when there is one, and null when the chain refused. */
  conclusion: ChainConclusionView | null
  /** The refusal when there is one, and null when the chain concluded. */
  refusal: RefusalView | null
  /**
   * F4's chain-level KIND, verbatim — null when its legs disagree, which is what
   * makes every leg state its own mark instead.
   */
  chainProvenance: DataProvenance | null
  /** The reading the answer came from; null for a leg that was never read. */
  reading: ChainReadingView | null
  /** The engine's answer, verbatim — what the page's own tests compare against. */
  deduction: CommuteChainDeduction
}
