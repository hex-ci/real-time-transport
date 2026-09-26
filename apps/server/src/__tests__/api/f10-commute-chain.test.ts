import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CYCLE_EXTRA_MINUTES } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F10 通勤链路在 HTTP 边界上的契约：CRUD 落到两条表上、站名与站序成对、公交段顺行、
 * 接驳方式按段存、起点由 purpose 推导、推演端点的拒绝码与余量、同一线路重复关注 409。
 *
 * 同一份主体对内存与 SQL 各跑一遍。SQL 那一遍才看得见列、CHECK、唯一索引与级联删除 ——
 * 因此每条契约都配一句「库里那一行/那一列现在是什么」的裸 pg 断言；内存那一遍同样的断言
 * 给出相反的期望，证明它确实没在写库。
 *
 * 上游一律桩掉（harness 的默认桩拒绝一切调用），fixture 用本用例自己的 id 前缀。
 * 101 / 甲线 / 乙站 是占位：本文件不出现真实线路、站点或上游 id。
 */

/** 冻结的墙上时钟（本地时间）：每一次读数都落在它上面，判断与「现在」无关。 */
const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

function freezeAt(localIso: string): void {
  // 只伪造 `Date`：应用自己的定时器保持真实。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

describeEachStore('F10 通勤链路', (store) => {
  let api: ApiHarness
  let LINE_A: string
  let LINE_B: string

  beforeEach(async () => {
    // 接驳定价要经高德路径服务：这条键在场才会有那次调用，而 fetch 已被 harness 桩掉。
    // 生成车辆（TRANSIT_SIMULATION）是另一条产数据的路径，这里关掉 —— 否则「上游没答」
    // 会被它悄悄补上，读数不再来自那个被桩掉的上游。
    vi.stubEnv('AMAP_MAPS_API_KEY', 'test-key')
    vi.stubEnv('TRANSIT_SIMULATION', 'false')
    vi.stubEnv('DEMO_MODE', 'false')
    api = await createApiHarness({ store })
    LINE_A = api.fixtureId('line-a')
    LINE_B = api.fixtureId('line-b')
  })

  afterEach(async () => {
    await api?.close()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  /** 一条乘车段：站名与站序成对，公交段顺行。 */
  function leg(over: Record<string, unknown> = {}) {
    return {
      lineId: LINE_A,
      lineName: '甲线',
      cityCode: '027',
      boardStationName: '乙站',
      boardStationOrder: 2,
      alightStationName: '丙站',
      alightStationOrder: 3,
      transferExtraMinutes: null,
      connectionMode: null,
      ...over,
    }
  }

  function chainBody(over: Record<string, unknown> = {}) {
    return { name: '上班链路', purpose: 'morning', legs: [leg()], ...over }
  }

  const post = (payload: Record<string, unknown>) => api.inject({
    method: 'POST',
    url: '/api/transit/commute-chains',
    payload,
  })
  const patch = (id: string, payload: Record<string, unknown>) => api.inject({
    method: 'PATCH',
    url: `/api/transit/commute-chains/${id}`,
    payload,
  })
  const read = (id: string) => api.inject({ url: `/api/transit/commute-chains/${id}` })
  const del = (id: string) => api.inject({ method: 'DELETE', url: `/api/transit/commute-chains/${id}` })

  const created = async (payload: Record<string, unknown>) => {
    const res = await post(payload)
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as { id: string, legs: Array<Record<string, unknown>> }
  }

  const chainRows = () => api.rows<{ id: string }>('SELECT id FROM commute_chains')
  const legRows = (chainId: string) => api.rows<{
    seq: number
    line_id: string
    board_station_name: string | null
    board_station_order: number | null
    alight_station_order: number | null
    transfer_extra_minutes: number | null
    connection_mode: string | null
  }>(
    'SELECT seq, line_id, board_station_name, board_station_order, alight_station_order, transfer_extra_minutes, connection_mode'
    + ' FROM commute_chain_legs WHERE chain_id = $1 ORDER BY seq',
    [chainId],
  )
  const allLegRows = () => api.rows<{ seq: number }>('SELECT seq FROM commute_chain_legs')

  it('写入一条链路：两行落下、seq 由数组顺序盖章、客户端给的序号不被采信', async () => {
    const res = await post(chainBody({
      legs: [
        // 调用方给 9：序号是位置，不是它说的数。
        { ...leg({ seq: 9 }) },
        { ...leg({ seq: 9, lineId: LINE_B, lineName: '乙线', boardStationName: '戊站', boardStationOrder: 3, alightStationName: '己站', alightStationOrder: 4 }) },
      ],
    }))
    expect(res.statusCode, res.body).toBe(200)
    const chain = res.json().data as { id: string, displayOrder: number, legs: Array<{ seq: number }> }

    expect(chain.legs.map(l => l.seq)).toEqual([0, 1])
    expect(chain.displayOrder).toBe(0)

    // 链一行、腿两行：两份表都真的写进去了。
    expect(await chainRows(), store === 'sql' ? '链路没有落到库里' : '内存路径不该在库里留下行')
      .toHaveLength(store === 'sql' ? 1 : 0)

    const legs = await legRows(chain.id)
    if (store === 'sql') {
      expect(legs.map(row => row.seq)).toEqual([0, 1])
      expect(legs.map(row => row.line_id)).toEqual([LINE_A, LINE_B])
      // 城市码是服务端填的，调用方没有这一列也能读回。
      expect(legs[0]!.board_station_name).toBe('乙站')
    }
    else {
      expect(legs).toHaveLength(0)
    }

    const one = await read(chain.id)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json().data.legs.map((l: { seq: number }) => l.seq)).toEqual([0, 1])

    const listed = await api.inject({ url: '/api/transit/commute-chains' })
    expect(listed.json().data.map((c: { id: string }) => c.id)).toEqual([chain.id])

    // 一次写入全程不碰上游。
    expect(api.upstream).not.toHaveBeenCalled()
  })

  it('PATCH 的 legs 整段替换，重编号后不留空洞', async () => {
    const chain = await created(chainBody({
      legs: [leg(), leg({ lineId: LINE_B, lineName: '乙线' })],
    }))

    const patched = await patch(chain.id, {
      name: '晚间链路',
      legs: [leg({ lineId: LINE_B, lineName: '乙线' }), leg(), leg({ lineId: LINE_A, lineName: '甲线' })],
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().data.name).toBe('晚间链路')
    expect(patched.json().data.legs.map((l: { seq: number }) => l.seq)).toEqual([0, 1, 2])
    expect(patched.json().data.legs.map((l: { lineId: string }) => l.lineId)).toEqual([LINE_B, LINE_A, LINE_A])

    const legs = await legRows(chain.id)
    if (store === 'sql') {
      // 是替换而不是合并：两段换成三段，序号连续。
      expect(legs.map(row => row.seq)).toEqual([0, 1, 2])
      expect(legs.map(row => row.line_id)).toEqual([LINE_B, LINE_A, LINE_A])
    }
    else {
      expect(legs).toHaveLength(0)
    }
  })

  it('删除链路时它的腿一起走（外键级联）', async () => {
    const chain = await created(chainBody({ legs: [leg(), leg({ lineId: LINE_B, lineName: '乙线' })] }))
    expect((await legRows(chain.id)).length).toBe(store === 'sql' ? 2 : 0)

    const removed = await del(chain.id)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json().data.removed).toBe(true)

    // 腿不靠第二条语句收拾：删链即删腿。
    expect(await legRows(chain.id)).toHaveLength(0)
    expect(await chainRows()).toHaveLength(0)
    expect((await read(chain.id)).statusCode).toBe(404)
    expect((await del(chain.id)).json().data.removed).toBe(false)
  })

  it('站名与站序成对：只给一半的写入被拒，且不留行', async () => {
    const halfName = await post(chainBody({ legs: [leg({ boardStationOrder: null })] }))
    expect(halfName.statusCode, halfName.body).toBe(400)
    expect(halfName.json().success).toBe(false)
    expect(typeof halfName.json().error).toBe('string')

    const halfOrder = await post(chainBody({ legs: [leg({ alightStationName: null })] }))
    expect(halfOrder.statusCode, halfOrder.body).toBe(400)

    // 被拒的写入什么都没落下。
    expect(await allLegRows()).toHaveLength(0)
    expect(await chainRows()).toHaveLength(0)

    // 两半都留空是合法状态，且以 SQL NULL 存下 —— 空串会读成一个名字为 "" 的站。
    const unset = await created(chainBody({
      legs: [leg({ boardStationName: null, boardStationOrder: null })],
    }))
    const legs = await legRows(unset.id)
    if (store === 'sql') {
      expect(legs[0]!.board_station_name).toBeNull()
      expect(legs[0]!.board_station_order).toBeNull()
    }
    expect(unset.legs[0]!.boardStationName).toBeNull()
    expect(unset.legs[0]!.boardStationName).not.toBe('')
  })

  it('公交段只能顺行，地铁段可以反向，同一站不是乘车段', async () => {
    const backwards = await post(chainBody({
      legs: [leg({ boardStationName: '丙站', boardStationOrder: 3, alightStationName: '乙站', alightStationOrder: 2 })],
    }))
    expect(backwards.statusCode, backwards.body).toBe(400)
    expect(backwards.json().success).toBe(false)

    const sameStation = await post(chainBody({ legs: [leg({ alightStationOrder: 2 })] }))
    expect(sameStation.statusCode, sameStation.body).toBe(400)

    // 地铁两个方向共用一个 lineId，方向由站序表达：反向段是真实乘车，不是录反了。
    const SUBWAY = 'subway_027_7'
    const reverse = await created(chainBody({
      legs: [leg({
        lineId: SUBWAY,
        lineName: '地铁7号线',
        boardStationName: '乙站',
        boardStationOrder: 3,
        alightStationName: '丙站',
        alightStationOrder: 2,
      })],
    }))
    const legs = await legRows(reverse.id)
    if (store === 'sql') {
      expect(legs[0]!.board_station_order).toBe(3)
      expect(legs[0]!.alight_station_order).toBe(2)
    }
    expect(reverse.legs[0]!.alightStationOrder).toBe(2)

    // 同一站对地铁同样是错的：从一站到它自己不是乘车段。
    const subwaySame = await post(chainBody({
      legs: [leg({ lineId: SUBWAY, lineName: '地铁7号线', alightStationOrder: 2 })],
    }))
    expect(subwaySame.statusCode, subwaySame.body).toBe(400)

    expect(api.upstream).not.toHaveBeenCalled()
  })

  it('接驳方式按段存：null 是没选过，0 是确实没有额外时间', async () => {
    const chain = await created(chainBody({
      legs: [
        leg({ connectionMode: 'walk', transferExtraMinutes: 0 }),
        leg({ lineId: LINE_B, lineName: '乙线', connectionMode: 'cycle', transferExtraMinutes: 3 }),
        leg({ connectionMode: null, transferExtraMinutes: null }),
      ],
    }))
    expect(chain.legs.map(l => l.connectionMode)).toEqual(['walk', 'cycle', null])

    const legs = await legRows(chain.id)
    if (store === 'sql') {
      expect(legs.map(row => row.connection_mode)).toEqual(['walk', 'cycle', null])
      // 0 与 NULL 是两个事实：写过 0 的那一段入库就是 0，没配的那一段是 NULL。
      expect(legs.map(row => row.transfer_extra_minutes)).toEqual([0, 3, null])
    }

    const listed = await api.inject({ url: '/api/transit/commute-chains' })
    expect(listed.json().data[0].legs.map((l: { connectionMode: string | null }) => l.connectionMode))
      .toEqual(['walk', 'cycle', null])
  })

  it('接驳方式：省略与两个已知取值之外的一切都是 400', async () => {
    const withoutMode = { ...leg() } as Record<string, unknown>
    delete withoutMode.connectionMode
    const missing = await post(chainBody({ legs: [withoutMode] }))
    expect(missing.statusCode, missing.body).toBe(400)
    expect(missing.json().success).toBe(false)

    const wrong = await post(chainBody({ legs: [leg({ connectionMode: 'drive' })] }))
    expect(wrong.statusCode, wrong.body).toBe(400)

    expect(await allLegRows()).toHaveLength(0)
    expect(await chainRows()).toHaveLength(0)
  })

  it('起点由 purpose 推导：payload 里的 originAnchor 一律被丢掉', async () => {
    // 起点不是链路的一列，而是「上班从家出发、下班从公司出发」这条规则的结论。
    const chain = await created(chainBody({ originAnchor: 'work' }))
    expect(chain).not.toHaveProperty('originAnchor')

    const one = await read(chain.id)
    expect(one.json().data).not.toHaveProperty('originAnchor')
    expect(one.json().data.purpose).toBe('morning')

    const patched = await patch(chain.id, { originAnchor: 'home', name: '改过的名字' })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().data).not.toHaveProperty('originAnchor')

    // 这一列在库里不存在 —— 旧调用方带着它也无处可存。
    const column = await api.rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'commute_chains' AND column_name = 'origin_anchor'`,
    )
    expect(column).toHaveLength(0)
  })

  /**
   * 同一线路重复关注：一条线路对两个方向只关注一次（`findFollowedRoute`）。
   * 这里同时钉住两件事 —— 409 的形状，以及被折进已有行时「已存的东西不被替换」。
   */
  it('重复关注 → 409 alreadyFollowed，且已存的那一行不被替换', async () => {
    const favorite = (payload: Record<string, unknown>) => api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { cityCode: '027', lineId: LINE_A, lineName: '甲线', reverseLineId: LINE_B, preferredDirection: 0, ...payload },
    })

    const first = await favorite({})
    expect(first.statusCode, first.body).toBe(200)
    const held = first.json().data.id as string

    // 第二次带着另一个名字与另一个偏好方向来：答复是「已关注」，不是失败，也不是第二张卡。
    const second = await favorite({ lineName: '甲线（改过名）', preferredDirection: 1 })
    expect(second.statusCode, second.body).toBe(409)
    expect(second.json().success).toBe(false)
    expect(second.json().alreadyFollowed).toBe(true)
    expect(second.json().data.id).toBe(held)

    // 反方向来时是同一条线路的同一张卡。
    const reverse = await favorite({ lineId: LINE_B, reverseLineId: undefined, preferredDirection: 1 })
    expect(reverse.statusCode, reverse.body).toBe(409)
    expect(reverse.json().data.id).toBe(held)

    const rows = await api.rows<{ id: string, line_name: string, preferred_direction: number }>(
      'SELECT id, line_name, preferred_direction FROM user_favorite_lines',
    )
    expect(rows, store === 'sql' ? '一条线路留下了多行' : '内存路径不该在库里留下行')
      .toHaveLength(store === 'sql' ? 1 : 0)
    if (store === 'sql') {
      // 行本身保留：名字是第一次关注时的那个，只有偏好方向被这一次写入覆盖。
      expect(rows[0]!.line_name).toBe('甲线')
      expect(rows[0]!.preferred_direction).toBe(1)
    }

    // 两个 POST 都自带反方向 id，因此守卫不需要读上游就能判定。
    expect(api.upstream).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // 推演端点：余量与拒绝码
  // ---------------------------------------------------------------------------

  /** 上游替身：一条公交线路的详情，加上两个路径服务端点。车头默认停在「乙站」那一跳。 */
  function stubUpstream(options: {
    nosePastBoard?: boolean
    walkFails?: boolean
    /** 步行时长；用来把接驳拖到所有已知车之后。 */
    walkSeconds?: number
    /** 两次定向读数各报一辆不同的车：它们无法按 id 配对。 */
    distinctVehicles?: boolean
  } = {}) {
    const stops = ['甲站', '乙站', '丙站']
    const travel: Record<number, number> = { 2: 900, 3: 1200 }

    api.upstream.mockImplementation(async (url: unknown) => {
      const href = String(url)

      // 骑行那条路线走自己的信封：成功时没有 v3 的成功码，只有 data.paths[]。
      if (href.includes('/v4/direction/bicycling')) {
        return { ok: true, status: 200, json: async () => ({ data: { paths: [{ distance: 400, duration: 300 }] } }) }
      }
      if (href.includes('/v3/direction/walking')) {
        if (options.walkFails) return amapOk({ route: { paths: [] } })
        return amapOk({ route: { paths: [{ distance: 400, duration: options.walkSeconds ?? 300 }] } })
      }
      if (!href.includes('encryptedLineDetail')) {
        throw new Error(`TEST: 未预期的上游调用 ${href}`)
      }

      const target = new URL(href).searchParams.get('targetOrder')
      const requested = target === null ? null : Number(target)
      // 上游的 `order` 是车辆正前往的下一站，故车头在 3 就是已越过站序 2 的上车站。
      const nose = options.nosePastBoard ? 3 : 2
      // travels 的 order 是被请求的那个站序：上游按点名的站回答这辆车的到站耗时。
      const time = requested === null ? undefined : travel[requested]

      return body(JSON.stringify({
        jsonr: {
          data: {
            line: { name: LINE_A, direction: 0, firstTime: '05:00', lastTime: '23:00' },
            stations: stops.map((sn, i) => ({
              sId: `s${i + 1}`,
              sn,
              order: i + 1,
              lat: 39.9 + (i + 1) / 100,
              lng: 116.4 + (i + 1) / 100,
            })),
            buses: [{
              busId: options.distinctVehicles ? `fixture-v${requested}` : 'fixture-v1',
              order: nose,
              speed: 6,
              ...(time === undefined ? {} : { travels: [{ order: requested, travelTime: time }] }),
            }],
          },
        },
      }))
    })
  }

  /** chelaile 提供方按文本读的响应，它本来就是这么读的。 */
  const body = (text: string) => ({ ok: true, status: 200, text: async () => text })

  /** 一个 Amap v3 成功信封。 */
  const amapOk = (payload: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  })

  const upstreamUrls = () => api.upstream.mock.calls.map(call => String(call[0]))
  const liveReads = () => upstreamUrls().filter(href => href.includes('targetOrder='))
  const etaCalls = (route: 'walking' | 'bicycling') =>
    upstreamUrls().filter(href => href.includes(`/direction/${route}`)).length

  /** 存下两个锚点：起点由 purpose 推导（上班 = 家），故写入的是家。 */
  const saveAnchors = () => api.inject({
    method: 'PATCH',
    url: '/api/transit/settings',
    payload: { homeLat: 39.9, homeLng: 116.4 },
  })

  const deductions = () => api.inject({ url: '/api/transit/commute-chains/deductions?purpose=morning' })

  it('一条可推演的链路：余量、带位与每个数字都来自被点名的那两次读数', async () => {
    freezeAt(T0)
    stubUpstream()
    expect((await saveAnchors()).statusCode).toBe(200)
    const chain = await created(chainBody({ legs: [leg({ connectionMode: 'walk' })] }))

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.purpose).toBe('morning')

    const view = res.json().data.chains[0]
    expect(view).toMatchObject({ chainId: chain.id, name: '上班链路', purpose: 'morning' })
    expect(view.deduction).toEqual({
      status: 'deduced',
      band: 'comfortable',
      marginMinutes: 10,
      bindingSeq: 0,
      legs: [{
        seq: 0,
        lineId: LINE_A,
        lineName: '甲线',
        vehicleId: 'fixture-v1',
        referenceVehicleId: 'fixture-v1',
        provenance: 'live',
        // 站台等待 = 车到上车站（900 s）− 你到站台（接驳 300 s）。
        waitMinutes: 10,
        alightMinutes: 20,
        rideMinutes: 5,
        marginMinutes: 10,
        operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
      }],
      provenance: 'live',
      // 读数的取得时刻是那个冻结的时刻，不是作答的时刻。
      lastUpdatedAt: T0_MS,
    })

    // 两次定向读数用的正是存下来的那两个站序：一段的分钟来自两次请求。
    expect(liveReads().map(href => new URL(href).searchParams.get('targetOrder'))).toEqual(['2', '3'])
  })

  it('没存过起点 → anchor-unset，一次读数都不花', async () => {
    freezeAt(T0)
    stubUpstream()
    await created(chainBody())

    // 完全没存锚点：进入第一段的接驳无法定价，而这个成因是用户唯一能动手修的 ——
    // 它有自己的线上码，不与通用的「接驳无价」混作一个。
    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.chains[0].deduction).toEqual({
      status: 'no-conclusion',
      reason: 'anchor-unset',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })
    expect(liveReads()).toEqual([])
    expect(etaCalls('walking')).toBe(0)
  })

  it('站点没选完 → station-unset；请求没命名目的 → 400', async () => {
    freezeAt(T0)
    stubUpstream()
    await saveAnchors()
    await created(chainBody({ legs: [leg({ boardStationName: null, boardStationOrder: null })] }))

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.chains[0].deduction).toEqual({
      status: 'no-conclusion',
      reason: 'station-unset',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })

    const missing = await api.inject({ url: '/api/transit/commute-chains/deductions' })
    expect(missing.statusCode, missing.body).toBe(400)
    const unknown = await api.inject({ url: '/api/transit/commute-chains/deductions?purpose=afternoon' })
    expect(unknown.statusCode, unknown.body).toBe(400)
  })

  it('上车站读到 0 行 → no-vehicle，且带上那次读数与运营状态', async () => {
    freezeAt(T0)
    // 车头已越过站序 2：上游对那个站序一行都不定价，而线路本身照常在运营。
    stubUpstream({ nosePastBoard: true })
    await saveAnchors()
    await created(chainBody())

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)

    const deduction = res.json().data.chains[0].deduction
    expect(deduction).toEqual({
      status: 'no-conclusion',
      reason: 'no-vehicle',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
      updatedAt: T0_MS,
      operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
    })
    // 拒绝里没有能被当成答案的量，也没有服务端写的句子。
    expect(Object.keys(deduction).sort()).toEqual(['leg', 'operatingStatus', 'reason', 'status', 'updatedAt'])
  })

  /**
   * 「这段录反了」与「这次读数没对上」是两个不同的责任，不能共用一个码。
   * 写侧 schema 已经拒掉了反向的公交段，但直写 SQL 的伙伴可以绕过它 —— 读侧那道检查是兜底，
   * 而这一条只能在 SQL 路径上造出形状（内存路径没有绕过契约的写入通道）。
   */
  it('绕过契约写进来的反向公交段被读成 leg-recorded-backwards', async () => {
    if (store !== 'sql') return

    freezeAt(T0)
    stubUpstream()
    await saveAnchors()
    const chain = await created(chainBody())

    // 两端对调：站名与站序成对地换过来，故两个站仍然定位得到 —— 这样对比才会落在
    // 「录反了」上，而不是落在定位失败上。
    await api.rows(
      `UPDATE commute_chain_legs
          SET board_station_name = '丙站', board_station_order = 3,
              alight_station_name = '乙站', alight_station_order = 2
        WHERE chain_id = $1 AND seq = 0`,
      [chain.id],
    )

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.chains[0].deduction).toMatchObject({
      status: 'no-conclusion',
      reason: 'leg-recorded-backwards',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })
  })

  it('接驳定不了价时，录反了的那一段也先答 connection-unpriced', async () => {
    if (store !== 'sql') return

    // 判定顺序是有意的：接驳能定价才证明两个站都在这个方向的站序表里定位到了，站序才可比。
    freezeAt(T0)
    stubUpstream({ walkFails: true })
    await saveAnchors()
    const chain = await created(chainBody())

    await api.rows(
      `UPDATE commute_chain_legs
          SET board_station_name = '丙站', board_station_order = 3,
              alight_station_name = '乙站', alight_station_order = 2
        WHERE chain_id = $1 AND seq = 0`,
      [chain.id],
    )

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data.chains[0].deduction).toMatchObject({
      status: 'no-conclusion',
      reason: 'connection-unpriced',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })
  })

  /**
   * 「没有可乘的车」是四个码，不是一个：这里钉住其中两个 —— 它们指向不同的责任人，
   * 页面也因此说不同的话。
   */
  it('两次读数都答了车但按 id 对不上 → no-shared-vehicle，不是「这条线没车」', async () => {
    freezeAt(T0)
    stubUpstream({ distinctVehicles: true })
    await saveAnchors()
    await created(chainBody())

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)

    // 上车站那次读数带了车（否则答案会是 no-vehicle），但没有一辆与下车站那次对得上：
    // 这是关于本应用自己读数的事实，责任不在线路运营。
    expect(res.json().data.chains[0].deduction).toMatchObject({
      status: 'no-conclusion',
      reason: 'no-shared-vehicle',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })
    expect(liveReads().map(href => new URL(href).searchParams.get('targetOrder'))).toEqual(['2', '3'])
  })

  it('接驳走完之后车都过去了 → no-vehicle-after-connection，且等待从接驳结束起算', async () => {
    freezeAt(T0)
    // 步行 30 分钟，而唯一的车 15 分钟就到了上车站：用户站上站台时它已走过。
    // 这条同时是「站台等待不是从现在起算」的判据 —— 从此刻起算会算出一辆赶得上的车。
    stubUpstream({ walkSeconds: 1800 })
    await saveAnchors()
    await created(chainBody({ legs: [leg({ connectionMode: 'walk' })] }))

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)

    expect(res.json().data.chains[0].deduction).toMatchObject({
      status: 'no-conclusion',
      reason: 'no-vehicle-after-connection',
      leg: { seq: 0, lineId: LINE_A, lineName: '甲线' },
    })
  })

  it('接驳方式决定那一段按哪条路线定价：没选过与显式步行逐字相同', async () => {
    freezeAt(T0)
    stubUpstream()
    await saveAnchors()
    await created(chainBody({ name: '走路链', legs: [leg({ connectionMode: 'walk' })] }))
    await created(chainBody({ name: '骑车链', legs: [leg({ connectionMode: 'cycle' })] }))
    await created(chainBody({ name: '没选过', legs: [leg({ connectionMode: null })] }))

    const res = await deductions()
    expect(res.statusCode, res.body).toBe(200)

    const byName = new Map<string, { status: string, marginMinutes: number }>(
      res.json().data.chains.map((c: { name: string, deduction: { status: string, marginMinutes: number } }) => [c.name, c.deduction]),
    )
    const marginOf = (name: string): number => {
      const deduction = byName.get(name)
      expect(deduction?.status, `链路「${name}」答了 ${JSON.stringify(deduction)}`).toBe('deduced')
      return deduction!.marginMinutes
    }

    // 方式决定端点：骑行问骑行那条路线，步行（含没选过的）问步行那条，各一次。
    expect(etaCalls('walking')).toBe(1)
    expect(etaCalls('bicycling')).toBe(1)

    // null 不是第二种方式：它按步行计价，与显式步行同一条链路的答案逐字相同。
    expect(byName.get('没选过')).toEqual(byName.get('走路链'))
    // 骑行更紧，差额正好是找车与停车那一段 —— 只可能来自这一列。
    expect(marginOf('走路链') - marginOf('骑车链')).toBe(DEFAULT_CYCLE_EXTRA_MINUTES)
  })
})

/**
 * 契约之外的兜底：直写 SQL 的伙伴绕不过列上的约束。
 * 这一组断言的是**数据库本身**（两条路径共用同一份测试库），故不按存储路径分支。
 */
describeEachStore('F10 链路表的列约束', (_store) => {
  let api: ApiHarness

  beforeEach(async () => {
    // 直写走的是同一个库；存储路径只决定 app 往哪里读写。
    api = await createApiHarness({ store: _store })
  })

  afterEach(async () => {
    await api?.close()
  })

  it('站名与站序的成对 CHECK 拒绝半对的直写', async () => {
    const chainId = await insertChain(api)

    await expect(api.rows(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, city_code, board_station_name, alight_station_name, alight_station_order)
       VALUES ($1, 0, 'fixture-line', '甲线', '027', '乙站', '丙站', 3)`,
      [chainId],
    )).rejects.toThrow(/commute_chain_legs_board_station_check/)
  })

  it('connection_mode 的 CHECK 只认 walk / cycle，NULL 照常通过', async () => {
    const chainId = await insertChain(api)

    await expect(api.rows(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, city_code, connection_mode)
       VALUES ($1, 0, 'fixture-line', '甲线', '027', 'drive')`,
      [chainId],
    )).rejects.toThrow(/commute_chain_legs_connection_mode_check/)

    // 未选过是 NULL：它不在两个取值里，也不被当成第三个取值。
    await expect(api.rows(
      `INSERT INTO commute_chain_legs (chain_id, seq, line_id, line_name, city_code, connection_mode)
       VALUES ($1, 0, 'fixture-line', '甲线', '027', NULL)`,
      [chainId],
    )).resolves.toBeDefined()
  })

  it('同一用户同一城市的同一条线路只能有一行（409 背后的唯一索引）', async () => {
    await api.rows(
      `INSERT INTO user_favorite_lines (id, user_id, city_code, line_id, line_name)
       VALUES (gen_random_uuid(), 'fixture-user', '027', 'fixture-line', '甲线')`,
    )

    await expect(api.rows(
      `INSERT INTO user_favorite_lines (id, user_id, city_code, line_id, line_name)
       VALUES (gen_random_uuid(), 'fixture-user', '027', 'fixture-line', '甲线')`,
    )).rejects.toThrow(/uniq_favorite_per_user_city_line/)
  })
})

/** 一条只为主键服务的链路行：上面那几条约束都在腿上。 */
async function insertChain(api: ApiHarness): Promise<string> {
  const rows = await api.rows<{ id: string }>(
    `INSERT INTO commute_chains (user_id, name, purpose)
     VALUES ('fixture-user', '兜底夹具', 'morning') RETURNING id`,
  )
  return rows[0]!.id
}
