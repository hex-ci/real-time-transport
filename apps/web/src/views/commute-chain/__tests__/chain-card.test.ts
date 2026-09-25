import { describe, expect, it } from 'vitest'
import { chainCardOf } from '../card'
import { chainView, conclusion, leg, refusal } from './chain-fixtures'

/**
 * One chain's answer, as its card renders it.
 *
 * The card is where a deduction and a refusal go their separate ways, and where
 * two facts have to be taken from the right place:
 *
 *  - the anchor a refusal names is the CHAIN's own stored one (`originAnchor`),
 *    never the purpose's — a chain recorded from 公司 is not repaired by the 家
 *    anchor's row, and naming the wrong one sends the user to the wrong setting;
 *  - a refused chain carries a conclusion of NO kind: there is no margin, no
 *    minute and no vehicle to render, because a refusal is a code rather than a
 *    smaller answer.
 */

describe('a deduced chain becomes a conclusion and its per-transfer rows', () => {
  const card = chainCardOf(chainView(conclusion([
    leg({ seq: 0, marginMinutes: 9, alightMinutes: 12 }),
    leg({ seq: 1, lineName: '地铁 88 号线', marginMinutes: 2, alightMinutes: 20, provenance: 'schedule_simulation' }),
  ])))

  it('carries the chain\'s own identity and start', () => {
    expect(card.chainId).toBe('chain-1')
    expect(card.name).toBe('上班 · 一路换乘')
    expect(card.originText).toBe('从「家」出发')
  })

  it('states the chain\'s conclusion, its binding transfer and every leg', () => {
    expect(card.refusal).toBeNull()
    expect(card.conclusion?.band).toBe('tight')
    expect(card.conclusion?.bindingText).toBe('最紧的是第 2 段 · 地铁 88 号线')
    expect(card.conclusion?.legs.map(item => item.lineName)).toEqual(['快线 1 路', '地铁 88 号线'])
  })

  it('states the reading\'s instant, and no chain-level mark when the legs disagree', () => {
    // 实时 and 排班推演 are two different kinds of number in one answer, so the
    // chain states no single kind — each leg states its own instead.
    expect(card.chainProvenance).toBeNull()
    expect(card.reading?.text).not.toContain('实时')
    expect(card.reading?.text).toContain('最后更新')
  })

  it('states the chain\'s one kind when its legs agree', () => {
    const agreed = chainCardOf(chainView(conclusion([
      leg({ seq: 0, provenance: 'live' }),
      leg({ seq: 1, provenance: 'live', marginMinutes: 3 }),
    ])))
    expect(agreed.chainProvenance).toBe('live')
    expect(agreed.reading?.text).toContain('实时')
  })
})

describe('a refused chain becomes one sentence and no answer', () => {
  it('carries the refusal and no conclusion of any kind', () => {
    const card = chainCardOf(chainView(refusal('no-vehicle', {
      leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' },
      updatedAt: 1_700_000_000_000,
      operatingStatus: { state: 'operating', firstDeparture: '05:30', lastDeparture: '23:00' },
    })))
    expect(card.conclusion).toBeNull()
    expect(card.refusal?.sentence).toBe('暂时没有开往这一站的车')
    expect(card.refusal?.serviceText).toBe('运营中 · 暂无来车')
    expect(card.chainProvenance).toBeNull()
    expect(card.reading?.text).toContain('最后更新')
  })

  it('hands the refusal the chain\'s own anchor rather than the purpose\'s', () => {
    // An 上班 chain recorded from 公司: the 家 anchor is not the row this user has
    // to repair, and naming it would send them to fix something else.
    const card = chainCardOf(chainView(refusal('anchor-unset'), { originAnchor: 'work', purpose: 'morning' }))
    expect(card.refusal?.sentence).toBe('未设置「公司」位置 · 在「设置」中设置')
    expect(card.refusal?.action).toBe('settings')
  })

  it('states no reading line for a leg that was never read', () => {
    // No reading means no line at all: the refusal's own instant is the reading's
    // instant, and this leg was never read, so neither the reading nor the refusal
    // carries one.
    const card = chainCardOf(chainView(refusal('anchor-unset')))
    expect(card.reading).toBeNull()
    expect(card.refusal).not.toHaveProperty('updatedAt')
  })
})
