import { describe, expect, it } from 'vitest'
import type { LineSummary } from '../schemas/api.js'
import {
  favoriteIsBidirectional,
  groupLineSummaries,
  isBidirectional,
  resolveFavoriteLineId,
  resolveRouteTarget,
} from '../line-group.js'

/** chelaile bus hit: one distinct lineId per direction. */
const busUp: LineSummary = {
  lineId: '0010257103360',
  lineName: '913',
  direction: 0,
  startStop: '海子角',
  endStop: '古城西桥公交场站',
  cityCode: '027',
}
const busDown: LineSummary = {
  lineId: '0010257104391',
  lineName: '913',
  direction: 1,
  startStop: '古城西桥公交场站',
  endStop: '海子角',
  cityCode: '027',
}

/** subway hit: the SAME lineId serves both directions. */
const subwayUp: LineSummary = {
  lineId: 'subway_027_10',
  lineName: '地铁10号线外环',
  direction: 0,
  startStop: '车道沟',
  endStop: '车道沟',
  cityCode: '027',
}
const subwayDown: LineSummary = { ...subwayUp, direction: 1 }

describe('groupLineSummaries', () => {
  it('merges both directions of a bus route into ONE result', () => {
    const groups = groupLineSummaries([busUp, busDown])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.lineName).toBe('913')
    expect(groups[0]!.up?.lineId).toBe('0010257103360')
    expect(groups[0]!.down?.lineId).toBe('0010257104391')
    expect(isBidirectional(groups[0]!)).toBe(true)
  })

  it('keeps the per-direction lineId distinct for buses (no invented ids)', () => {
    const groups = groupLineSummaries([busUp, busDown])
    // The two directions must NOT collapse onto one lineId — that would make
    // switching show the wrong way's vehicles.
    expect(groups[0]!.up!.lineId).not.toBe(groups[0]!.down!.lineId)
  })

  it('merges subway directions under the same lineId', () => {
    const groups = groupLineSummaries([subwayUp, subwayDown])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.up?.lineId).toBe('subway_027_10')
    expect(groups[0]!.down?.lineId).toBe('subway_027_10')
    expect(isBidirectional(groups[0]!)).toBe(true)
  })

  it('does not merge different routes that merely share a prefix', () => {
    const other: LineSummary = { ...busUp, lineId: '0010999', lineName: '914' }
    const groups = groupLineSummaries([busUp, busDown, other])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.lineName).sort()).toEqual(['913', '914'])
  })

  it('does not merge the same name across different cities', () => {
    const shanghai: LineSummary = { ...busUp, lineId: 'sh_1', cityCode: '034' }
    const groups = groupLineSummaries([busUp, shanghai])
    expect(groups).toHaveLength(2)
  })

  it('leaves a one-direction route half-empty instead of synthesizing a partner', () => {
    const groups = groupLineSummaries([busUp])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.up).not.toBeNull()
    // Must stay null: inventing a down lineId would point at a nonexistent route.
    expect(groups[0]!.down).toBeNull()
    expect(isBidirectional(groups[0]!)).toBe(false)
  })

  it('ignores hits with no lineId', () => {
    const groups = groupLineSummaries([{ ...busUp, lineId: '' }])
    expect(groups).toHaveLength(0)
  })
})

describe('resolveRouteTarget', () => {
  it('returns the requested direction only', () => {
    const [group] = groupLineSummaries([busUp, busDown])
    expect(resolveRouteTarget(group!, 0)?.lineId).toBe('0010257103360')
    expect(resolveRouteTarget(group!, 1)?.lineId).toBe('0010257104391')
  })

  it('returns null for an unavailable direction (no silent fallback)', () => {
    const [group] = groupLineSummaries([busUp])
    expect(resolveRouteTarget(group!, 1)).toBeNull()
  })
})

describe('resolveFavoriteLineId', () => {
  it('swaps to the reverse lineId for a bus favourite', () => {
    const fav = {
      lineId: '0010257103360',
      preferredDirection: 0,
      reverseLineId: '0010257104391',
    }
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010257103360')
    expect(resolveFavoriteLineId(fav, 1)).toBe('0010257104391')
  })

  it('respects a favourite stored with direction 1 as primary', () => {
    const fav = {
      lineId: '0010257104391',
      preferredDirection: 1,
      reverseLineId: '0010257103360',
    }
    expect(resolveFavoriteLineId(fav, 1)).toBe('0010257104391')
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010257103360')
  })

  it('returns null when the opposite direction was never resolved', () => {
    const fav = { lineId: '0010257103360', preferredDirection: 0 }
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010257103360')
    expect(resolveFavoriteLineId(fav, 1)).toBeNull()
  })

  it('treats a subway favourite (same id both ways) as switchable', () => {
    const fav = {
      lineId: 'subway_027_10',
      preferredDirection: 0,
      reverseLineId: 'subway_027_10',
    }
    expect(resolveFavoriteLineId(fav, 1)).toBe('subway_027_10')
    expect(favoriteIsBidirectional(fav)).toBe(true)
  })

  it('marks a legacy favourite without reverseLineId as non-switchable', () => {
    expect(favoriteIsBidirectional({ lineId: 'subway_027_7' })).toBe(false)
  })
})
