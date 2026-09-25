import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DataSourceTypeSchema } from '@real-time-transport/shared'
import { REFUSAL_SENTENCE, anchorNameOf, anchorUnsetSentenceOf, refusalOf } from '../refusal'
import { READ_AT, OPERATING, refusal } from './chain-fixtures'

/**
 * Every 「不给结论」 code the page can receive, and the ONE sentence it gets.
 *
 * A code with no sentence is a hole; a sentence that is true of only some of a
 * code's causes is a lie for the rest. So the code set is not typed out here from
 * memory — it is read off the contract's own `ChainNoConclusionReason` union, and
 * the copy table is a total `Record` over that union, which makes a code added
 * upstream a COMPILE error before it is a test failure.
 *
 * Two documented traps are held below:
 *
 *  - `connection-unpriced` covers four causes that differ in PERMANENCE — an
 *    unplaced stop is a permanent upstream data gap, an unpriced route is a
 *    momentary one — so its sentence states only the fact the code carries and
 *    promises no retry (a retry would be true of the last and false of the first);
 *  - no two codes may be answered with one another's words: 「暂时没有开往这一站
 *    的车」 is not 「这条线停运」, and our own reading failing is not the service
 *    being empty.
 */

/** The contract's own union, read from the source that declares it. */
function declaredReasons(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../../../packages/shared/src/commute-chain.ts', import.meta.url)),
    'utf8',
  )
  const block = /export type ChainNoConclusionReason\s*=([\s\S]*?)\n\n/.exec(source)
  expect(block, 'the contract no longer declares ChainNoConclusionReason').not.toBeNull()
  return [...block![1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]!)
}

/** A sentence per code, with the anchor the only parameter one of them needs. */
function sentencesOf(): Array<[string, string]> {
  return Object.entries(REFUSAL_SENTENCE).map(([reason, copy]) => [reason, copy({ anchor: 'home' })])
}

