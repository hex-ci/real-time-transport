import { afterEach, beforeEach, expect, it } from 'vitest'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F9 拖动排序：顺序就是存储的 `display_order`，读侧按
 * `is_pinned DESC, display_order ASC, created_at ASC` 收敛。
 *
 * 四件事各自成例：写进去的顺序就是读出来的顺序；同一个位置上并列的两条按关注先后分开
 * （关注时刻是决胜档，不是 `Array#sort` 的稳定性）；置顶只占第一关键字、不占位置；
 * `0` 是一个真位置，不是「没给值」。
 *
 * 写侧与读侧都断言：只看读侧，一条从不写存储的实现在内存路径上也会绿。
 *
 * 夹具一律带 `reverseLineId`：缺它的行会触发读侧的反方向解析，那是一次上游调用。
 */

const CITY_CODE = '027'

describeEachStore('F9 关注列表的顺序', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  async function follow(label: string, displayOrder: number): Promise<string> {
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
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    return String((res.json() as { data: UserFavoriteLine }).data.id)
  }

  async function reorder(id: string, displayOrder: number) {
    const res = await api.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${id}`,
      payload: { displayOrder },
    })
    expect(res.statusCode, res.body).toBe(200)
    return res
  }

  async function setPinned(id: string, isPinned: boolean) {
    const res = await api.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${id}`,
      payload: { isPinned },
    })
    expect(res.statusCode, res.body).toBe(200)
    return res
  }

  /** 首页读到的 id 顺序 —— 这正是排序收敛的答案。 */
  async function ids(): Promise<string[]> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/favorites' })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: UserFavoriteLine[] }).data.map(f => String(f.id))
  }

  it('拖动后的顺序就是读出来的顺序，存储里也是那一份', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)
    const c = await follow('c', 2)

    // 拖成 c, a, b：整份列表按位置重写，没有一条被豁免。
    await reorder(c, 0)
    await reorder(a, 1)
    await reorder(b, 2)
    expect(await ids()).toEqual([c, a, b])

    if (store === 'sql') {
      const rows = await api.rows<{ id: string, display_order: number }>(
        'SELECT id, display_order FROM user_favorite_lines ORDER BY display_order',
      )
      expect(rows.map(r => [r.id, r.display_order])).toEqual([[c, 0], [a, 1], [b, 2]])
    }
  })

  it('位置相同的两条按关注先后收敛', async () => {
    const first = await follow('first', 0)
    const second = await follow('second', 0)
    const third = await follow('third', 0)

    expect(await ids()).toEqual([first, second, third])

    // 三条都写回 0：位置仍然并列，顺序只能由关注时刻决定。
    await reorder(first, 0)
    await reorder(second, 0)
    await reorder(third, 0)
    expect(await ids()).toEqual([first, second, third])
  })

  it('0 是一个真位置，不是「没给值」', async () => {
    const a = await follow('a', 1)
    const b = await follow('b', 0)
    expect(await ids()).toEqual([b, a])

    await reorder(a, 0)
    expect(await ids()).toEqual([a, b])

    if (store === 'sql') {
      const rows = await api.rows<{ display_order: number }>(
        'SELECT display_order FROM user_favorite_lines WHERE id = $1',
        [a],
      )
      expect(rows[0]!.display_order).toBe(0)
    }
  })

  it('置顶占第一关键字，位置仍管其余的那些', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)
    const c = await follow('c', 2)

    // c 在位置最后，置顶把它提到最前；a、b 的相对顺序不受影响。
    await setPinned(c, true)
    expect(await ids()).toEqual([c, a, b])

    await setPinned(c, false)
    expect(await ids()).toEqual([a, b, c])
  })

  it('负数位置被拒（400），那一行保持原样', async () => {
    const a = await follow('a', 0)
    const b = await follow('b', 1)

    const rejected = await api.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${b}`,
      payload: { displayOrder: -1 },
    })
    expect(rejected.statusCode, rejected.body).toBe(400)

    expect(await ids()).toEqual([a, b])
  })
})
