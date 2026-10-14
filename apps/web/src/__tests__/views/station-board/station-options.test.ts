import { describe, expect, it } from 'vitest'
import { NEARBY_RADIUS_M } from '@real-time-transport/shared/geo'
import {
  ANCHOR_ROLE_LABELS,
  applyAnchors,
  arrangeOptions,
  mergeStationSources,
  movedEnough,
  originMarkOf,
  outOfNearbyNoteOf,
  sortByDistance,
  stationSecondaryTextOf,
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

/** 钉过的站台：一条选项外加身份。 */
function anchorOf(name: string, role: StationOption['anchor'], meters: number): StationOption {
  return { ...eastOfMe(name, meters), stationId: `010-${name}-钉`, anchor: role }
}

/** 在参考点东边约 `meters` 米的**一个位置**（不是站）。 */
function positionEastOf(meters: number): { lat: number, lng: number } {
  return { lat: ME.lat, lng: ME.lng + (meters / 854) * 0.01 }
}

describe('一张按距离排的表，钉过的站不被名额截掉', () => {
  it('钉过的站也在它该在的位置上：整张表严格按远近', () => {
    // 角色（上班 / 下班 / 关注）只是**标注**，不是排序：一个 10 公里的上班上车点不该压住
    // 300 米外的站，也不该压住 2.5 公里的下班上车点。
    const arranged = arrangeOptions(withDistances([
      anchorOf('上班上车点', 'morning', 10300),
      anchorOf('下班上车点', 'evening', 2500),
      anchorOf('关注站', 'followed', 6000),
      eastOfMe('旁边的站', 300),
    ], ME), 30)

    expect(arranged.map(option => option.name)).toEqual(['旁边的站', '下班上车点', '关注站', '上班上车点'])
  })

  it('钉过的站在 30 名之外也照样在列表里（免截断），位置仍按远近', () => {
    // 20/30 公里外的两个钉过的站：没有这一条它们会被「最近 30 个」整批截掉 ——
    // 那正是「我走远了就找不到我钉的站」。
    const candidates = Array.from({ length: 31 }, (_, index) => eastOfMe(`站${index + 1}`, 100 + index * 10))
    const arranged = arrangeOptions(withDistances([
      anchorOf('钉过的甲', 'morning', 30000),
      anchorOf('钉过的乙', 'evening', 20000),
      ...candidates,
    ], ME), 30)

    expect(arranged).toHaveLength(32)
    expect(arranged.map(option => option.name).slice(-2)).toEqual(['钉过的乙', '钉过的甲'])
    // 被挤掉的是**第 31 近**的候选，不是钉过的那个。
    expect(arranged.map(option => option.name)).not.toContain('站31')
  })

  it('钉过的站没有距离时排在有距离的锚点之后（不知道远近就不冒充最近）', () => {
    const arranged = arrangeOptions(withDistances([
      { ...anchorOf('没有坐标的锚点', 'morning', 0), lat: null, lng: null },
      anchorOf('有坐标的锚点', 'evening', 2500),
    ], ME), 30)

    expect(arranged.map(option => option.name)).toEqual(['有坐标的锚点', '没有坐标的锚点'])
  })

  it('盖身份：同名项换成用户钉的那一个的站 id 与坐标', () => {
    // 同名多站是真实存在的（马路两侧各一个站 id），而列表按站名去重 —— 不盖这一下，
    // 钉了东侧站台的人会被读到西侧那个。
    const pinned = anchorOf('同一个名字', 'followed', 5000)
    const identified = applyAnchors([
      stationOf('同一个名字', ME.lat, ME.lng + 0.01),
      stationOf('别的站', ME.lat, ME.lng),
    ], [pinned])

    const merged = identified.find(option => option.name === '同一个名字')!
    expect(merged.stationId).toBe('010-同一个名字-钉')
    expect(merged.lng).toBe(pinned.lng)
    expect(merged.anchor).toBe('followed')
  })

  it('没钉过任何站：一条都不变', () => {
    const list = [eastOfMe('甲站', 400), eastOfMe('乙站', 100)]

    expect(applyAnchors(list, [])).toEqual(list)
  })
})

describe('次级文字：钉过的站台说自己的身份', () => {
  it('三种身份各说各的，照旧带距离', () => {
    expect(stationSecondaryTextOf({ ...anchorOf('甲', 'morning', 300), distanceMeters: 300 }))
      .toBe(`${ANCHOR_ROLE_LABELS.morning} · 300 米`)
    expect(stationSecondaryTextOf({ ...anchorOf('乙', 'evening', 12000), distanceMeters: 12000 }))
      .toBe(`${ANCHOR_ROLE_LABELS.evening} · 12.0 公里`)
    expect(stationSecondaryTextOf({ ...anchorOf('丙', 'followed', 24000), distanceMeters: 24000 }))
      .toBe(`${ANCHOR_ROLE_LABELS.followed} · 24.0 公里`)
  })

  it('钉过的站同时也在附近：说身份（那是它排在最前的理由），也照说距离', () => {
    const text = stationSecondaryTextOf({ ...anchorOf('甲', 'morning', 28), origin: 'nearby', distanceMeters: 28 })

    expect(text).toBe(`${ANCHOR_ROLE_LABELS.morning} · 28 米`)
  })

  it('没钉过时照旧只标例外：附近才写「附近」', () => {
    expect(stationSecondaryTextOf({ ...stationOf('甲', ME.lat, ME.lng, 'nearby'), distanceMeters: 193 }))
      .toBe('附近 · 193 米')
    expect(stationSecondaryTextOf({ ...stationOf('乙', ME.lat, ME.lng), distanceMeters: 300 }))
      .toBe('300 米')
  })
})

describe('「最近的站台也在 3 公里外」不算钉过的那些', () => {
  it('钉过的在 20 公里外、附近的站就在旁边：这句话不出现', () => {
    const list = withDistances([anchorOf('钉过的', 'followed', 20000), eastOfMe('旁边的站', 300)], ME)

    expect(outOfNearbyNoteOf(list)).toBe('')
  })

  it('一个附近的站都没有：也不出现（没有可说的对象）', () => {
    const list = withDistances([anchorOf('钉过的', 'followed', 20000)], ME)

    expect(outOfNearbyNoteOf(list)).toBe('')
  })

  it('附近的站确实都超过 3 公里：说出来', () => {
    const list = withDistances([anchorOf('钉过的', 'followed', 20000), eastOfMe('远处的站', 4000)], ME)

    // 说的是**最近那个**的米数，不是某个固定阈值：这句话要能被核对。
    expect(outOfNearbyNoteOf(list)).toBe('最近的站台也在 4.0 公里外')
  })
})

describe('走开多远才算换了地方：抖动不重排', () => {
  it('还没取过快照时算换了地方 —— 那时没有可留住的东西', () => {
    expect(movedEnough(null, ME, 50)).toBe(true)
  })

  it('站着不动时 GPS 在几十米里打转：不算换地方，列表不许重排', () => {
    // 实测：六次 20~40 米的抖动，按每一下重排会让顺序六次全变（站台彼此常只差几十米）。
    for (const drift of [12, 20, 33, 41, 49]) {
      expect(movedEnough(positionEastOf(drift), ME, 50), `挪 ${drift} 米`).toBe(false)
    }
  })

  it('真的走开了就重排：超过门槛即算', () => {
    expect(movedEnough(positionEastOf(51), ME, 50)).toBe(true)
    expect(movedEnough(positionEastOf(400), ME, 50)).toBe(true)
  })

  it('门槛可以被精度抬高：承认自己有 ±100 米误差的定位，80 米不算走开', () => {
    // 分不出相隔几十米的两站谁更近，按它重排只会让顺序来回跳。
    expect(movedEnough(positionEastOf(80), ME, 100)).toBe(false)
    expect(movedEnough(positionEastOf(120), ME, 100)).toBe(true)
  })
})

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
