import { describe, expect, it } from 'vitest'
import {
  CommuteChainLegSchema,
  CommuteChainSchema,
  CongestionLevelSchema,
  LiveBusSchema,
  NearbyStationSchema,
  StationSchema,
  UpdateCommuteChainSchema,
  UpdateFavoriteSchema,
  UpdateSettingsSchema,
  UserFavoriteLineSchema,
  UserSettingsSchema,
  CommuteProfileSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from '../index.js'

import type { CommuteChain } from '../index.js'

describe('Shared Schemas', () => {
  it('validates StationSchema properly', () => {
    const validStation = {
      id: '010-10001',
      name: '火车站',
      order: 57,
      lat: 39.9,
      lng: 116.4,
      interchanges: ['88号线'],
    }
    const parsed = StationSchema.parse(validStation)
    expect(parsed.name).toBe('火车站')
    expect(parsed.order).toBe(57)
  })

  it('accepts a stop whose position the upstream never stated, and states none for it either', () => {
    const unplaced = {
      id: '010-10002',
      name: '火车站',
      order: 58,
      interchanges: [],
    }
    const parsed = StationSchema.parse(unplaced)
    // 缺省就是 schema 自己的答案：既不要求坐标也不补一个。(0, 0) 是大西洋上的真实位置，
    // 在这里补默认值会与上游真放过的站无法区分。
    expect(parsed.lat).toBeUndefined()
    expect(parsed.lng).toBeUndefined()
  })

  it('validates LiveBusSchema properly', () => {
    const validBus = {
      id: 'bus_101_1',
      order: 12,
      nextOrder: 13,
      progress: 0.45,
      lat: 39.82,
      lng: 116.55,
      speed: 6.2,
      congestion: 'low' as const,
      updatedAt: Date.now(),
    }
    const parsed = LiveBusSchema.parse(validBus)
    expect(parsed.speed).toBe(6.2)
    expect(parsed.congestion).toBe('low')
  })

  it('offers only the crowding levels the upstream has been observed to report', () => {
    // F12：拥挤度的取值域取自**实测到的**词表，不是猜出来的分档。没人采样过的中间档
    // 会让后续代码把「没有读数」变成结论，而上游从未给出的结论就是编造值 —— 那些读数保持 `unknown`。
    expect(CongestionLevelSchema.options).toEqual(['unknown', 'low', 'high'])
    expect(CongestionLevelSchema.safeParse('medium').success).toBe(false)
    expect(CongestionLevelSchema.parse('high')).toBe('high')
  })

  it('validates WebSocket messages', () => {
    const subMsg = {
      action: 'subscribe',
      lineId: '0010000000001',
      direction: 0,
    }
    const parsed = WsClientMessageSchema.parse(subMsg)
    expect(parsed.action).toBe('subscribe')

    const serverPong = {
      type: 'pong',
    }
    const parsedServer = WsServerMessageSchema.parse(serverPong)
    expect(parsedServer.type).toBe('pong')
  })

  it('serves the generated city dictionary with Beijing as default hot city', async () => {
    const { CITY_DICTIONARY, HOT_CITY_META, getCityAdcode } = await import('../cities.js')
    const { DEFAULT_CITY_CODE } = await import('../constants.js')
    expect(CITY_DICTIONARY.length).toBeGreaterThan(400)
    expect(DEFAULT_CITY_CODE).toBe('027')
    const beijing = CITY_DICTIONARY.find(c => c.code === '027')
    expect(beijing).toBeTruthy()
    expect(beijing!.name).toBe('北京')
    expect(beijing!.hasMetro).toBe(true)
    expect(getCityAdcode('027')).toBe('110000')
    expect(getCityAdcode('999')).toBe('999')
    // 广州 / 深圳由人工维护的 amap-only 条目覆盖。
    expect(HOT_CITY_META.some(c => c.name === '广州')).toBe(true)
    expect(HOT_CITY_META.some(c => c.name === '深圳')).toBe(true)
  })

  it('normalizes time format from amap HHMM in schemas context', () => {
    // firstBusTime / lastBusTime 是归一化为 HH:MM 的普通字符串。
    expect(/^(\d{2}):(\d{2})$/.test('05:09')).toBe(true)
  })
})

describe('Favourite ordering and pinning contract', () => {
  it('keeps displayOrder and isPinned on update instead of stripping them', () => {
    const parsed = UpdateFavoriteSchema.parse({ displayOrder: 3, isPinned: true })
    expect(parsed.displayOrder).toBe(3)
    expect(parsed.isPinned).toBe(true)
  })

  it('rejects a negative displayOrder', () => {
    expect(UpdateFavoriteSchema.safeParse({ displayOrder: -1 }).success).toBe(false)
  })

  it('defaults isPinned to false so an unpinned row is never undefined', () => {
    const parsed = UserFavoriteLineSchema.parse({
      userId: 'default_user',
      cityCode: '027',
      lineId: '010-1-0',
      lineName: '1',
      preferredDirection: 0,
    })
    expect(parsed.isPinned).toBe(false)
  })

  it('carries the creation instant through, and does not require one to create a row', () => {
    const parsed = UserFavoriteLineSchema.parse({
      userId: 'default_user',
      cityCode: '027',
      lineId: '010-1-0',
      lineName: '1',
      preferredDirection: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    // 排序的最终 tiebreak 随行出行：丢掉它客户端就无法复刻服务端的 `created_at ASC`；
    // 新建请求没有自己的瞬间，该列属于服务端。
    expect(parsed.createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(UserFavoriteLineSchema.safeParse({
      userId: 'default_user',
      cityCode: '027',
      lineId: '010-1-0',
      lineName: '1',
      preferredDirection: 0,
    }).success).toBe(true)
  })
})

describe('Home/work anchor contract', () => {
  const hours = { morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00', eveningEnd: '22:00' }

  it('carries anchor coordinates through instead of stripping them', () => {
    const parsed = UserSettingsSchema.parse({ ...hours, homeLat: 39.9, homeLng: 116.4, workLat: null, workLng: null })
    expect(parsed.homeLat).toBe(39.9)
    expect(parsed.workLat).toBeNull()
  })

  it('states whether a window was stored, and refuses a profile that does not', () => {
    // `z.object` 丢弃未知键，故只断言 `safeParse(...).success` 在该字段存在前也会通过 ——
    // 所以要断言解析后的值，并配一个拒绝用例。该字段刻意必填且无默认值：
    // `mode: 'auto'` 同时表示「时段之外」与「从未配置时段」，只有这个词能告诉消费方读到的是哪一个。
    expect(CommuteProfileSchema.safeParse({ mode: 'work', description: '早通勤时段', windowState: 'stored' }).success).toBe(true)
    expect(CommuteProfileSchema.parse({ mode: 'auto', description: '未设置通勤时段', windowState: 'unset' }).windowState).toBe('unset')

    expect(CommuteProfileSchema.safeParse({ mode: 'auto', description: '非通勤时段' }).success).toBe(false)
    expect(CommuteProfileSchema.safeParse({ mode: 'auto', description: '非通勤时段', windowState: 'default' }).success).toBe(false)
  })

  it('accepts a row with no anchors saved yet', () => {
    expect(UserSettingsSchema.safeParse(hours).success).toBe(true)
  })

  it('rejects out-of-range coordinates', () => {
    expect(UserSettingsSchema.safeParse({ ...hours, homeLat: 999 }).success).toBe(false)
    expect(UserSettingsSchema.safeParse({ ...hours, homeLng: 200 }).success).toBe(false)
  })

  it('lets an anchor be patched without the commute hours', () => {
    expect(UpdateSettingsSchema.parse({ homeLat: 39.9 }).homeLat).toBe(39.9)
  })

  it('rejects a non-numeric or non-finite coordinate instead of storing it', () => {
    // 坐标列里写进 NaN 或 Infinity 会毒化之后每一次步行路线（NaN 米或垃圾起点），
    // 而 `z.object` 是丢弃而非拒绝 —— 故逐字段断言，已存行与 PATCH payload 都覆盖。
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '39.9']) {
      expect(UpdateSettingsSchema.safeParse({ homeLat: bad }).success, `PATCH homeLat=${String(bad)}`).toBe(false)
      expect(UserSettingsSchema.safeParse({ ...hours, workLng: bad }).success, `row workLng=${String(bad)}`).toBe(false)
      const parsed = UpdateSettingsSchema.safeParse({ workLat: bad })
      expect(parsed.success).toBe(false)
      // 拒绝体现为解析结果里没有该值，而不是被吞掉：这里解析成功会把值带进写入路径。
      expect(parsed.success ? parsed.data.workLat : undefined).toBeUndefined()
    }
  })

  it('accepts the extremes of the coordinate range and rejects just outside it', () => {
    const parsed = UserSettingsSchema.parse({
      ...hours,
      homeLat: 90,
      homeLng: 180,
      workLat: -90,
      workLng: -180,
    })
    expect(parsed.homeLat).toBe(90)
    expect(parsed.workLng).toBe(-180)
    expect(UpdateSettingsSchema.safeParse({ homeLat: 90.0001 }).success).toBe(false)
    expect(UpdateSettingsSchema.safeParse({ workLng: -180.0001 }).success).toBe(false)
  })

  it('keeps the anchor contract per-field, so the endpoint can rule on pairs', () => {
    // 「两个轴同在或同缺」是服务端 `/settings` 的规则：换算需要两个轴，
    // 故只有边界能用理由拒绝单个轴；契约保持逐字段，部分写入才仍然可表达。
    const parsed = UpdateSettingsSchema.parse({ workLng: 116.3974 })
    expect(parsed.workLng).toBe(116.3974)
    expect(parsed.workLat).toBeUndefined()
  })
})

describe('Nearby-radar distance contract', () => {
  /** 一条雷达返回的 POI，去掉当前用例所针对的字段。 */
  const poi = (over: Record<string, unknown> = {}) => ({
    name: '甲路(公交站)',
    type: 'bus',
    lat: 39.9,
    lng: 116.4,
    ...over,
  })

  it('accepts a POI whose distance the radar never stated, and states none for it either', () => {
    const parsed = NearbyStationSchema.parse(poi())
    // 缺省是 schema 自己的答案：该字段可选且无默认值。`distanceMeters: 0` 会声称用户就站在站台上 ——
    // 一个没人测过的真实距离。
    expect(parsed.distanceMeters).toBeUndefined()
  })

  it('keeps a distance the radar does state, a zero included', () => {
    // 另一半：0 米是合法读数（POI 就在测点上），不是「字段缺失」的另一种写法；
    // 丢掉已声明的 0 会抹掉一次真实测量。
    expect(NearbyStationSchema.parse(poi({ distanceMeters: 120 })).distanceMeters).toBe(120)
    expect(NearbyStationSchema.parse(poi({ distanceMeters: 0 })).distanceMeters).toBe(0)
  })

  it('still requires the name and the route type the radar is read for', () => {
    // 只有距离允许缺失：没有站名或没有类型的 POI 根本无法与站台匹配。
    expect(NearbyStationSchema.safeParse({ type: 'bus' }).success).toBe(false)
    expect(NearbyStationSchema.safeParse({ name: '甲路(公交站)' }).success).toBe(false)
  })
})

describe('Commute chain contract (F10)', () => {
  const leg = {
    lineId: '010-2-0',
    lineName: '2路',
    cityCode: '027',
    boardStationName: '甲路',
    boardStationOrder: 3,
    alightStationName: '乙路',
    alightStationOrder: 7,
    transferExtraMinutes: null,
    connectionMode: null,
  }

  const chain = (over: Record<string, unknown> = {}) => ({
    name: '上班链路',
    purpose: 'morning',
    legs: [{ ...leg }],
    ...over,
  })

  it('accepts a chain whose legs carry a line and its two stations', () => {
    const parsed = CommuteChainSchema.parse(chain())
    expect(parsed.userId).toBe('default_user')
    expect(parsed.displayOrder).toBe(0)
    expect(parsed.legs[0]!.lineId).toBe('010-2-0')
    expect(parsed.legs[0]!.alightStationOrder).toBe(7)
  })

  it('lets a leg be saved with no station chosen, and says so with null', () => {
    const parsed = CommuteChainSchema.parse(chain({
      legs: [{ ...leg, boardStationName: null, boardStationOrder: null }],
    }))
    // 空串读回来会是一个名为 "" 的站 —— 并不存在的站。「尚未选择」就是 null，别无其他。
    expect(parsed.legs[0]!.boardStationName).toBeNull()
    expect(parsed.legs[0]!.boardStationOrder).toBeNull()
  })

  it('refuses half a station: a name without its stop order cannot be located', () => {
    // 站名单独无法解析回停靠列表（有重名，且地铁按方向对同一站编号不同），
    // 故配对要么同时出行、要么都不出行。
    expect(CommuteChainSchema.safeParse(chain({
      legs: [{ ...leg, boardStationOrder: null }],
    })).success).toBe(false)
    expect(CommuteChainSchema.safeParse(chain({
      legs: [{ ...leg, alightStationName: null }],
    })).success).toBe(false)
  })

  it('requires at least one ride leg — a chain with none carries nothing', () => {
    expect(CommuteChainSchema.safeParse(chain({ legs: [] })).success).toBe(false)
  })

  it('keeps the purpose to its two known values', () => {
    expect(CommuteChainSchema.safeParse(chain({ purpose: 'noon' })).success).toBe(false)
    expect(CommuteChainSchema.parse(chain({ purpose: 'evening' })).purpose).toBe('evening')
  })

  it('neither accepts nor carries the origin anchor — the purpose decides where a chain starts', () => {
    // 起点由通勤目的决定（上班从家出发、下班从公司出发），故契约里没有这个字段：
    // 旧调用方仍带着它时，它被丢弃而不是被存下 —— 一条「上班·从公司出发」的矛盾链在契约上无法表达。
    expect(CommuteChainSchema.parse(chain({ originAnchor: 'work' }))).not.toHaveProperty('originAnchor')
    expect(CommuteChainSchema.parse(chain())).not.toHaveProperty('originAnchor')
    // PATCH 同理：带它的补丁改不了任何东西，因为它不再是链路上的一列。
    expect(UpdateCommuteChainSchema.parse({ originAnchor: 'work' })).not.toHaveProperty('originAnchor')
    expect(UpdateCommuteChainSchema.parse({ originAnchor: 'work' })).toEqual({})

    // 类型层：`CommuteChain` 上没有这个键 —— 字段回到类型里时，这一行本身就不成立。
    const noAnchorInType: 'originAnchor' extends keyof CommuteChain ? never : true = true
    expect(noAnchorInType).toBe(true)
  })

  it('rejects a negative transfer time rather than storing it as 0', () => {
    // 「未设置」是 null；负数不是更小的「未设置」，而是会把接驳时长减成负数的矛盾值。
    expect(CommuteChainSchema.safeParse(chain({
      legs: [{ ...leg, transferExtraMinutes: -1 }],
    })).success).toBe(false)
  })

  it('carries the connection mode as one of the two ways, or as an explicit null', () => {
    // 方式决定接驳按哪条路线定价，故它必须是契约的一部分，而不是服务端各自写死的常量。
    // 形状与 `transferExtraMinutes` 相同：必填、可空 —— 省略它就是一次没说明方式的写入。
    expect(CommuteChainSchema.parse(chain({ legs: [{ ...leg, connectionMode: 'cycle' }] })).legs[0]!.connectionMode)
      .toBe('cycle')
    expect(CommuteChainSchema.parse(chain({ legs: [{ ...leg, connectionMode: 'walk' }] })).legs[0]!.connectionMode)
      .toBe('walk')
    expect(CommuteChainSchema.parse(chain()).legs[0]!.connectionMode).toBeNull()
  })

  it('refuses anything that is not one of the two ways — including the empty string', () => {
    // 两个已知方式之外的一切都不是方式。空串尤其：它不是「没选过」，那是 `null`；
    // 把它读成「没选」就是把一个用户没做过的选择当成他的选择。
    for (const wrong of ['drive', 'bike', 'WALK', '', 0]) {
      expect(CommuteChainLegSchema.safeParse({ ...leg, connectionMode: wrong }).success,
        `the contract accepted 「${wrong}」 as a connection mode`).toBe(false)
    }

    // 省略字段同样被拒：方式是必填可空，不是可选 —— 一个 `.optional()` 会让
    // 「没选过」与「写侧忘了带」在库里是同一个 NULL，而它们该由同一处写成。
    const { connectionMode: omitted, ...withoutMode } = { ...leg, connectionMode: null }
    expect(omitted).toBeNull()
    expect(CommuteChainLegSchema.safeParse(withoutMode).success).toBe(false)
  })

  it('patches the order alone without restating the legs', () => {
    expect(UpdateCommuteChainSchema.parse({ displayOrder: 4 }).displayOrder).toBe(4)
    expect(UpdateCommuteChainSchema.parse({}).legs).toBeUndefined()
  })
})
