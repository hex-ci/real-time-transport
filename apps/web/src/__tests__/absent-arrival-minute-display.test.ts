import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { statedArrivalMinutes } from '@real-time-transport/shared'
import type { ArrivalRow } from '@real-time-transport/shared'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '../arrival-copy'

/**
 * Every surface that lists arrivals must render the absence, never a minute.
 *
 * The server no longer states a minute for a targeted bus reading that published
 * none (it extrapolated a snapshot speed and a nominal dwell across every
 * remaining stop — ~12 min mean error, 28 min worst, sign unfixed), so the wire
 * serves such a row with NO `etaSeconds` at all. Three surfaces list arrivals:
 * the line panel's 后续进站计划, the overview card's leading/subsequent rows, and
 * the platform board's 预计到站 column. Each of them used to have exactly one
 * branch for "a minute" and would now paint `Math.round(undefined / 60)` next to
 * 「分」 — the same lie as the estimate, one layer out.
 *
 * The rule and the WORDS are both pinned here rather than in each template:
 * `statedArrivalMinutes` answers the minute or `null`, and 「暂无到站耗时」 is
 * the platform board's own token for an unknown arrival, held once in
 * `@/arrival-copy` so the three surfaces cannot drift into three sentences. These
 * components are browser-only artefacts in this repo (no jsdom, no
 * @vue/test-utils), so the wiring is asserted against the SFC source, the way
 * this project's other display rules are.
 */

function sfc(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** Everything between the SFC's own <template> tags: what reaches the screen. */
function templateOf(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

const popover = sfc('../views/line-detail/components/station-popover.vue')
const card = sfc('../views/overview/components/line-mini-card.vue')
const board = sfc('../views/platform/components/departure-board.vue')
const linePage = sfc('../views/line-detail/index.vue')

describe('the unknown-arrival token is one token', () => {
  it('is the platform board\'s own wording, and contains no digit', () => {
    expect(ARRIVAL_MINUTE_UNAVAILABLE_TEXT).toBe('暂无到站耗时')
    // A digit in this token would read as a minute beside it.
    expect(ARRIVAL_MINUTE_UNAVAILABLE_TEXT).not.toMatch(/\d/)
  })

  it('is the constant every arrivals surface renders, the board included', () => {
    // Not a re-typed literal per file: one source, so the two surfaces that show
    // the same state for the same row cannot word it differently.
    expect(templateOf(board)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    expect(templateOf(popover)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    expect(templateOf(card)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
  })
})

describe('no arrivals surface prices a minute for a row that states none', () => {
  it('the line panel renders the absence and guards its minute on the helper', () => {
    const template = templateOf(popover)
    // The minute comes from the helper — never from raw arithmetic over a field
    // that may be absent.
    expect(template).toContain('statedArrivalMinutes(a)')
    expect(template, 'the panel still rounds etaSeconds itself, which is undefined for this row')
      .not.toContain('Math.round(a.etaSeconds / 60)')
    // And the absence branch is real: a row with no minute states the token.
    expect(template).toMatch(/ARRIVAL_MINUTE_UNAVAILABLE_TEXT/)
    // The helper answers for the row the panel is drawing.
    const absent: ArrivalRow = { stopsAway: 2, busId: 'b1' }
    expect(statedArrivalMinutes(absent)).toBeNull()
    const present: ArrivalRow = { time: '14:07', etaSeconds: 420 }
    expect(statedArrivalMinutes(present)).toBe(7)
  })

  it('the overview card renders the absence on its leading and subsequent rows', () => {
    const template = templateOf(card)
    expect(template, 'the card still rounds etaSeconds itself for a subsequent row')
      .not.toContain('Math.round(a.etaSeconds / 60)')
    expect(template).toContain('statedArrivalMinutes(a)')
    // The leading row keeps its own branch for "no minute", ahead of the
    // operating-state fallback which claims something else entirely (that no
    // vehicle is in range).
    const numbered = template.indexOf('minutesOf(primaryArrivals) !== null')
    const absence = template.indexOf('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    const operating = template.indexOf('primaryOperatingText', numbered)
    expect(numbered, 'the card lost its numbered branch').toBeGreaterThan(-1)
    expect(absence, 'the card has no branch for a row that states no minute').toBeGreaterThan(numbered)
    expect(absence, 'the absence falls through to the operating fact, which claims no vehicle is in range')
      .toBeLessThan(operating)
  })

  it('reads the row the wire serves, so the token is what the screen shows', () => {
    // The row shape the server now serves for a vehicle it could not price: it is
    // still reported, with its place in the order, and no minute.
    const row: ArrivalRow = { stopsAway: 3, distanceMeters: 1200, busId: 'b1' }
    expect(statedArrivalMinutes(row)).toBeNull()
    expect(JSON.stringify(row), 'a minute-shaped number is hiding in the row').not.toMatch(/\d{2}:\d{2}/)
  })
})

/**
 * The line page's own headline. It lived in `pending-estimate.ts` as a copy of
 * the server's position/dwell formula; both copies are gone, so the page states
 * the absence for the same reason the list rows do.
 *
 * PINNED AS THE SFC SOURCE ON PURPOSE: `index.vue` is being edited by a
 * concurrent unit at the moment this rule lands, so the two assertions below are
 * the exact text that must hold once that write has landed — they are RED until
 * it does, and they are the only assertions in this suite that are.
 */
describe('the line page states the absence instead of a bus minute of its own', () => {
  it('no longer prices a minute from the vehicle\'s position', () => {
    expect(linePage, 'the page still imports the deleted position estimate')
      .not.toContain('estimatePositionArrivalSeconds')
    expect(linePage, 'the page still computes a position/dwell minute inline')
      .not.toContain('remainingMeters / speed')
  })

  it('states the same absence token the arrivals list renders', () => {
    expect(linePage).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
  })
})
