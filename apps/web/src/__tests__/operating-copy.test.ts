import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { OperatingStatus } from '@real-time-transport/shared'
import { operatingBadgeOf, operatingLabelOf, operatingTextOf } from '../operating-copy'

/**
 * F3 的运营行，以文本形式。
 *
 * 措辞是纯逻辑，故在此测试（本应用无 DOM 测试台）。要点是 F3 严格对待的一件事：
 * 「未到首班」「已过末班」「运营中但没有车」是三个不同的事实，任意两者不得读起来一样。
 * 末尾的源码守卫钉住另一半——本特性替掉的句子（「暂无来车」）不再是屏幕上能陈述真话时的答案。
 */

function status(partial: Partial<OperatingStatus> & { state: OperatingStatus['state'] }): OperatingStatus {
  return { firstDeparture: '05:16', lastDeparture: '23:06', ...partial }
}

/**
 * 去掉说明性文字的文件，使关于**代码**的规则不被「恰好点出它所要解释之物」的注释触发。
 * 下方的缺失性检查读它而非原始文件。
 *
 * `//` 仅在不跟在冒号后时才剥离，因此含 `ws://`、`https://` 的字符串字面量得以保留、仍可扫描。
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('the operating line names the state the line is actually in', () => {
  it('says service has not started yet, and when it does', () => {
    expect(operatingTextOf(status({ state: 'before_first' }))).toBe('未到首班 · 首班 05:16')
  })

  it('says service has ended, naming the last departure that has gone', () => {
    expect(operatingTextOf(status({ state: 'after_last' }))).toBe('已过末班 · 末班 23:06')
  })

  it('says the line is running when the only fact is that nothing is in range', () => {
    expect(operatingTextOf(status({ state: 'operating' }))).toBe('运营中 · 暂无来车')
  })

  it('says the service hours are unknown instead of assuming them', () => {
    expect(operatingTextOf(status({ state: 'unknown', firstDeparture: null, lastDeparture: null })))
      .toBe('运营时间未知 · 暂无来车')
  })

  it('reads every state differently, so no two can be confused', () => {
    const lines = [
      operatingTextOf(status({ state: 'before_first' })),
      operatingTextOf(status({ state: 'operating' })),
      operatingTextOf(status({ state: 'after_last' })),
      operatingTextOf(status({ state: 'unknown' })),
    ]
    expect(new Set(lines).size).toBe(lines.length)
  })

  it('never leaves a dangling separator when the time it refers to is unknown', () => {
    // 只会由不一致的载荷到达，但该行是用户读到的内容：「已过末班 · 」会把缺失的值装扮成值。
    expect(operatingTextOf(status({ state: 'after_last', lastDeparture: null }))).toBe('已过末班')
    expect(operatingTextOf(status({ state: 'before_first', firstDeparture: null }))).toBe('未到首班')
  })

  it('falls back to the plain sentence only when there is no status at all', () => {
    // 无 feed 即无状态：运营时段一概未知，因此不作任何断言——只有这里「暂无来车」仍是完整的真话。
    expect(operatingTextOf(null)).toBe('暂无来车')
    expect(operatingTextOf(undefined)).toBe('暂无来车')
  })

  it('names the same state in a badge as in a full line', () => {
    // 徽标是去掉时间的同一事实，绝非另一个判决。
    expect(operatingLabelOf(status({ state: 'before_first' }))).toBe('未到首班')
    expect(operatingLabelOf(status({ state: 'after_last' }))).toBe('已过末班')
    expect(operatingLabelOf(status({ state: 'operating' }))).toBe('运营中')
    expect(operatingLabelOf(status({ state: 'unknown' }))).toBe('运营时间未知')
    // 每个状态的徽标文本是其整行的开头，故两者无法漂移。
    for (const s of ['before_first', 'operating', 'after_last', 'unknown'] as const) {
      expect(operatingTextOf(status({ state: s }))).toContain(operatingLabelOf(status({ state: s })))
    }
  })
})

describe('the boards state the operating fact instead of the generic sentence', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  const card = read('../views/overview/components/line-mini-card.vue')
  const platform = read('../views/platform/index.vue')
  const board = read('../views/platform/components/departure-board.vue')

  it('renders the home card\'s empty state from the operating status', () => {
    expect(card).toContain('operatingTextOf')
    expect(codeOf(card)).not.toContain('本站暂无来车')
  })

  it('no longer answers the station board with a literal 「暂无来车」', () => {
    expect(codeOf(platform)).not.toContain('暂无来车')
    expect(codeOf(board)).not.toContain('暂无来车')
    // 「待发车/停运」同时说了两件事，正是 F3 要拆开的那种混同。
    expect(codeOf(board)).not.toContain('待发车/停运')
  })
})

describe('the live badge claims a real vehicle only from a real vehicle', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  const hero = read('../views/line-detail/components/line-hero.vue')

  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  it('outranks the schedule for a real vehicle', () => {
    expect(operatingBadgeOf(true, status({ state: 'operating' }))).toBe('有车在途')
  })

  it('does not express the real-vehicle fact as a one-character variant of the service word', () => {
    const service = operatingLabelOf(status({ state: 'operating' }))
    const vehicle = operatingBadgeOf(true, status({ state: 'operating' }))
    expect(vehicle).not.toBe(service)
    // 「营运中」与「运营中」仅一字之差、对 TTS 毫无区别，两个读者都无法区分这两个事实。
    // 真实车辆的词绝不能由运营时段的词拼出。
    expect(vehicle).not.toContain(service.replace('中', ''))
  })

  it('lets the state keep its say when no real vehicle is in the list', () => {
    expect(operatingBadgeOf(false, status({ state: 'before_first' }))).toBe('未到首班')
    expect(operatingBadgeOf(false, status({ state: 'after_last' }))).toBe('已过末班')
    expect(operatingBadgeOf(false, status({ state: 'operating' }))).toBe('运营中')
  })

  it('never lets generated vehicles outrank a state that is known to be unknown', () => {
    // 徽标曾发布的正是这个矛盾：引擎把列车放在内部模拟窗口内，故列表非空，
    // 而同屏的状态回答是「运营时间未知」。已知的未知不得被本应用生成的数据压过。
    const unknown = status({ state: 'unknown', firstDeparture: null, lastDeparture: null })
    expect(operatingBadgeOf(false, unknown)).toBe('运营时间未知')
    expect(operatingBadgeOf(false, unknown)).not.toBe('有车在途')
    expect(operatingBadgeOf(false, unknown)).toBe(operatingLabelOf(unknown))
  })

  it('takes its word from this module rather than hard-coding it in the template', () => {
    expect(hero).toContain('operatingBadgeOf')
    // 车辆类型取自载荷自己声明的来源。
    expect(hero).toContain('vehicleProvenanceOf')
    expect(templateOf(hero), 'the hero template states 有车在途 itself').not.toContain('有车在途')
  })
})
