import type { UserSettings } from '@real-time-transport/shared'
import { isAnchorSet, pickAnchors, type StoredAnchors } from './anchors'
import type { ReadValue } from '@/read-state'

/**
 * 设置索引行可以就自己那个域说什么。
 *
 * 行把**当前状态**作为事实陈述，而关于一次读取的事实有三种、不是两种：仍在读取、
 * 读取失败、已读到。第二种必须与第一种可区分，并照原样陈述——「读不到就是读不到」——
 * 故模型携带「读取失败」，而不是把它折成一个空值。下面每个措辞函数都对三种状态穷尽，
 * 没有一个留有可退回的默认值。
 *
 * 「读取中…」是唯一对已存记录什么都不说的状态，但它仍要说：读取作答前保持沉默的行，
 * 看起来像一行没有事实。
 *
 * 三种状态本身来自 `@/read-state`——四个子页面与设置以外的界面读关注线路 store 用的是
 * 同一套模型——故索引不会漂出第四种。设置行只新增自己的一员（`unset`），而
 * `settingsReadOf` 是把 `/settings` 应答变成这些状态的唯一处。
 */

/** 索引行可以陈述的值：读取中、读不到、已读到。 */
export type SummaryValue<T> = ReadValue<T>

/**
 * 设置域的值：上面三种状态，加上设置行新增的两种。
 *
 * `unset`——读取已作答且没有记录：没人存过任何东西，故没有东西可印，也没什么可道歉的。
 *
 * `unchosen`——读取已作答、记录存在，但四个时刻从未被选过（线路上为 `null`）。
 * 它是第三种事实，不是另两种的变体：`unset` 对记录说错（记录在，可能带锚点），
 * `read` 对时刻说错（没人选过，故没有窗口可印）。
 *
 * 自带一员而不并入 `unset`，因为两者在一个界面会据以行动的事实上不同：有没有一条已存
 * 记录可供更新。用户读到的**词**相同（「未设置」），而那个共享的词是 `hoursText` 的事，
 * 不是本模型的。绝不能发生的，是把 `null` 印成一个时刻；这个状态就是让它不可能发生的东西。
 */
export type SettingsSummaryValue<T> = SummaryValue<T> | { state: 'unset' } | { state: 'unchosen' }

/** 仍在读取。首次作答前，关于已存记录一无所知。 */
function reading(): string {
  return '读取中…'
}

/** 读取失败。每行共用这一种措辞。 */
export function unreadableText(): string {
  return '未读到'
}

/** 当前城市关注了多少条线路。 */
export function followedLinesText(value: SummaryValue<number>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  return `已关注 ${value.value} 条`
}

/** 录入了多少条链路。 */
export function chainsText(value: SummaryValue<number>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  return `已录入 ${value.value} 条`
}

/**
 * 已保存的时段，按折叠摘要自己的写法。
 *
 * 一个值只有一种拼法，由索引行与通勤时段页的折叠卡片共享——
 * 两种拼法会让同一条已存时段读成两个不同的设置。
 */
export function hoursSummaryOf(hours: UserSettings): string {
  return `${hours.morningStart}–${hours.morningEnd} · ${hours.eveningStart}–${hours.eveningEnd}`
}

/**
 * 未设置：读取已作答且没有时段可展示——没有记录，或记录里的四个时刻从未被选过。
 * 这是对一个无人保存过的值的措辞，而**不是**「未读到」——后者是对失败读取的断言。
 */
export function unsetText(): string {
  return '未设置'
}

/**
 * 已保存的时段；设置记录读不到时为「未读到」，没有时段时为「未设置」——
 * 没有记录，或记录里的时刻从未被选过。
 */
export function hoursText(value: SettingsSummaryValue<UserSettings>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  // 两种事实对用户读起来一样，且都不是时刻：「未设置」是摘要对不存在的窗口所说的话。
  // 两种状态区分开的是那条记录是否存在（编辑器据此行动）；
  // 它们绝不能产出的，是一个被印出来的时刻。
  if (value.state === 'unset' || value.state === 'unchosen') return unsetText()
  return hoursSummaryOf(value.value)
}

/**
 * 每个锚点自己的状态：两者都是设置记录，一个词覆盖这一对，
 * 就会对其中的另一个说错。
 */
export function anchorsText(value: SummaryValue<StoredAnchors>): string {
  if (value.state === 'reading') return reading()
  if (value.state === 'unreadable') return unreadableText()
  const home = isAnchorSet(value.value, 'home') ? '已设置' : '未设置'
  const work = isAnchorSet(value.value, 'work') ? '已设置' : '未设置'
  return `家 ${home} · 公司 ${work}`
}

/**
 * `/settings` 应答里的四个时刻；应答没把它们作为时刻携带时为 null。
 *
 * null 不是「未设置」：它同时覆盖「本屏读不成的记录」与「时刻为 NULL（从未被选过）的记录」，
 * 由调用方区分——下面的 `timesUnchosen` 是后者。
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

/** 已存记录的四个时刻，每个都显式为 `null`。 */
const TIME_KEYS = ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const

/**
 * 一条已存记录是否逐列陈述它的四个时刻都没被选过。
 *
 * 每个键都必须**存在**且为 `null`：省略时刻的响应体是本屏读不成的记录，而 null 与时刻
 * 混用是写入契约拒绝存储的半成品——两者都不是「未设置」（那是对用户选择的主张），
 * 故都归为读不到。
 */
function timesUnchosen(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false
  return TIME_KEYS.every(key => key in data && data[key] === null)
}

/** 设置域的一行所陈述的两个事实，各处于自己的状态。 */
export interface SettingsRead {
  hours: SettingsSummaryValue<UserSettings>
  anchors: SummaryValue<StoredAnchors>
}

/**
 * `GET /api/transit/settings` 应答的唯一读法，供每个展示它的界面使用。
 *
 * 应答携带读取的状态（`settingsState`）以及记录（如果有）。四种结果只在此处区分：
 *
 *  - `unset`——读取已作答且没有记录。四个时刻报为「未设置」，绝不用内置窗口。
 *    同一应答里的锚点各自是真实的「未设置」：锚点是记录的一列，故没有记录的存储
 *    没有存过锚点——那是关于记录的事实，不是猜测。
 *  - `unchosen`——记录在，四个时刻为 `null`。时刻报 `unchosen`、锚点报已读到：
 *    两者是同一记录的不同列，仅设置锚点而保存的记录正是这个形状。
 *  - `stored`——记录照其原样读取：四个时刻，以及各锚点自己的 null。
 *  - 其余一切——拒绝、缺少 `settingsState`、自相矛盾的响应体（`unset` 带记录）、
 *    时刻半 null 半有值、或省略时刻——都是读不到。「未设置」会是对已存记录一个
 *    无人核实过的主张，而自相矛盾应答里的值更糟：这一对必须一致，否则这次读取不算读到。
 *
 * 只此一个函数，因为索引行与通勤时段页展示的是同一条记录：两个解析器就是两次对
 * 「未设置」含义产生分歧的机会，而分歧正是关于已存记录的谎言会出现的地方。
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
