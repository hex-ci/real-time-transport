import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema } from '@real-time-transport/shared'
import { cardListProvenanceOf, cardRowProvenanceOf } from '../views/overview/provenance'
import { arrivalListProvenanceOf, arrivalRowProvenanceOf } from '../views/line-detail/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * 标记限定一个数字，而「正在本站」这类状态本身没有数字。
 *
 * 总览卡片的 at-platform 行曾把标记放在「正在进站」旁，线路面板对同一状态刻意不渲染。
 * 标记的契约（`provenance-copy.ts`）里，实时 / 排班推演 / 精确时刻表 都在回答
 * 「这个数从哪来」，问的是分钟。
 *
 * 卡片该行带 `provenance: 'live'`，去掉标记不能连带去掉它所属的分钟：卡片的 at-platform
 * 分支不渲染标记，而 feed 的同一个词仍落到下面的带数字行。
 *
 * 同一规则也适用于面板自己的到站列表：混合 feed 可能把某行的标记放在「正在进站」旁。
 *
 * 这些组件只跑在浏览器（无 jsdom、无 @vue/test-utils），故逻辑按断言、接线按 SFC 源码。
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

/** 卡片的 at-platform 分支：从它的 `v-if` 到下一个 `v-else-if`。 */
function cardAtPlatformBranch(): string {
  const template = templateOf(card)
  const start = template.indexOf('nextOf(primaryArrivals)?.isAtStation')
  const end = template.indexOf('minutesOf(primaryArrivals) !== null')
  expect(start, 'the card no longer has an at-platform branch').toBeGreaterThan(-1)
  expect(end, 'the card no longer has a numbered branch after it').toBeGreaterThan(start)
  return template.slice(start, end)
}

/** 卡片的带数字分支：标记所属的分钟。 */
function cardNumberedBranch(): string {
  const template = templateOf(card)
  const start = template.indexOf('minutesOf(primaryArrivals) !== null')
  const end = template.indexOf('primaryOperatingText', start)
  expect(start, 'the card no longer has a numbered branch').toBeGreaterThan(-1)
  expect(end, 'the card no longer has the operating-state branch after it').toBeGreaterThan(start)
  return template.slice(start, end)
}

const AT_PLATFORM_THEN_MINUTE = [
  { time: '正在进站', etaSeconds: 0, stopsAway: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
  { time: '14:07', etaSeconds: 420, stopsAway: 2, busId: 'v2', provenance: 'live' },
].map(row => ArrivalRowSchema.parse(row))

/** 两条分钟的 feed：用于「只出现一次」规则。 */
const TWO_MINUTES = [
  { time: '14:05', etaSeconds: 300, busId: 'v1', provenance: 'live' },
  { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'live' },
].map(row => ArrivalRowSchema.parse(row))

describe('G3: the card states no mark beside the at-platform state', () => {
  it('renders no mark in the branch that states 「正在进站」', () => {
    const branch = cardAtPlatformBranch()
    expect(branch).toContain('正在进站')
    expect(branch, 'a mark is rendered beside a statement that carries no number')
      .not.toContain('primaryMark')
  })

  it('still renders the mark on the minutes it qualifies', () => {
    expect(cardNumberedBranch()).toContain('primaryMark')
  })

  it('words no mark itself, so the removal is not a re-wording', () => {
    const template = templateOf(card)
    for (const word of ['实时', '排班推演', '精确时刻表']) {
      expect(template, `the card template states ${word} itself`).not.toContain(word)
    }
  })
})

describe('G3: the feed\'s one word reaches a row that states a number', () => {
  it('does not let the word ride on an at-platform leading row', () => {
    // 列表整体仍属同一类，但首行是一次观测而非分钟，词不能落在那里：
    // 卡片在该分支不渲染标记，落在那里会被整个丢掉。
    expect(cardListProvenanceOf(AT_PLATFORM_THEN_MINUTE)).toBe('live')
    expect(provenanceLabelOf(cardRowProvenanceOf(AT_PLATFORM_THEN_MINUTE, 1))).toBe('实时')
    expect(AT_PLATFORM_THEN_MINUTE[1]!.isAtStation).toBeUndefined()
  })

  it('keeps the once-only rule for a feed whose leading row IS a minute', () => {
    // 不得破坏的约定：一个词只说一次，落在首个分钟行，而非在后续子列表里重复。
    expect(cardRowProvenanceOf(TWO_MINUTES, 0)).toBe('live')
    expect(cardRowProvenanceOf(TWO_MINUTES, 1)).toBeNull()
  })

  it('still reports each row\'s own kind when the feed mixes kinds', () => {
    const mixed = [
      { time: '正在进站', etaSeconds: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
      { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'schedule_simulation' },
    ].map(row => ArrivalRowSchema.parse(row))
    expect(cardListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(cardRowProvenanceOf(mixed, 1))).toBe('排班推演')
  })
})

describe('G3: the panel\'s list applies the same rule to its own rows', () => {
  it('renders no per-row mark on an at-platform entry', () => {
    const template = templateOf(popover)
    const markSpan = /<span[^>]*v-if="[^"]*rowMarkOf\(i\)[^"]*"[^>]*>/.exec(template)
    expect(markSpan, 'the panel list no longer renders per-row marks').not.toBeNull()
    expect(markSpan![0], 'the per-row mark is not guarded by isAtStation').toContain('v-if="!a.isAtStation && rowMarkOf(i)"')
    // 列表级标记是对列表的陈述，不针对单条，位置不动。
    expect(template).toContain('{{ listMark }}')
  })

  it('leaves a numbered row\'s mark alone', () => {
    const mixed = [
      { time: '正在进站', etaSeconds: 0, isAtStation: true, busId: 'v1', provenance: 'live' },
      { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'schedule_simulation' },
    ].map(row => ArrivalRowSchema.parse(row))
    expect(arrivalListProvenanceOf(mixed)).toBeNull()
    expect(provenanceLabelOf(arrivalRowProvenanceOf(mixed, 1))).toBe('排班推演')
  })
})
