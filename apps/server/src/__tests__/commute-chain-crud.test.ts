import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import {
  Database,
  normalizeCommuteChainLegs,
  storedCommuteChainLeg,
} from '../db/client.js'

/**
 * F10：链路是存下来的，从不推导 —— 本文件按构造就是离网的。
 * 一旦有调用逃出去，这里会抛错而不是花掉配额。
 */
function forbidNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const LEG = {
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

function chainBody(over: Record<string, unknown> = {}) {
  return {
    name: '上班链路',
    purpose: 'morning',
    legs: [{ ...LEG }],
    ...over,
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

const createChain = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/transit/commute-chains', payload })

const listChains = (app: App, userId?: string) =>
  app.inject({ url: `/api/transit/commute-chains${userId ? `?userId=${userId}` : ''}` })

const json = (res: { body: string }) => JSON.parse(res.body)

describe('F10 chains: storage', () => {
  it('stores a chain and reads its legs back in sequence', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())

    expect(created.id).toBeTruthy()
    expect(created.userId).toBe('default_user')
    expect(created.displayOrder).toBe(0)
    expect(created.createdAt).toBeTruthy()
    expect(created.legs).toHaveLength(1)
    expect(created.legs[0]!.seq).toBe(0)
    expect(created.legs[0]!.alightStationOrder).toBe(7)

    const list = await db.getCommuteChains('default_user')
    expect(list.map(c => c.id)).toEqual([created.id])
    expect(list[0]!.legs[0]!.lineId).toBe('010-2-0')
  })

  it('keeps a leg whose stations are not chosen yet as null, never as an empty name', async () => {
    const db = new Database()
    await db.createCommuteChain(chainBody({
      legs: [
        { ...LEG, boardStationName: null, boardStationOrder: null },
        { ...LEG, alightStationName: null, alightStationOrder: null, transferExtraMinutes: 3, connectionMode: 'cycle' },
      ],
    }))

    const [chain] = await db.getCommuteChains('default_user')
    const [first, second] = chain!.legs

    // 未设置是 null。空串会是一个名字为 "" 的站。
    expect(first!.boardStationName).toBeNull()
    expect(first!.boardStationOrder).toBeNull()
    expect(first!.boardStationName).not.toBe('')
    expect(second!.alightStationName).toBeNull()
    expect(second!.alightStationOrder).toBeNull()
    // 配置过的加时与未设置的是两件事。
    expect(second!.transferExtraMinutes).toBe(3)
    expect(first!.transferExtraMinutes).toBeNull()
    // 接驳方式同样是两个事实：选过骑行，与从没选过（NULL）。
    expect(second!.connectionMode).toBe('cycle')
    expect(first!.connectionMode).toBeNull()
  })

  it('keeps each leg\'s own connection mode: one chain can walk one leg and ride the next', async () => {
    // 粒度是**进入每一段乘车段的那一段接驳**，故方式挂在段上而不是链上：
    // 一条链路一段走路一段骑车不是矛盾记录，而是这个模型的常态。
    const db = new Database()
    await db.createCommuteChain(chainBody({
      legs: [
        { ...LEG, connectionMode: 'walk', transferExtraMinutes: 0 },
        { ...LEG, lineId: '010-9-0', lineName: '9路', connectionMode: 'cycle', transferExtraMinutes: 3 },
      ],
    }))

    const [chain] = await db.getCommuteChains('default_user')
    expect(chain!.legs.map(leg => leg.connectionMode)).toEqual(['walk', 'cycle'])
  })

  it('numbers the legs from the array order and replaces them as a unit', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())
    const updated = await db.updateCommuteChain(created.id, {
      legs: [
        { ...LEG, lineId: '010-9-0', lineName: '9路' },
        { ...LEG, lineId: '010-52-0', lineName: '52路', transferExtraMinutes: 5 },
      ],
    })

    // 数组就是顺序：seq 由它盖章，所以客户端传的数字
    // 留不下空档或重复。
    expect(updated!.legs.map(l => l.seq)).toEqual([0, 1])
    expect(updated!.legs.map(l => l.lineId)).toEqual(['010-9-0', '010-52-0'])

    const [read] = await db.getCommuteChains('default_user')
    // 第一段是没了，不是被合并：legs 是一个值，整份写入。
    expect(read!.legs).toHaveLength(2)
    expect(read!.legs.some(l => l.lineId === '010-2-0')).toBe(false)
  })

  it('updates the chain row without touching legs that were not sent', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())
    const updated = await db.updateCommuteChain(created.id, { name: '晚间链路', purpose: 'evening' })

    expect(updated!.name).toBe('晚间链路')
    expect(updated!.purpose).toBe('evening')
    expect(updated!.legs).toHaveLength(1)
  })

  it('reports a chain that does not exist as null, not as a created row', async () => {
    const db = new Database()
    expect(await db.getCommuteChain('3f1c2f9e-0000-4000-8000-000000000000')).toBeNull()
    expect(await db.updateCommuteChain('3f1c2f9e-0000-4000-8000-000000000000', { name: 'x' })).toBeNull()
    expect(await db.removeCommuteChain('3f1c2f9e-0000-4000-8000-000000000000')).toBe(false)
  })

  it('orders the list by display order and scopes it to one user', async () => {
    const db = new Database()
    const late = await db.createCommuteChain(chainBody({ name: '第二条', displayOrder: 5 }))
    const early = await db.createCommuteChain(chainBody({ name: '第一条', displayOrder: 1 }))
    const other = await db.createCommuteChain(chainBody({ name: '别人', userId: 'someone_else' }))

    expect((await db.getCommuteChains('default_user')).map(c => c.id)).toEqual([early.id, late.id])
    expect((await db.getCommuteChains('someone_else')).map(c => c.id)).toEqual([other.id])
  })

  it('removes a chain and reports the removal', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())

    expect(await db.removeCommuteChain(created.id)).toBe(true)
    expect(await db.getCommuteChains('default_user')).toEqual([])
    expect(await db.removeCommuteChain(created.id)).toBe(false)
  })

  it('maps a stored row so an unset column cannot read as a station', () => {
    const leg = storedCommuteChainLeg({
      seq: 1,
      line_id: '010-2-0',
      line_name: '2路',
      city_code: null,
      board_station_name: null,
      board_station_order: null,
      alight_station_name: '乙路',
      alight_station_order: 7,
      transfer_extra_minutes: null,
      connection_mode: null,
    })

    expect(leg.seq).toBe(1)
    expect(leg.cityCode).toBe('027')
    expect(leg.boardStationName).toBeNull()
    expect(leg.boardStationOrder).toBeNull()
    expect(leg.alightStationName).toBe('乙路')
    expect(leg.alightStationOrder).toBe(7)
    expect(leg.transferExtraMinutes).toBeNull()
    // NULL 读作「没选过」，绝不替使用者补一个步行 —— 补上之后两种状态读起来一模一样。
    expect(leg.connectionMode).toBeNull()
  })

  it('reads a stored mode through the two known values, and anything else as never chosen', () => {
    // `?? 0` 那个习惯在这里正是错的（它对 `display_order` 是对的）：这一列的缺省含义是
    // 「不知道」，而默认值会把「不知道」变成「知道」。
    const row = (connection_mode: unknown) => storedCommuteChainLeg({
      seq: 0,
      line_id: '010-2-0',
      line_name: '2路',
      city_code: '027',
      board_station_name: null,
      board_station_order: null,
      alight_station_name: null,
      alight_station_order: null,
      transfer_extra_minutes: null,
      connection_mode,
    })

    expect(row('walk').connectionMode).toBe('walk')
    expect(row('cycle').connectionMode).toBe('cycle')
    expect(row(null).connectionMode).toBeNull()
    // 缺列（更早的库、别的读路径）与写坏的取值都不是一种方式，也不是步行。
    expect(row(undefined).connectionMode).toBeNull()
    expect(row('drive').connectionMode).toBeNull()
    expect(row('').connectionMode).toBeNull()
  })

  it('stamps the sequence from position, ignoring a number from the caller', () => {
    const legs = normalizeCommuteChainLegs([
      { ...LEG, seq: 9 },
      { ...LEG, seq: 9, connectionMode: 'cycle' },
    ])

    expect(legs.map(l => l.seq)).toEqual([0, 1])
    expect(legs[0]!.cityCode).toBe('027')
    // 方式由写入方给，编号由存储盖：两个字段各有来源，谁也不替谁作主。
    expect(legs.map(l => l.connectionMode)).toEqual([null, 'cycle'])
  })

  it('stores no origin anchor, even when a legacy caller still sends one', async () => {
    // 起点由通勤目的决定，链路上没有这一列：旧调用方带着它也无处可存 ——
    // 一条「上班·从公司出发」的矛盾链因此不可能被写进来。
    const db = new Database()
    const created = await db.createCommuteChain(chainBody({ originAnchor: 'work' }))

    expect(created).not.toHaveProperty('originAnchor')
    const [read] = await db.getCommuteChains('default_user')
    expect(read).not.toHaveProperty('originAnchor')
    expect(read!.purpose).toBe('morning')
  })
})

