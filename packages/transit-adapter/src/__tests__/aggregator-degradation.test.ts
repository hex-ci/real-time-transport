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
 * What a provider says about ITS OWN answer.
 *
 * The value carries no position and no rank: a provider that answered from the
 * only source capable of answering declares `false`, and a provider that
 * answered as a stand-in for another source declares `true`. The aggregator's
 * contract is to report this declaration — the flag feeds F4's provenance
 * decision and F10's reading-quality reason, so a value derived from list
 * position mislabels the reading the user is shown.
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

/** A provider that answers with a fixed reading, or declines with null. */
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
 * A subway detail whose service window covers the engine's whole normalized day
 * range, so the reading below exists whatever the wall clock says (the engine
 * maps 00:00–03:59 to +24h, so currentSecOfDay spans [14400, 100799]).
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
    // A subway id is answered by the subway engine and by nothing else: the
    // chelaile provider's own `getLiveStatus` declines every `subway_*` id
    // outright, so the router in position 1 is the ONLY source that can answer
    // this line. That makes its answer the primary one, and the engine declares
    // it so (`isDegraded: false` on the status `UniversalSubwayEngine`'s
    // `getLiveStatus` returns). Reporting `true` here is how a schedule-derived
    // reading gets labelled 「备用来源」 in the chain.
    const aggregator = new TransitAggregator([
      new ScriptedProvider('chelaile', null),
      new ScriptedProvider('subway_schedule', reading({ dataSource: 'subway_schedule', isDegraded: false })),
    ])

    const status = await aggregator.getLiveStatus('subway_027_1', 0, '027')

    expect(status?.dataSource).toBe('subway_schedule')
    expect(status?.isDegraded).toBe(false)
  })

  it('reports the real provider chain\'s subway reading as not degraded', async () => {
    // Same statement, through the wiring the server actually builds: chelaile,
    // the subway router and apizero, with the engine driven by an injected
    // detail resolver so no upstream is contacted.
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
    // apizero is a real fallback: it answers for a bus line only when chelaile
    // throttled, and its own `getLiveStatus` declares that about itself
    // (`isDegraded: true` on the status it returns). Deriving the flag from the
    // declaration rather than the index must not lower it — that sentence is
    // TRUE here.
    const aggregator = new TransitAggregator([
      new ScriptedProvider('chelaile', null),
      new ScriptedProvider('apizero', reading({ dataSource: 'apizero', isDegraded: true })),
    ])

    const status = await aggregator.getLiveStatus('010-52-0', 0, '027')

    expect(status?.dataSource).toBe('apizero')
    expect(status?.isDegraded).toBe(true)
  })

  it('reports a first-position provider\'s own degradation declaration unchanged', async () => {
    // The other half of position-independence: a fallback answer that happens to
    // sit first must still be reported as a fallback. Nothing about the list
    // order may raise or lower this flag.
    const aggregator = new TransitAggregator([
      new ScriptedProvider('apizero', reading({ dataSource: 'apizero', isDegraded: true })),
    ])

    const status = await aggregator.getLiveStatus('010-1-1', 0, '027')

    expect(status?.isDegraded).toBe(true)
  })
})
