import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { congestionChipClass, congestionClass, congestionLabel } from '../congestion'

/**
 * 站台屏上的 F12：拥挤度芯片由其陈述的**判决**着色，绝不由某个到站分钟是否存在决定。
 *
 * 一行可以同时携带真实判决与无分钟——上游在无法算出行程时间时报拥挤度——故按分钟取色的做法会在
 * 判决**已知**时恰好把芯片置灰，颜色随即与它上面印的词争吵。两个必须成立的方向：已知等级在无分钟
 * 时保留其判决色，未知等级无论如何都保持中性，因为颜色不得报出上游从未给出的判决（「未知」不是「不拥挤」）。
 */

/** 上游被观察到会上报的等级：拥挤度_1 与 拥挤度_3。 */
const VERDICTS = ['low', 'high'] as const

/** 未知等级渲染的中性灰。 */
const NEUTRAL = congestionClass('unknown')

/**
 * 徽标文字是上游**自己**的措辞，转录自实时采样：拥挤度_1 给的标题是「不拥挤」，拥挤度_3 给的是「拥挤」。
 * 不得为没人采样过的等级合成程度词——「畅通」「适中」「较拥挤」正是如此——且「未知」必须保持自己的词，
 * 因为把未观测的等级渲染成「不拥挤」就是在替用户决定（F12，同 F4 规则）。
 */
describe('the badge words come from the observed upstream vocabulary', () => {
  it('labels each observed level with the wording the upstream itself served', () => {
    expect(congestionLabel('low')).toBe('不拥挤')
    expect(congestionLabel('high')).toBe('拥挤')
  })

  it('keeps 「未知」 for every level nobody has sampled, an invented middle rung included', () => {
    for (const level of ['unknown', 'medium', '', 'some_future_level']) {
      expect(congestionLabel(level)).toBe('未知')
      expect(congestionChipClass(level)).toBe(NEUTRAL)
    }
    // 「不拥挤」是判决而「未知」不是：两个词绝不能合并。
    expect(congestionLabel('unknown')).not.toBe(congestionLabel('low'))
  })
})

describe('the crowding chip\'s colour follows the verdict, not the minute', () => {
  it('gives a known verdict its own colour, with no minute in play', () => {
    for (const level of VERDICTS) {
      const chip = congestionChipClass(level)
      // 可以不同：中性类正是未知等级渲染的样子，
      // 故判决读起来像它就意味着本规则禁止的按分钟置灰。
      expect(chip).not.toBe(NEUTRAL)
      // 可以不同：一个判决不得借用邻近判决的颜色。
      for (const other of VERDICTS) {
        if (other === level) continue
        expect(chip, `${level} renders as ${other}`).not.toBe(congestionClass(other))
      }
      expect(chip).toBe(congestionClass(level))
    }
  })

  it('stays neutral for an unknown verdict', () => {
    for (const congestion of ['unknown', '', 'some_future_level']) {
      expect(congestionChipClass(congestion)).toBe(NEUTRAL)
    }
    // F12 规则最锐利处：中性芯片不借用任何判决色，故未知绝不会渲染成拥挤——或畅通——的读数。
    expect(congestionLabel('unknown')).toBe('未知')
    for (const level of VERDICTS) {
      expect(NEUTRAL).not.toBe(congestionClass(level))
    }
  })
})

describe('the board binds the chip through that decision, not through a ternary', () => {
  const board = readFileSync(
    fileURLToPath(new URL('../components/departure-board.vue', import.meta.url)),
    'utf8',
  )

  /** SFC 里每个静态 `:class` 绑定，空白已折叠。 */
  const classBindings = [...board.matchAll(/:class="([^"]+)"/g)]
    .map(m => (m[1] ?? '').replace(/\s+/g, ' '))

  it('derives the chip\'s class from the row\'s crowding level', () => {
    // 看属性而非表达式：无论绑定怎么写，芯片的颜色都由本行的拥挤等级算出。
    expect(classBindings.length).toBeGreaterThan(0)
    expect(
      classBindings.some(b => b.includes('item.congestion') && b.includes('congestionChipClass')),
      'no class binding derives the chip from the crowding level',
    ).toBe(true)
  })

  it('never lets the arrival minute decide a class', () => {
    // 对分钟做三元处理的任何写法都会把颜色重新置于其控制下；检查每个绑定可在两个方向都抓住它。
    for (const binding of classBindings) {
      expect(binding, 'a :class binding reads the arrival minute').not.toContain('etaMinutes')
    }
  })
})
