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
    // No fake seed injection: unknown lines must return an empty array, never fabricated results
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
    // Beijing must be present and hot
    const beijing = json.data.find((c: any) => c.code === '027')
    expect(beijing).toBeTruthy()
    expect(beijing.name).toBe('北京')
    expect(beijing.hot).toBe(true)
    await app.close()
  })
})
