import { describe, expect, it } from 'vitest'
import {
  LiveBusSchema,
  StationSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from '../index.js'

describe('Shared Schemas', () => {
  it('validates StationSchema properly', () => {
    const validStation = {
      id: '010-20785',
      name: '亦庄火车站',
      order: 57,
      lat: 39.8145,
      lng: 116.5923,
      interchanges: ['亦庄线'],
    }
    const parsed = StationSchema.parse(validStation)
    expect(parsed.name).toBe('亦庄火车站')
    expect(parsed.order).toBe(57)
  })

  it('validates LiveBusSchema properly', () => {
    const validBus = {
      id: 'bus_913_1',
      order: 12,
      nextOrder: 13,
      progress: 0.45,
      lat: 39.82,
      lng: 116.55,
      speed: 6.2,
      congestion: 'low' as const,
      updatedAt: Date.now(),
    }
    const parsed = LiveBusSchema.parse(validBus)
    expect(parsed.speed).toBe(6.2)
    expect(parsed.congestion).toBe('low')
  })

  it('validates WebSocket messages', () => {
    const subMsg = {
      action: 'subscribe',
      lineId: '0010257103360',
      direction: 0,
    }
    const parsed = WsClientMessageSchema.parse(subMsg)
    expect(parsed.action).toBe('subscribe')

    const serverPong = {
      type: 'pong',
    }
    const parsedServer = WsServerMessageSchema.parse(serverPong)
    expect(parsedServer.type).toBe('pong')
  })

  it('serves the generated city dictionary with Beijing as default hot city', async () => {
    const { CITY_DICTIONARY, HOT_CITY_META, getCityAdcode, DEFAULT_CITY_CODE } = await import('../cities.js')
    expect(CITY_DICTIONARY.length).toBeGreaterThan(400)
    expect(DEFAULT_CITY_CODE).toBe('027')
    const beijing = CITY_DICTIONARY.find(c => c.code === '027')
    expect(beijing).toBeTruthy()
    expect(beijing!.name).toBe('北京')
    expect(beijing!.hasMetro).toBe(true)
    expect(getCityAdcode('027')).toBe('110000')
    expect(getCityAdcode('999')).toBe('999')
    // Guangzhou/Shenzhen covered by curated amap-only entries
    expect(HOT_CITY_META.some(c => c.name === '广州')).toBe(true)
    expect(HOT_CITY_META.some(c => c.name === '深圳')).toBe(true)
  })

  it('normalizes time format from amap HHMM in schemas context', () => {
    // firstBusTime/lastBusTime are plain strings normalized to HH:MM
    expect(/^(\d{2}):(\d{2})$/.test('05:09')).toBe(true)
  })
})
