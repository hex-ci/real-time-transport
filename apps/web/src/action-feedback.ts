import { toast } from 'vue-sonner'
import { TOAST_ITEM_CLASS } from '@/refresh-toast'

/**
 * 用户按下的动作用一句话回答：成功一句确认，失败一句原因。
 *
 * 这是本仓与提示库之间的第二处接缝（刷新结局那一处是 `refresh-toast.ts`）：措辞只有下面这一张表，
 * 页面与 store 只报出「按下的是哪个动作、这次动的是谁」，故同一个动作在几处按下说的话一致，
 * 也没有哪一页自己措辞一次。库换了要改的只有这两个文件。
 *
 * 只在用户按下的东西上推话。界面上立刻看得见其变化的动作不推 —— 模式、目的、方向、城市的切换、
 * 导航跳转、展开线路工具，它们的变化就是它们自己的回答；后台或装饰性的请求落空同样不推，
 * 那里静默是刻意的（例如地标解析）。
 *
 * 维护规矩：
 * 1. 新的用户动作反馈一律进这张表，不在组件里手写 `toast(...)` —— 文案是产品决策，要能被 diff 审。
 * 2. `FeedbackContext` 是健康指标：字段数涨了说明不同动作的上下文根本不一样，此时按动作分组
 *    拆 context 类型，而不是继续往接口里加可选字段。
 * 3. 措辞跟场景强绑定的用 lambda 写，不硬套统一句式；ok/fail 二元只保证「一个动作一个结局」，
 *    不保证所有动作说同样的话。
 */

/**
 * 一次定位为什么没有结果。
 *
 * 三种各有各的下一步，故不能并成一句：「不支持」是换浏览器，「被拒」是去系统设置里放行，
 * 而取不到或超时只是这一次没成，值得再试一次。设备报的 `TIMEOUT` 与 `POSITION_UNAVAILABLE`
 * 让用户做的事相同，故合成同一个 `unavailable`。
 */
export type LocationFailure = 'unsupported' | 'denied' | 'unavailable'

/**
 * 一次动作的上下文：这次动的是谁，以及它为什么没成。
 *
 * `name` 由调用方给出（线路名、链路名、锚点名……），`error` 由包装器填入被拒的原文 ——
 * 表里那一条自己决定要不要把原因说出来：服务端的契约消息很短、值得带上，
 * 而定位这类一失败就是整句话的，带上会把一句提示撑成一屏。
 */
export interface FeedbackContext {
  name?: string
  reason?: LocationFailure
  landmark?: string
  /** 位置来自开发模拟，不是设备真的定位到的那一个。 */
  simulated?: boolean
  error?: string
}

/** 一次动作的两种结局各说什么。 */
export interface FeedbackCopy {
  ok: (context: FeedbackContext) => string
  fail: (context: FeedbackContext) => string
}

/** 「 52」——有对象就点名它，没有就不带（是 `null`，绝不是一个空的引号）。 */
function named(context: FeedbackContext): string {
  return context.name ? ` ${context.name}` : ''
}

/** 「 · 原因」——被拒的原文，包装器已经确认它与表里那句话不是同一句。 */
function why(context: FeedbackContext): string {
  return context.error ? ` · ${context.error}` : ''
}

/** 「家」——锚点的名字；没有名字时是那个记号本身，而不是一对空引号。 */
function quoted(context: FeedbackContext): string {
  return `「${context.name ?? '锚点'}」`
}

/**
 * 动作 → 它两种结局各说什么。唯一一处措辞。
 *
 * `satisfies` 使每一项都必须是完整的两句：成功与失败各一句，漏掉一句是编译错误，
 * 而不是用户按下一个什么都不说的按钮。
 */
