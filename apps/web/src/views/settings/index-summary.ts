import type { UserSettings } from '@real-time-transport/shared'
import { isAnchorSet, pickAnchors, type StoredAnchors } from './anchors'
import type { ReadValue } from '@/read-state'

/**
 * What a 设置 index row may say about its own domain.
 *
 * The row states the CURRENT STATE as a fact, and a fact about a read has three states,
 * not two: still reading, READ AND FAILED, and read. §4.1 requires the second one to be
 * distinguishable from the first and to be told as itself — 「读不到就是读不到」 — so the
 * model carries a read that failed rather than folding it into an empty value. Every
 * wording function below is therefore total over the three, and none of them has a
 * default to fall back on: the collapsed 通勤时段 summary used to keep `06:30–11:30` when
 * `GET /api/transit/settings` threw, which reads as the user's own configuration.
 *
 * 「读取中…」 is the one state that says nothing about the stored row, and it is stated
 * anyway: a row that is silent before its read answers looks like a row with no fact.
 *
 * The three states themselves are `@/read-state`'s — the same model the four sub-pages and
 * the screens outside 设置 read the followed-lines store through — so the index cannot
 * drift into a fourth one. The settings row adds exactly one member of its own (`unset`),
 * and `settingsReadOf` is the single place a `/settings` answer is turned into these
 * states: the index row, the 通勤时段 page and the hours editor all read through it, so
 * none of them can decide for itself what 「未设置」 means.
 */

/** A value the index may state: pending, unreadable, or read. */
export type SummaryValue<T> = ReadValue<T>

/**
 * A SETTINGS-domain value: the three states above, plus the two a settings row adds.
 *
 * `unset` — the read answered and there is NO row. §4.1 separates 读失败 from 确实为空,
 * and this is the second: nobody stored anything, so there is nothing to print and
 * nothing to apologise for.
 *
 * `unchosen` — the read answered, the row EXISTS, and the four times on it were never
 * chosen (`null` on the wire since 009 dropped the columns' NOT NULL DEFAULT). It is
 * a third fact, not a shade of the other two: `unset` would be false about the row
 * (there is one — it may carry anchors), and `read` would be false about the times
 * (nobody picked them, so there is no window to print). Before 009 this state was
 * unrepresentable: an anchors-only write stored the built-in window, so the row came
 * back looking exactly like a user who had configured 06:30–11:30 / 17:00–22:00, and
 * every surface below printed it as his own.
 *
 * Its own member rather than being folded into `unset`, because the two differ in a
 * fact a surface acts on: whether a saved row is there to be updated. The WORD the
 * user reads is the same (「未设置」) — from where he stands, 「我还没设置过通勤时段」 is
 * true in both cases — and that shared word is `hoursText`'s business, not this
 * model's. What must never happen is a `null` being printed as a time; the state is
 * what makes that impossible.
 */
export type SettingsSummaryValue<T> = SummaryValue<T> | { state: 'unset' } | { state: 'unchosen' }

/** Still reading. Before the first answer nothing about the stored row is known. */
function reading(): string {
  return '读取中…'
}

/** Read and FAILED. The one wording every row shares for it. */
export function unreadableText(): string {
  return '未读到'
}

/** How many lines of the active city are followed. */
export function followedLinesText(value: SummaryValue<number>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  return `已关注 ${value.value} 条`
}

/** How many chains are recorded. */
export function chainsText(value: SummaryValue<number>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  return `已录入 ${value.value} 条`
}

/**
 * The saved hours, in the collapsed summary's own wording: `06:30–11:30 · 17:00–22:00`.
 *
 * One spelling of one value, shared by the index row and the 通勤时段 page's collapsed
 * card — two spellings would let the same stored hours read as two different settings.
 */
export function hoursSummaryOf(hours: UserSettings): string {
  return `${hours.morningStart}–${hours.morningEnd} · ${hours.eveningStart}–${hours.eveningEnd}`
}

/**
 * 未设置: the read answered and there are no hours to show — no row at all, or a row
 * whose four times were never chosen. §4.1's own word for a value nobody saved, and
 * NOT 「未读到」, which is a claim about a read that failed.
 */
export function unsetText(): string {
  return '未设置'
}

/**
 * The saved hours, or 「未读到」 when the settings row could not be read, or 「未设置」
 * when there are none — no row, or a row whose times were never chosen.
 */
export function hoursText(value: SettingsSummaryValue<UserSettings>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  // Both facts read the same to the user, and neither is a time: 「未设置」 is what a
  // summary says about a window that is not there. What the two states keep apart is
  // whether a row exists (the editor acts on that); what they must never produce is a
  // printed hour.
  if (value.state === 'unset' || value.state === 'unchosen') return unsetText()
  return hoursSummaryOf(value.value)
}