describe('every refusal code the contract declares has exactly one sentence', () => {
  it('covers the contract\'s whole set, and nothing that is not in it', () => {
    const declared = declaredReasons()
    expect(declared.length).toBeGreaterThan(0)
    expect(Object.keys(REFUSAL_SENTENCE).sort()).toEqual([...declared].sort())
  })

  it('gives each code words of its own, so no two codes read alike', () => {
    const sentences = sentencesOf().map(([, sentence]) => sentence)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('states the fact and stops: no sentence is a sentence about a different code', () => {
    // 停运 is the trap in miniature: an empty board read is 「nothing is on its way
    // to this station」, and a line whose day has ended is stated by the service
    // state beside it — never by turning one into the other.
    for (const [reason, sentence] of sentencesOf()) {
      expect(sentence, reason).not.toMatch(/停运|停驶|取消/)
    }
  })
})

describe('an unpriced connection promises no retry it cannot keep', () => {
  it('states only that the connection has no duration', () => {
    const sentence = REFUSAL_SENTENCE['connection-unpriced']({ anchor: 'home' })
    expect(sentence).toBe('这一段接驳的时长取不到，无法判断余量')
    // Two of its causes are permanent (a stop the stop list carries without a
    // coordinate, which upstream may never state) and one is transient (a route
    // the path service happened not to price). 「稍后重试」 would be true of the
    // last and false of the first, on a row that cannot tell the page which one
    // fired — so it is not said.
    expect(sentence).not.toMatch(/重试|稍后|再试|稍候|过一会儿/)
  })

  it('promises no code a retry', () => {
    for (const [reason, sentence] of sentencesOf()) {
      expect(sentence, reason).not.toMatch(/重试|稍后|再试|稍候|过一会儿/)
    }
  })
})

describe('a sentence is true of every cause its code can carry', () => {
  it('states no ordering for the code whose causes include two ends that are one station', () => {
    // `leg-recorded-backwards` has TWO documented causes: a bus leg whose alight
    // station is not downstream, and any leg whose two ends are the SAME station.
    // There is no order to be wrong in the second, so a sentence naming the order
    // is false for part of its own set — and the row cannot tell the page which
    // cause fired, so the wording has to hold for both.
    const sentence = REFUSAL_SENTENCE['leg-recorded-backwards']({ anchor: 'home' })
    expect(sentence).not.toMatch(/顺序|颠倒|反向|反了|录反|先后|前后|站序|倒/)
    // …and it still states the fact BOTH causes share: this leg cannot be ridden.
    expect(sentence).toMatch(/走不通|乘不了|不能乘车|无法乘车/)
  })

  it('states the same-station case as the ordering one, in one sentence', () => {
    // The sentence a row prints does not depend on the cause (the code carries no
    // second field), so the only way to be true of both is to be about neither
    // cause in particular — which is what makes the words above the whole contract.
    const sentence = REFUSAL_SENTENCE['leg-recorded-backwards']({ anchor: 'home' })
    expect(sentence).toBe('这条链路有乘车段的上车站与下车站填得走不通')
  })
})

describe('no sentence names a data source or an internal mechanism', () => {
  it('keeps every vendor out of the wording', () => {
    // The source names come from the contract's own enum rather than from a list
    // kept here, so a new source is covered the moment it is declared.
    for (const [reason, sentence] of sentencesOf()) {
      for (const source of DataSourceTypeSchema.options) {
        expect(sentence, `${reason} names ${source}`).not.toContain(source)
      }
    }
  })
})

describe('an empty answer about the service is governed by the service state', () => {
  const legOf = (extra: Record<string, unknown> = {}) => ({
    leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
    ...extra,
  })

  it('states the arrival fact, and F3\'s own service state beside it', () => {
    const view = refusalOf({
      deduction: refusal('no-vehicle', legOf({ updatedAt: READ_AT, operatingStatus: { ...OPERATING, state: 'after_last' } })),
      anchor: 'home',
    })
    expect(view.sentence).toBe('暂时没有开往这一站的车')
    // 已过末班 is the answer an empty board must not be given as 暂无来车, and it
    // rides beside the arrival fact rather than replacing it: the two are different
    // facts and neither may stand for the other.
    expect(view.serviceText).toBe('已过末班 · 末班 23:00')
  })

  it('keeps the four service states apart, in F3\'s words', () => {
    const states = [
      { ...OPERATING, state: 'before_first', firstDeparture: '05:30' },
      { ...OPERATING, state: 'operating' },
      { ...OPERATING, state: 'after_last', lastDeparture: '23:00' },
      { ...OPERATING, state: 'unknown', firstDeparture: null, lastDeparture: null },
    ] as const
    const texts = states.map(status => refusalOf({
      deduction: refusal('no-vehicle', legOf({ updatedAt: READ_AT, operatingStatus: status })),
      anchor: 'home',
    }).serviceText)
    expect(texts).toEqual([
      '未到首班 · 首班 05:30',
      '运营中 · 暂无来车',
      '已过末班 · 末班 23:00',
      '运营时间未知 · 暂无来车',
    ])
    expect(new Set(texts).size).toBe(4)
  })

  it('says nothing about the service day beside a refusal about our own reading', () => {
    // 「数据太旧」 is a fact about the reading, and a service state beside it would
    // read as its cause — the one thing these two facts must not be confused for.
    for (const reason of ['stale', 'degraded', 'provenance-unknown', 'inconsistent-live', 'no-live'] as const) {
      const view = refusalOf({
        deduction: refusal(reason, legOf({ updatedAt: READ_AT, operatingStatus: { ...OPERATING, state: 'after_last' } })),
        anchor: 'home',
      })
      expect(view.serviceText, reason).toBeNull()
    }
  })

  it('states the service state when the arrival fact is about vehicles that had already gone', () => {
    for (const reason of ['no-vehicle-after-connection', 'no-vehicle-at-departure'] as const) {
      const view = refusalOf({
        deduction: refusal(reason, legOf({ updatedAt: READ_AT, operatingStatus: OPERATING })),
        anchor: 'home',
      })
      expect(view.serviceText, reason).toBe('运营中 · 暂无来车')
    }
  })
})

describe('the cause the user can act on is the anchor, and nothing may take its place', () => {
  it('sends an unsaved anchor to the screen that owns it, in F1\'s own words', () => {
    const view = refusalOf({
      deduction: refusal('anchor-unset', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(view.sentence).toBe('未设置「家」位置 · 在「设置」中设置')
    expect(view.sentence).toBe(anchorUnsetSentenceOf('home'))
    expect(view.action).toBe('settings')
  })

  it('names the chain\'s own anchor, not a fixed one', () => {
    const view = refusalOf({ deduction: refusal('anchor-unset'), anchor: 'work' })
    expect(view.sentence).toContain('公司')
    expect(view.sentence).not.toContain('家」')
  })

  it('keeps the anchor\'s affordance when the leg was never read', () => {
    // The engine settles the anchor BEFORE it reads a leg's line or locates a
    // station, so this is the state a chain with an unreadable line arrives in:
    // the user is told the cause they can repair rather than one they cannot. The
    // page must not weaken that into a line problem, and its action may not depend
    // on any other field.
    const unread = refusalOf({
      deduction: refusal('anchor-unset', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(unread.serviceText).toBeNull()
    expect(unread.action).toBe('settings')
    // …and with no leg at all the sentence and its action are unchanged.
    const noLeg = refusalOf({ deduction: refusal('anchor-unset'), anchor: 'home' })
    expect(noLeg.legText).toBeNull()
    expect(noLeg.sentence).toBe(unread.sentence)
    expect(noLeg.action).toBe('settings')
  })

  it('never lets the other connection code offer the anchor\'s action', () => {
    const generic = refusalOf({
      deduction: refusal('connection-unpriced', { leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' } }),
      anchor: 'home',
    })
    expect(generic.action).toBeNull()
    expect(generic.sentence).not.toBe(REFUSAL_SENTENCE['anchor-unset']({ anchor: 'home' }))
  })

  it('offers no action for a cause that leaves the user none', () => {
    for (const reason of declaredReasons()) {
      const view = refusalOf({ deduction: refusal(reason as never, {}), anchor: 'home' })
      expect(view.action, reason).toBe(reason === 'anchor-unset' ? 'settings' : null)
    }
  })
})

describe('a refusal states which transfer refused', () => {
  it('names the leg by its position and its line', () => {
    const view = refusalOf({
      deduction: refusal('no-vehicle', {
        leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
        updatedAt: READ_AT,
        operatingStatus: OPERATING,
      }),
      anchor: 'home',
    })
    expect(view.legText).toBe('第 2 段 · 快线 1 路')
  })

  it('has no leg to name when the chain carries none', () => {
    const view = refusalOf({ deduction: refusal('no-legs'), anchor: 'home' })
    expect(view.legText).toBeNull()
  })

  it('carries no field the card never renders (a shape guard: a dead field is not left behind)', () => {
    // The instant a reading was obtained is NOT here: the card prints it from the
    // reading line it renders for both kinds of answer, and a second copy of one
    // instant is a field no view reads. `reason` is the engine's code itself — the
    // page never re-words it, and the tests below compare against it.
    const view = refusalOf({
      deduction: refusal('no-vehicle', {
        leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
        updatedAt: READ_AT,
        operatingStatus: OPERATING,
      }),
      anchor: 'home',
    })
    expect(Object.keys(view).sort()).toEqual(['action', 'legText', 'reason', 'sentence', 'serviceText'])
  })
})

describe('a code this build does not know is stated as no conclusion, never as a guess', () => {
  it('invents no cause and no action for it', () => {
    const view = refusalOf({ deduction: refusal('a-code-from-a-newer-server' as never), anchor: 'home' })
    expect(view.sentence).toBe('这条链路无法给出结论')
    expect(view.action).toBeNull()
    expect(view.serviceText).toBeNull()
  })
})

describe('the anchor vocabulary is F1\'s', () => {
  it('names the two stored anchors the way the reference line does', () => {
    expect(anchorNameOf('home')).toBe('家')
    expect(anchorNameOf('work')).toBe('公司')
  })
})
