import { describe, expect, it } from 'vitest'
import { NEARBY_RADIUS_M } from '@real-time-transport/shared/geo'
import {
  mergeStationSources,
  originMarkOf,
  outOfNearbyNoteOf,
  sortByDistance,
  withDistances,
  type StationOption,
} from '../../../views/station-board/station-options'

/**
 * 站台列表的顺序（PRD F5）：**离我最近的在前**。
 *
 * 这一页要回答的问题里，「哪个站台上车」是由**位置**决定的，故排错一个位置，使用者读到的
 * 就是另一个站台的车。本文件因此守四件事：最近的在前、没有距离的不冒充最近、
 * 没有定位时如实说不知道、以及「最近的也在 3 公里外」这句话什么时候出现。
 *
 * `NN站` 是占位：本文件不出现真实站名。
 */

const ME = { lat: 39.9, lng: 116.4 }

function stationOf(
  name: string,
  lat: number | null,
  lng: number | null,
  origin: StationOption['origin'] = 'followed',
): StationOption {
  return { name, stationId: `010-${name}`, lat, lng, distanceMeters: null, origin }
}

/** 在参考点东边约 `meters` 米的一个站（0.01° 经度 ≈ 854 米）。 */
function eastOfMe(name: string, meters: number): StationOption {
  return stationOf(name, ME.lat, ME.lng + (meters / 854) * 0.01)
}

describe('最近的在前', () => {
  it('按直线距离升序，最近的排第一', () => {
    const ordered = sortByDistance(withDistances([
      eastOfMe('远处站', 5000),
      eastOfMe('近处站', 300),
      eastOfMe('中距站', 1200),
    ], ME))

    expect(ordered.map(option => option.name)).toEqual(['近处站', '中距站', '远处站'])
    expect(ordered[0]!.distanceMeters).toBeGreaterThan(280)
    expect(ordered[0]!.distanceMeters).toBeLessThan(320)
  })

  it('两个站一样近时按站名稳定排，不靠输入顺序', () => {
    const same = [stationOf('B站', ME.lat, ME.lng), stationOf('A站', ME.lat, ME.lng)]
    expect(sortByDistance(withDistances(same, ME)).map(o => o.name)).toEqual(['A站', 'B站'])
  })

  it('距离用的是与别处同一条直线距离：0.01 经度在这个纬度约 854 米', () => {
    const [only] = withDistances([stationOf('NN站', ME.lat, ME.lng + 0.01)], ME)
    expect(only!.distanceMeters).toBeGreaterThan(840)
    expect(only!.distanceMeters).toBeLessThan(870)
  })
})

describe('不知道就说不知道', () => {
  it('没有定位时每个距离都是 null，顺序退回站名', () => {
    const measured = withDistances([
      eastOfMe('B站', 300),
      eastOfMe('A站', 4000),
    ], null)

    expect(measured.map(option => option.distanceMeters)).toEqual([null, null])
    expect(sortByDistance(measured).map(option => option.name)).toEqual(['A站', 'B站'])
  })

  it('站表没给坐标的站不测距，也不被顶到「最近」的位置上', () => {
    const ordered = sortByDistance(withDistances([
      stationOf('无坐标站', null, null),
      eastOfMe('有坐标站', 2000),
    ], ME))

    expect(ordered.map(option => option.name)).toEqual(['有坐标站', '无坐标站'])
    expect(ordered[1]!.distanceMeters).toBeNull()
  })

  it('坐标为 0 的站（上游的缺省哨兵）同样不参与测距', () => {
    const ordered = sortByDistance(withDistances([
      stationOf('零坐标站', 0, 0),
      eastOfMe('有坐标站', 2000),
    ], ME))

    // (0, 0) 在大西洋上：从它量出的距离会让这个站成为「离你最近的东西」。
    expect(ordered[0]!.name).toBe('有坐标站')
  })
})

describe('两个来源合成一张列表', () => {
  it('一个名字一行：两个来源都有的名字算「附近」，只有一个来源的按它自己那份', () => {
    const merged = mergeStationSources(
      [stationOf('甲站', ME.lat, ME.lng), stationOf('乙站', ME.lat, ME.lng + 0.02)],
      [stationOf('乙站', ME.lat, ME.lng + 0.02, 'nearby'), stationOf('丙站', ME.lat, ME.lng + 0.03, 'nearby')],
    )

    expect(merged.map(option => option.name).sort()).toEqual(['丙站', '乙站', '甲站'])
    expect(merged.find(o => o.name === '甲站')!.origin).toBe('followed')
    // 两个理由都成立时算「附近」：人此刻就站在跟前，那是更当下的那个。
    expect(merged.find(o => o.name === '乙站')!.origin).toBe('nearby')
    expect(merged.find(o => o.name === '丙站')!.origin).toBe('nearby')
  })

  it('只标例外：附近那份里有它才带标记，只有关注线路的站表里有它的不标', () => {
    expect(originMarkOf(stationOf('甲站', null, null, 'followed'))).toBeNull()
    expect(originMarkOf(stationOf('乙站', null, null, 'nearby'))).toBe('附近')
  })

  it('同一个来源里同名只留一条：附近那份自己重复时不会把自己标成两个来源', () => {
    const merged = mergeStationSources(
      [],
      [stationOf('甲站', ME.lat, ME.lng, 'nearby'), stationOf('甲站', ME.lat, ME.lng + 0.01, 'nearby')],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]!.origin).toBe('nearby')
    expect(originMarkOf(merged[0]!)).toBe('附近')
  })

  it('关注线路那份没给坐标时用附近那份补上：没有坐标就没有距离', () => {
    const merged = mergeStationSources(
      [stationOf('甲站', null, null)],
      [stationOf('甲站', ME.lat, ME.lng, 'nearby')],
    )

    const measured = withDistances(merged, ME)
    expect(measured[0]!.origin).toBe('nearby')
    expect(originMarkOf(measured[0]!)).toBe('附近')
    expect(measured[0]!.distanceMeters).not.toBeNull()
  })

  it('合并之后仍然按远近排：附近那些站自然落在前面', () => {
    const merged = mergeStationSources(
      [eastOfMe('远处的关注站', 4000)],
      [eastOfMe('附近站', 300)],
    )
    const ordered = sortByDistance(withDistances(merged, ME))
    expect(ordered.map(option => option.name)).toEqual(['附近站', '远处的关注站'])
    expect(ordered.map(originMarkOf)).toEqual(['附近', null])
  })
})

describe('「最近的也在 3 公里外」这句话', () => {
  it('最近的站在 3 公里内时不说', () => {
    const list = sortByDistance(withDistances([eastOfMe('近处站', 800)], ME))
    expect(outOfNearbyNoteOf(list)).toBe('')
    expect(list[0]!.distanceMeters).toBeLessThan(NEARBY_RADIUS_M)
  })

  it('最近的站也在 3 公里外时如实说，且仍把它排在第一（过滤掉等于清空列表）', () => {
    const list = sortByDistance(withDistances([
      eastOfMe('远处站', 12_000),
      eastOfMe('更远站', 20_000),
    ], ME))

    expect(list.map(option => option.name)).toEqual(['远处站', '更远站'])
    expect(outOfNearbyNoteOf(list)).toBe('最近的站台也在 12.0 公里外')
  })

  it('一个距离都没有时不说这句话（不知道远近，就没什么可说）', () => {
    expect(outOfNearbyNoteOf(withDistances([eastOfMe('NN站', 1000)], null))).toBe('')
    expect(outOfNearbyNoteOf([])).toBe('')
  })
})
