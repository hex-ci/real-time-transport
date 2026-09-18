import { describe, expect, it } from 'vitest'
import {
  StationTimetableService,
  normalizeStationName,
  dayTypeForDate,
} from '../index.js'

describe('StationTimetableService (precise timetable overlay)', () => {
  const svc = new StationTimetableService()

  it('normalizes station names so 群芳站 matches 群芳', () => {
    expect(normalizeStationName('群芳站')).toBe('群芳')
    expect(normalizeStationName('群芳')).toBe('群芳')
    expect(normalizeStationName('北京西站')).toBe('北京西')
    expect(normalizeStationName('次渠南（临时站）')).toBe('次渠南')
    expect(svc.has('subway_027_7', '群芳站')).toBe(true)
    expect(svc.has('subway_027_7', '群芳')).toBe(true)
  })

  it('selects workday table on weekdays and weekend table on Sat/Sun', () => {
    // 2026-01-19 is a Monday, 2026-01-24 is a Saturday
    expect(dayTypeForDate(new Date('2026-01-19T00:30:00Z'))).toBe('workday')
    expect(dayTypeForDate(new Date('2026-01-24T00:30:00Z'))).toBe('weekend')
    expect(dayTypeForDate(new Date('2026-01-25T00:30:00Z'))).toBe('weekend') // Sunday
  })

  it('returns exact departures for Line 7 群芳站 to_west_railway (dir 0)', () => {
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
    expect(svc.has('subway_027_7', '万盛东')).toBe(false)
    expect(svc.query('subway_027_7', '万盛东', 0, 8 * 3600)).toBeNull()
    expect(svc.has('subway_034_2', '群芳')).toBe(false)
  })

  it('lists exact-timetable stations for a line', () => {
    expect(svc.stationsForLine('subway_027_7')).toEqual(['群芳'])
    expect(svc.stationsForLine('subway_027_10')).toEqual([])
  })
})
