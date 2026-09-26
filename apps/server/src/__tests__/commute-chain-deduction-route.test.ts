import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F10 的路由部分：一个用途的链路，每条链路带引擎自己的答案。
 *
 * 1. 线上形状：该用途的每条链路都在同一次响应里，每条链路的推演原样透传 —— 「不给结论」
 *    的原因是一个码，不带任何多余的东西；用户读到的每一个字归 web 层所有。
 * 2. 两次定向读数走真实提供方与聚合器，用的是存下来的路段点名的目标站序，所以装配依赖的
 *    按站缓存键是真正被用到的那些，而不是只有替身才见过的。
 *
 * 101 / 202 / 甲路 / 乙路 是占位：本文件不出现真实线路、站点或上游 id，也触不到上游。
 */

const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

const LINE_A = '101'
const LINE_B = '202'

/** 每条线路被读取时用的站表，以及挂在它上面的那一段。 */
const STOPS: Record<string, string[]> = {
  [LINE_A]: ['甲路', '乙路', '丙路'],
  [LINE_B]: ['丙路', '丁路', '戊路', '己路'],
}
const BOARD_ORDER: Record<string, number> = { [LINE_A]: 2, [LINE_B]: 3 }
/** 上游为每个被请求的目标站序报的秒数。 */
const TRAVEL: Record<string, Record<number, number>> = {
  [LINE_A]: { 2: 900, 3: 1200 },
  [LINE_B]: { 3: 2100, 4: 2400 },
}
/** 路径服务替身为每个换乘定价的步行时长。 */
const WALK_SECONDS = 300

function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const LEG_A = {
  lineId: LINE_A,
  lineName: '101路',
  cityCode: '027',
  boardStationName: '乙路',
  boardStationOrder: 2,
  alightStationName: '丙路',
  alightStationOrder: 3,
  transferExtraMinutes: null,
}

const LEG_B = {
  lineId: LINE_B,
  lineName: '202路',
  cityCode: '027',
  boardStationName: '戊路',
  boardStationOrder: 3,
  alightStationName: '己路',
  alightStationOrder: 4,
  transferExtraMinutes: null,
}

function chainBody(over: Record<string, unknown> = {}) {
  return { name: '上班链路', originAnchor: 'home', purpose: 'morning', legs: [{ ...LEG_A }, { ...LEG_B }], ...over }
}

/**
 * 推演能触到的两个上游，都计数。
 *
 * `targets` 记录每次实时读数的目标站序，`<线路>:<站序>` 这串就是「每段在自己的两个站各读
 * 一次」从外面可观测的方式；线路详情读数不带目标，不计入其中。
 *
 * `noseAtByLine` 让线路上的车往前走，于是测试能再现上游那个「一行都不定价」的过滤：车头已经
 * 越过所请求站序的车，对那个站序不会被返回。
 */
function stubUpstream(options: { noseAtByLine?: Record<string, number> } = {}): { lines: string[], targets: string[], walking: number } {
  const state = { lines: [] as string[], targets: [] as string[], walking: 0 }

  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)

    if (href.includes('/v3/direction/walking')) {
      state.walking += 1
      return amapOk({ route: { paths: [{ distance: 400, duration: WALK_SECONDS }] } })
    }
    if (!href.includes('encryptedLineDetail')) {
      throw new Error(`unexpected upstream call: ${href}`)
    }

    const params = new URL(href).searchParams
    const lineId = String(params.get('lineId'))
    const target = params.get('targetOrder')
    if (target) state.targets.push(`${lineId}:${target}`)
    state.lines.push(lineId)

    return body(JSON.stringify({
      jsonr: { data: lineBody(lineId, target ? Number(target) : null, options.noseAtByLine?.[lineId]) },
    }))
  }))

  return state
}

/** chelaile 提供方按文本读的响应，它本来就是这么读的。 */
function body(text: string) {
  return { ok: true, status: 200, text: async () => text }
}

/** 一个 Amap v3 成功信封。 */
function amapOk(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...payload }),
  }
}

/**
 * 一条线路的详情，只带上游为所请求目标站序报的那辆车 —— 与真实的一样，其 `travels` 按请求
 * 点名的站序匹配。没有 `mileage` 也没有 `distanceToWaitStn`，所以没有一行会被读成「正在进站」，
 * 下面每个分钟都是上游自己的。
 *
 * `noseAt` 是车头所在处；不设就是这条线路自己的上车站序，也就是通常情形。上游只在车头尚未
 * 越过该站序时才为它返回车辆，所以车头越过某个站序，就是让那次读数一行都不定价的原因。
 */