export const ACTION_FEEDBACK = {
  'location': {
    ok: (context) => {
      if (context.simulated) return '已获取位置 · 开发模拟'
      return `已获取位置${context.landmark ? ` · ${context.landmark}` : ''}`
    },
    fail: (context) => {
      if (context.reason === 'unsupported') return '此浏览器不支持定位'
      if (context.reason === 'denied') return '定位权限被拒，请在系统设置里允许'
      return '暂时无法定位，请稍后再试'
    },
  },
  'favorite-add': {
    ok: context => `已关注${named(context)}`,
    fail: context => `关注失败${named(context)}${why(context)}`,
  },
  'favorite-remove': {
    ok: context => `已取消关注${named(context)}`,
    fail: context => `取消关注失败${named(context)}${why(context)}`,
  },
  'favorite-reorder': {
    ok: () => '顺序已更新',
    fail: context => `顺序保存失败${why(context)}`,
  },
  'favorite-save': {
    ok: () => '已保存关注设置',
    fail: context => `保存失败${why(context)}`,
  },
  'favorite-board-stop': {
    ok: () => '已保存上车点',
    fail: context => `上车点保存失败${why(context)}`,
  },
  'followed-station-save': {
    ok: () => '已保存关注站',
    fail: context => `关注站保存失败${why(context)}`,
  },
  'commute-hours-save': {
    ok: () => '已保存通勤时段',
    fail: context => `通勤时段保存失败${why(context)}`,
  },
  'refresh-interval-save': {
    ok: () => '已保存刷新间隔，实时数据将按新节拍更新',
    fail: context => `刷新间隔保存失败${why(context)}`,
  },
  'anchor-save': {
    ok: context => `已保存${quoted(context)}的位置`,
    // 服务端的拒绝（例如坐标不在服务范围内）与设备定位失败是两件事，故原文跟上来。
    fail: context => `未能保存${quoted(context)}的位置${why(context)}`,
  },
  'chain-save': {
    ok: context => `已保存链路${named(context)}`,
    fail: context => `链路保存失败${named(context)}${why(context)}`,
  },
  'chain-remove': {
    ok: context => `已删除链路${named(context)}`,
    fail: context => `链路删除失败${named(context)}${why(context)}`,
  },
  'chain-reorder': {
    ok: () => '顺序已更新',
    fail: context => `顺序保存失败${why(context)}`,
  },
} satisfies Record<string, FeedbackCopy>

/**
 * 一次动作的全部结局。
 *
 * 它**取自**那张表：一个动作只因在表里有一句话而存在，故加了一个动作却忘了给它文案这件事
 * 根本写不出来，而传错动作名是编译错误。
 */
export type FeedbackAction = keyof typeof ACTION_FEEDBACK

/** 结局的色调：只说它成了还是没成，话本身携带状态。 */
const TONE_OF = { ok: 'text-cyan-300', fail: 'text-rose-300' } as const

/** 这一次动作说的那句话 —— 从表里查出，再按这次的对象与原因填好。 */
export function feedbackTextOf(
  action: FeedbackAction,
  kind: keyof typeof TONE_OF,
  context: FeedbackContext = {},
): string {
  return ACTION_FEEDBACK[action][kind](context)
}

/**
 * 这次动作的结局说一次。
 *
 * 不给固定 id：同一个结局连着发生两次也该各说一次，而库按 id 会把第二条读成第一条的更新。
 * 时长是库自己的默认值 —— 这几句是一次回答，说完就退场；只有要逐秒改写自己的那条（刷新冷却）
 * 才需要固定身份与不自动退场。
 */
export function announceActionFeedback(
  action: FeedbackAction,
  kind: keyof typeof TONE_OF,
  context: FeedbackContext = {},
): void {
  toast(feedbackTextOf(action, kind, context), {
    class: `${TOAST_ITEM_CLASS} ${TONE_OF[kind]}`,
  })
}

/**
 * 一次按下的结局说一次：成功一句，被拒一句后原样重抛。
 *
 * 运行体解析为 `false` 表示这一次什么都没改变（例如该线路已经被关注），于是什么都不说 ——
 * 界面自己那一处已经陈述了那个状态，而「已关注」不是这一次按下的成绩。
 *
 * 重抛而不是吞掉：页面可以据此在字段旁留下持久的那一份（toast 几秒就走）。不留内联的页面自己
 * 吞掉它 —— 例如首页的置顶，卡片自身被回滚就是记录，页上不再说第二遍。
 */
export async function runWithFeedback<T>(
  action: FeedbackAction,
  run: () => Promise<T>,
  context: FeedbackContext = {},
): Promise<T> {
  try {
    const result = await run()
    if (result !== false) announceActionFeedback(action, 'ok', context)
    return result
  }
  catch (err) {
    announceActionFeedback(action, 'fail', { ...context, error: rejectionOf(action, context, err) })
    throw err
  }
}

/**
 * 被拒的原文，或 `undefined`。
 *
 * 表里那句话已经说了这是一次失败，故只有点出具体成因的原文才跟上去：store 与界面自己的缺省
 * 消息就是一句「……失败」（`保存失败`、`位置保存失败`），跟上去只是同一件事换个说法，而逐字
 * 相同的那句更不必说两遍。判据是**整句就是它**（以「失败」收尾），而不是「含这两个字」——
 * 服务端的拒绝会把成因写在一句话里（`家位置坐标为 (0, 0)，通常是定位失败，请重新定位`），
 * 那种恰恰是最该带上的。
 */
function rejectionOf(
  action: FeedbackAction,
  context: FeedbackContext,
  err: unknown,
): string | undefined {
  const message = err instanceof Error ? err.message.trim() : ''
  if (!message || message.endsWith('失败')) return undefined
  return feedbackTextOf(action, 'fail', context).includes(message) ? undefined : message
}
