import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'

describe('Server Application', () => {
  it('responds to health check', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.status).toBe('ok')
    await app.close()
  })

  it('search endpoint returns contract-valid response without hardcoded seeds', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/lines/search?keyword=zzz_no_such_line',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    // 不做假种子注入：未知线路必须返回空数组，绝不返回编造的结果
    expect(json.success).toBe(true)
    expect(json.data).toEqual([])
    await app.close()
  })

  it('fetches commute profile', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/commute-profile',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(['work', 'home', 'auto']).toContain(json.data.mode)
    await app.close()
  })

  it('walk-eta endpoint validates required params', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/gis/walk-eta',
    })
    expect(res.statusCode).toBe(400)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(false)
    await app.close()
  })

  it('nearby-stations endpoint validates required params', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/gis/nearby-stations',
    })
    expect(res.statusCode).toBe(400)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(false)
    await app.close()
  })

  it('regeo endpoint validates required params', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/gis/regeo',
    })
    expect(res.statusCode).toBe(400)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(false)
    await app.close()
  })

  it('walk-decision endpoint validates required params', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/gis/walk-decision',
    })
    expect(res.statusCode).toBe(400)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(false)
    await app.close()
  })

  it('serves the multi-city dictionary', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/cities',
    })
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.success).toBe(true)
    expect(Array.isArray(json.data)).toBe(true)
    expect(json.data.length).toBeGreaterThan(100)
    const beijing = json.data.find((c: any) => c.code === '027')
    expect(beijing).toBeTruthy()
    expect(beijing.name).toBe('北京')
    expect(beijing.hot).toBe(true)
    await app.close()
  })

  it('PATCH /favorites/:id accepts displayOrder on its own', async () => {
    const app = await buildApp()
    const created = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { userId: 'default_user', cityCode: '027', lineId: '010-1-0', lineName: '1' },
    })).body).data

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${created.id}`,
      payload: { displayOrder: 3 },
    })

    // 只写 order 的 PATCH 没有上车点可写，这不该 404。
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.displayOrder).toBe(3)
    await app.close()
  })

  it('PATCH /favorites/:id accepts isPinned on its own', async () => {
    const app = await buildApp()
    const created = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { userId: 'default_user', cityCode: '027', lineId: '010-52-0', lineName: '52' },
    })).body).data

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${created.id}`,
      payload: { isPinned: true },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.isPinned).toBe(true)
    await app.close()
  })

  it('PATCH /favorites/:id rejects a negative displayOrder', async () => {
    const app = await buildApp()
    const created = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/transit/favorites',
      payload: { userId: 'default_user', cityCode: '027', lineId: '010-300-0', lineName: '300' },
    })).body).data

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/transit/favorites/${created.id}`,
      payload: { displayOrder: -1 },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
