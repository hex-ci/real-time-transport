import { describe, expect, it } from 'vitest'
import {
  isSubwayTimetablePayload,
  timetablesFromCacheRows,
  type SubwayTimetableCacheRow,
  type SubwayTimetablePayload,
} from '../subway-timetable-cache.js'
import { queryStationArrivals } from '../station-timetable.js'

function payload(): SubwayTimetablePayload {
  return {
    lineName: '地铁7号线',
    directionName: '开往环球度假区',
    stations: [
      { name: '群芳', pStopId: 14711, departures: { 5: [48, 57], 23: [51] } },
      { name: '花庄', pStopId: 14713, departures: { 0: [5], 5: [53] } },
    ],
  }
}

describe('isSubwayTimetablePayload', () => {
  it('accepts the shape written by the fetcher', () => {
    expect(isSubwayTimetablePayload(payload())).toBe(true)
  })

  it('rejects an empty station list', () => {
    expect(isSubwayTimetablePayload({ ...payload(), stations: [] })).toBe(false)
  })

  it('rejects a missing line or direction name', () => {
    expect(isSubwayTimetablePayload({ ...payload(), lineName: '' })).toBe(false)
    expect(isSubwayTimetablePayload({ ...payload(), directionName: '' })).toBe(false)
  })

  it('rejects an out-of-range hour', () => {
    const bad = payload()
    bad.stations[0]!.departures['24'] = [0]
    expect(isSubwayTimetablePayload(bad)).toBe(false)
  })

  it('rejects an out-of-range or fractional minute', () => {
    for (const minute of [60, -1, 1.5]) {
      const bad = payload()
      bad.stations[0]!.departures['5'] = [minute]
      expect(isSubwayTimetablePayload(bad), `minute ${minute}`).toBe(false)
    }
  })

  it('rejects a non-positive pStopId', () => {
    for (const id of [0, -1, 1.5]) {
      const bad = payload()
      bad.stations[0]!.pStopId = id
      expect(isSubwayTimetablePayload(bad), `pStopId ${id}`).toBe(false)
    }
  })

  it('rejects departures that are not an object map', () => {
    const bad = payload() as unknown as { stations: Array<{ departures: unknown }> }
    bad.stations[0]!.departures = [48, 57]
    expect(isSubwayTimetablePayload(bad)).toBe(false)
  })
})

describe('timetablesFromCacheRows', () => {
  function row(direction: number, subLineId: number): SubwayTimetableCacheRow {
    return {
      cityCode: '027',
      lineId: 'subway_027_7',
      subLineId,
      direction,
      dayType: 'weekend',
      serviceDate: '2026-10-17',
      payload: {
        lineName: '地铁7号线',
        directionName: direction === 1 ? '开往环球度假区' : '开往北京西站',
        stations: [{ name: '群芳', pStopId: 14711, departures: { 5: [10], 6: [5] } }],
      },
      fetchedAt: Date.now(),
    }
  }

  it('merges the two directions into one station entry, only the cached day type', () => {
    const [timetable] = timetablesFromCacheRows([row(1, 47), row(0, 46)])
    expect(timetable).toBeDefined()
    expect(timetable!.directions['1']!.weekend).toBeDefined()
    expect(timetable!.directions['0']!.weekend).toBeDefined()
    expect(timetable!.directions['1']!.workday).toBeUndefined()
    expect(timetable!.directions['1']!.name).toBe('开往环球度假区')
  })

  it('computes first/last from departures', () => {
    const [timetable] = timetablesFromCacheRows([row(1, 47)])
    expect(timetable!.directions['1']!.weekend!.first).toBe('5:10')
    expect(timetable!.directions['1']!.weekend!.last).toBe('6:05')
  })

  it('returns null for a day type that was never fetched, instead of the other one', () => {
    const [timetable] = timetablesFromCacheRows([row(1, 47)])
    const now = new Date(Date.UTC(2026, 9, 17, 2, 0))
    expect(queryStationArrivals(timetable!, 1, 5 * 3600 + 300, { dayType: 'workday', now })).toBeNull()
    expect(queryStationArrivals(timetable!, 1, 5 * 3600 + 300, { dayType: 'weekend', now })).not.toBeNull()
  })

  it('drops rows whose payload is invalid', () => {
    const bad = row(1, 47)
    bad.payload.stations[0]!.departures['24'] = [0]
    expect(timetablesFromCacheRows([bad])).toEqual([])
  })
})

describe('timetablesFromCacheRows: 残缺表', () => {
  it('drops the whole direction when one station has no departures', () => {
    const bad: SubwayTimetableCacheRow = {
      cityCode: '027',
      lineId: 'subway_027_7',
      subLineId: 47,
      direction: 1,
      dayType: 'weekend',
      serviceDate: '2026-10-17',
      payload: {
        lineName: '地铁7号线',
        directionName: '开往环球度假区',
        stations: [
          { name: '群芳', pStopId: 14711, departures: { 5: [10] } },
          { name: '花庄', pStopId: 14713, departures: {} },
        ],
      },
      fetchedAt: Date.now(),
    }
    expect(timetablesFromCacheRows([bad])).toEqual([])
  })
})
