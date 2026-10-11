import { afterEach, beforeEach, expect, it } from 'vitest'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F1 · 关注站（015 的四列）：按方向各存一对 (站名, 站序)，与时段无关。
 *
 * 站的身份是**一对**，不是一个名字：上下行的站名经常不同（路口东 / 路口西），环线还有同名多站，
 * 故站名与站序必须一起给出、一起清空（契约见 `UpdateFavoriteSchema` 的四条 refine）。
 * 这一层唯一能证明「真的落到 SQL 上」的地方是 `api.rows`：读路径经服务端映射，与写路径同源，
 * 两边一起错会互相掩盖。
 *
 * 夹具一律带 `reverseLineId`：缺它的行会触发读侧的反方向解析，那是一次上游调用，与本文件无关。
 */

const CITY_CODE = '027'

describeEachStore('F1 关注站', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /** 关注一条线路，返回它自己的行 id。 */
  async function follow(label: string): Promise<string> {
    const lineId = api.fixtureId(label)
    const res = await api.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: {
        cityCode: CITY_CODE,
        lineId,
        lineName: `夹具线路-${label}`,
        reverseLineId: `${lineId}-r`,
      },
    })
    expect(res.statusCode, res.body).toBe(200)
    return String((res.json() as { data: UserFavoriteLine }).data.id)
  }

  /** 写一次关注站（PATCH），返回响应。 */
  function patch(id: string, payload: Record<string, unknown>) {
    return api.inject({ method: 'PATCH', url: `/api/transit/favorites/${id}`, payload })
  }

  /** 读回这一行（GET 列表里按 id 找）。 */
  async function readBack(id: string): Promise<Record<string, unknown>> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/favorites' })
    expect(res.statusCode, res.body).toBe(200)
    const rows = (res.json() as { data: Record<string, unknown>[] }).data
    const found = rows.find(row => String(row.id) === id)
    if (!found) throw new Error(`读回的列表里没有 ${id}`)
    return found
  }

  it('两个方向各存一对，读回同一对；SQL 路径真的落在它自己的列上', async () => {
    const id = await follow('followed')

    const res = await patch(id, {
      followedStopName0: '甲路东口',
      followedStopOrder0: 12,
      followedStopName1: '甲路西口',
      followedStopOrder1: 0,
    })
    expect(res.statusCode, res.body).toBe(200)

    const row = await readBack(id)
    expect(row.followedStopName0).toBe('甲路东口')
    expect(row.followedStopOrder0).toBe(12)
    // 0 是一个真站序（010 的先例），不是「没给值」。
    expect(row.followedStopName1).toBe('甲路西口')
    expect(row.followedStopOrder1).toBe(0)

    const stored = await api.rows<{
      followed_station_name_0: string | null
      followed_station_order_0: number | null
      followed_station_name_1: string | null
      followed_station_order_1: number | null
    }>(
      `SELECT followed_station_name_0, followed_station_order_0,
              followed_station_name_1, followed_station_order_1
         FROM user_favorite_lines WHERE id = $1`,
      [id],
    )
    if (store === 'sql') {
      expect(stored).toHaveLength(1)
      expect(stored[0]!.followed_station_name_0).toBe('甲路东口')
      expect(stored[0]!.followed_station_order_0).toBe(12)
      expect(stored[0]!.followed_station_name_1).toBe('甲路西口')
      expect(stored[0]!.followed_station_order_1).toBe(0)
    }
    else {
      // 内存路径不该在库里留下任何行 —— 这是这一层存在的理由（两条存储路径各跑一遍）。
      expect(stored).toHaveLength(0)
    }
  })

  it('只写一个方向时，另一个方向保持原样', async () => {
    const id = await follow('one-direction')
    expect((await patch(id, { followedStopName0: '甲路东口', followedStopOrder0: 3 })).statusCode).toBe(200)
    expect((await patch(id, { followedStopName1: '甲路西口', followedStopOrder1: 4 })).statusCode).toBe(200)

    // 再改方向 0：方向 1 的那一对一动不能动。
    expect((await patch(id, { followedStopName0: '乙路东口', followedStopOrder0: 9 })).statusCode).toBe(200)

    const row = await readBack(id)
    expect(row.followedStopName0).toBe('乙路东口')
    expect(row.followedStopOrder0).toBe(9)
    expect(row.followedStopName1).toBe('甲路西口')
    expect(row.followedStopOrder1).toBe(4)
  })

  it('清空要成对：两列都传 null 才清得掉，读回时那一对是两个 null', async () => {
    const id = await follow('clear')
    expect((await patch(id, { followedStopName0: '甲路东口', followedStopOrder0: 5 })).statusCode).toBe(200)

    const cleared = await patch(id, { followedStopName0: null, followedStopOrder0: null })
    expect(cleared.statusCode, cleared.body).toBe(200)

    const row = await readBack(id)
    // 未设置读作**缺席**（不是 null）：与它旁边那两个上车点用同一种约定，一对里只有一种读法。
    expect(row.followedStopName0).toBeUndefined()
    expect(row.followedStopOrder0).toBeUndefined()
  })

  it('半对被拒：只给站名、或只给站序，都是 400，且原来那一对一动不动', async () => {
    const id = await follow('half-pair')
    expect((await patch(id, { followedStopName0: '甲路东口', followedStopOrder0: 5 })).statusCode).toBe(200)

    const nameOnly = await patch(id, { followedStopName0: '乙路东口' })
    expect(nameOnly.statusCode, nameOnly.body).toBe(400)
    const orderOnly = await patch(id, { followedStopOrder0: 7 })
    expect(orderOnly.statusCode, orderOnly.body).toBe(400)
    // 清一半也不行：那不是「清空」，是一对里少了一半。
    const halfClear = await patch(id, { followedStopName0: null })
    expect(halfClear.statusCode, halfClear.body).toBe(400)

    const row = await readBack(id)
    expect(row.followedStopName0).toBe('甲路东口')
    expect(row.followedStopOrder0).toBe(5)
  })

  it('站名成对校验对两个方向各管各的：方向 0 合法不替方向 1 兜底', async () => {
    const id = await follow('two-directions')

    const res = await patch(id, {
      followedStopName0: '甲路东口',
      followedStopOrder0: 5,
      followedStopOrder1: 6,
    })
    expect(res.statusCode, res.body).toBe(400)

    const row = await readBack(id)
    expect(row.followedStopName0).toBeUndefined()
    expect(row.followedStopOrder0).toBeUndefined()
  })
})
