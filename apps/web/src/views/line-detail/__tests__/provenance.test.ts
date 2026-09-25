import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema } from '@real-time-transport/shared'
import { arrivalListProvenanceOf, arrivalRowProvenanceOf } from '../provenance'
import { provenanceLabelOf } from '../../../provenance-copy'

/**
 * F4 in the station panel: one arrivals answer, rows of different kinds.
 *
 * The panel renders ONE list, and a single answer can carry rows of different
 * kinds — the payload sent a real vehicle's own minute and this app computed the
 * next. `listProvenanceOf` answers null for such a list, so a panel that rendered
 * only the list-level word would show nothing beside the rows, and a live minute
 * would read exactly like a computed one. The fallback under test is the one the
 * overview card already uses.
 *
 * The panel itself is a browser-only artefact in this repo (no jsdom, no
 * @vue/test-utils), so the rule is asserted here as logic and the wiring is
 * asserted against the SFC source.
 */

let nextMinute = 5
/** One arrival row, with whatever provenance the case is about. */
function row(provenance?: string | null): ReturnType<typeof ArrivalRowSchema.parse> {
  nextMinute += 2
  return ArrivalRowSchema.parse({
    time: `14:${String(nextMinute).padStart(2, '0')}`,
    etaSeconds: nextMinute * 60,
    ...(provenance === undefined ? {} : { provenance }),
  })
}

describe('one arrivals list, two kinds of minute', () => {
  it('cannot be described by one word', () => {
    const mixed = [row('live'), row('position_estimate')]
    expect(arrivalListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(arrivalListProvenanceOf(mixed))).toBeNull()
  })

  it('states each row\'s own kind, so the two minutes read differently', () => {
    const mixed = [row('live'), row('position_estimate')]
    const lead = provenanceLabelOf(arrivalRowProvenanceOf(mixed, 0))
    const next = provenanceLabelOf(arrivalRowProvenanceOf(mixed, 1))
    expect(lead).toBe('实时')
    expect(next).toBe('位置推算')
    expect(lead).not.toBe(next)
  })
})

describe('a list whose classified rows agree is stated once', () => {
  it('lets the list speak the one word', () => {
    const uniform = [row('live'), row('live')]
    expect(arrivalListProvenanceOf(uniform)).toBe('live')
    expect(provenanceLabelOf(arrivalListProvenanceOf(uniform))).toBe('实时')
  })

  it('does not repeat that word on every row', () => {
    const uniform = [row('live'), row('live')]
    expect(arrivalRowProvenanceOf(uniform, 0)).toBeNull()
    expect(arrivalRowProvenanceOf(uniform, 1)).toBeNull()
  })
})

describe('an unstated provenance is never rounded up to 实时', () => {
  it('marks nothing for a list whose rows state nothing', () => {
    const silent = [row(null), row()]
    expect(arrivalListProvenanceOf(silent)).toBeNull()
    for (let i = 0; i < silent.length; i++) {
      expect(provenanceLabelOf(arrivalRowProvenanceOf(silent, i))).toBeNull()
    }
  })

  it('leaves the unstated row unmarked even when the rest of the list agrees', () => {
    // `listProvenanceOf` ignores a row that stated nothing, so the list still
    // speaks with one word — and the silent row is given no borrowed one.
    const rows = [row('live'), row()]
    expect(arrivalListProvenanceOf(rows)).toBe('live')
    expect(arrivalRowProvenanceOf(rows, 1)).toBeNull()
  })
})

describe('the panel renders that fallback where the minutes are', () => {
  const popover = readFileSync(
    fileURLToPath(new URL('../components/station-popover.vue', import.meta.url)),
    'utf8',
  )

  /** Everything between the SFC's own <template> tags: what reaches the screen. */
  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  it('decides the list mark and every row mark from the shared rule', () => {
    expect(popover).toContain('arrivalListProvenanceOf')
    expect(popover).toContain('arrivalRowProvenanceOf')
  })

  it('words no mark itself', () => {
    // The kind becomes words in provenance-copy.ts, the one place that decision
    // lives; 实时 in particular must never be hard-coded into a template.
    const template = templateOf(popover)
    for (const word of ['实时', '位置推算', '排班推演', '精确时刻表']) {
      expect(template, `the popover template states ${word} itself`).not.toContain(word)
    }
  })
})
