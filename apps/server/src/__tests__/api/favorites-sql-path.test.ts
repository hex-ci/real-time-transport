import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 地基是否真的在跑 SQL：同一条关注走 HTTP 边界写进去，再用**裸 pg** 从测试库里读出来。
 *
 * 同一份主体对内存实现与 SQL 实现各跑一遍，差分断言就是那句「这一遍走的是哪条路」：
 * SQL 路径下库里必须真有那一行，内存路径下库里必须一行都没有（后者同时是「内存路径没在
 * 偷偷连库」的钉子）。只跑 SQL 一遍，这条用例就证明不了它与内存版本有区别。
 *
 * `app.inject()` 意味着没有端口、没有真实网络；上游一律桩掉，未桩的调用直接抛错。
 */
describeEachStore('关注一条线路：库里那一行', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  // 类型上 `api` 一定在；`?.` 是给「beforeEach 自己失败」这一种运行时刻留的余地 ——
  // 那种情况下不该再叠一个 TypeError 把真正的原因埋掉。
  afterEach(async () => {
    await api?.close()
  })

  /** 夹具 id 带本实例的统一前缀：一眼可辨是这一次跑出来的行，收尾按 id 精确删。 */
  function fixture() {
    const lineId = api.fixtureId('line')
    return { lineId, lineName: `夹具线路-${lineId}`, reverseLineId: `${lineId}-r` }
  }

  it('关注写入存储，取消关注把它抹掉', async () => {
    const fav = fixture()

    const added = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { cityCode: '027', ...fav, preferredDirection: 0 },
    })
    expect(added.statusCode, added.body).toBe(200)
    const favoriteId = (added.json() as { data: { id: string } }).data.id

    // 裸 pg 不认识 app 的读映射：这一行真的在库里，只有 SQL 路径能通过。
    const afterAdd = await api.rows<{ id: string, line_name: string }>(
      'SELECT id, line_name FROM user_favorite_lines WHERE id = $1',
      [favoriteId],
    )
    expect(
      afterAdd,
      store === 'sql' ? '关注没有落到库里' : '内存路径不该在库里留下行',
    ).toHaveLength(store === 'sql' ? 1 : 0)
    if (store === 'sql') expect(afterAdd[0]!.line_name).toBe(fav.lineName)

    const list = await api.inject({ method: 'GET', url: '/api/transit/favorites' })
    expect(list.statusCode, list.body).toBe(200)
    const listed = (list.json() as { data: { lineId: string }[] }).data
    expect(listed.map(f => f.lineId)).toContain(fav.lineId)

    const removed = await api.inject({
      method: 'DELETE',
      url: `/api/transit/favorites/${favoriteId}`,
    })
    expect(removed.statusCode, removed.body).toBe(200)

    const afterRemove = await api.rows('SELECT id FROM user_favorite_lines WHERE id = $1', [favoriteId])
    expect(afterRemove).toHaveLength(0)
  })

  it('上游一次都没被调用', async () => {
    const fav = fixture()
    await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { cityCode: '027', ...fav },
    })
    expect(api.upstream).not.toHaveBeenCalled()
  })

  it('每例开始前测试库是空的', async () => {
    expect(await api.rows('SELECT id FROM user_favorite_lines')).toHaveLength(0)
    expect(await api.rows('SELECT id FROM commute_chains')).toHaveLength(0)
  })

  it('夹具可以按 id 精确删，删的是自己那一行', async () => {
    const fav = fixture()
    const added = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { cityCode: '027', ...fav },
    })
    const favoriteId = (added.json() as { data: { id: string } }).data.id

    expect(await api.removeRows('user_favorite_lines', [favoriteId])).toBe(store === 'sql' ? 1 : 0)
    expect(await api.rows('SELECT id FROM user_favorite_lines WHERE id = $1', [favoriteId])).toHaveLength(0)
  })
})

describe('harness 本身', () => {
  it('测试库那一行就是 transit_test', async () => {
    const api = await createApiHarness({ store: 'sql' })
    try {
      const rows = await api.rows<{ current_database: string }>('SELECT current_database()')
      expect(rows[0]!.current_database.endsWith('_test')).toBe(true)
    }
    finally {
      await api.close()
    }
  })
})
