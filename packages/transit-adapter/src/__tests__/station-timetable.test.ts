import { describe, expect, it } from 'vitest'
import {
  StationTimetableService,
  normalizeStationName,
  dayTypeForDate,
  nextDepartureEtaSeconds,
} from '../index.js'

// The ids and station names used with the production table below are that table's
// PRIMARY KEYS: they index the transcribed timetable in `src/data/subway-timetables.data.ts`,
// which is real upstream data rather than a fixture. They must keep matching it —
// renaming one silently kills the exact-timetable branch. Names that exist only as
// fixtures in this file (乙乙站, 丙丙（临时站）) carry no such constraint.
describe('StationTimetableService (precise timetable overlay)', () => {
  const svc = new StationTimetableService()

  it('normalizes a station name to the key the table is indexed by', () => {
    expect(normalizeStationName('群芳站')).toBe('群芳')
    expect(normalizeStationName('群芳')).toBe('群芳')
    expect(normalizeStationName('乙乙站')).toBe('乙乙')
    expect(normalizeStationName('丙丙（临时站）')).toBe('丙丙')
    expect(svc.has('subway_027_7', '群芳站')).toBe(true)
    expect(svc.has('subway_027_7', '群芳')).toBe(true)
  })

  it('selects workday table on weekdays and weekend table on Sat/Sun', () => {
    // 2026-01-19 is a Monday, 2026-01-24 is a Saturday
    expect(dayTypeForDate(new Date('2026-01-19T00:30:00Z'))).toBe('workday')
    expect(dayTypeForDate(new Date('2026-01-24T00:30:00Z'))).toBe('weekend')
    expect(dayTypeForDate(new Date('2026-01-25T00:30:00Z'))).toBe('weekend') // Sunday
  })

  it('returns exact departures for the shipped table station to_west_railway (dir 0)', () => {
    const monday = new Date('2026-01-19T00:30:00Z') // 08:30 CST Monday
    const nowSec = 8 * 3600 + 30 * 60
    const r = svc.query('subway_027_7', '群芳站', 0, nowSec, { count: 6, now: monday })
    expect(r).not.toBeNull()
    expect(r!.isExact).toBe(true)
    expect(r!.dayType).toBe('workday')
    // Official workday to_west_railway hour 8: [2,8,14,20,26,32,38,44,50,57]
    expect(r!.arrivals[0]!.time).toBe('08:32')
    expect(r!.arrivals[1]!.time).toBe('08:38')
    // etaSeconds must be positive and increasing
    expect(r!.arrivals[0]!.etaSeconds).toBe(120)
    expect(r!.arrivals[1]!.etaSeconds).toBeGreaterThan(r!.arrivals[0]!.etaSeconds)
  })

  it('returns weekend departures on Saturday', () => {
    const sat = new Date('2026-01-24T00:30:00Z') // 08:30 CST Saturday
    const nowSec = 8 * 3600 + 30 * 60
    const r = svc.query('subway_027_7', '群芳站', 0, nowSec, { count: 4, now: sat })
    expect(r!.dayType).toBe('weekend')
    // Official weekend to_west_railway hour 8: [2,12,20,29,39,47,56]
    expect(r!.arrivals[0]!.time).toBe('08:39')
  })

  it('reports nothing once the last departure of the day has gone', () => {
    // 23:59 CST Monday: dir 0's last departure is 23:06, so nothing is left
    // today. Returning tomorrow's first train would show as a ~300 minute ETA
    // and read as a live train when the line is closed.
    const monday = new Date('2026-01-19T15:59:00Z')
    const r = svc.query('subway_027_7', '群芳站', 0, 23 * 3600 + 59 * 60, { now: monday })
    expect(r).not.toBeNull()
    expect(r!.isExact).toBe(true)
    expect(r!.arrivals).toEqual([])
    expect(nextDepartureEtaSeconds(r)).toBeNull()
  })

  it('reports nothing before the first departure either', () => {
    // 04:00 CST Tuesday: still Monday's operating day, whose first departure is
    // 05:16. Showing it would be a 76 minute countdown while the metro is shut.
    const tue = new Date('2026-01-19T20:00:00Z') // 04:00 CST Tue
    const r = svc.query('subway_027_7', '群芳站', 0, 4 * 3600, { now: tue })
    expect(r).not.toBeNull()
    expect(r!.arrivals).toEqual([])
    expect(nextDepartureEtaSeconds(r)).toBeNull()
  })

  it('still lists the after-midnight tail during the same operating day', () => {
    // 00:10 CST Tuesday belongs to Monday's operating day: dir 1 has 0:01, 0:08,
    // 0:16 entries, so 00:16 is still ahead.
    const tue = new Date('2026-01-19T16:10:00Z') // 00:10 CST Tue
    const nowSec = 24 * 3600 + 10 * 60
    const r = svc.query('subway_027_7', '群芳站', 1, nowSec, { count: 3, now: tue })
    expect(r).not.toBeNull()
    // Monday is the operating day, so the workday table applies.
    expect(r!.dayType).toBe('workday')
    expect(r!.arrivals.map(a => a.time)).toEqual(['00:16'])
  })

  it('allDeparturesToday shifts after-midnight entries to +24h', () => {
    const monday = new Date('2026-01-19T04:00:00Z') // 12:00 CST
    const all = svc.allDeparturesToday('subway_027_7', '群芳', 1, monday) // to_universal has hour 0 entries
    expect(all).not.toBeNull()
    const secs = all!.departures
    // hour 0 entries (0:01,0:08,0:16) must appear as > 24h
    expect(secs.some(s => s > 24 * 3600)).toBe(true)
    // sorted ascending
    expect(secs.every((s, i) => i === 0 || s >= secs[i - 1]!)).toBe(true)
  })

  it('returns null for stations without a precise timetable', () => {
    expect(svc.has('subway_027_7', '乙站')).toBe(false)
    expect(svc.query('subway_027_7', '乙站', 0, 8 * 3600)).toBeNull()
    expect(svc.has('subway_027_88', '群芳')).toBe(false)
  })

  it('lists exact-timetable stations for a line', () => {
    expect(svc.stationsForLine('subway_027_7')).toEqual(['群芳'])
    expect(svc.stationsForLine('subway_027_88')).toEqual([])
  })
})