function lineBody(lineId: string, targetOrder: number | null, noseAt?: number) {
  const names = STOPS[lineId] ?? []
  const travel = targetOrder !== null ? TRAVEL[lineId]?.[targetOrder] : undefined

  return {
    line: { name: lineId, direction: 0, firstTime: '05:00', lastTime: '23:00' },
    stations: names.map((name, i) => ({
      sId: `s${i + 1}`,
      sn: name,
      order: i + 1,
      lat: 39.9 + (i + 1) / 100,
      lng: 116.4 + (i + 1) / 100,
    })),
    buses: [{
      busId: 'v1',
      order: noseAt ?? BOARD_ORDER[lineId],
      speed: 6,
      ...(travel !== undefined ? { travels: [{ order: noseAt ?? targetOrder, travelTime: travel }] } : {}),
    }],
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

const deductions = (app: App, query = '?purpose=morning') =>
  app.inject({ url: `/api/transit/commute-chains/deductions${query}` })

const createChain = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/transit/commute-chains', payload })

const saveAnchor = (app: App) =>
  app.inject({ method: 'PATCH', url: '/api/transit/settings', payload: { homeLat: 39.9, homeLng: 116.4 } })

describe('F10 route: one response carries every chain of the purpose', () => {
  it('answers the chains with the engine\'s own deduction, over the real live path', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      expect((await saveAnchor(app)).statusCode).toBe(200)
      const created = (await createChain(app, chainBody())).json().data

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      const payload = res.json()
      expect(payload.success).toBe(true)
      expect(payload.data.purpose).toBe('morning')
      expect(payload.data.chains).toHaveLength(1)

      const view = payload.data.chains[0]
      expect(view).toMatchObject({
        chainId: created.id,
        name: '上班链路',
        originAnchor: 'home',
        purpose: 'morning',
      })

      expect(view.deduction).toEqual({
        status: 'deduced',
        band: 'comfortable',
        marginMinutes: 10,
        bindingSeq: 0,
        legs: [
          {
            seq: 0,
            lineId: LINE_A,
            lineName: '101路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 20,
            rideMinutes: 5,
            marginMinutes: 10,
            // F3 的状态跟着路段走：线路自己的时刻，加上 `now`。
            operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
          },
          {
            seq: 1,
            lineId: LINE_B,
            lineName: '202路',
            vehicleId: 'v1',
            referenceVehicleId: 'v1',
            provenance: 'live',
            waitMinutes: 10,
            alightMinutes: 40,
            rideMinutes: 5,
            marginMinutes: 10,
            operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
          },
        ],
        provenance: 'live',
        lastUpdatedAt: T0_MS,
      })

      // 每个站一次实时读数：适配器一次只答一个目标站序，所以一段的上车分钟与下车分钟来自两次请求，
      // 点名的站序是存下来的那些，而且走的是真实提供方。
      expect(upstream.targets).toEqual([`${LINE_A}:2`, `${LINE_A}:3`, `${LINE_B}:3`, `${LINE_B}:4`])
    }
    finally {
      await app.close()
    }
  })

  it('answers only the chains of THIS purpose and THIS user', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      const morning = (await createChain(app, chainBody())).json().data
      await createChain(app, chainBody({ name: '下班链路', purpose: 'evening' }))
      await createChain(app, chainBody({ name: '别人的链路', userId: 'someone_else' }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains.map((c: { chainId: string }) => c.chainId)).toEqual([morning.id])

      const evening = await deductions(app, '?purpose=evening')
      expect(evening.json().data.chains.map((c: { name: string }) => c.name)).toEqual(['下班链路'])
    }
    finally {
      await app.close()
    }
  })

  it('answers an empty list, not an error, for a purpose with no chain', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data).toEqual({ purpose: 'morning', chains: [] })
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: 不给结论 travels as the engine\'s code', () => {
  it('ships a code with no sentence beside it', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({
        legs: [{ ...LEG_A, boardStationName: null, boardStationOrder: null }],
      }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      const deduction = res.json().data.chains[0].deduction
      expect(deduction).toEqual({
        status: 'no-conclusion',
        reason: 'station-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 只有一个原因码和点名哪一段被拒，别的什么都没有：没有句子，没有兜底的分钟。
      // 「哪一段」不是关于这个答案的量 —— 见 `ChainNoConclusion`。
      expect(Object.keys(deduction).sort()).toEqual(['leg', 'reason', 'status'])
    }
    finally {
      await app.close()
    }
  })

  it('reports an unusable chain as a 200 with a reason, not as a failure of the request', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // 完全没存锚点：进入第一段的换乘无法定价，引擎如实说明，而不是从一个用户从未保存过的坐标
      // 起步。原因点名的正是这件事 —— 记录这条链路时所依据的起点从未设置 —— 因为这是用户唯一能
      // 动手修的「换乘无价」成因，也是 F1 自己的空状态为同一件事用的那个词。
      await createChain(app, chainBody({ legs: [{ ...LEG_A }] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
      })
      // 一步没走、一站没读：引擎在读任何数据之前就在这个换乘上拒掉了。
      expect(upstream.walking).toBe(0)
      expect(upstream.targets).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('names the unsaved anchor even when the leg could not be located either', async () => {
    freezeAt(T0)
    const upstream = stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      // 两个毛病同时出现：锚点从未保存，且这一段自己的站表无法定位它的站（未知线路读成没有站的
      // 线路）。两者只有一个是用户能修的，答案必须点名那一个：点了另一个，会把用户送到没有解药的
      // 页面上去。
      const unlocatable = { ...LEG_A, lineId: '999', lineName: '999路' }
      await createChain(app, chainBody({ legs: [unlocatable] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'anchor-unset',
        leg: { seq: 0, lineId: '999', lineName: '999路' },
      })
      expect(upstream.walking).toBe(0)
      expect(upstream.targets).toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('refuses a request that names no purpose of ours, instead of picking one', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const missing = await deductions(app, '')
      expect(missing.statusCode, missing.body).toBe(400)
      expect(missing.json().success).toBe(false)
      expect(typeof missing.json().error).toBe('string')

      const unknown = await deductions(app, '?purpose=afternoon')
      expect(unknown.statusCode, unknown.body).toBe(400)
      expect(unknown.json().success).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: the refusal names the leg it is about, over the wire', () => {
  it('names the SECOND leg when the second leg is the one that refused', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({
        legs: [LEG_A, { ...LEG_B, boardStationName: null, boardStationOrder: null }],
      }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)

      // 第 0 段可推演，第 1 段的站从未选过。拒绝必须说明那是哪个换乘点 —— 否则两条腿的链路会让
      // 页面既指不出它，也说不清是哪条线路在那里拒的。
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'station-unset',
        leg: { seq: 1, lineId: '202', lineName: '202路' },
      })
    }
    finally {
      await app.close()
    }
  })

  it('carries the refusing leg\'s reading age and service state, not only its reason', async () => {
    freezeAt(T0)
    // LINE_A 的车头已在站序 3，而这一段在站序 2 上车，所以上车读数一行都不定价，这个空答案是
    // 服务的。拒绝必须给那次读数标上时间、说明由哪个运营状态管辖 —— 08:30 处在 05:00–23:00 之内，
    // 即 运营中，页面才能说这是运营中的空档，而不是一天已经结束。
    stubUpstream({ noseAtByLine: { [LINE_A]: 3 } })
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await saveAnchor(app)
      await createChain(app, chainBody({ legs: [{ ...LEG_A }] }))

      const res = await deductions(app)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().data.chains[0].deduction).toEqual({
        status: 'no-conclusion',
        reason: 'no-vehicle',
        leg: { seq: 0, lineId: '101', lineName: '101路' },
        updatedAt: T0_MS,
        operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
      })
    }
    finally {
      await app.close()
    }
  })
})

describe('F10 route: a leg recorded the wrong way round cannot be stored', () => {
  /** 同一条线路，两个站反着记录。 */
  const BACKWARDS = {
    ...LEG_A,
    boardStationName: '丙路',
    boardStationOrder: 3,
    alightStationName: '乙路',
    alightStationOrder: 2,
  }

  it('refuses a POST whose leg runs upstream, with a 400 and a reason', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await createChain(app, chainBody({ legs: [BACKWARDS] }))
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().success).toBe(false)
      expect(typeof res.json().error).toBe('string')
    }
    finally {
      await app.close()
    }
  })

  it('refuses a PATCH that would store one, and changes nothing', async () => {
    freezeAt(T0)
    stubUpstream()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const created = (await createChain(app, chainBody({ legs: [LEG_A] }))).json().data

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${created.id}`,
        payload: { legs: [BACKWARDS] },
      })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().success).toBe(false)

      // 被拒的写入什么都没存：这一段仍旧在下游跑。
      const read = (await app.inject({ url: `/api/transit/commute-chains/${created.id}` })).json().data
      expect(read.legs[0].boardStationOrder).toBe(2)
      expect(read.legs[0].alightStationOrder).toBe(3)
    }
    finally {
      await app.close()
    }
  })
})
