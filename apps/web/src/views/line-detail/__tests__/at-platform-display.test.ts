import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AT_PLATFORM_ETA_TEXT } from '../at-platform'

/**
 * F-A and F-C on the display side.
 *
 * F-A: the upstream says `travelTime 0` for a vehicle standing at the stop, and
 * the server now routes that to the at-platform row (`isAtStation`, `time:
 * '正在进站'`, `etaSeconds: 0`). The panel must then state the fact and NO minute —
 * 「车辆正在本站」 is an observation of where a vehicle is, and a minute printed
 * beside it would be this app's arithmetic dressed as the source's reading. The
 * panel is a browser-only artefact here (no jsdom, no @vue/test-utils), so the
 * wording is asserted as a module and the rendering is asserted against the SFC
 * source, the way the panel's provenance rules already are.
 *
 * F-C: the exact table's caveat about the day's last departures (a half-route)
 * travels in the arrivals answer and is rendered where those departures are.
 */

const popover = readFileSync(
  fileURLToPath(new URL('../components/station-popover.vue', import.meta.url)),
  'utf8',
)

const view = readFileSync(fileURLToPath(new URL('../index.vue', import.meta.url)), 'utf8')

/** Everything between the SFC's own <template> tags: what reaches the screen. */
function templateOf(sfc: string): string {
  const start = sfc.indexOf('<template>')
  const end = sfc.lastIndexOf('</template>')
  return start >= 0 && end > start ? sfc.slice(start, end) : ''
}

describe('F-A: the at-platform state is a statement, not a number', () => {
  it('words the state with no minute in it', () => {
    expect(AT_PLATFORM_ETA_TEXT).toBe('车辆正在本站 (即将发车)')
    // No digit: a number beside this sentence would be the app's own estimate of
    // a vehicle the source already reported as here.
    expect(AT_PLATFORM_ETA_TEXT).not.toMatch(/\d/)
  })

  it('is the ONE wording, chosen by the module rather than typed into the view', () => {
    // The same sentence stood in three branches of this view; a wording that can
    // drift in three places is how one fact becomes three readings.
    expect(view).not.toContain('车辆正在本站')
    expect(view).toContain('AT_PLATFORM_ETA_TEXT')
  })

  it('answers a row that is at the platform BEFORE any minute arithmetic', () => {
    const branch = view.indexOf('if (next.isAtStation)')
    // The minute comes from `statedArrivalMinutes` now, which answers `null` for a
    // row that states none — that is what makes the absence a state instead of the
    // `NaN分` raw arithmetic over an optional field would paint. Pinned here so the
    // at-platform ordering keeps being asserted against the real expression (this
    // assertion is RED until the pending `index.vue` patch lands: see
    // `src/__tests__/absent-arrival-minute-display.test.ts`).
    const minuteMath = view.indexOf('statedArrivalMinutes(next)')
    expect(branch, 'the arrivals branch no longer checks isAtStation').toBeGreaterThan(-1)
    expect(minuteMath, 'the arrivals minute is no longer computed there').toBeGreaterThan(-1)
    expect(branch, 'the minute is computed before the at-platform state is answered').toBeLessThan(minuteMath)
    expect(view.slice(branch, minuteMath)).toContain('AT_PLATFORM_ETA_TEXT')
  })

  it('renders no per-row minute for a row the server marked at the platform', () => {
    const template = templateOf(popover)
    // The minute now comes from `statedArrivalMinutes`, which answers `null` for a row
    // that states none — so the guard is on the ANSWER rather than on the raw field,
    // and a row with no minute renders the absence instead of `undefined分`.
    const minuteSpan = /<span[^>]*>\s*\{\{\s*statedArrivalMinutes\(a\)\s*\}\}分\s*<\/span>/
    const match = minuteSpan.exec(template)
    expect(match, 'the panel no longer renders a per-row minute at all').not.toBeNull()
    expect(match![0], 'the row minute is not guarded by isAtStation').toContain('v-if="!a.isAtStation"')
    // The whole branch is guarded by the row stating a minute at all, and the
    // at-platform observation inside it precedes any number.
    const guard = template.indexOf('statedArrivalMinutes(a) !== null')
    expect(guard, 'the panel no longer distinguishes a row with no minute').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(template.indexOf('{{ a.time }}'))
  })
})

describe('F-C: the table\'s own caveat is rendered with the departures', () => {
  it('renders the note the answer carries', () => {
    const template = templateOf(popover)
    expect(template).toContain('{{ arrivals.note }}')
  })

  it('renders it OUTSIDE the departures list, so an empty list still states it', () => {
    // After the last departure has gone the list is empty — and that is exactly
    // the hour the caveat matters (the last train may not go the whole way). So
    // the note's element is its own sibling of the list, not a child of it.
    const template = templateOf(popover)
    const listOpen = template.indexOf('v-if="arrivals && arrivals.arrivals.length > 0"')
    expect(listOpen, 'the departures list is no longer guarded by its own v-if').toBeGreaterThan(-1)
    const listEnd = endOfElement(template, listOpen)
    const note = template.indexOf('{{ arrivals.note }}')
    expect(listEnd).toBeGreaterThan(listOpen)
    expect(note, 'the note is inside the list block, so it vanishes when nothing is left to list')
      .toBeGreaterThan(listEnd)
  })

  it('guards the note on the note alone, not on the list having rows', () => {
    const template = templateOf(popover)
    const noteTag = /<p\b[^>]*data-arrivals-note[^>]*>/.exec(template)
    expect(noteTag, 'the note is no longer rendered as its own element').not.toBeNull()
    expect(noteTag![0]).toContain('v-if="arrivals?.note"')
    expect(noteTag![0]).not.toContain('arrivals.arrivals.length')
  })

  it('words nothing itself: the sentence is the table\'s', () => {
    // The note is upstream's own caveat text; a prefix written here would make
    // the app the author of a claim it only carries.
    const template = templateOf(popover)
    expect(template).not.toContain('末班说明')
    expect(template).not.toContain('半程')
  })

  it('receives the note through the feed type the view passes down', () => {
    expect(view).toContain('note?: string | null')
    expect(popover).toContain('note?: string | null')
  })
})

/** Index just past the element opened at `from` (its matching </div>), or -1. */
function endOfElement(template: string, from: number): number {
  const openTagEnd = template.indexOf('>', from)
  if (openTagEnd < 0) return -1
  let depth = 1
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = openTagEnd
  let m: RegExpExecArray | null
  while ((m = tag.exec(template)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) return m.index + '</div>'.length
  }
  return -1
}
