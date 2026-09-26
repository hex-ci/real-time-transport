import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'

/**
 * T1 — 一个请求的 user id 只有一处解析，读与写因此不可能各说各话。
 *
 * 这里钉住的是行为：同一个 id 的写被同一个 id 的读看见（a），别人的读看不见（b），
 * 不带 id 的请求照旧落在默认用户并且默认读看得见（c，正对照），以及关注线路与通勤链路
 * 这两条同样带 user id 的路线走的是同一套解析（d）。
 */

const WRITER = 'settings_contract_writer'
const OTHER = 'settings_contract_other'

type App = Awaited<ReturnType<typeof buildApp>>

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 拒绝的上游：本文件里任何调用都不许触网。 */
function refuseUpstream(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => ({
    ok: false,
    status: 503,
    text: async () => `unexpected upstream call: ${String(url)}`,
  })))
}

const json = (res: { body: string }) => JSON.parse(res.body)

const getSettings = (app: App, query = '') =>
  app.inject({ method: 'GET', url: `/api/transit/settings${query}` })

const patchSettings = (app: App, payload: Record<string, unknown>, query = '') =>
  app.inject({ method: 'PATCH', url: `/api/transit/settings${query}`, payload })

/** 不花任何上游请求的链路体（还没选站）。 */
const UNCHOSEN_LEG = {
  lineId: '010-2-0',
  lineName: '2路',
  cityCode: '027',
  boardStationName: null,
  boardStationOrder: null,
  alightStationName: null,
  alightStationOrder: null,
  transferExtraMinutes: null,
  connectionMode: null,
}