/**
 * Each anchor's own state: both are settings rows, and one word for the pair would be
 * false about whichever of them differs. 已设置 / 未设置 are §4.1's own two words.
 */
export function anchorsText(value: SummaryValue<StoredAnchors>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  const home = isAnchorSet(value.value, 'home') ? '已设置' : '未设置'
  const work = isAnchorSet(value.value, 'work') ? '已设置' : '未设置'
  return `家 ${home} · 公司 ${work}`
}

/**
 * The four times out of a `/settings` answer, or null when the answer did not carry
 * them as times.
 *
 * Null is not 「未设置」: it covers both a row this screen cannot read as a schedule and
 * a row whose times are NULL (never chosen). The two are told apart by the caller, which
 * knows which case it is looking at — `timesUnchosen` below is the second one.
 */
export function hoursOf(data: Record<string, unknown> | null | undefined): UserSettings | null {
  const keys = ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const
  if (!data || !keys.every(key => typeof data[key] === 'string')) return null
  return {
    morningStart: data.morningStart as string,
    morningEnd: data.morningEnd as string,
    eveningStart: data.eveningStart as string,
    eveningEnd: data.eveningEnd as string,
  }
}

/** The four times of a stored row, each an explicit `null`. */
const TIME_KEYS = ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const

/**
 * Whether a stored row states, column by column, that none of its four times was chosen.
 *
 * Every key must be PRESENT and `null`: a body that omits the times is a row this screen
 * cannot read (the endpoint always sends all four), and one that mixes nulls with times
 * is the half-written window the write contract refuses to store — neither is 「未设置」,
 * which is a claim about the user's choices, so both go to `unreadable` instead.
 */
function timesUnchosen(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false
  return TIME_KEYS.every(key => key in data && data[key] === null)
}

/** The two facts a settings-domain row states, each in its own state. */
export interface SettingsRead {
  hours: SettingsSummaryValue<UserSettings>
  anchors: SummaryValue<StoredAnchors>
}

/**
 * THE reading of a `GET /api/transit/settings` answer, for every surface that shows it.
 *
 * The answer carries the state of the read (`settingsState`) and the row when there is
 * one. Four outcomes are told apart here and nowhere else:
 *
 *  - `unset` — the read answered and found no row. The four times are reported as
 *    「未设置」, never as the built-in window. The anchors of that same answer are a real
 *    「未设置」 each: an anchor is a column of the row, so a store with no row has stored
 *    no anchor — that is a fact about the row, not a guess about it.
 *  - `unchosen` — the row is there and its four times are `null`: nobody ever chose a
 *    window (since 009 that is what the columns hold, and the endpoint sends the nulls).
 *    Reported as `unchosen` for the hours and READ for the anchors, because the two are
 *    different columns of that one row: a row saved by setting an anchor alone is
 *    exactly this shape, and it has a real anchor.
 *  - `stored` — the row is read for what it is: the four times, and each anchor by its
 *    own null.
 *  - everything else — a refusal, a missing `settingsState`, a body that contradicts
 *    itself (`unset` carrying a row), a row whose times are half `null` and half times,
 *    or one that omits them — is UNREADABLE. 「未设置」 would be a claim about the stored
 *    row that nobody verified, and a value from a self-contradicting answer is worse:
 *    the pair must agree or the read is not read.
 *
 * One function, because the index row and the 通勤时段 page show the same row: two parsers
 * are two chances to disagree about what 「未设置」 means, and that disagreement is exactly
 * where a lie about the stored row would appear.
 */
export function settingsReadOf(body: unknown): SettingsRead {
  const answer = body as { success?: unknown, settingsState?: unknown, data?: unknown } | null | undefined
  if (!answer || answer.success !== true) {
    return { hours: { state: 'unreadable' }, anchors: { state: 'unreadable' } }
  }

  if (answer.settingsState === 'unset') {
    const empty = answer.data === null || answer.data === undefined
    return empty
      ? { hours: { state: 'unset' }, anchors: { state: 'read', value: pickAnchors(null) } }
      : { hours: { state: 'unreadable' }, anchors: { state: 'unreadable' } }
  }

  if (answer.settingsState === 'stored') {
    const data = answer.data as Record<string, unknown> | null | undefined
    const hours = hoursOf(data)
    if (hours) {
      return { hours: { state: 'read', value: hours }, anchors: { state: 'read', value: pickAnchors(data) } }
    }
    if (timesUnchosen(data)) {
      return { hours: { state: 'unchosen' }, anchors: { state: 'read', value: pickAnchors(data) } }
    }
    return { hours: { state: 'unreadable' }, anchors: { state: 'unreadable' } }
  }

  return { hours: { state: 'unreadable' }, anchors: { state: 'unreadable' } }
}
