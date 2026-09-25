import { describe, expect, it } from 'vitest'
import type { DataProvenance } from '@real-time-transport/shared'
import { refreshFreshnessOf } from '@/stores/transit.store'
import { chainReadingOf, legMarkOf } from '../provenance'
import { READ_AT } from './chain-fixtures'

/**
 * F4 on the F10 page, and the one thing the refresh control cannot supply here.
 *
 * A chain's answer is not one number from one line: each leg's alight minute is its
 * own vehicle's, and a subway leg's is 排班推演 while a bus leg's is 实时. The
 * engine already decided that per leg, and `listProvenanceOf` answers null for the
 * chain when the legs disagree — one word would then be false about part of it. So
 * the chain states its own mark when it has one, and each leg states its own when
 * it does not; a leg never borrows the chain's word for a number it did not produce.
 *
 * The instant the reading was obtained is worded by the store's own freshness line,
 * so F11's control and this page cannot print one instant two ways.
 */

describe('one mark for the chain, or one per leg', () => {
  it('states the chain\'s word once, and lets no leg repeat it', () => {
    const chain = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'live' })
    expect(chain?.mark).toBe('实时')
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'schedule_simulation' })?.mark).toBe('排班推演')
    // The chain is already saying it: a leg repeating it is noise, not information.
    expect(legMarkOf('live', 'live')).toBeNull()
  })

  it('makes every leg state its own kind when the chain cannot state one', () => {
    expect(chainReadingOf({ lastUpdatedAt: READ_AT, provenance: null })?.mark).toBeNull()
    expect(legMarkOf('live', null)).toBe('实时')
    expect(legMarkOf('schedule_simulation', null)).toBe('排班推演')
    expect(legMarkOf('position_estimate', null)).toBe('位置推算')
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
    // `no-live` and every reason decided before a reading is needed carry no
    // instant, and a clock is not a reading: the page states nothing.
    expect(chainReadingOf({ lastUpdatedAt: null, provenance: null })).toBeNull()
  })

  it('never presents a generated number as a live one', () => {
    const modelled = chainReadingOf({ lastUpdatedAt: READ_AT, provenance: 'schedule_simulation' })
    expect(modelled?.mark).toBe('排班推演')
    expect(modelled?.text).not.toContain('实时')
  })
})
