import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema, listProvenanceOf } from '@real-time-transport/shared'
import { cardListProvenanceOf, cardRowProvenanceOf } from '../views/overview/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * F4 on the overview card: a feed that mixes kinds stays tellable apart row by row.
 *
 * One card shows one feed per direction, and a single feed can carry rows of
 * different kinds. The probe that opened this gap ran through the real service and
 * came back with one response holding two vehicles:
 *
 *   [{ busId: 'upstream-bus', provenance: 'live',  etaSeconds: 300 },
 *    { busId: 'computed-bus', provenance: 'position_estimate', etaSeconds: 417 }]
 *
 * `listProvenanceOf` answers null for that list — one word would be false about
 * part of it — so a card that rendered only the list mark showed NOTHING: no word
 * beside the leading minute and none in the 后续 sub-list, leaving a live minute
 * and a computed one reading exactly alike. The fallback below is the one the
 * station popover already uses.
 *
 * The card itself is a browser-only artefact in this repo (no jsdom, no
 * @vue/test-utils), so the rule is asserted here as logic and the wiring is
 * asserted against the SFC source.
 */

/** The mixed feed exactly as the probe produced it, validated against the wire schema. */
const MIXED = [
  { time: '14:05', etaSeconds: 300, busId: 'upstream-bus', provenance: 'live' },
  { time: '14:07', etaSeconds: 417, busId: 'computed-bus', provenance: 'position_estimate' },
].map(row => ArrivalRowSchema.parse(row))

describe('one feed, two kinds of minute', () => {
  it('cannot be described by one word', () => {
    expect(cardListProvenanceOf(MIXED)).toBeNull()
    expect(provenanceLabelOf(listProvenanceOf(MIXED))).toBeNull()
  })

  it('states each row\'s own kind, so the two minutes read differently', () => {
    const lead = provenanceLabelOf(cardRowProvenanceOf(MIXED, 0))
    const next = provenanceLabelOf(cardRowProvenanceOf(MIXED, 1))
    expect(lead).toBe('实时')
    expect(next).toBe('位置推算')
    expect(lead).not.toBe(next)
  })
})

describe('a feed whose classified rows agree is stated once', () => {
  const UNIFORM = [{ provenance: 'live' }, { provenance: 'live' }] as const

  it('gives the list one word, carried by the leading minute', () => {
    expect(cardListProvenanceOf(UNIFORM)).toBe('live')
    expect(cardRowProvenanceOf(UNIFORM, 0)).toBe('live')
  })

  it('does not repeat that word down the 后续 sub-list', () => {
    expect(cardRowProvenanceOf(UNIFORM, 1)).toBeNull()
  })
})

describe('an unstated provenance is never rounded up to 实时', () => {
  it('marks nothing for a feed whose rows state nothing', () => {
    const silent = [{ provenance: null }, {}] as const
    expect(cardListProvenanceOf(silent)).toBeNull()
    for (let i = 0; i < silent.length; i++) {
      expect(provenanceLabelOf(cardRowProvenanceOf(silent, i))).toBeNull()
    }
  })

  it('leaves the unstated row unmarked even when the rest of the list agrees', () => {
    // `listProvenanceOf` ignores a row that stated nothing, so the list still
    // speaks with one word — and the silent row is given no borrowed one.
    const rows = [{ provenance: 'live' }, {}] as const
    expect(cardListProvenanceOf(rows)).toBe('live')
    expect(cardRowProvenanceOf(rows, 0)).toBe('live')
    expect(cardRowProvenanceOf(rows, 1)).toBeNull()
  })

  it('does not lend the list word to a leading row that stated nothing', () => {
    // The reverse order: the same list still agrees on one word, but the word
    // belongs to the classified row's own kind. The leading row stated none, so it
    // must carry none — lending it there marked a number nobody had described.
    const rows = [{}, { provenance: 'live' }] as const
    expect(cardListProvenanceOf(rows)).toBe('live')
    expect(provenanceLabelOf(cardRowProvenanceOf(rows, 0))).toBeNull()
    // The row that stated its own kind still reports it.
    expect(provenanceLabelOf(cardRowProvenanceOf(rows, 1))).toBe('实时')
  })
})

describe('the card renders that fallback where the minutes are', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )

  /** Everything between the SFC's own <template> tags: what reaches the screen. */
  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  it('decides the mark for every row from the shared rule', () => {
    expect(card).toContain('cardRowProvenanceOf')
  })

  it('marks each 后续 row, not just the leading minute', () => {
    const followUpAt = card.indexOf('>后续<')
    expect(followUpAt, 'the card has no 后续 sub-list').toBeGreaterThan(-1)
    // The mark call must sit inside the 后续 block, on the element that iterates
    // its rows — not merely somewhere later in the file. Anchoring on those two
    // markers keeps this from depending on how much the block grows.
    const markAt = card.indexOf('subsequentMarkOf(i)', followUpAt)
    expect(markAt, 'the 后续 rows render no per-row mark').toBeGreaterThan(followUpAt)
    const vForAt = card.lastIndexOf('v-for', markAt)
    expect(vForAt, 'the mark is not bound to an iterated row').toBeGreaterThan(followUpAt)
  })

  it('words no mark itself', () => {
    // The kind becomes words in provenance-copy.ts, the one place that decision
    // lives; 实时 in particular must never be hard-coded into a template.
    const template = templateOf(card)
    for (const word of ['实时', '位置推算', '排班推演', '精确时刻表']) {
      expect(template, `the card template states ${word} itself`).not.toContain(word)
    }
  })
})
