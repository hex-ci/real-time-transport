import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { DataProvenanceSchema } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream, type BusFixture, type LineFixture } from './support/upstream-mock.js'

/**
 * F4：数据可信度标记。
 *
 * 三档各自由一条真实路径产出，因此这里让三条路径都跑一遍：上游发布到站时间的真实车辆（实时）、
 * 本系统按行车间隔推演出的列车（排班推演）、以及该站已注册的分钟级时刻表（精确时刻表）。
 * 词汇表只保留有生产路径的档位 —— 曾有一档「本系统自算的到站分钟」，没有任何路径产出它，
 * 因此绝不能再出现在响应里：缺分钟的行改为**不给分钟**，而不是给一个推算值。
 *
 * 同一个空的量（没有分钟）在三种情形下必须仍然是三种可分辨的答案，这也是本文件断言的核心。
 */
const TARGET_ORDER = 5
const STATION = '站5'
const STOP_NAMES = ['站1', '站2', '站3', '站4', STATION, '站6', '站7', '站8']

/** 已注册分钟级时刻表的站台（`subway-timetables.data.ts` 里的唯一一份）。 */
const TIMETABLE_LINE_ID = 'subway_027_7'
const TIMETABLE_STATION = '群芳'

interface ArrivalRowView {
  busId?: string
  time?: string
  etaSeconds?: number
  stopsAway?: number
  provenance?: string | null
}

interface StationArrivalsView {
  isExact: boolean
  arrivals: ArrivalRowView[]
  operatingStatus: { state: string, firstDeparture: string | null, lastDeparture: string | null }
  reference: unknown
}

function stationArrivalsUrl(lineId: string, stationName: string): string {
  return `/api/transit/lines/${lineId}/stations/${encodeURIComponent(stationName)}/arrivals`
}

describeEachStore('F4 · 来源标记', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /**
   * 站序 5 的线路夹具；站台没有坐标，因此来源标记与参考行互不牵连。
   * `label` 必须逐条不同：夹具 id 是「本次运行 + 标签」，同标签的两条线路会撞成同一个 id。
   */
  function fixture(label: string, buses: BusFixture[] = []): LineFixture {
    return {
      lineId: api.fixtureId(label),
      lineName: '夹具线路',
      stops: STOP_NAMES.map(name => ({ name })),
      buses,
    }
  }

  async function arrivalsOf(lineId: string, stationName: string = STATION): Promise<StationArrivalsView> {
    const res: LightMyRequestResponse = await api.inject({
      method: 'GET',
      url: stationArrivalsUrl(lineId, stationName),
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: StationArrivalsView }).data
  }

  it('每一行的来源都在三档词表内，没有一行是已删的那一档', async () => {
    const line = fixture('mixed', [
      { busId: 'from-upstream', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 300 }] },
      { busId: 'no-minutes', nextStopOrder: TARGET_ORDER },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const provenances = (await arrivalsOf(line.lineId)).arrivals.map(row => row.provenance)
    // 一次响应可以混合：给了到站时间的行是实时，没给的行不声明来源。
    expect(provenances).toEqual(['live', null])

    for (const provenance of provenances) {
      if (provenance === null || provenance === undefined) continue
      expect(DataProvenanceSchema.safeParse(provenance).success, `${provenance} 不在三档词表内`).toBe(true)
    }
    // 被删除的那一档（本系统自算的到站分钟）不得再被任何路径产出。
    expect(provenances).not.toContain('position_estimate')
    expect(DataProvenanceSchema.options).not.toContain('position_estimate')
  })

  it('没有上游到站时间的行不声明来源：未知绝不向「实时」取整', async () => {
    const line = fixture('no-minutes', [{ busId: 'no-minutes', nextStopOrder: TARGET_ORDER }])
    installUpstream(api.upstream, { lines: [line] })

    const rows = (await arrivalsOf(line.lineId)).arrivals
    expect(rows).toHaveLength(1)
    // 行仍然在，但没有数字可标记：来源为 null，绝不是 live。
    expect(rows[0]!.stopsAway).toBe(1)
    expect(Object.hasOwn(rows[0]!, 'etaSeconds')).toBe(false)
    expect(rows[0]!.provenance).toBeNull()
  })

  it('生成车辆的到站行标为排班推演，绝不标成实时', async () => {
    // 上游此刻没有车：开关打开时由本系统按行车间隔推演列车。
    const line = fixture('simulated', [])
    installUpstream(api.upstream, { lines: [line] })

    const previous = process.env.TRANSIT_SIMULATION
    process.env.TRANSIT_SIMULATION = 'true'
    try {
      const simulatedLive = await api.inject({
        method: 'GET',
        url: `/api/transit/lines/${line.lineId}/live?simulate=true`,
      })
      expect(simulatedLive.statusCode, simulatedLive.body).toBe(200)
      expect((simulatedLive.json() as { data: { dataSource: string } }).data.dataSource).toBe('subway_schedule')

      const rows = (await arrivalsOf(line.lineId)).arrivals
      const priced = rows.filter(row => typeof row.etaSeconds === 'number')
      // 生成的列车带着引擎自己编的分钟：整行仍是模型输出，因此先问「这是什么车」。
      expect(priced.length).toBeGreaterThan(0)
      expect(priced.every(row => row.provenance === 'schedule_simulation')).toBe(true)
      expect(rows.some(row => row.provenance === 'live')).toBe(false)
    }
    finally {
      if (previous === undefined) delete process.env.TRANSIT_SIMULATION
      else process.env.TRANSIT_SIMULATION = previous
    }
  })

  it('已注册分钟级时刻表的站台标为精确时刻表', async () => {
    installUpstream(api.upstream, {})

    const body = await arrivalsOf(TIMETABLE_LINE_ID, TIMETABLE_STATION)
    // 注册时刻表作答时读侧明确说出来：`isExact` 是它与推演引擎的分界。
    expect(body.isExact).toBe(true)
    // 该站自己的首末班可判定：状态不是未知，说明用的是时刻表那一对时刻。
    expect(body.operatingStatus.state).not.toBe('unknown')

    const wrong = body.arrivals.filter(row => row.provenance !== 'exact_timetable')
    expect(wrong).toHaveLength(0)

    if (body.arrivals.length === 0) {
      // 空列表只可能出现在首班之前或末班之后（另一段属于另一个运营日）—— 绝不会是运营中。
      expect(['before_first', 'after_last']).toContain(body.operatingStatus.state)
    }
    else {
      expect(body.arrivals[0]!.time).toMatch(/^\d{2}:\d{2}$/)
      expect(typeof body.arrivals[0]!.etaSeconds).toBe('number')
    }
  })
})
