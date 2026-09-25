import { describe, expect, it } from 'vitest'
import type { DataSourceType } from '../index.js'
import {
  ArrivalRowSchema,
  arrivalProvenanceOf,
  listProvenanceOf,
  vehicleProvenanceOf,
} from '../index.js'

/**
 * F4: what KIND of number the user is looking at.
 *
 * The whole point of these tests is the boundary the feature exists to hold:
 * 「没有来源」 and 「实时」 are different facts. A value this app computed is not a
 * live reading, a value whose producer said nothing gets no mark, and no input
 * to these functions can round an unknown up to 实时.
 */

describe('vehicle provenance comes from the source the payload declared', () => {
  it('reads a real vehicle feed as 实时 and the timetable engine as 排班推演', () => {
    expect(vehicleProvenanceOf('chelaile')).toBe('live')
    expect(vehicleProvenanceOf('apizero')).toBe('live')
    expect(vehicleProvenanceOf('subway_schedule')).toBe('schedule_simulation')
  })

  it('classifies nothing when there is no reading at all', () => {
    expect(vehicleProvenanceOf(null)).toBeNull()
    expect(vehicleProvenanceOf(undefined)).toBeNull()
  })

  it('leaves a source this build does not know unclassified', () => {
    // A third data source must never be rounded to the flattering answer: the
    // fallthrough returns "no statement", not 实时.
    expect(vehicleProvenanceOf('some_future_source' as DataSourceType)).toBeNull()
    expect(vehicleProvenanceOf('' as DataSourceType)).toBeNull()
  })
})

describe('an arrival minute is classified by how it was produced', () => {
  it('keeps a minute the data source itself sent as 实时', () => {
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'upstream' })).toBe('live')
  })

  it('keeps a vehicle seen at this platform as 实时', () => {
    // The position is observed, not modelled — the one case a live vehicle's row
    // states something the data source's own payload did not carry.
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'at_platform' })).toBe('live')
  })

  it('calls a minute this app computed from a live position 位置推算', () => {
    expect(arrivalProvenanceOf({ vehicle: 'live', basis: 'our_estimate' })).toBe('position_estimate')
  })

  it('never lets this app\'s own arithmetic read as 实时', () => {
    for (const vehicle of ['live', 'schedule_simulation'] as const) {
      expect(arrivalProvenanceOf({ vehicle, basis: 'our_estimate' }))
        .not.toBe('live')
    }
  })

  it('marks a simulated vehicle 排班推演 however the minute beside it was produced', () => {
    // The engine puts a travelTimeSec on each of its trains, so a row can reach
    // the "upstream sent the minute" branch while the train itself is generated.
    // The vehicle decides.
    for (const basis of ['upstream', 'at_platform', 'our_estimate'] as const) {
      expect(arrivalProvenanceOf({ vehicle: 'schedule_simulation', basis }))
        .toBe('schedule_simulation')
    }
  })

  it('states nothing when the vehicle kind is unknown', () => {
    for (const basis of ['upstream', 'at_platform', 'our_estimate'] as const) {
      expect(arrivalProvenanceOf({ vehicle: null, basis })).toBeNull()
      expect(arrivalProvenanceOf({ vehicle: undefined, basis })).toBeNull()
    }
  })
})

describe('a list states one provenance only when its rows agree', () => {
  it('answers for a list whose rows share a source', () => {
    expect(listProvenanceOf([{ provenance: 'live' }, { provenance: 'live' }])).toBe('live')
    expect(listProvenanceOf([{ provenance: 'exact_timetable' }])).toBe('exact_timetable')
  })

  it('refuses to answer for a list that mixes sources', () => {
    // One word would then be false about half the rows, and the caller renders a
    // per-row mark instead.
    expect(listProvenanceOf([{ provenance: 'live' }, { provenance: 'position_estimate' }])).toBeNull()
    expect(listProvenanceOf([{ provenance: 'exact_timetable' }, { provenance: 'live' }])).toBeNull()
  })

  it('answers nothing for an empty list or one with no stated provenance', () => {
    expect(listProvenanceOf([])).toBeNull()
    expect(listProvenanceOf([{}, { provenance: undefined }, { provenance: null }])).toBeNull()
  })

  it('ignores unclassified rows when deciding', () => {
    // An unclassified row is not a second opinion; it must not silence a list
    // whose classified rows all agree.
    expect(listProvenanceOf([{ provenance: 'live' }, {}])).toBe('live')
  })
})

describe('the arrival row contract carries the value\'s own provenance', () => {
  it('parses the provenance value it was given', () => {
    const parsed = ArrivalRowSchema.parse({
      time: '09:12',
      etaSeconds: 512,
      stopsAway: 4,
      provenance: 'position_estimate',
    })
    // Asserted on the parsed output: `safeParse(...).success` alone would pass
    // before this field existed, because Zod strips unknown keys.
    expect(parsed.provenance).toBe('position_estimate')
  })

  it('accepts an exact-timetable row and a row that states nothing', () => {
    expect(ArrivalRowSchema.parse({
      time: '08:32',
      etaSeconds: 120,
      provenance: 'exact_timetable',
    }).provenance).toBe('exact_timetable')

    const silent = ArrivalRowSchema.parse({ time: '08:32', etaSeconds: 120 })
    expect(silent.provenance).toBeUndefined()
  })

  it('rejects a provenance outside the vocabulary', () => {
    expect(ArrivalRowSchema.safeParse({
      time: '09:12',
      etaSeconds: 512,
      provenance: 'realtime-ish',
    }).success).toBe(false)
  })
})
