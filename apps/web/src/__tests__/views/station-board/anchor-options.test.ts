import { describe, expect, it } from 'vitest'
import {
  LineDetailSchema,
  UserFavoriteLineSchema,
  type LineDetail,
  type UserFavoriteLine,
} from '@real-time-transport/shared'
import { anchorStationsOf, type FavoriteDetails } from '../../../views/station-board/anchor-options'

/**
 * 「我钉过的站台」从关注线路里解析出来的规则（F1 的上下班上车点与关注站）。
 *
 * 这一层最容易出的错是**谎报**：把站名随便对上一个站序，或者对不上时退回第一个同名站 ——
 * 于是下拉里多出一个用户没钉过的站，而他点进去读到的是另一个实体站台的到站。故本文件逐个钉住
 * 定位不到的四种情形（站名改过、只留站名而同名多站、本方向不停靠、方向未设置），一律**跳过**。
 *
 * `NN…` 是占位：本文件不出现真实站名。
 */

const CITY = '027'

/** 一条关注线路；只给本用例关心的字段，其余走 schema 自己的缺省。 */
function favoriteOf(over: Record<string, unknown> = {}): UserFavoriteLine {
  return UserFavoriteLineSchema.parse({
    cityCode: CITY,
    lineId: 'bus_027_1',
    lineName: '101路',
    reverseLineId: 'bus_027_2',
    ...over,
  })
}

/** 某方向的站表。 */
function detailOf(
  direction: 0 | 1,
  stops: Array<{ id: string, name: string, order: number, lat?: number, lng?: number }>,
): LineDetail {
  return LineDetailSchema.parse({
    lineId: direction === 0 ? 'bus_027_1' : 'bus_027_2',
    lineName: '101路',
    direction,
    directionName: '开往 NN终点站',
    stops: stops.map(stop => ({ ...stop, interchanges: [] })),
  })
}

const STOPS = [
  { id: '010-1', name: 'NN起点站', order: 1 },
  { id: '010-2', name: 'NN上车点', order: 5, lat: 39.9, lng: 116.4 },
  { id: '010-3', name: 'NN终点站', order: 9 },
]

function entriesOf(over: { favorite?: UserFavoriteLine, details?: Partial<FavoriteDetails['details']> } = {}): FavoriteDetails[] {
  return [{
    favorite: over.favorite ?? favoriteOf({ morningStopName: 'NN上车点', morningStopOrder: 5 }),
    details: { 0: detailOf(0, STOPS), 1: detailOf(1, STOPS), ...(over.details ?? {}) },
  }]
}

describe('上下班上车点解析成实体站', () => {
  it('按 (站名, 站序) 定位到那一站，带站 id、坐标与身份', () => {
    const anchors = anchorStationsOf(entriesOf({
      favorite: favoriteOf({ morningStopName: 'NN上车点', morningStopOrder: 5, morningDirection: 0 }),
    }))

    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({
      name: 'NN上车点',
      stationId: '010-2',
      lat: 39.9,
      lng: 116.4,
      anchor: 'morning',
      origin: 'followed',
      distanceMeters: null,
    })
  })

  it('站名被改过（存的是旧站名）：跳过，绝不按站名去猜一个', () => {
    // 站序还在，但那个站序上已经是别的站名 —— 上游重编过站序，退回站名匹配会悄悄挪走用户的站台。
    const anchors = anchorStationsOf(entriesOf({
      favorite: favoriteOf({ morningStopName: 'NN旧站名', morningStopOrder: 5, morningDirection: 0 }),
    }))

    expect(anchors).toEqual([])
  })

  it('只留了站名而已且同名多站：跳过（指哪一个无从得知）', () => {
    const doubled = [
      { id: '010-1', name: 'NN起点站', order: 1 },
      { id: '010-2', name: 'NN上车点', order: 5 },
      { id: '010-9', name: 'NN上车点', order: 7 },
    ]
    // 只留站名的行在今天写不出来（站名与站序同生同灭），但**旧行**还在库里；故这里手工造一个，
    // 而不是经 schema —— 那条规则挡的正是这种行。
    const legacy = {
      ...favoriteOf({ morningDirection: 0 }),
      morningStopName: 'NN上车点',
      morningStopOrder: null,
    } as UserFavoriteLine
    const anchors = anchorStationsOf(entriesOf({
      favorite: legacy,
      details: { 0: detailOf(0, doubled) },
    }))

    expect(anchors).toEqual([])
  })

  it('本方向不停靠：跳过', () => {
    const anchors = anchorStationsOf(entriesOf({
      favorite: favoriteOf({ morningStopName: 'NN别的站', morningStopOrder: 3, morningDirection: 0 }),
    }))

    expect(anchors).toEqual([])
  })

  it('方向还没选（双向线路）：跳过，不退回到方向 0', () => {
    const anchors = anchorStationsOf(entriesOf({
      favorite: favoriteOf({ morningStopName: 'NN上车点', morningStopOrder: 5, morningDirection: null }),
    }))

    expect(anchors).toEqual([])
  })

  it('站表没读到：跳过 —— 从一个没人读过的列表里说不出「不匹配」', () => {
    const anchors = anchorStationsOf(entriesOf({ details: { 0: null, 1: null } }))

    expect(anchors).toEqual([])
  })
})

describe('下班上车点与关注站', () => {
  it('三种身份都能解析出来，顺序是上班 → 下班 → 关注站', () => {
    const anchors = anchorStationsOf([{
      favorite: favoriteOf({
        morningStopName: 'NN上车点',
        morningStopOrder: 5,
        morningDirection: 0,
        eveningStopName: 'NN终点站',
        eveningStopOrder: 9,
        eveningDirection: 0,
        followedStopName0: 'NN起点站',
        followedStopOrder0: 1,
      }),
      details: { 0: detailOf(0, STOPS), 1: detailOf(1, STOPS) },
    }])

    expect(anchors.map(anchor => [anchor.name, anchor.anchor])).toEqual([
      ['NN上车点', 'morning'],
      ['NN终点站', 'evening'],
      ['NN起点站', 'followed'],
    ])
  })

  it('两个方向的关注站各自解析（上下行站名常常不同）', () => {
    const anchors = anchorStationsOf([{
      favorite: favoriteOf({
        followedStopName0: 'NN起点站',
        followedStopOrder0: 1,
        followedStopName1: 'NN终点站',
        followedStopOrder1: 9,
      }),
      details: { 0: detailOf(0, STOPS), 1: detailOf(1, STOPS) },
    }])

    expect(anchors.map(anchor => anchor.name)).toEqual(['NN起点站', 'NN终点站'])
  })

  it('同名只留一条：一个站既是上车点又是关注站时，先遇到的身份胜出', () => {
    // 说的是同一趟车的同一件事，两行会让人以为它们去的是两个地方。
    const anchors = anchorStationsOf([{
      favorite: favoriteOf({
        morningStopName: 'NN上车点',
        morningStopOrder: 5,
        morningDirection: 0,
        followedStopName0: 'NN上车点',
        followedStopOrder0: 5,
      }),
      details: { 0: detailOf(0, STOPS), 1: detailOf(1, STOPS) },
    }])

    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ name: 'NN上车点', anchor: 'morning' })
  })

  it('什么都没钉的关注线路：一条都不贡献', () => {
    expect(anchorStationsOf(entriesOf({ favorite: favoriteOf() }))).toEqual([])
  })
})
