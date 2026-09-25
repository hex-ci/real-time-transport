import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { congestionChipClass, congestionClass, congestionLabel } from '../congestion'

/**
 * F12 on the platform board: the crowding chip is coloured by the verdict it
 * states, never by whether an arrival minute happens to exist.
 *
 * A row can carry a genuine verdict with no minute at once — upstream reports the
 * crowding while no travel time can be computed — so a colour that keys off the
 * minute greys the chip exactly when the verdict IS known, and the colour then
 * argues with the word printed on it. The two directions that must hold: a known
 * level keeps its verdict colour with no minute present, and an unknown level
 * stays neutral however the minute reads, because colour must not report a
 * verdict upstream never gave (「未知」 is not 「not crowded」).
 */

/** The levels upstream has been observed to report: 拥挤度_1 and 拥挤度_3. */
const VERDICTS = ['low', 'high'] as const

/** The neutral grey the unknown level renders as. */
const NEUTRAL = congestionClass('unknown')

/**
 * The badge words are the upstream's OWN wording, transcribed from the live
 * samples in `realtime-transit-apps/references/chelaile-api.md`: 「不拥挤」 is the
 * title served for 拥挤度_1 and 「拥挤」 the one served for 拥挤度_3. No degree may
 * be synthesised for a level nobody sampled — 「畅通」 / 「适中」 / 「较拥挤」 were
 * exactly that — and 「未知」 must stay its own word, because rendering an
 * unobserved level as 「不拥挤」 decides for the user (F12, same rule as F4).
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
    // 「不拥挤」 is a verdict and 「未知」 is not: the two words must never collapse.
    expect(congestionLabel('unknown')).not.toBe(congestionLabel('low'))
  })
})

describe('the crowding chip\'s colour follows the verdict, not the minute', () => {
  it('gives a known verdict its own colour, with no minute in play', () => {
    for (const level of VERDICTS) {
      const chip = congestionChipClass(level)
      // Can differ: the neutral class is what an unknown level renders as, so a
      // verdict reading as it would be the minute-gated grey this rule forbids.
      expect(chip).not.toBe(NEUTRAL)
      // Can differ: a verdict must not borrow a neighbouring one's colour.
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
    // The F12 rule at its sharpest: the neutral chip borrows no verdict colour,
    // so an unknown can never render as a crowded — or a clear — reading.
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

  /** Every static `:class` binding in the SFC, whitespace collapsed. */
  const classBindings = [...board.matchAll(/:class="([^"]+)"/g)]
    .map(m => (m[1] ?? '').replace(/\s+/g, ' '))

  it('derives the chip\'s class from the row\'s crowding level', () => {
    // The property, not the expression: however the binding is written, the chip's
    // colour is computed from this row's crowding level.
    expect(classBindings.length).toBeGreaterThan(0)
    expect(
      classBindings.some(b => b.includes('item.congestion') && b.includes('congestionChipClass')),
      'no class binding derives the chip from the crowding level',
    ).toBe(true)
  })

  it('never lets the arrival minute decide a class', () => {
    // Any shape of a ternary over the minute would put the colour back under its
    // control; checking every binding catches it in either direction.
    for (const binding of classBindings) {
      expect(binding, 'a :class binding reads the arrival minute').not.toContain('etaMinutes')
    }
  })
})
