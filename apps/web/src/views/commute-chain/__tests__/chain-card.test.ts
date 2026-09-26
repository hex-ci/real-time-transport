import { describe, expect, it } from 'vitest'
import { chainCardOf } from '../card'
import { chainView, conclusion, leg, refusal } from './chain-fixtures'

/**
 * 一条链路的答案，如它的卡片所渲染。
 *
 * 卡片是推断与拒绝分道之处，也是两个事实必须取自正确位置之处：
 *
 *  - 拒绝点名的锚点是**链路**自己存储的那个（`originAnchor`），绝非目的的——从公司记录的
 *    链路不会被「家」锚点的行修复，点错会把用户送去错的设置；
 *  - 被拒绝的链路不带任何种类的结论：没有余量、没有分钟、没有车辆可渲染，因为拒绝是一个
 *    代码而非一个更小的答案。
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
    // 实时与排班推演是同一答案里两种不同种类的数字，故链路不陈述单一类型——每段各自陈述。
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
    // 从公司记录的上班链路：「家」锚点不是该用户需要修复的行，点名它会把人送去修别的东西。
    const card = chainCardOf(chainView(refusal('anchor-unset'), { originAnchor: 'work', purpose: 'morning' }))
    expect(card.refusal?.sentence).toBe('未设置「公司」位置 · 在「设置」中设置')
    expect(card.refusal?.action).toBe('settings')
  })

  it('states no reading line for a leg that was never read', () => {
    // 无读取即无该行：本段从未被读取，故读取与拒绝都不带时刻。
    const card = chainCardOf(chainView(refusal('anchor-unset')))
    expect(card.reading).toBeNull()
    expect(card.refusal).not.toHaveProperty('updatedAt')
  })
})
