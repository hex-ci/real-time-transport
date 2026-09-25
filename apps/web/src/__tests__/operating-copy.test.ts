import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { OperatingStatus } from '@real-time-transport/shared'
import { operatingBadgeOf, operatingLabelOf, operatingTextOf } from '../operating-copy'

/**
 * F3's operating line, as text.
 *
 * The wording is pure logic, so it is tested here rather than left to a browser
 * pass (this app has no DOM test harness). What matters is the one thing F3 is
 * strict about: 「未到首班」「已过末班」 and 「运营中但没有车」 are three different
 * facts, and no two of them may read alike. The source guards at the end hold
 * the other half — that the sentence this feature replaced (「暂无来车」) is no
 * longer what a board says when it could state something true.
 */

function status(partial: Partial<OperatingStatus> & { state: OperatingStatus['state'] }): OperatingStatus {
  return { firstDeparture: '05:16', lastDeparture: '23:06', ...partial }
}

/**
 * The file with its explanatory prose removed, so a rule about CODE is not
 * tripped by a comment that names the very thing it explains was removed.
 *
 * The absence checks below read this rather than the raw file: a future comment
 * explaining why a board no longer says 「暂无来车」 would otherwise fail the
 * suite that keeps it out of the copy.
 *
 * `//` alone is only stripped when it does not follow a colon, so a string
 * literal holding a `ws://` or `https://` URL survives and stays scannable.
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
    // Only reachable from an inconsistent payload, but the line is what the user
    // reads: 「已过末班 · 」 would be a missing value dressed as a value.
    expect(operatingTextOf(status({ state: 'after_last', lastDeparture: null }))).toBe('已过末班')
    expect(operatingTextOf(status({ state: 'before_first', firstDeparture: null }))).toBe('未到首班')
  })

  it('falls back to the plain sentence only when there is no status at all', () => {
    // No feed, no status: nothing about service hours is known, so nothing is
    // claimed — this is the one case 「暂无来车」 is still the whole truth.
    expect(operatingTextOf(null)).toBe('暂无来车')
    expect(operatingTextOf(undefined)).toBe('暂无来车')
  })

  it('names the same state in a badge as in a full line', () => {
    // A badge is the same fact with the time left out, never a different verdict.
    expect(operatingLabelOf(status({ state: 'before_first' }))).toBe('未到首班')
    expect(operatingLabelOf(status({ state: 'after_last' }))).toBe('已过末班')
    expect(operatingLabelOf(status({ state: 'operating' }))).toBe('运营中')
    expect(operatingLabelOf(status({ state: 'unknown' }))).toBe('运营时间未知')
    // The badge text of each state opens its full line, so the two cannot drift.
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
    // 「待发车/停运」 said both things at once, which is the conflation F3 removes.
    expect(codeOf(board)).not.toContain('待发车/停运')
  })
})

describe('the live badge claims a real vehicle only from a real vehicle', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  const hero = read('../views/line-detail/components/line-hero.vue')

  /** Everything between the SFC's own <template> tags: what reaches the screen. */
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
    // 营运中 vs 运营中 differed by one character and by nothing at all over TTS,
    // so neither reader could tell the two facts apart. The real-vehicle word
    // must not be built out of the service-hours word at all.
    expect(vehicle).not.toContain(service.replace('中', ''))
  })

  it('lets the state keep its say when no real vehicle is in the list', () => {
    expect(operatingBadgeOf(false, status({ state: 'before_first' }))).toBe('未到首班')
    expect(operatingBadgeOf(false, status({ state: 'after_last' }))).toBe('已过末班')
    expect(operatingBadgeOf(false, status({ state: 'operating' }))).toBe('运营中')
  })

  it('never lets generated vehicles outrank a state that is known to be unknown', () => {
    // The exact contradiction the badge used to publish: the engine places its
    // trains inside an internal simulation window, so the list is non-empty while
    // the state answer on the same screen says 运营时间未知. A known unknown
    // must not be outranked by data this app generated.
    const unknown = status({ state: 'unknown', firstDeparture: null, lastDeparture: null })
    expect(operatingBadgeOf(false, unknown)).toBe('运营时间未知')
    expect(operatingBadgeOf(false, unknown)).not.toBe('有车在途')
    expect(operatingBadgeOf(false, unknown)).toBe(operatingLabelOf(unknown))
  })

  it('takes its word from this module rather than hard-coding it in the template', () => {
    expect(hero).toContain('operatingBadgeOf')
    // The kind of vehicle is read off the payload's own declared source.
    expect(hero).toContain('vehicleProvenanceOf')
    expect(templateOf(hero), 'the hero template states 有车在途 itself').not.toContain('有车在途')
  })
})
