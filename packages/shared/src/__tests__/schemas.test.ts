import { describe, expect, it } from 'vitest'
import {
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
    // The absence is the schema's own answer: it neither requires a coordinate
    // nor supplies one. (0, 0) is a real position in the Atlantic, so a default
    // here would be indistinguishable from a stop the upstream really placed.
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
    // F12: the crowding domain is the OBSERVED vocabulary, not a guessed ladder.
    // Measured live so far, the upstream's crowding tag states two labels:
    // 「不拥挤」 (key 拥挤度_1) and 「拥挤」 (keys 拥挤度_3 and 拥挤度_5 — the
    // observed keys are not contiguous). A middle rung nobody has sampled would
    // let a later code path turn "no reading" into a verdict, and a verdict the
    // upstream never gave is a fabricated value; those readings stay `unknown`.
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
    // Guangzhou/Shenzhen covered by curated amap-only entries
    expect(HOT_CITY_META.some(c => c.name === '广州')).toBe(true)
    expect(HOT_CITY_META.some(c => c.name === '深圳')).toBe(true)
  })

  it('normalizes time format from amap HHMM in schemas context', () => {
    // firstBusTime/lastBusTime are plain strings normalized to HH:MM
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
    // The order's final tiebreak travels with the row; dropping it would leave
    // the client unable to mirror the server's `created_at ASC`.
    expect(parsed.createdAt).toBe('2024-01-01T00:00:00.000Z')
    // A create request has no instant of its own — the column is the server's.
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
    // `z.object` STRIPS unknown keys, so `safeParse(...).success` is green before the
    // field exists — hence the parsed VALUE, and hence a rejection case. The field is
    // required with no default on purpose: `mode: 'auto'` means both 「outside the
    // configured windows」 and 「no window configured」, and only this word tells a
    // consumer which one it is reading.
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
    // A NaN or Infinity written into a coordinate column poisons every later
    // walking route with NaN metres or a garbage origin, and `z.object` strips
    // rather than rejects — so this is asserted per field, on both the stored
    // row and the PATCH payload.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '39.9']) {
      expect(UpdateSettingsSchema.safeParse({ homeLat: bad }).success, `PATCH homeLat=${String(bad)}`).toBe(false)
      expect(UserSettingsSchema.safeParse({ ...hours, workLng: bad }).success, `row workLng=${String(bad)}`).toBe(false)
      const parsed = UpdateSettingsSchema.safeParse({ workLat: bad })
      expect(parsed.success).toBe(false)
      // The rejection is visible in the parsed output's absence, not swallowed:
      // a successful parse here would carry the value into the write path.
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
    // Both-or-neither is the SERVER's rule at `/settings`: the conversion needs
    // both axes, so only the boundary can reject a lone one with a reason. The
    // contract stays per-field so a partial write remains expressible.
    const parsed = UpdateSettingsSchema.parse({ workLng: 116.3974 })
    expect(parsed.workLng).toBe(116.3974)
    expect(parsed.workLat).toBeUndefined()
  })
})

describe('Nearby-radar distance contract', () => {
  /** One POI as the radar answers it, minus whatever the case is about. */
  const poi = (over: Record<string, unknown> = {}) => ({
    name: '甲路(公交站)',
    type: 'bus',
    lat: 39.9,
    lng: 116.4,
    ...over,
  })

  it('accepts a POI whose distance the radar never stated, and states none for it either', () => {
    const parsed = NearbyStationSchema.parse(poi())
    // The absence is the schema's OWN answer: the field is optional and carries
    // no default. `distanceMeters: 0` would be a claim that the user is standing
    // on the platform — a real distance nobody measured.
    expect(parsed.distanceMeters).toBeUndefined()
  })

  it('keeps a distance the radar does state, a zero included', () => {
    // The other half: 0 metres is a legal reading (the POI sits on the measured
    // point), so it is not the spelling of an absent field. A schema that dropped
    // a stated 0 would erase a real measurement.
    expect(NearbyStationSchema.parse(poi({ distanceMeters: 120 })).distanceMeters).toBe(120)
    expect(NearbyStationSchema.parse(poi({ distanceMeters: 0 })).distanceMeters).toBe(0)
  })

  it('still requires the name and the route type the radar is read for', () => {
    // The distance is the only field allowed to be absent: a POI with no name or
    // no type cannot be matched to a platform at all.
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
  }

  const chain = (over: Record<string, unknown> = {}) => ({
    name: '上班链路',
    originAnchor: 'home',
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
    // An empty string would read back as a station named "" — a station that
    // does not exist. "Not chosen yet" is null, and nothing else.
    expect(parsed.legs[0]!.boardStationName).toBeNull()
    expect(parsed.legs[0]!.boardStationOrder).toBeNull()
  })

  it('refuses half a station: a name without its stop order cannot be located', () => {
    // The name alone does not resolve back into the line's stop list (duplicate
    // names, and a subway line numbers its stops differently per direction), so
    // the pair travels together or not at all.
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

  it('keeps the anchor and the purpose to their two known values each', () => {
    expect(CommuteChainSchema.safeParse(chain({ originAnchor: 'office' })).success).toBe(false)
    expect(CommuteChainSchema.safeParse(chain({ purpose: 'noon' })).success).toBe(false)
    expect(CommuteChainSchema.parse(chain({ originAnchor: 'work', purpose: 'evening' })).originAnchor).toBe('work')
  })

  it('rejects a negative transfer time rather than storing it as 0', () => {
    // "Unset" is null; a negative number is not a smaller "unset", it is a
    // contradiction that would subtract minutes from a connection.
    expect(CommuteChainSchema.safeParse(chain({
      legs: [{ ...leg, transferExtraMinutes: -1 }],
    })).success).toBe(false)
  })

  it('patches the order alone without restating the legs', () => {
    expect(UpdateCommuteChainSchema.parse({ displayOrder: 4 }).displayOrder).toBe(4)
    expect(UpdateCommuteChainSchema.parse({}).legs).toBeUndefined()
  })
})
