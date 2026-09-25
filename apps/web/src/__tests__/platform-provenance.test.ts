import { describe, expect, it } from 'vitest'
import type { DataSourceType } from '@real-time-transport/shared'
import { platformRowProvenanceOf } from '../views/platform/provenance'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * F4 on the platform board: one mark per ROW.
 *
 * The board is the mixed-list case the spec calls out. It shows a row per
 * followed line/direction, so one glance can hold rows of different kinds of
 * number at once — a real vehicle's own travel time, a generated train's, and a
 * row nobody could classify. Two rules are load-bearing: those rows must be
 * tellable apart, and a row whose producer stated nothing must NOT read as 实时.
 *
 * The wording itself is `provenance-copy.ts`'s job and is tested there; this file
 * tests which KIND each row gets.
 */

const UNKNOWN = 'some_future_source' as DataSourceType

describe('a platform row states the kind of number it carries', () => {
  it('keeps a real vehicle\'s own travel time as 实时', () => {
    for (const dataSource of ['chelaile', 'apizero'] as const) {
      expect(platformRowProvenanceOf({ dataSource, hasMinute: true })).toBe('live')
    }
  })

  it('marks a generated train 排班推演, however the minute reached the board', () => {
    // The timetable engine puts a travel time on each of its trains, so this row
    // arrives looking like any other live one — the vehicle decides, not the
    // branch the minute was read in.
    expect(platformRowProvenanceOf({ dataSource: 'subway_schedule', hasMinute: true }))
      .toBe('schedule_simulation')
  })

  it('states nothing for a source this build does not know', () => {
    // The zero-fabrication rule at its sharpest: a brand-new feed answers null,
    // so the row keeps its minute and shows no mark — never the flattering word.
    const unknown = platformRowProvenanceOf({ dataSource: UNKNOWN, hasMinute: true })
    expect(unknown).toBeNull()
    expect(provenanceLabelOf(unknown)).toBeNull()
    expect(provenanceLabelOf(unknown)).not.toBe('实时')
  })

  it('states nothing for a row that has no minute to classify', () => {
    // No vehicle in range: the row reports a service fact instead and there is no
    // number for a kind to belong to. A failed request is the same case.
    for (const dataSource of ['chelaile', 'apizero', 'subway_schedule', UNKNOWN, null, undefined] as const) {
      expect(platformRowProvenanceOf({ dataSource, hasMinute: false })).toBeNull()
    }
  })
})

describe('the rows of one board stay tellable apart', () => {
  it('gives a classified row, a modelled row and an unclassified row three different readings', () => {
    const live = provenanceLabelOf(platformRowProvenanceOf({ dataSource: 'chelaile', hasMinute: true }))
    const modelled = provenanceLabelOf(platformRowProvenanceOf({ dataSource: 'subway_schedule', hasMinute: true }))
    const silent = provenanceLabelOf(platformRowProvenanceOf({ dataSource: UNKNOWN, hasMinute: true }))
    expect(live).toBe('实时')
    expect(modelled).not.toBe(live)
    expect(silent).toBeNull()
    expect(new Set([live, modelled, silent]).size).toBe(3)
  })

  it('never rounds an unclassifiable row up to the flattering mark', () => {
    for (const dataSource of [null, undefined, UNKNOWN] as const) {
      const provenance = platformRowProvenanceOf({ dataSource, hasMinute: true })
      expect(provenance).toBeNull()
      expect(provenanceLabelOf(provenance)).not.toBe('实时')
    }
  })
})