describe('(a) 同一个 id：写进去的，那个 id 读得到', () => {
  it('PATCH ?userId=X 写入的时刻，GET ?userId=X 读得回来', async () => {
    const app = await buildApp({})
    try {
      const saved = await patchSettings(app, { morningStart: '07:15', morningEnd: '09:45' }, `?userId=${WRITER}`)
      expect(saved.statusCode, saved.body).toBe(200)

      const readBack = await getSettings(app, `?userId=${WRITER}`)
      expect(readBack.statusCode, readBack.body).toBe(200)
      expect(json(readBack).settingsState, 'the write for X is invisible to the read for X').toBe('stored')
      expect(json(readBack).data).toMatchObject({ morningStart: '07:15', morningEnd: '09:45' })
    }
    finally {
      await app.close()
    }
  })

  it('写侧把 id 放在请求体里同样解析得到，和查询串是同一套', async () => {
    const app = await buildApp({})
    try {
      const saved = await patchSettings(app, { userId: WRITER, eveningStart: '18:00', eveningEnd: '21:30' })
      expect(saved.statusCode, saved.body).toBe(200)

      const readBack = await getSettings(app, `?userId=${WRITER}`)
      expect(json(readBack).settingsState, 'a body-carried id was dropped on the way to the store').toBe('stored')
      expect(json(readBack).data).toMatchObject({ eveningStart: '18:00', eveningEnd: '21:30' })
    }
    finally {
      await app.close()
    }
  })

  it('同一个 id 的锚点写入，那个 id 读得到', async () => {
    const app = await buildApp({})
    try {
      await patchSettings(app, { homeLat: 39.90931, homeLng: 116.3974 }, `?userId=${WRITER}`)

      const data = json(await getSettings(app, `?userId=${WRITER}`)).data
      expect(data.homeLat, 'the anchor written for X is invisible to the read for X').not.toBeNull()
      expect(data.homeLng).not.toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

describe('(b) 隔离：别人的读看不见这次写入', () => {
  it('GET 另一个 userId 报告「没有这一行」，不是一个借来的值', async () => {
    const app = await buildApp({})
    try {
      await patchSettings(app, { morningStart: '07:15', morningEnd: '09:45' }, `?userId=${WRITER}`)

      const other = await getSettings(app, `?userId=${OTHER}`)
      expect(other.statusCode, other.body).toBe(200)
      expect(json(other).settingsState, 'one user\'s row was read as another user\'s').toBe('unset')
      expect(json(other).data).toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('另一个 id 的读里不出现第一个 id 的值（一个字节都不行）', async () => {
    const app = await buildApp({})
    try {
      await patchSettings(
        app,
        { morningStart: '07:15', morningEnd: '09:45', eveningStart: '18:00', eveningEnd: '21:30' },
        `?userId=${WRITER}`,
      )

      const other = await getSettings(app, `?userId=${OTHER}`)
      for (const value of ['07:15', '09:45', '18:00', '21:30']) {
        expect(other.body.includes(value), `another user's read carried ${value}`).toBe(false)
      }
    }
    finally {
      await app.close()
    }
  })
})

describe('(c) 正对照：不带 user id 的请求照旧落在默认用户', () => {
  it('不带 id 的写入被不带 id 的读看见，并且它落在默认用户上', async () => {
    const app = await buildApp({})
    try {
      const saved = await patchSettings(app, { morningStart: '07:15', morningEnd: '09:45' })
      expect(saved.statusCode, saved.body).toBe(200)

      // 今天的客户端一个 id 都不发：这条路径的行为不许变。
      const readBack = await getSettings(app)
      expect(json(readBack).settingsState).toBe('stored')
      expect(json(readBack).data).toMatchObject({ morningStart: '07:15', morningEnd: '09:45' })

      // 显式点名默认用户，读到的是同一行。
      const named = await getSettings(app, `?userId=${DEFAULT_USER_ID}`)
      expect(json(named).data, 'naming the default user read a different row than naming none').toEqual(json(readBack).data)
    }
    finally {
      await app.close()
    }
  })

  it('不带 id 的写入对另一个 id 不可见', async () => {
    const app = await buildApp({})
    try {
      await patchSettings(app, { morningStart: '07:15', morningEnd: '09:45' })

      expect(json(await getSettings(app, `?userId=${OTHER}`)).settingsState).toBe('unset')
    }
    finally {
      await app.close()
    }
  })

  it('一个空串或重复的 user id 命名不了任何用户，落到默认用户上（明说的归一化）', async () => {
    // 「命名不了一个用户」与「没命名用户」是同一件事：查询串里的空串、以及被解析成数组的
    // 重复参数，都不是一个 id。它们不被当成第四个用户，也不被当成 X 或 Y —— 落到默认用户，
    // 这正是本应用自己的客户端读的那一行。（另一种选择是拒绝，见 `user-id.ts` 的说明。）
    const app = await buildApp({})
    try {
      await patchSettings(app, { morningStart: '07:15', morningEnd: '09:45' })

      expect(json(await getSettings(app, '?userId=')).data).toMatchObject({ morningStart: '07:15' })
      expect(json(await getSettings(app, `?userId=${WRITER}&userId=${OTHER}`)).data).toMatchObject({ morningStart: '07:15' })
    }
    finally {
      await app.close()
    }
  })
})

describe('(d) 类审计：关注线路与通勤链路的读/写也是同一套解析', () => {
  it('关注线路：POST 里带的 id 决定它属于谁，别人的读看不到', async () => {
    refuseUpstream()
    const app = await buildApp({})
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/transit/favorites',
        payload: { userId: WRITER, cityCode: '027', lineId: '010-1-0', lineName: '1' },
      })
      expect(created.statusCode, created.body).toBe(200)

      const mine = json(await app.inject({ method: 'GET', url: `/api/transit/favorites?userId=${WRITER}` }))
      expect(mine.data.map((row: any) => row.id)).toEqual([json(created).data.id])

      const theirs = json(await app.inject({ method: 'GET', url: `/api/transit/favorites?userId=${OTHER}` }))
      expect(theirs.data, 'one user\'s favourite was listed for another user').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('通勤链路：POST 里带的 id 决定它属于谁，别人的列表与推导都看不到', async () => {
    refuseUpstream()
    const app = await buildApp({})
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/transit/commute-chains',
        payload: { userId: WRITER, name: '上班链路', purpose: 'morning', legs: [{ ...UNCHOSEN_LEG }] },
      })
      expect(created.statusCode, created.body).toBe(200)
      const chainId = json(created).data.id

      const mine = json(await app.inject({ method: 'GET', url: `/api/transit/commute-chains?userId=${WRITER}` }))
      expect(mine.data.map((chain: any) => chain.id)).toEqual([chainId])

      const theirs = json(await app.inject({ method: 'GET', url: `/api/transit/commute-chains?userId=${OTHER}` }))
      expect(theirs.data, 'one user\'s chain was listed for another user').toEqual([])

      const mineDeduction = json(await app.inject({
        method: 'GET',
        url: `/api/transit/commute-chains/deductions?purpose=morning&userId=${WRITER}`,
      }))
      expect(mineDeduction.data.chains.map((view: any) => view.chainId)).toEqual([chainId])

      const theirsDeduction = json(await app.inject({
        method: 'GET',
        url: `/api/transit/commute-chains/deductions?purpose=morning&userId=${OTHER}`,
      }))
      expect(theirsDeduction.data.chains, 'a chain was deduced for a user who does not own it').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it('默认路径：不带 id 时，关注线路与链路也仍然落在默认用户上', async () => {
    refuseUpstream()
    const app = await buildApp({})
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/transit/commute-chains',
        payload: { name: '上班链路', purpose: 'morning', legs: [{ ...UNCHOSEN_LEG }] },
      })
      const chainId = json(created).data.id

      const list = json(await app.inject({ method: 'GET', url: '/api/transit/commute-chains' }))
      expect(list.data.map((chain: any) => chain.id)).toEqual([chainId])
      expect(json(created).data.userId).toBe(DEFAULT_USER_ID)
    }
    finally {
      await app.close()
    }
  })
})
