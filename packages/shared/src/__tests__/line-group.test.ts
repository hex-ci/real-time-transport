import { describe, expect, it } from 'vitest'
import type { LineSummary } from '../schemas/api.js'
import {
  commuteDirectionFor,
  effectiveCommuteDirection,
  favoriteDirections,
  favoriteIsBidirectional,
  groupLineSummaries,
  isBidirectional,
  resolveFavoriteLineId,
  resolveRouteTarget,
  stopServedByDirection,
} from '../line-group.js'

/** chelaile bus hit: one distinct lineId per direction. */
const busUp: LineSummary = {
  lineId: '0010257103360',
  lineName: '913',
  direction: 0,
  startStop: '海子角',
  endStop: '古城西桥公交场站',
  directionName: '开往 古城西桥公交场站',
  cityCode: '027',
}
const busDown: LineSummary = {
  lineId: '0010257104391',
  lineName: '913',
  direction: 1,
  startStop: '古城西桥公交场站',
  endStop: '海子角',
  directionName: '开往 海子角',
  cityCode: '027',
}

/** subway hit: the SAME lineId serves both directions. */
const subwayUp: LineSummary = {
  lineId: 'subway_027_10',
  lineName: '地铁10号线外环',
  direction: 0,
  startStop: '车道沟',
  endStop: '车道沟',
  directionName: '开往 车道沟',
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

describe('search-hit direction labels', () => {
  it('carries the provider-built label instead of leaving callers to compose one', () => {
    const [group] = groupLineSummaries([busUp, busDown])
    // Regression: the search rows used to render `开往 ${endStop}` themselves,
    // which is a SECOND composition of the same label the direction selector
    // builds from `directionName`. Two composition sites can drift apart; the
    // entry must expose the finished label so the UI only renders it.
    expect(group!.up!.directionName).toBe('开往 古城西桥公交场站')
    expect(group!.down!.directionName).toBe('开往 海子角')
    for (const entry of [group!.up!, group!.down!]) {
      expect(entry.directionName).toMatch(/^开往 /)
      // The label must name the same terminal the stop fields report.
      expect(entry.directionName).toBe(`开往 ${entry.endStop}`)
    }
  })

  it('labels both subway directions from their own terminal', () => {
    const [group] = groupLineSummaries([subwayUp, { ...subwayUp, direction: 1, startStop: '苹果园', endStop: '车道沟', directionName: '开往 苹果园' }])
    expect(group!.up!.directionName).toBe('开往 车道沟')
    expect(group!.down!.directionName).toBe('开往 苹果园')
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

describe('commuteDirectionFor', () => {
  it('returns the explicitly chosen direction per purpose', () => {
    const fav = { morningDirection: 1, eveningDirection: 0 }
    expect(commuteDirectionFor(fav, 'morning')).toBe(1)
    expect(commuteDirectionFor(fav, 'evening')).toBe(0)
  })

  it('treats 0 as a real choice, not a missing value', () => {
    expect(commuteDirectionFor({ morningDirection: 0 }, 'morning')).toBe(0)
  })

  it('returns null when the user has not chosen', () => {
    expect(commuteDirectionFor({}, 'morning')).toBeNull()
    expect(commuteDirectionFor({ morningDirection: null }, 'morning')).toBeNull()
    expect(commuteDirectionFor({ eveningDirection: null }, 'evening')).toBeNull()
  })

  it('does not fall back to the other purpose or to preferredDirection', () => {
    // A morning choice must not answer for the evening, and the lineId anchor
    // (`preferredDirection`) is not a commute direction.
    const fav = { morningDirection: 1, preferredDirection: 0 }
    expect(commuteDirectionFor(fav, 'evening')).toBeNull()
  })
})

describe('effectiveCommuteDirection', () => {
  const twoWay = {
    lineId: '0010257103360',
    reverseLineId: '0010257104391',
    preferredDirection: 0,
  }

  it('is the stored choice on a two-way route, with no fallback', () => {
    expect(effectiveCommuteDirection({ ...twoWay, morningDirection: 1 }, 'morning')).toBe(1)
    expect(effectiveCommuteDirection({ ...twoWay, eveningDirection: 0 }, 'evening')).toBe(0)
    // Unchosen stays unchosen: the UI must show "not set", not an arbitrary way.
    expect(effectiveCommuteDirection(twoWay, 'morning')).toBeNull()
    expect(effectiveCommuteDirection({ ...twoWay, morningDirection: 1 }, 'evening')).toBeNull()
  })

  it('resolves the sole direction on a one-way route', () => {
    // 金融街1号专线: upstream returns no reverse lineId, so the settings panel
    // renders a static label instead of a picker and nothing can ever store a
    // choice. Requiring one left every consumer stuck on "not set" forever.
    const oneWay = { lineId: '001059482134', preferredDirection: 0 }
    expect(effectiveCommuteDirection(oneWay, 'morning')).toBe(0)
    expect(effectiveCommuteDirection(oneWay, 'evening')).toBe(0)
  })

  it('honours preferredDirection when the sole direction is 1', () => {
    expect(effectiveCommuteDirection(
      { lineId: 'x', preferredDirection: 1 }, 'morning',
    )).toBe(1)
  })

  it('prefers a stored choice over the one-way fallback', () => {
    // Should upstream later gain a reverse lineId, a stored choice still wins.
    const fav = {
      lineId: '001059482134',
      reverseLineId: '001059482135',
      preferredDirection: 0,
      morningDirection: 1,
    }
    expect(effectiveCommuteDirection(fav, 'morning')).toBe(1)
  })

  it('treats a subway favourite as two-way (same id, real choice)', () => {
    const subway = {
      lineId: 'subway_027_7',
      reverseLineId: 'subway_027_7',
      preferredDirection: 0,
    }
    expect(effectiveCommuteDirection(subway, 'morning')).toBeNull()
  })
})

describe('favoriteDirections', () => {
  it('yields both directions of a bus route, each with its own lineId', () => {
    const fav = {
      lineId: '0010257103360',
      reverseLineId: '0010257104391',
      preferredDirection: 0,
    }
    expect(favoriteDirections(fav)).toEqual([
      { direction: 0, lineId: '0010257103360' },
      { direction: 1, lineId: '0010257104391' },
    ])
  })

  it('honours preferredDirection when it is 1', () => {
    const fav = {
      lineId: '0010257104391',
      reverseLineId: '0010257103360',
      preferredDirection: 1,
    }
    expect(favoriteDirections(fav)).toEqual([
      { direction: 1, lineId: '0010257104391' },
      { direction: 0, lineId: '0010257103360' },
    ])
  })

  it('yields ONE entry for a single-direction route', () => {
    // 金融街1号专线. Enumerating [0, 1] with a `?? f.lineId` fallback made the
    // same lineId answer for both, so the platform board listed it twice with
    // identical order and arrivals.
    const oneWay = { lineId: '001059482134', preferredDirection: 0 }
    expect(favoriteDirections(oneWay)).toEqual([
      { direction: 0, lineId: '001059482134' },
    ])
  })

  it('yields two entries for a subway route sharing one lineId', () => {
    const subway = {
      lineId: 'subway_027_7',
      reverseLineId: 'subway_027_7',
      preferredDirection: 0,
    }
    expect(favoriteDirections(subway)).toEqual([
      { direction: 0, lineId: 'subway_027_7' },
      { direction: 1, lineId: 'subway_027_7' },
    ])
  })
})

describe('stopServedByDirection', () => {
  const detail = { stops: [{ name: '金星桥东' }, { name: '大马庄' }] }

  it('reports a stop that this direction serves', () => {
    expect(stopServedByDirection(detail, '大马庄')).toBe(true)
  })

  it('reports a stop this direction does not serve (direction-exclusive platform)', () => {
    expect(stopServedByDirection(detail, '金星桥西')).toBe(false)
  })

  it('returns null when there is nothing to judge, never false', () => {
    expect(stopServedByDirection(detail, null)).toBeNull()
    expect(stopServedByDirection(detail, undefined)).toBeNull()
    // Stops not loaded yet: unknown, not "not served".
    expect(stopServedByDirection(null, '大马庄')).toBeNull()
    expect(stopServedByDirection(undefined, '大马庄')).toBeNull()
  })
})
