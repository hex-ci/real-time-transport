import type { DepartureAdvice, DepartureReference } from '@real-time-transport/shared/departure'

/**
 * F1 的参考行，作为文本。
 *
 * 放在卡片组件之外，是为了让措辞成为可断言的事实，而不是只有浏览器能检查的模板。这里 F1 严格
 * 的一点是：不同的状态读起来绝不能一样 ——「暂无数据」不是「不用着急」，缺失的值也永远不会被
 * 打扮成一个答案。
 */

export interface ReferenceLine {
  walk: string | null
  conclusion: string
}

/**
 * 一个结论的措辞。
 *
 * 这一行陈述事实，把决定留在 F1 放它的地方 —— 留给用户，让他对照旁边的到站分钟数。
 */
export function conclusionOf(advice: DepartureAdvice): string {
  if (advice.state === 'comfortable') {
    return `${advice.leaveInMinutes} 分钟后出门`
  }
  if (advice.state === 'hurry') {
    // 产品文档自己的措辞：赶得上是一个事实，不是一条指令。
    return '现在走还来得及'
  }
  // 这班车已经走了。没有第二班车被定价时就没有成本可说，而编一个出来正是这一整行守着的
  // 失败模式。
  return advice.missCostMinutes === null
    ? '赶不上这班'
    : `赶不上这班 · 下一班多等 ${advice.missCostMinutes} 分`
}

/**
 * 要渲染的那一行，或 null 表示根本没有行。
 *
 * `null` 覆盖服务端没有画出结论的所有情形 —— 两个通勤窗口之外、没有步行路线、没有车、数据
 * 过期或降级 —— 那时这一行干脆缺席。唯一自带内容的「非结论」是从未保存过的锚点：它指向
 * 「设置」，否则这个功能恰好在用户从未设置它的时候看起来是坏的。
 */
export function referenceLineOf(reference: DepartureReference | null | undefined): ReferenceLine | null {
  if (!reference) return null
  if (reference.status === 'anchor-unset') {
    return {
      walk: null,
      conclusion: `未设置「${reference.anchor === 'home' ? '家' : '公司'}」位置 · 在「设置」中设置`,
    }
  }
  return {
    walk: `步行 ${reference.advice.walkMinutes} 分`,
    conclusion: conclusionOf(reference.advice),
  }
}
