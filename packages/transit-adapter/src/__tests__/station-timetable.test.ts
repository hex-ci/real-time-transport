import { describe, expect, it } from 'vitest'
import {
  StationTimetableService,
  normalizeStationName,
  dayTypeForDate,
  nextDepartureEtaSeconds,
} from '../index.js'

// 与下面的生产表一起使用的这些 id 与站名就是那张表的主键：它们索引
// `src/data/subway-timetables.data.ts` 里转录的真实上游数据，必须
// 与之一致 —— 改名会静默废掉精确时刻表分支。
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
    expect(dayTypeForDate(new Date('2026-01-19T00:30:00Z'))).toBe('workday')
    expect(dayTypeForDate(new Date('2026-01-24T00:30:00Z'))).toBe('weekend')
    expect(dayTypeForDate(new Date('2026-01-25T00:30:00Z'))).toBe('weekend')
  })

  it('returns exact departures for the shipped table station to_west_railway (dir 0)', () => {
    const monday = new Date('2026-01-19T00:30:00Z')
    const nowSec = 8 * 3600 + 30 * 60
    const r = svc.query('subway_027_7', '群芳站', 0, nowSec, { count: 6, now: monday })
    expect(r).not.toBeNull()
    expect(r!.isExact).toBe(true)
    expect(r!.dayType).toBe('workday')
    expect(r!.arrivals[0]!.time).toBe('08:32')
    expect(r!.arrivals[1]!.time).toBe('08:38')
    expect(r!.arrivals[0]!.etaSeconds).toBe(120)
    expect(r!.arrivals[1]!.etaSeconds).toBeGreaterThan(r!.arrivals[0]!.etaSeconds)
  })

  it('returns weekend departures on Saturday', () => {
    const sat = new Date('2026-01-24T00:30:00Z')
    const nowSec = 8 * 3600 + 30 * 60
    const r = svc.query('subway_027_7', '群芳站', 0, nowSec, { count: 4, now: sat })
    expect(r!.dayType).toBe('weekend')
    expect(r!.arrivals[0]!.time).toBe('08:39')
  })

  it('reports nothing once the last departure of the day has gone', () => {
    // 末班发出之后不报车：把明天的首班报出来会读作有车在跑，
    // 而线路其实已经收车。
    const monday = new Date('2026-01-19T15:59:00Z')
    const r = svc.query('subway_027_7', '群芳站', 0, 23 * 3600 + 59 * 60, { now: monday })
    expect(r).not.toBeNull()
    expect(r!.isExact).toBe(true)
    expect(r!.arrivals).toEqual([])
    expect(nextDepartureEtaSeconds(r)).toBeNull()
  })

  it('reports nothing before the first departure either', () => {
    // 04:00 周二仍属于周一的运营日：首班之前同样不报车，
    // 否则会在未开始服务时给出倒计时。
    const tue = new Date('2026-01-19T20:00:00Z')
    const r = svc.query('subway_027_7', '群芳站', 0, 4 * 3600, { now: tue })
    expect(r).not.toBeNull()
    expect(r!.arrivals).toEqual([])
    expect(nextDepartureEtaSeconds(r)).toBeNull()
  })

  it('still lists the after-midnight tail during the same operating day', () => {
    // 00:10 周二属于周一的运营日：方向 1 的跨 0 点尾班仍在前面。
    const tue = new Date('2026-01-19T16:10:00Z')
    const nowSec = 24 * 3600 + 10 * 60
    const r = svc.query('subway_027_7', '群芳站', 1, nowSec, { count: 3, now: tue })
    expect(r).not.toBeNull()
    expect(r!.dayType).toBe('workday')
    expect(r!.arrivals.map(a => a.time)).toEqual(['00:16'])
  })

  it('allDeparturesToday shifts after-midnight entries to +24h', () => {
    const monday = new Date('2026-01-19T04:00:00Z')
    const all = svc.allDeparturesToday('subway_027_7', '群芳', 1, monday)
    expect(all).not.toBeNull()
    const secs = all!.departures
    expect(secs.some(s => s > 24 * 3600)).toBe(true)
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
