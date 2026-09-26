import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@real-time-transport/shared'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F8 置顶：一人同时只能有一条，取消后那条落回**自己**在顺序里的位置。
 *
 * 三件事各自独立，因此各自成例：同时只能一条（第二条顶掉第一条）、置顶是状态而不是位置
 * （不动任何 `display_order`）、取消置顶不产生新位置（回它自己的槽，既不是插到头也不是落到尾）。
 *
 * 同一份主体对内存与 SQL 各跑一遍：两条路径的「只有一条」由不同的东西保证 —— SQL 是
 * `is_pinned` 上的部分唯一索引加先清后置，内存是 `setPinned` 自己清。索引本身是数据库对象，
 * 与哪条存储路径无关，放在文件末尾单独验证。
 *
 * 夹具一律带 `reverseLineId`：缺它的行会触发读侧的反方向解析，那是一次上游调用，与本文件无关。
 */

const CITY_CODE = '027'

describeEachStore('F8 置顶', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  async function follow(label: string, displayOrder: number, userId?: string): Promise<string> {
    const lineId = api.fixtureId(label)
    const res = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: {
        cityCode: CITY_CODE,
        lineId,
        lineName: `夹具线路-${label}`,
        reverseLineId: `${lineId}-r`,
        displayOrder,
        ...(userId ? { userId } : {}),
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    return String((res.json() as { data: UserFavoriteLine }).data.id)
  }

  async function pinned(id: string, isPinned: boolean, userId?: string): Promise<UserFavoriteLine> {
    const res = await api.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${id}${userId ? `?userId=${userId}` : ''}`,
      payload: { isPinned },
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: UserFavoriteLine }).data
  }

  async function ids(userId?: string): Promise<string[]> {
    const res = await api.inject({
      method: 'GET',
      url: `/api/transit/favorites${userId ? `?userId=${userId}` : ''}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: UserFavoriteLine[] }).data.map(f => String(f.id))
  }

  /** 每个 id 自己的位置，与列表顺序无关 —— 置顶会改列表顺序，但它不该改这些值。 */
  async function ordersById(): Promise<Record<string, number>> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/favorites' })
    const rows = (res.json() as { data: UserFavoriteLine[] }).data
    return Object.fromEntries(rows.map(f => [String(f.id), f.displayOrder]))
  }

  /** 库里真的被标为置顶的行。内存路径一行都不该有，两种答案都是断言。 */
  async function pinnedRows(userId: string = DEFAULT_USER_ID): Promise<Array<{ id: string }>> {
    return api.rows<{ id: string }>(
      'SELECT id FROM user_favorite_lines WHERE user_id = $1 AND is_pinned ORDER BY created_at',
      [userId],
    )
  }

  it('置顶后它排第一，且只有它被标为置顶', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)
    const c = await follow('c', 2)

    const patched = await pinned(b, true)
    expect(patched.isPinned).toBe(true)

    expect(await ids()).toEqual([b, a, c])
    expect(await pinnedRows()).toHaveLength(store === 'sql' ? 1 : 0)
  })

  it('置顶第二条会顶掉第一条：永远只有一条', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)

    await pinned(a, true)
    await pinned(b, true)

    const res = await api.inject({ method: 'GET', url: '/api/transit/favorites' })
    const rows = (res.json() as { data: UserFavoriteLine[] }).data
    expect(rows.map(f => f.id)).toEqual([b, a])
    expect(rows.filter(f => f.isPinned).map(f => f.id)).toEqual([b])
    // 存储里同样只有一条置顶：应用层的「先清后置」漏掉时，数据库这边会露出来。
    expect(await pinnedRows()).toHaveLength(store === 'sql' ? 1 : 0)
  })

  it('取消置顶后回到它自己的槽：中间的回到中间', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)
    const c = await follow('c', 2)

    await pinned(b, true)
    expect(await ids()).toEqual([b, a, c])

    await pinned(b, false)
    // 插到头会给 [b, a, c]，落到尾会给 [a, c, b]。
    expect(await ids()).toEqual([a, b, c])
    expect(await pinnedRows()).toHaveLength(0)
  })

  it('置顶不改动任何 display_order', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)
    const c = await follow('c', 2)

    const before = await ordersById()
    await pinned(b, true)
    expect(await ordersById()).toEqual(before)
    expect(before[b]).toBe(1)

    await pinned(b, false)
    expect(await ordersById()).toEqual(before)

    if (store === 'sql') {
      const rows = await api.rows<{ id: string, display_order: number }>(
        'SELECT id, display_order FROM user_favorite_lines ORDER BY display_order',
      )
      expect(rows.map(r => [r.id, r.display_order])).toEqual([[a, 0], [b, 1], [c, 2]])
    }
  })

  it('每个用户各有各的置顶：给一个用户置顶不会清掉另一个用户的', async () => {
    const mine = await follow('mine', 0)
    const theirs = await follow('theirs', 0, 'fixture-user-b')

    await pinned(mine, true)
    await pinned(theirs, true, 'fixture-user-b')

    expect(await ids()).toEqual([mine])
    expect(await ids('fixture-user-b')).toEqual([theirs])
    if (store === 'sql') {
      expect(await pinnedRows()).toHaveLength(1)
      expect(await pinnedRows('fixture-user-b')).toHaveLength(1)
    }
  })
})

/**
 * 「同时只能一条」的兜底是 `is_pinned` 上的部分唯一索引（`006`），它挡住任何绕过应用层
 * 先清后置的写入 —— 并发关注、或将来某个忘记先清的调用方。索引是数据库对象，因此这里直接
 * 对表写，不经 app：两条存储路径在这一层没有区别。
 */
describe('F8：部分唯一索引拒绝第二个置顶', () => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store: 'sql' })
  })

  afterEach(async () => {
    await api?.close()
  })

  async function insertRow(label: string, isPinned: boolean, userId: string = DEFAULT_USER_ID): Promise<string> {
    const rows = await api.rows<{ id: string }>(
      `INSERT INTO user_favorite_lines (user_id, city_code, line_id, line_name, is_pinned)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, CITY_CODE, api.fixtureId(label), `夹具线路-${label}`, isPinned],
    )
    return rows[0]!.id
  }

  async function pinnedIds(userId: string = DEFAULT_USER_ID): Promise<string[]> {
    const rows = await api.rows<{ id: string }>(
      'SELECT id FROM user_favorite_lines WHERE user_id = $1 AND is_pinned',
      [userId],
    )
    return rows.map(row => row.id)
  }

  it('同一用户插入第二条置顶被拒（23505），第一条不受影响', async () => {
    const first = await insertRow('first', true)

    await expect(insertRow('second', true)).rejects.toMatchObject({ code: '23505' })

    expect(await pinnedIds()).toEqual([first])
  })

  it('把已存在的行改成置顶同样被拒，它保持未置顶', async () => {
    await insertRow('first', true)
    const second = await insertRow('second', false)

    await expect(
      api.rows('UPDATE user_favorite_lines SET is_pinned = TRUE WHERE id = $1', [second]),
    ).rejects.toMatchObject({ code: '23505' })

    const rows = await api.rows<{ is_pinned: boolean }>(
      'SELECT is_pinned FROM user_favorite_lines WHERE id = $1',
      [second],
    )
    expect(rows[0]!.is_pinned).toBe(false)
  })

  it('约束按用户划域：另一个用户的置顶不受影响', async () => {
    const mine = await insertRow('mine', true)
    const theirs = await insertRow('theirs', true, 'fixture-user-b')

    expect(await pinnedIds()).toEqual([mine])
    expect(await pinnedIds('fixture-user-b')).toEqual([theirs])
  })
})
