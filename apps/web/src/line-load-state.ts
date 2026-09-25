/**
 * The line page's two absent states, and the one sentence each of them states.
 *
 * WHY THE TWO ARE SPLIT. A line id that does not exist and a read that failed are
 * different facts, and the page used to answer both with one sentence: the server's
 * own `error` string was rendered as the heading — 「Line not found」 in an app whose
 * every other string is zh-CN — above 「未能加载该线路数据，请稍后重试或检查线路号」.
 * That single sentence promised a retry that cannot help a line that does not exist,
 * and told the user to check a 线路号 that is correct by construction (it came from
 * the route, not from a form).
 *
 * The HTTP status is what tells them apart, and only the status does: 404 is the
 * detail route's own 「no such line」 answer, and anything else the read can produce
 * — a 5xx, a 200 whose body says the upstream had nothing, a request that never
 * arrived — is a load that failed and may succeed later. So each state states its own
 * cause and its own action:
 *
 * - `not-found`  the line does not exist: check the address, or pick the line again.
 *                No 「稍后重试」 — nothing about waiting changes this answer.
 * - `unavailable` the data did not load: the retry is honest here, and it is the only
 *                state that offers one.
 *
 * The wording lives here rather than in the component so it can be asserted as text
 * (this app has no DOM harness), and the component renders what this returns.
 */

/** The two ways a line can be absent, each a fact of its own. */
export type LineLoadState = 'not-found' | 'unavailable'

/**
 * Which of the two an answer at this HTTP status means.
 *
 * 404 is the detail route's own refusal: it answers it when no detail could be
 * produced for the requested id. Every other status — a 5xx, or a 200 whose body
 * carries no detail — is a read that did not deliver, which is the state that may
 * change on a second attempt.
 */
export function lineLoadStateOf(status: number): LineLoadState {
  return status === 404 ? 'not-found' : 'unavailable'
}

/**
 * What the page states for one of the two states: a heading and the sentence under it.
 *
 * Both are zh-CN and neither carries a Latin letter: the app has no i18n and every
 * other string is hardcoded Chinese, so a server-side `error` string must never reach
 * a heading (the defect this module replaces).
 */
export function lineLoadNoticeOf(state: LineLoadState): { title: string, detail: string } {
  if (state === 'not-found') {
    return {
      title: '线路不存在',
      // The action is the one that can change the answer: the address names a line
      // that is not there, so the line has to be chosen rather than waited for.
      detail: '没有找到这个线路号，请返回总览重新选择线路',
    }
  }
  return {
    title: '线路数据加载失败',
    // The one state where retrying is a real answer.
    detail: '未能加载该线路数据，请稍后重试',
  }
}
