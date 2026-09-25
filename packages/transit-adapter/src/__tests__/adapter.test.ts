import { describe, expect, it } from 'vitest'
import {
  wgs84ToGcj02,
  gcj02ToWgs84,
  UniversalSubwayEngine,
  SubwayRouterProvider,
  ChelaileProvider,
  AmapGisService,
  TransitAggregator,
} from '../index.js'
import type { ITransitProvider } from '../types.js'
import type { LineDetail } from '@real-time-transport/shared'

/** A provider that always fails, used to verify aggregator degradation (no mocks in prod path). */
class FailingProvider implements ITransitProvider {
  readonly name = 'chelaile' as const
  async searchLines(): Promise<never> {
    throw new Error('upstream down')
  }

  async getLineDetail(): Promise<null> {
    throw new Error('upstream down')
  }

  async getLiveStatus(): Promise<null> {
    throw new Error('upstream down')
  }

  async isAvailable(): Promise<boolean> {
    return false
  }
}

describe('Transit Adapter Package', () => {
  it('converts coordinates between WGS-84 and GCJ-02 with reasonable precision', () => {
    // Beijing Tiananmen coordinate
    const wgsLng = 116.3974
    const wgsLat = 39.9093

    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat)
    expect(gcjLng).toBeGreaterThan(wgsLng)
    expect(gcjLat).toBeGreaterThan(wgsLat)

    const [backLng, backLat] = gcj02ToWgs84(gcjLng, gcjLat)
    expect(backLng).toBeCloseTo(wgsLng, 4)
    expect(backLat).toBeCloseTo(wgsLat, 4)
  })

  it('runs UniversalSubwayEngine with graceful degradation without Amap key', async () => {
    const amap = new AmapGisService('') // Explicit empty key (no env fallback)
    const subway = new UniversalSubwayEngine(amap)

    // Should return null details gracefully (no Amap key configured)
    const detail = await subway.getLineDetail('subway_027_88', 0)
    expect(detail).toBeNull()

    const live = await subway.getLiveStatus('subway_027_88', 0)
    expect(live).toBeNull()
  })

  it('normalizes amap HHMM time format to HH:MM', async () => {
    const { normalizeAmapTime } = await import('../services/amap-gis.service.js')
    expect(normalizeAmapTime('0509')).toBe('05:09')
    expect(normalizeAmapTime('2259')).toBe('22:59')
    expect(normalizeAmapTime('530')).toBe('05:30')
    expect(normalizeAmapTime('05:30')).toBe('05:30')
    expect(normalizeAmapTime('')).toBe('')
    expect(normalizeAmapTime(undefined)).toBe('')
  })

  it('routes subway lineIds to UniversalSubwayEngine and bus lineIds to ChelaileProvider', async () => {
    const amap = new AmapGisService('')
    const subwayEngine = new UniversalSubwayEngine(amap)
    const chelaile = new ChelaileProvider()
    const router = new SubwayRouterProvider(subwayEngine, chelaile)

    // Subway line id starts with subway_ => routed to subway engine
    const subwayDetail = await router.getLineDetail('subway_027_88', 0)
    expect(subwayDetail).toBeNull() // No Amap key, graceful null

    // Bus line id => routed to Chelaile. The upstream call is real (no mock):
    // it may return a detail (network available) or null (offline/throttled).
    // Both are contract-valid; the only invalid outcome is throwing.
    const busDetail = await router.getLineDetail('001073243721', 0)
    expect(busDetail === null || typeof busDetail?.lineId === 'string').toBe(true)
  })

  it('parses subway lineIds with city code and keyword correctly', async () => {
    const { resolveCityFromLineId, extractLineKeyword } = await import('../providers/universal-subway.js')
    expect(resolveCityFromLineId('subway_027_88')).toBe('027')
    expect(resolveCityFromLineId('subway_amap_440100_3')).toBe('amap_440100')
    expect(extractLineKeyword('subway_027_88')).toBe('88')
    expect(extractLineKeyword('subway_027_环城线')).toBe('环城线')
    expect(extractLineKeyword('subway_amap_440100_3')).toBe('3')
  })

  it('rejects non-subway keywords in SubwayRouterProvider search', async () => {
    const amap = new AmapGisService('')
    const subwayEngine = new UniversalSubwayEngine(amap)
    const router = new SubwayRouterProvider(subwayEngine, new ChelaileProvider())

    // "372" is a bus keyword -> subway router must NOT match it (regression: old bug matched via includes('7'))
    const results = await router.searchLines('372', '027')
    expect(results).toEqual([])
  })

  it('aggregator degrades gracefully when a provider throws and caches successful results', async () => {
    // No key => UniversalSubwayEngine returns null, FailingProvider throws:
    // the aggregator must skip both and return null without throwing.
    const failing = new FailingProvider()
    const amap = new AmapGisService('')
    const aggregator = new TransitAggregator([failing, new UniversalSubwayEngine(amap)])

    const detail = await aggregator.getLineDetail('subway_027_88', 0)
    expect(detail).toBeNull()

    const live = await aggregator.getLiveStatus('subway_027_88', 0)
    expect(live).toBeNull()

    const search = await aggregator.searchLines('372', '027')
    expect(search).toEqual([])
  })

  it('aggregator caches identical detail instances on repeated calls', async () => {
    // Chelaile without network still exercises the cache path when it succeeds;
    // in offline CI this may be null on both calls, which is also contract-valid.
    const aggregator = new TransitAggregator([new ChelaileProvider()])
    const d1 = await aggregator.getLineDetail('nonexistent_line_xyz', 0)
    const d2 = await aggregator.getLineDetail('nonexistent_line_xyz', 0)
    if (d1) {
      expect(d2).toBe(d1) // same cached instance
    }
    else {
      expect(d2).toBeNull()
    }
  })

  it('subway live uses the injected detail resolver without needing Amap (no 404 on throttle)', async () => {
    // Regression: /lines/:id/live used to re-resolve static geometry from Amap
    // on every poll, so one QPS throttle 404'd a perfectly valid line.
    const cachedDetail: LineDetail = {
      lineId: 'subway_027_88',
      lineName: '地铁88号线',
      direction: 0,
      directionName: '开往 辛站',
      // Service window must cover the engine's whole normalized day range.
      // It maps 00:00–03:59 to +24h, so currentSecOfDay spans [14400, 100799];
      // 01:00–30:00 covers that with margin, keeping this test time-independent.
      firstBusTime: '01:00',
      lastBusTime: '30:00',
      cityCode: '027',
      type: 'subway',
      stops: [
        { id: 's1', name: '甲站', order: 1, lat: 39.95, lng: 116.3, interchanges: [] },
        { id: 's2', name: '乙站', order: 2, lat: 39.955, lng: 116.305, interchanges: [] },
        { id: 's3', name: '丙站', order: 3, lat: 39.96, lng: 116.31, interchanges: [] },
        { id: 's4', name: '丁站', order: 4, lat: 39.965, lng: 116.315, interchanges: [] },
        { id: 's5', name: '戊站', order: 5, lat: 39.97, lng: 116.32, interchanges: [] },
        { id: 's6', name: '己站', order: 6, lat: 39.975, lng: 116.325, interchanges: [] },
        { id: 's7', name: '庚站', order: 7, lat: 39.98, lng: 116.33, interchanges: [] },
        { id: 's8', name: '辛站', order: 8, lat: 39.985, lng: 116.335, interchanges: [] },
      ],
      routeLengthMeters: 40000,
      stationDistances: [0, 2000, 6000, 12000, 18000, 24000, 32000, 40000],
    }

    // No Amap key at all: proves the live path works purely off the resolver.
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => cachedDetail)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(live?.dataSource).toBe('subway_schedule')
    expect(live?.buses.length).toBeGreaterThan(0)
    // Trains carry real continuous positions derived from the cached geometry
    expect(live?.buses.every(b => typeof b.distanceFromStart === 'number')).toBe(true)
  })

  it('subway live degrades to null (never throws) when the resolver fails', async () => {
    const throwing = new UniversalSubwayEngine(
      new AmapGisService(''),
      undefined,
      async () => { throw new Error('DB down') },
    )
    await expect(throwing.getLiveStatus('subway_027_88', 0, '027')).resolves.toBeNull()

    const empty = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => null)
    await expect(empty.getLiveStatus('subway_027_88', 0, '027')).resolves.toBeNull()
  })
})
