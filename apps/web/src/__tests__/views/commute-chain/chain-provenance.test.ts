import { describe, expect, it } from 'vitest'
import type { DataProvenance } from '@real-time-transport/shared'
import { refreshFreshnessOf } from '@/stores/transit.store'
import { chainReadingOf, legMarkOf } from '../provenance'
import { READ_AT } from './chain-fixtures'

/**
 * F10 页面上的 F4，以及刷新控件在此无法提供的那一件事。
 *
 * 链路的答案不是一个来自一条线路的数字：每段的下车分钟属于它自己的车辆，地铁段是排班推演而公交段是实时。
 * 引擎已按段决定，且各段不一致时 `listProvenanceOf` 对链路答 null——一个词会对其中一部分为假。
 * 故链路有标记时陈述自己的，没有时每段陈述自己的；段绝不会为自己未产出的数字借用链路的词。
 *
 * 取得读取的时刻由 store 自己的新鲜度行措辞，故 F11 的控件与本页不会把一个时刻印成两种样子。
 */

describe('one mark for the chain, or one per leg', () => {
  it('states the chain\'s word once, and lets no leg repeat it', () => {
    const chain = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'live' })
    expect(chain?.mark).toBe('实时')
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'schedule_simulation' })?.mark).toBe('排班推演')
    // 链路已经在说它了：段再重复是噪声，不是信息。
    expect(legMarkOf('live', 'live')).toBeNull()
  })

  it('makes every leg state its own kind when the chain cannot state one', () => {
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: null })?.mark).toBeNull()
    expect(legMarkOf('live', null)).toBe('实时')
    expect(legMarkOf('schedule_simulation', null)).toBe('排班推演')
    expect(legMarkOf('exact_timetable', null)).toBe('精确时刻表')
  })

  it('states no mark for a kind this build does not know, rather than the flattering one', () => {
    const unknown = 'some_future_kind' as DataProvenance
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: unknown })?.mark).toBeNull()
    expect(legMarkOf(unknown, null)).toBeNull()
  })
})

describe('the reading line states when the reading was obtained', () => {
  it('words the instant exactly as F11\'s control words the same instant', () => {
    const reading = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'live' })
    const house = refreshFreshnessOf({ at: READ_AT, dataSource: null, isDegraded: null })
    expect(reading?.time).toBe(house.time)
    expect(reading?.text).toBe(`最后更新 ${house.time} · 实时`)
  })

  it('states the chain\'s own kind, and no mark when its legs disagree', () => {
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: null })?.mark).toBeNull()
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: null })?.text).toBe(`最后更新 ${
      refreshFreshnessOf({ at: READ_AT, dataSource: null, isDegraded: null }).time}`)
  })

  it('reports the reading\'s own instant rather than the clock it is rendered at', () => {
    const earlier = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'live' })
    const later = chainReadingOf({ lastUpdatedAt: READ_AT + 3_600_000, provenance: 'live' })
    expect(later?.time).not.toBe(earlier?.time)
  })

  it('has no line at all when there was no reading', () => {
    // `no-live` 以及所有在需要读取之前就决定的理由都不带时刻，时钟不是读取：页面什么都不陈述。
    expect(chainReadingOf({ lastUpdatedAt: null, provenance: null })).toBeNull()
  })

  it('never presents a generated number as a live one', () => {
    const modelled = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'schedule_simulation' })
    expect(modelled?.mark).toBe('排班推演')
    expect(modelled?.text).not.toContain('实时')
  })
})
