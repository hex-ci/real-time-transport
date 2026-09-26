import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
} from '../line-group.js'

/** 公交命中：上行与下行各是一个不同的 lineId。 */
const busUp: LineSummary = {
  lineId: '0010000000001',
  lineName: '101',
  direction: 0,
  startStop: '火车站',
  endStop: '汽车站',
  directionName: '开往 汽车站',
  cityCode: '027',
}
const busDown: LineSummary = {
  lineId: '0010000000002',
  lineName: '101',
  direction: 1,
  startStop: '汽车站',
  endStop: '火车站',
  directionName: '开往 火车站',
  cityCode: '027',
}

/** 地铁命中：同一 lineId 服务两个方向。 */
const subwayUp: LineSummary = {
  lineId: 'subway_027_88',
  lineName: '地铁88号线外环',
  direction: 0,
  startStop: '甲站',
  endStop: '甲站',
  directionName: '开往 甲站',
  cityCode: '027',
}
const subwayDown: LineSummary = { ...subwayUp, direction: 1 }

describe('groupLineSummaries', () => {
  it('merges both directions of a bus route into ONE result', () => {
    const groups = groupLineSummaries([busUp, busDown])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.lineName).toBe('101')
    expect(groups[0]!.up?.lineId).toBe('0010000000001')
    expect(groups[0]!.down?.lineId).toBe('0010000000002')
    expect(isBidirectional(groups[0]!)).toBe(true)
  })

  it('keeps the per-direction lineId distinct for buses (no invented ids)', () => {
    const groups = groupLineSummaries([busUp, busDown])
    // 两个方向绝不能塌到同一个 lineId —— 那会让切换方向后显示反方向的车辆。
    expect(groups[0]!.up!.lineId).not.toBe(groups[0]!.down!.lineId)
  })

  it('merges subway directions under the same lineId', () => {
    const groups = groupLineSummaries([subwayUp, subwayDown])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.up?.lineId).toBe('subway_027_88')
    expect(groups[0]!.down?.lineId).toBe('subway_027_88')
    expect(isBidirectional(groups[0]!)).toBe(true)
  })

  it('does not merge different routes that merely share a prefix', () => {
    const other: LineSummary = { ...busUp, lineId: '0010000000003', lineName: '102' }
    const groups = groupLineSummaries([busUp, busDown, other])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.lineName).sort()).toEqual(['101', '102'])
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
    // 必须保持 null：凭空造一个下行 lineId 会指向并不存在的线路。
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
    expect(resolveRouteTarget(group!, 0)?.lineId).toBe('0010000000001')
    expect(resolveRouteTarget(group!, 1)?.lineId).toBe('0010000000002')
  })

  it('returns null for an unavailable direction (no silent fallback)', () => {
    const [group] = groupLineSummaries([busUp])
    expect(resolveRouteTarget(group!, 1)).toBeNull()
  })
})

describe('search-hit direction labels', () => {
  it('carries the provider-built label instead of leaving callers to compose one', () => {
    const [group] = groupLineSummaries([busUp, busDown])
    // 方向名只有一个合成点：条目必须暴露已合成好的标签，UI 只负责渲染 —— 两处合成必然各自漂移。
    expect(group!.up!.directionName).toBe('开往 汽车站')
    expect(group!.down!.directionName).toBe('开往 火车站')
    for (const entry of [group!.up!, group!.down!]) {
      expect(entry.directionName).toMatch(/^开往 /)
      // 标签必须与停靠字段给出同一个终点站。
      expect(entry.directionName).toBe(`开往 ${entry.endStop}`)
    }
  })

  it('labels both subway directions from their own terminal', () => {
    const [group] = groupLineSummaries([subwayUp, { ...subwayUp, direction: 1, startStop: '乙站', endStop: '甲站', directionName: '开往 乙站' }])
    expect(group!.up!.directionName).toBe('开往 甲站')
    expect(group!.down!.directionName).toBe('开往 乙站')
  })
})

describe('resolveFavoriteLineId', () => {
  it('swaps to the reverse lineId for a bus favourite', () => {
    const fav = {
      lineId: '0010000000001',
      preferredDirection: 0,
      reverseLineId: '0010000000002',
    }
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010000000001')
    expect(resolveFavoriteLineId(fav, 1)).toBe('0010000000002')
  })

  it('respects a favourite stored with direction 1 as primary', () => {
    const fav = {
      lineId: '0010000000002',
      preferredDirection: 1,
      reverseLineId: '0010000000001',
    }
    expect(resolveFavoriteLineId(fav, 1)).toBe('0010000000002')
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010000000001')
  })

  it('returns null when the opposite direction was never resolved', () => {
    const fav = { lineId: '0010000000001', preferredDirection: 0 }
    expect(resolveFavoriteLineId(fav, 0)).toBe('0010000000001')
    expect(resolveFavoriteLineId(fav, 1)).toBeNull()
  })

  it('treats a subway favourite (same id both ways) as switchable', () => {
    const fav = {
      lineId: 'subway_027_88',
      preferredDirection: 0,
      reverseLineId: 'subway_027_88',
    }
    expect(resolveFavoriteLineId(fav, 1)).toBe('subway_027_88')
    expect(favoriteIsBidirectional(fav)).toBe(true)
  })

  it('marks a legacy favourite without reverseLineId as non-switchable', () => {
    expect(favoriteIsBidirectional({ lineId: 'subway_027_88' })).toBe(false)
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
    // 早上的选择不得替晚上作答；lineId 锚点（`preferredDirection`）不是通勤方向。
    const fav = { morningDirection: 1, preferredDirection: 0 }
    expect(commuteDirectionFor(fav, 'evening')).toBeNull()
  })
})