describe('F10 chains: HTTP routes', () => {
  it('creates, reads, lists, patches and deletes a chain', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody()))
      expect(created.success).toBe(true)
      expect(created.data.legs[0].boardStationOrder).toBe(3)

      const listed = json(await listChains(app))
      expect(listed.data.map((c: { id: string }) => c.id)).toEqual([created.data.id])

      const one = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(one.data.name).toBe('上班链路')

      const patched = json(await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${created.data.id}`,
        payload: { name: '晚间链路', purpose: 'evening', legs: [{ ...LEG, lineId: '010-9-0' }] },
      }))
      expect(patched.data.name).toBe('晚间链路')
      expect(patched.data.legs.map((l: { lineId: string }) => l.lineId)).toEqual(['010-9-0'])

      const removed = json(await app.inject({
        method: 'DELETE',
        url: `/api/transit/commute-chains/${created.data.id}`,
      }))
      expect(removed.data.removed).toBe(true)

      const gone = await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` })
      expect(gone.statusCode).toBe(404)
    }
    finally {
      await app.close()
    }
  })

  it('answers a created chain without an origin anchor, even for a legacy payload that still carries one', async () => {
    // 写侧契约里没有这一列了，故旧客户端发来的它在入口就被丢掉：存下的与读回的都不携带它，
    // 而这条链路照常可用 —— 起点由它自己的 purpose 决定。
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody({ originAnchor: 'work' })))
      expect(created.success).toBe(true)
      expect(created.data).not.toHaveProperty('originAnchor')

      const read = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(read.data).not.toHaveProperty('originAnchor')
      expect(read.data.purpose).toBe('morning')
    }
    finally {
      await app.close()
    }
  })

  it('carries an unset station through the wire as null', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody({
        legs: [{ ...LEG, boardStationName: null, boardStationOrder: null }],
      })))

      const read = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(read.data.legs[0].boardStationName).toBeNull()
      expect(read.data.legs[0].boardStationOrder).toBeNull()
      expect(read.data.legs[0].boardStationName).not.toBe('')
    }
    finally {
      await app.close()
    }
  })

  it('carries the connection mode of every leg through the wire, both ways', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody({
        legs: [
          { ...LEG, connectionMode: 'cycle', transferExtraMinutes: 2 },
          { ...LEG, lineId: '010-9-0', lineName: '9路', connectionMode: null },
        ],
      })))
      expect(created.success, created.error).toBe(true)
      expect(created.data.legs.map((l: { connectionMode: string | null }) => l.connectionMode)).toEqual(['cycle', null])

      const read = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(read.data.legs.map((l: { connectionMode: string | null }) => l.connectionMode)).toEqual(['cycle', null])

      // PATCH 的 `legs` 整段替换，方式跟着走 —— 与加时、站点同一条写入路径。
      const patched = json(await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${created.data.id}`,
        payload: { legs: [{ ...LEG, connectionMode: null }] },
      }))
      expect(patched.data.legs).toHaveLength(1)
      expect(patched.data.legs[0].connectionMode).toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('refuses a leg that names no connection mode, and one that names a mode that is not ours', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      // 省略字段是一次没说清方式的写入，而不是隐含的步行：契约里它是必填可空。
      const { connectionMode: omitted, ...withoutMode } = { ...LEG, connectionMode: null }
      expect(omitted).toBeNull()
      const missing = await createChain(app, chainBody({ legs: [withoutMode] }))
      expect(missing.statusCode, missing.body).toBe(400)
      expect(json(missing).success).toBe(false)

      // 两个已知方式之外的一切都不是方式。
      const wrong = await createChain(app, chainBody({ legs: [{ ...LEG, connectionMode: 'drive' }] }))
      expect(wrong.statusCode, wrong.body).toBe(400)
      expect(json(wrong).success).toBe(false)
    }
    finally {
      await app.close()
    }
  })

  it('rejects a chain with no ride leg with a 400 and a reason', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const res = await createChain(app, chainBody({ legs: [] }))
      expect(res.statusCode).toBe(400)
      expect(json(res).success).toBe(false)
      expect(typeof json(res).error).toBe('string')
    }
    finally {
      await app.close()
    }
  })

  it('rejects half a station instead of storing the name without its order', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const res = await createChain(app, chainBody({
        legs: [{ ...LEG, boardStationOrder: null }],
      }))
      expect(res.statusCode).toBe(400)
      expect(json(res).success).toBe(false)
    }
    finally {
      await app.close()
    }
  })

  it('answers 404 for a chain that does not exist', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const missing = '3f1c2f9e-0000-4000-8000-000000000000'
      expect((await app.inject({ url: `/api/transit/commute-chains/${missing}` })).statusCode).toBe(404)

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${missing}`,
        payload: { name: 'x' },
      })
      expect(patched.statusCode).toBe(404)

      const removed = json(await app.inject({
        method: 'DELETE',
        url: `/api/transit/commute-chains/${missing}`,
      }))
      expect(removed.data.removed).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})
