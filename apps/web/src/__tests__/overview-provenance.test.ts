import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArrivalRowSchema, listProvenanceOf } from '@real-time-transport/shared'
import { cardListProvenanceOf, cardRowProvenanceOf } from '../views/overview/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * 总览卡片上的 F4：混合种类的 feed 仍能逐行区分。
 *
 * 一张卡显示每个方向一个 feed，而单个 feed 可以携带不同种类的行。`listProvenanceOf` 对这样的列表
 * 答 null（一个词会对其中一部分为假），故只渲染列表级标记的卡片会什么都不显示：首个分钟旁没有词，
 * 后续子列表里也没有，使实时分钟与推算分钟读起来完全一样。下方的回退即站点弹层已在用的那个。
 *
 * 卡片在本仓库只跑在浏览器（无 jsdom、无 @vue/test-utils），故规则按逻辑断言，接线按 SFC 源码断言。
 */

/** 混合 feed，已按线上 schema 校验。 */
const MIXED = [
  { time: '14:05', etaSeconds: 300, busId: 'upstream-bus', provenance: 'live' },
  { time: '14:07', etaSeconds: 417, busId: 'modelled-train', provenance: 'schedule_simulation' },
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
    expect(next).toBe('排班推演')
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
    // `listProvenanceOf` 忽略未陈述任何内容的行，故列表仍以一个词说话——
    // 而沉默的行不会被借给它一个词。
    const rows = [{ provenance: 'live' }, {}] as const
    expect(cardListProvenanceOf(rows)).toBe('live')
    expect(cardRowProvenanceOf(rows, 0)).toBe('live')
    expect(cardRowProvenanceOf(rows, 1)).toBeNull()
  })

  it('does not lend the list word to a leading row that stated nothing', () => {
    // 顺序互换：同一列表仍只认一个词，但该词属于被分类行自己的类型。首行未陈述任何内容，
    // 故必须不带——借给它就是在给一个没人描述过的数字加标记。
    const rows = [{}, { provenance: 'live' }] as const
    expect(cardListProvenanceOf(rows)).toBe('live')
    expect(provenanceLabelOf(cardRowProvenanceOf(rows, 0))).toBeNull()
    // 陈述了自己类型的行仍上报它。
    expect(provenanceLabelOf(cardRowProvenanceOf(rows, 1))).toBe('实时')
  })
})

describe('the card renders that fallback where the minutes are', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )

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
    // 标记调用必须落在后续块内、落在迭代其行的那个元素上，而不只是文件里更靠后的某处。
    // 锚定这两个标记可避免依赖块增长多少。
    const markAt = card.indexOf('subsequentMarkOf(i)', followUpAt)
    expect(markAt, 'the 后续 rows render no per-row mark').toBeGreaterThan(followUpAt)
    const vForAt = card.lastIndexOf('v-for', markAt)
    expect(vForAt, 'the mark is not bound to an iterated row').toBeGreaterThan(followUpAt)
  })

  it('words no mark itself', () => {
    // 类型在 provenance-copy.ts 变词（该决定的唯一所在处）；实时尤其不得硬编码进模板。
    const template = templateOf(card)
    for (const word of ['实时', '排班推演', '精确时刻表']) {
      expect(template, `the card template states ${word} itself`).not.toContain(word)
    }
  })
})
