import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCongestion } from '../providers/chelaile.js'

/**
 * F12: the crowding level is read from the upstream's OWN label (`title`) on the
 * crowding tag, matched by EXACT EQUALITY. Nothing else in the tag is evidence:
 * not the key's number, not `sort`, not `dispatch`.
 *
 * MEASURED EVIDENCE — live upstream, 2026-09-25, 20 detail reads / 159 vehicles
 * on the four followed lines (transcribed as the (key, title) pairs the payload
 * actually carried):
 *
 *   拥挤度_1  → 不拥挤          ×113   every sampled line
 *   拥挤度_3  → 拥挤            ×30    the two busiest lines
 *   拥挤度_5  → 拥挤            ×7     only on 010-1-0 / 010-1-1
 *   拥挤度_2 / 拥挤度_4         ×0     never observed
 *
 * `_5` is the finding: the upstream stated 拥挤 in the tag's own object while the
 * key-enumerating table served the vehicle as 「未知」. The observed keys are not
 * contiguous, so enumerating keys cannot be complete by construction — any key
 * nobody happened to sample is silently downgraded even when its title states
 * the level. The label is therefore the lookup and the keys live here as
 * evidence of what was measured.
 *
 * The negated form is its own exact string: `不拥挤` must be matched as itself,
 * never as 「拥挤」 found inside it. A copy-loose matcher (`.includes('拥挤')`)
 * once reported 14 buses the upstream had labelled 不拥挤 as crowded.
 */

/** Upstream crowding tag, verbatim: `{"dispatch":false,"imageUrlKey":…,"sort":5,"title":…}`. */
const crowdingTag = (imageUrlKey: string, title: string) =>
  ({ imageUrlKey, title, sort: 5, dispatch: false })

/** The non-crowding tag a bus is also seen to carry. */
const accessibleTag = { imageUrlKey: '无障碍', title: '无障碍', sort: 1, dispatch: false }

describe('parseCongestion (chelaile busTagList): the upstream label is the level', () => {
  it('maps the three measured (key, title) pairs the live upstream served', () => {
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_3', '拥挤')])).toBe('high')
    // THE FINDING: this pair is on 010-1-0/010-1-1 and the payload says 拥挤.
    expect(parseCongestion([crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
  })

  it('maps a tag key it has never seen, on the label alone', () => {
    // The class pin: the mapping must work for tags no sample has ever produced,
    // which is the whole point of reading the label instead of enumerating keys.
    expect(parseCongestion([crowdingTag('拥挤度_9', '拥挤')])).toBe('high')
    expect(parseCongestion([crowdingTag('拥挤度_9', '不拥挤')])).toBe('low')
    // The key need not even look like a crowding key: the label is the signal.
    expect(parseCongestion([crowdingTag('车厢状态', '拥挤')])).toBe('high')
    expect(parseCongestion([crowdingTag('车厢状态', '不拥挤')])).toBe('low')
  })

  it('leaves a title nobody has measured unknown, however the key is named', () => {
    for (const title of ['适中', '严重拥堵', '舒适', '畅通', '']) {
      expect(parseCongestion([crowdingTag('拥挤度_9', title)])).toBe('unknown')
      expect(parseCongestion([crowdingTag('拥挤度_1', title)])).toBe('unknown')
      expect(parseCongestion([crowdingTag('拥挤度_5', title)])).toBe('unknown')
    }
  })

  it('reads exact titles only, so 「不拥挤」 is never read as 「拥挤」', () => {
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_5', '不拥挤')])).toBe('low')
    // Near misses are not the measured title: no substring, no prefix, no trim.
    for (const title of ['不 拥挤', '很拥挤', '拥挤 ', ' 拥挤', '不拥挤啊', '擁擠']) {
      expect(parseCongestion([crowdingTag('拥挤度_5', title)])).toBe('unknown')
    }
  })

  it('never infers a level from the key number, sort or dispatch', () => {
    // A measured key whose title states something unmeasured is not a reading.
    expect(parseCongestion([crowdingTag('拥挤度_1', '畅行')])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_3', title: '畅行', sort: 5, dispatch: true }])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_9', title: '畅行', sort: 1, dispatch: false }])).toBe('unknown')
  })

  it('picks the crowding tag by its known title, not by position', () => {
    // A bus whose first tag is the non-crowding 无障碍 tag still has its reading.
    expect(parseCongestion([accessibleTag, crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
    expect(parseCongestion([accessibleTag, crowdingTag('拥挤度_5', '不拥挤')])).toBe('low')
    // And a tag nobody has measured never shadows a known title behind it.
    expect(parseCongestion([crowdingTag('拥挤度_9', '舒适'), crowdingTag('拥挤度_5', '拥挤')])).toBe('high')
    // Two crowding tags on one bus is outside every sample: the first label the
    // upstream sent wins, and that is a reading either way.
    expect(parseCongestion([crowdingTag('拥挤度_1', '不拥挤'), crowdingTag('拥挤度_5', '拥挤')])).toBe('low')
    expect(parseCongestion([crowdingTag('拥挤度_5', '拥挤'), crowdingTag('拥挤度_1', '不拥挤')])).toBe('high')
  })

  it('reports unknown when the tag list carries no crowding reading', () => {
    expect(parseCongestion(undefined)).toBe('unknown')
    expect(parseCongestion([])).toBe('unknown')
    expect(parseCongestion([{ sort: 5 }])).toBe('unknown')
    // A tag with no title at all states nothing, even under a crowding key.
    expect(parseCongestion([{ imageUrlKey: '拥挤度_5' }])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '拥挤度_5', sort: 5, dispatch: false }])).toBe('unknown')
    // Only the non-crowding tag: 无障碍 is not a crowding reading.
    expect(parseCongestion([accessibleTag])).toBe('unknown')
    expect(parseCongestion([{ imageUrlKey: '空调车', title: '空调车' }])).toBe('unknown')
  })
})

describe('the matcher is an exact-title table, never copy matching', () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../providers/chelaile.ts', import.meta.url)),
    'utf8',
  )
  const body = SOURCE.slice(
    SOURCE.indexOf('export function parseCongestion'),
    SOURCE.indexOf('function holdsLineRecord'),
  )

  it('contains no substring, prefix, suffix or regex match on the tag title', () => {
    expect(body.length).toBeGreaterThan(0)
    for (const loose of ['.includes(', '.startsWith(', '.endsWith(', '.match(', 'RegExp']) {
      expect(body, `the crowding matcher matches copy via ${loose}`).not.toContain(loose)
    }
  })
})
