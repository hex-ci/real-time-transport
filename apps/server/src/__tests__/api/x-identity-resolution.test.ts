import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 身份一处解析：query → body → 默认常量。
 *
 * `resolveUserId`（src/user-id.ts）是「这次请求针对谁」的唯一解析处，读与写共用它，
 * 因此同一个 id 不可能在两条路径上各说各话。这里钉三件事：优先级（query 胜过 body）、
 * 三种入参最终落在同一个人身上、以及「命名不了任何用户」的值落到那唯一的默认常量上，
 * 而不是变成一个谁都没命名的第四个用户（空串、重复参数以数组到达）。
 *
 * 差分的另一半在库里：SQL 路径直接读 `user_id` 列，看这次写入落在哪个 id 上；内存路径
 * 断言库里一行都没有。两条断言合起来才说明「这一遍走的是哪条路」，而不是各自在自己的
 * 世界里成立。
 */
describeEachStore('身份一处解析：query → body → 默认常量', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  // `?.` 只应付 beforeEach 自己失败那一次：那时不该再叠一个 TypeError 埋掉真正的原因。
  afterEach(async () => {
    await api?.close()
  })

  /** 平台用户 id —— 谁都不是真实账号，只是这一次跑出来的名字。 */
  const NAMED_IN_QUERY = 'fx-identity-query'
  const NAMED_IN_BODY = 'fx-identity-body'

  const getSettings = (query = '') => api.inject({ method: 'GET', url: `/api/transit/settings${query}` })

  const patchSettings = (payload: Record<string, unknown>, query = '') =>
    api.inject({ method: 'PATCH', url: `/api/transit/settings${query}`, payload })

  /** 这次写入落在哪个 user_id 上：SQL 路径是库里的列，内存路径应为空。 */
  async function storedUserIds(table: 'user_settings' | 'user_favorite_lines' | 'commute_chains'): Promise<string[]> {
    const rows = await api.rows<{ user_id: string }>(`SELECT user_id FROM ${table} ORDER BY user_id`)
    return rows.map(row => row.user_id)
  }

  const storedIdsDiff = (ids: string[], table: string) =>
    [ids, store === 'sql' ? `写入没有落到 ${table} 的 user_id 列上` : '内存路径不该在库里留下行'] as const

  it('query 里的 id 决定写入属于谁，同名的读看得见', async () => {
    const saved = await patchSettings({ morningStart: '07:15', morningEnd: '08:45' }, `?userId=${NAMED_IN_QUERY}`)
    expect(saved.statusCode, saved.body).toBe(200)

    const readBack = await getSettings(`?userId=${NAMED_IN_QUERY}`)
    expect(readBack.json().settingsState, 'the write for the named user is invisible to its own read').toBe('stored')
    expect(readBack.json().data).toMatchObject({ morningStart: '07:15', morningEnd: '08:45' })

    const [ids, message] = storedIdsDiff(store === 'sql' ? [NAMED_IN_QUERY] : [], 'user_settings')
    expect(await storedUserIds('user_settings'), message).toEqual(ids)
  })

  it('body 里的 id 与 query 里的 id 是同一套解析：写入属于同一个人', async () => {
    const saved = await patchSettings({ userId: NAMED_IN_BODY, eveningStart: '18:00', eveningEnd: '20:30' })
    expect(saved.statusCode, saved.body).toBe(200)

    const readBack = await getSettings(`?userId=${NAMED_IN_BODY}`)
    expect(readBack.json().settingsState, 'a body-carried id was dropped on the way to the store').toBe('stored')
    expect(readBack.json().data).toMatchObject({ eveningStart: '18:00', eveningEnd: '20:30' })

    const [ids, message] = storedIdsDiff(store === 'sql' ? [NAMED_IN_BODY] : [], 'user_settings')
    expect(await storedUserIds('user_settings'), message).toEqual(ids)
  })

  it('两个位置都命名了用户时 query 胜出，body 里那个名字什么都没拿到', async () => {
    // 优先级由那一处解析决定，不随路由而变。用「谁读得到」钉住它，而不是读源码：
    // 写落在 query 那个人身上，body 那个人读不到任何东西。
    const saved = await patchSettings(
      { userId: NAMED_IN_BODY, morningStart: '07:00', morningEnd: '08:00' },
      `?userId=${NAMED_IN_QUERY}`,
    )
    expect(saved.statusCode, saved.body).toBe(200)

    const winner = await getSettings(`?userId=${NAMED_IN_QUERY}`)
    expect(winner.json().data, 'the query-carried id did not win').toMatchObject({ morningStart: '07:00', morningEnd: '08:00' })

    const loser = await getSettings(`?userId=${NAMED_IN_BODY}`)
    expect(loser.json().settingsState, 'the body-carried id was stored as well').toBe('unset')
    expect(loser.json().data).toBeNull()

    const [ids, message] = storedIdsDiff(store === 'sql' ? [NAMED_IN_QUERY] : [], 'user_settings')
    expect(await storedUserIds('user_settings'), message).toEqual(ids)
  })

  it('两个位置都不带 id 时落在默认常量上，点名那个常量读到同一行', async () => {
    const saved = await patchSettings({ morningStart: '07:00', morningEnd: '08:00' })
    expect(saved.statusCode, saved.body).toBe(200)

    const unnamed = await getSettings()
    expect(unnamed.json().settingsState, 'a write without an id created no row for the default user').toBe('stored')

    const named = await getSettings(`?userId=${DEFAULT_USER_ID}`)
    expect(named.json().data, 'naming the default user read a different row than naming none')
      .toEqual(unnamed.json().data)

    // 默认常量是那个字面量的唯一副本：库里那一列必须正好是它，绝不是空串或别的替身。
    const [ids, message] = storedIdsDiff(store === 'sql' ? [DEFAULT_USER_ID] : [], 'user_settings')
    expect(await storedUserIds('user_settings'), message).toEqual(ids)
  })

  it('空串与重复参数命名不了任何用户：落到默认常量，不产生第四个用户', async () => {
    // 「命名不了一个用户」与「没命名用户」是同一件事。空串、被解析成数组的重复参数都被
    // 解析成默认用户 —— 库里那列必须正好是那个常量，也不许存在一行 user_id = ''。
    const empty = await patchSettings({ userId: '', morningStart: '07:00', morningEnd: '08:00' }, '?userId=')
    expect(empty.statusCode, empty.body).toBe(200)
    const repeated = await patchSettings({ userId: '' }, `?userId=${NAMED_IN_QUERY}&userId=${NAMED_IN_BODY}`)
    expect(repeated.statusCode, repeated.body).toBe(200)

    expect((await getSettings()).json().data, 'an id that names nobody did not land on the default user')
      .toMatchObject({ morningStart: '07:00', morningEnd: '08:00' })

    const [ids, message] = storedIdsDiff(store === 'sql' ? [DEFAULT_USER_ID] : [], 'user_settings')
    expect(await storedUserIds('user_settings'), message).toEqual(ids)
  })

  it('类审计：关注线路的读与写走的是同一套解析', async () => {
    const lineId = api.fixtureId('line')
    const created = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: {
        userId: NAMED_IN_BODY,
        cityCode: '027',
        lineId,
        lineName: '夹具线路',
        reverseLineId: `${lineId}-r`,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const createdId = created.json().data.id as string

    const mine = await api.inject({ method: 'GET', url: `/api/transit/favorites?userId=${NAMED_IN_BODY}` })
    expect(mine.json().data.map((row: { id: string }) => row.id), 'the write is invisible to its own read')
      .toEqual([createdId])
    const theirs = await api.inject({ method: 'GET', url: `/api/transit/favorites?userId=${NAMED_IN_QUERY}` })
    expect(theirs.json().data, 'one user\'s favourite was listed for another user').toEqual([])

    const [ids, message] = storedIdsDiff(store === 'sql' ? [NAMED_IN_BODY] : [], 'user_favorite_lines')
    expect(await storedUserIds('user_favorite_lines'), message).toEqual(ids)
  })

  it('类审计：通勤链路的读与写走的是同一套解析', async () => {
    const created = await api.inject({
      method: 'POST',
      url: '/api/transit/commute-chains',
      payload: {
        userId: NAMED_IN_QUERY,
        name: '夹具链路',
        purpose: 'morning',
        // 还没选站：不花任何上游读取，也就不必桩上游。
        legs: [{
          lineId: '010-2-0',
          lineName: '2路',
          cityCode: '027',
          boardStationName: null,
          boardStationOrder: null,
          alightStationName: null,
          alightStationOrder: null,
          transferExtraMinutes: null,
          connectionMode: null,
        }],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const chainId = created.json().data.id as string

    const mine = await api.inject({ method: 'GET', url: `/api/transit/commute-chains?userId=${NAMED_IN_QUERY}` })
    expect(mine.json().data.map((chain: { id: string }) => chain.id)).toEqual([chainId])
    const theirs = await api.inject({ method: 'GET', url: `/api/transit/commute-chains?userId=${NAMED_IN_BODY}` })
    expect(theirs.json().data, 'one user\'s chain was listed for another user').toEqual([])

    const [ids, message] = storedIdsDiff(store === 'sql' ? [NAMED_IN_QUERY] : [], 'commute_chains')
    expect(await storedUserIds('commute_chains'), message).toEqual(ids)
  })
})
