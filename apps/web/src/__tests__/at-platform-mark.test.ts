import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema } from '@real-time-transport/shared'
import { cardListProvenanceOf, cardRowProvenanceOf } from '../views/overview/provenance'
import { arrivalListProvenanceOf, arrivalRowProvenanceOf } from '../views/line-detail/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * G3: the mark qualifies a NUMBER — the at-platform state is a fact with none.
 *
 * The overview card rendered the leading row's mark beside 「正在进站」, while the
 * line-detail panel deliberately renders none for the same state: 「车辆正在本站」
 * is an observation of where a vehicle is, and the panel's own branch says so
 * ("a mark qualifies a number, and this claim states none"). The panel is the
 * right surface — the card is the one that must change — and the reason is the
 * mark's contract (`provenance-copy.ts`): 实时 / 位置推算 / 排班推演 / 精确时刻表
 * each answer 「这个数从哪来」, which is a question about a minute.
 *
 * The card's at-platform row carries `provenance: 'live'` (the server prices it
 * with `basis: 'at_platform'`, and a real vehicle observed at the platform is
 * 实时), so the word was not missing: it was attached to the one statement on the
 * card that states no number. Removing it there must not take it off the minutes
 * it exists for, which is why both halves are pinned: the card's at-platform
 * branch renders no mark, and the feed's single word still reaches the numbered
 * rows below it.
 *
 * The same rule is applied to the panel's own arrivals list, where a MIXED feed
 * (one live row, one computed row) can still put a row's mark beside a
 * 「正在进站」 entry — the state the card is being aligned to, one element away.
 *
 * These components are browser-only artefacts here (no jsdom, no
 * @vue/test-utils), so the rule is asserted as logic and the wiring against the
 * SFC source, the way this view's provenance rules already are.
 */

const card = readFileSync(
  fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
  'utf8',
)

const popover = readFileSync(
  fileURLToPath(new URL('../views/line-detail/components/station-popover.vue', import.meta.url)),
  'utf8',
)

function templateOf(sfc: string): string {
  const start = sfc.indexOf('<template>')
  const end = sfc.lastIndexOf('</template>')
  return start >= 0 && end > start ? sfc.slice(start, end) : ''
}

/** The card's at-platform branch: from its `v-if` to the next `v-else-if`. */
function cardAtPlatformBranch(): string {
  const template = templateOf(card)
  const start = template.indexOf('nextOf(primaryArrivals)?.isAtStation')
  const end = template.indexOf('minutesOf(primaryArrivals) !== null')
  expect(start, 'the card no longer has an at-platform branch').toBeGreaterThan(-1)
  expect(end, 'the card no longer has a numbered branch after it').toBeGreaterThan(start)
  return template.slice(start, end)
}

/** The card's numbered branch: the minutes the mark belongs to. */
function cardNumberedBranch(): string {
  const template = templateOf(card)
  const start = template.indexOf('minutesOf(primaryArrivals) !== null')
  const end = template.indexOf('primaryOperatingText', start)
  expect(start, 'the card no longer has a numbered branch').toBeGreaterThan(-1)
  expect(end, 'the card no longer has the operating-state branch after it').toBeGreaterThan(start)
  return template.slice(start, end)
}

/** A feed whose leading row is a vehicle AT the platform, followed by one on the way. */
const AT_PLATFORM_THEN_MINUTE = [
  { time: '正在进站', etaSeconds: 0, stopsAway: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
  { time: '14:07', etaSeconds: 420, stopsAway: 2, busId: 'v2', provenance: 'live' },
].map(row => ArrivalRowSchema.parse(row))

/** A feed of two minutes: the once-only rule for a list whose rows all agree. */
const TWO_MINUTES = [
  { time: '14:05', etaSeconds: 300, busId: 'v1', provenance: 'live' },
  { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'live' },
].map(row => ArrivalRowSchema.parse(row))

describe('G3: the card states no mark beside the at-platform state', () => {
  it('renders no mark in the branch that states 「正在进站」', () => {
    const branch = cardAtPlatformBranch()
    // The branch under test is the one that states the fact, and it states no minute.
    expect(branch).toContain('正在进站')
    expect(branch, 'a mark is rendered beside a statement that carries no number')
      .not.toContain('primaryMark')
  })

  it('still renders the mark on the minutes it qualifies', () => {
    expect(cardNumberedBranch()).toContain('primaryMark')
  })

  it('words no mark itself, so the removal is not a re-wording', () => {
    const template = templateOf(card)
    for (const word of ['实时', '位置推算', '排班推演', '精确时刻表']) {
      expect(template, `the card template states ${word} itself`).not.toContain(word)
    }
  })
})

describe('G3: the feed\'s one word reaches a row that states a number', () => {
  it('does not let the word ride on an at-platform leading row', () => {
    // The list still agrees on one kind — but its leading row is an
    // OBSERVATION, not a minute, so the word cannot be carried there: the card
    // renders no mark in that branch, and a word parked on it would be dropped
    // from the screen entirely.
    expect(cardListProvenanceOf(AT_PLATFORM_THEN_MINUTE)).toBe('live')
    expect(provenanceLabelOf(cardRowProvenanceOf(AT_PLATFORM_THEN_MINUTE, 1))).toBe('实时')
    // The row it now rides on is a minute, which is the whole point.
    expect(AT_PLATFORM_THEN_MINUTE[1]!.isAtStation).toBeUndefined()
  })

  it('keeps the once-only rule for a feed whose leading row IS a minute', () => {
    // The convention the fix must not break: one word, stated once, on the
    // leading minute rather than repeated down the 后续 sub-list.
    expect(cardRowProvenanceOf(TWO_MINUTES, 0)).toBe('live')
    expect(cardRowProvenanceOf(TWO_MINUTES, 1)).toBeNull()
  })

  it('still reports each row\'s own kind when the feed mixes kinds', () => {
    const mixed = [
      { time: '正在进站', etaSeconds: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
      { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'position_estimate' },
    ].map(row => ArrivalRowSchema.parse(row))
    expect(cardListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(cardRowProvenanceOf(mixed, 1))).toBe('位置推算')
  })
})

describe('G3: the panel\'s list applies the same rule to its own rows', () => {
  it('renders no per-row mark on an at-platform entry', () => {
    const template = templateOf(popover)
    const markSpan = /<span[^>]*v-if="[^"]*rowMarkOf\(i\)[^"]*"[^>]*>/.exec(template)
    expect(markSpan, 'the panel list no longer renders per-row marks').not.toBeNull()
    expect(markSpan![0], 'the per-row mark is not guarded by isAtStation').toContain('v-if="!a.isAtStation && rowMarkOf(i)"')
    // The list-level mark is a statement about the list, not about one entry,
    // and stays where it is.
    expect(template).toContain('{{ listMark }}')
  })

  it('leaves a numbered row\'s mark alone', () => {
    // A mixed feed: the numbered row still states its own kind.
    const mixed = [
      { time: '正在进站', etaSeconds: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
      { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'position_estimate' },
    ].map(row => ArrivalRowSchema.parse(row))
    expect(arrivalListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(arrivalRowProvenanceOf(mixed, 1))).toBe('位置推算')
  })
})