describe('effectiveCommuteDirection', () => {
  const twoWay = {
    lineId: '0010000000001',
    reverseLineId: '0010000000002',
    preferredDirection: 0,
  }

  it('is the stored choice on a two-way route, with no fallback', () => {
    expect(effectiveCommuteDirection({ ...twoWay, morningDirection: 1 }, 'morning')).toBe(1)
    expect(effectiveCommuteDirection({ ...twoWay, eveningDirection: 0 }, 'evening')).toBe(0)
    // 未选择就保持未选择：UI 必须显示「未设置」，而不是随便一个方向。
    expect(effectiveCommuteDirection(twoWay, 'morning')).toBeNull()
    expect(effectiveCommuteDirection({ ...twoWay, morningDirection: 1 }, 'evening')).toBeNull()
  })

  it('resolves the sole direction on a one-way route', () => {
    // 单向线路（102 专线：上游不给反向 lineId，面板只能给静态标签）存不进方向选择，
    // 故回落到 preferredDirection。
    const oneWay = { lineId: '001000000001', preferredDirection: 0 }
    expect(effectiveCommuteDirection(oneWay, 'morning')).toBe(0)
    expect(effectiveCommuteDirection(oneWay, 'evening')).toBe(0)
  })

  it('honours preferredDirection when the sole direction is 1', () => {
    expect(effectiveCommuteDirection(
      { lineId: 'x', preferredDirection: 1 }, 'morning',
    )).toBe(1)
  })

  it('prefers a stored choice over the one-way fallback', () => {
    // 即便上游后来有了反向 lineId，已存的选择仍然优先。
    const fav = {
      lineId: '001000000001',
      reverseLineId: '001000000002',
      preferredDirection: 0,
      morningDirection: 1,
    }
    expect(effectiveCommuteDirection(fav, 'morning')).toBe(1)
  })

  it('treats a subway favourite as two-way (same id, real choice)', () => {
    const subway = {
      lineId: 'subway_027_88',
      reverseLineId: 'subway_027_88',
      preferredDirection: 0,
    }
    expect(effectiveCommuteDirection(subway, 'morning')).toBeNull()
  })
})

describe('favoriteDirections', () => {
  it('yields both directions of a bus route, each with its own lineId', () => {
    const fav = {
      lineId: '0010000000001',
      reverseLineId: '0010000000002',
      preferredDirection: 0,
    }
    expect(favoriteDirections(fav)).toEqual([
      { direction: 0, lineId: '0010000000001' },
      { direction: 1, lineId: '0010000000002' },
    ])
  })

  it('honours preferredDirection when it is 1', () => {
    const fav = {
      lineId: '0010000000002',
      reverseLineId: '0010000000001',
      preferredDirection: 1,
    }
    expect(favoriteDirections(fav)).toEqual([
      { direction: 1, lineId: '0010000000002' },
      { direction: 0, lineId: '0010000000001' },
    ])
  })

  it('yields ONE entry for a single-direction route', () => {
    // 单向线路：若用 `?? f.lineId` 兜底枚举 [0, 1]，两个方向会得到同一个 lineId，
    // 站台看板便会以相同的站序与到站把它列两次。
    const oneWay = { lineId: '001000000001', preferredDirection: 0 }
    expect(favoriteDirections(oneWay)).toEqual([
      { direction: 0, lineId: '001000000001' },
    ])
  })

  it('yields two entries for a subway route sharing one lineId', () => {
    const subway = {
      lineId: 'subway_027_88',
      reverseLineId: 'subway_027_88',
      preferredDirection: 0,
    }
    expect(favoriteDirections(subway)).toEqual([
      { direction: 0, lineId: 'subway_027_88' },
      { direction: 1, lineId: 'subway_027_88' },
    ])
  })
})

describe('reading a stored stop back', () => {
  it('is not answered by a name-only helper any more', () => {
    const lineGroup = readFileSync(
      fileURLToPath(new URL('../line-group.ts', import.meta.url)),
      'utf8',
    )
    expect(lineGroup, 'a name-only "is it served" helper is back, and it cannot tell WHICH stop')
      .not.toContain('stopServedByDirection')
  })
})
