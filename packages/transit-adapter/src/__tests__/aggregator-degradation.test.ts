import { describe, expect, it } from 'vitest'
import {
  AmapGisService,
  ApizeroProvider,
  ChelaileProvider,
  SubwayRouterProvider,
  TransitAggregator,
  UniversalSubwayEngine,
} from '../index.js'
import type { ITransitProvider } from '../types.js'
import type { DataSourceType, LineDetail, LiveLineStatus } from '@real-time-transport/shared'

/**
 * provider 说的是「它自己答案」的性质。
 *
 * 这个值不带位置也不带排名：唯一能作答的来源给出的答案是 `false`，
 * 作为他源替代品作答的 provider 声明的才是 `true`。聚合层的契约就是
 * 原样报告这条声明 —— 由列表位置推导会标错用户看到的读数。
 */
function reading(params: { dataSource: DataSourceType, isDegraded: boolean }): LiveLineStatus {
  return {
    lineId: 'scripted',
    direction: 0,
    buses: [],
    dataSource: params.dataSource,
    isDegraded: params.isDegraded,
    updatedAt: Date.now(),
  }
}

class ScriptedProvider implements ITransitProvider {
  readonly name: DataSourceType
  private readonly answer: LiveLineStatus | null

  constructor(name: DataSourceType, answer: LiveLineStatus | null) {
    this.name = name
    this.answer = answer
  }

  async searchLines(): Promise<[]> {
    return []
  }

  async getLineDetail(): Promise<LineDetail | null> {
    return null
  }

  async getLiveStatus(): Promise<LiveLineStatus | null> {
    return this.answer
  }

  async isAvailable(): Promise<boolean> {
    return true
  }
}

/**
 * 服务窗口覆盖引擎归一化后整个日范围的线路详情，使下面的读数与
 * 真实时钟无关（引擎把 00:00–03:59 映射到 +24h）。
 */
const SUBWAY_DETAIL: LineDetail = {
  lineId: 'subway_027_88',
  lineName: '地铁88号线',
  direction: 0,
  directionName: '开往 辛站',
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

describe('TransitAggregator: degradation is the answering provider\'s own declaration', () => {
  it('does not mark a subway reading degraded just because a later provider answered it', async () => {
    // 地铁 id 只由地铁引擎回答：车来了自己的 `getLiveStatus` 直接拒绝
    // 每一个 `subway_*` id，所以位置 1 的路由器是唯一能回答该线路的来源 ——
    // 它是主来源而非替代品，引擎也如此声明。这里报 `true` 会把一条排班
    // 推演的读数在链路里标成「备用来源」。
    const aggregator = new TransitAggregator([
      new ScriptedProvider('chelaile', null),
      new ScriptedProvider('subway_schedule', reading({ dataSource: 'subway_schedule', isDegraded: false })),
    ])

    const status = await aggregator.getLiveStatus('subway_027_1', 0, '027')

    expect(status?.dataSource).toBe('subway_schedule')
    expect(status?.isDegraded).toBe(false)
  })

  it('reports the real provider chain\'s subway reading as not degraded', async () => {
    // 同一句话，走服务端真正搭出来的接线：chelaile、地铁路由器与 apizero，
    // 引擎由注入的详情 resolver 驱动，因此不触达任何上游。
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => SUBWAY_DETAIL)
    const chelaile = new ChelaileProvider()
    const aggregator = new TransitAggregator([
      chelaile,
      new SubwayRouterProvider(engine, chelaile),
      new ApizeroProvider(undefined),
    ])

    const status = await aggregator.getLiveStatus('subway_027_88', 0, '027')

    expect(status?.dataSource).toBe('subway_schedule')
    expect(status?.isDegraded).toBe(false)
  })

  it('keeps a genuine fallback degraded when a later provider answers as a stand-in', async () => {
    // apizero 是真正的兜底：只在车来了被限流时替公交线路作答，并且它
    // 自己的 `getLiveStatus` 就此声明（`isDegraded: true`）。按声明而不是
    // 按下标取这个标志，不能把它降级 —— 这句话在这里是真的。
    const aggregator = new TransitAggregator([
      new ScriptedProvider('chelaile', null),
      new ScriptedProvider('apizero', reading({ dataSource: 'apizero', isDegraded: true })),
    ])

    const status = await aggregator.getLiveStatus('010-52-0', 0, '027')

    expect(status?.dataSource).toBe('apizero')
    expect(status?.isDegraded).toBe(true)
  })

  it('reports a first-position provider\'s own degradation declaration unchanged', async () => {
    // 位置无关的另一半：恰好在第一位的兜底答案，仍必须被报成兜底。
    // 列表顺序不能抬高或压低这个标志。
    const aggregator = new TransitAggregator([
      new ScriptedProvider('apizero', reading({ dataSource: 'apizero', isDegraded: true })),
    ])

    const status = await aggregator.getLiveStatus('010-1-1', 0, '027')

    expect(status?.isDegraded).toBe(true)
  })
})
