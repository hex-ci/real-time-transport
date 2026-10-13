import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream, type BusFixture, type LineFixture } from './support/upstream-mock.js'

/**
 * F5：站台聚合大屏的读侧。
 *
 * 大屏由「同一站台上的一行行」拼起来，每行是**一条线路**的一次定点实时读数
 * （`GET /lines/:id/live?order=<本站在本方向上的站序>`）：行的分钟取自该响应自己发布的
 * `travelTimeSec`，行的来源标记取自该响应声明的 `dataSource`。于是聚合屏赖以成立的四条契约
 * 都发生在这一层，而不是界面里：
 *
 *  - 一行只说自己那条线路：分钟与车辆不跨线路借用，否则这一屏的排序键会把两条线的读数混起来；
 *  - `travelTimeSec` 是**被请求的那一站**的价，不是线路末端的价，否则整屏的排序依据是错的；
 *  - 每行各带自己的来源；「答了但没车」与「读不到」形状不同，不得互相冒充；
 *  - 每行的时间戳是产出这些行的那次读数，轮询的钟推不动它。
 *
 * 翻牌动效、发光行这类视觉形态不在这一层。
 */

const STATION = '换乘站'
/** 换乘站在站表里的序号（1 基）——大屏对每条线路都用它问价。 */
const TARGET_ORDER = 3
const STOP_NAMES = ['甲站', '乙站', STATION, '丁站', '戊站']

interface LiveBusView {
  id?: string
  travelTimeSec?: number
}

interface LiveStatusView {
  lineId?: string
  buses: LiveBusView[]
  dataSource?: string | null
  updatedAt?: number
}

describeEachStore('F5 · 站台聚合大屏的读侧', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /**
   * 一条经过本站台的线路夹具。`label` 必须逐条不同：夹具 id 是「本次运行 + 标签」，
   * 同标签的两条线路会撞成同一个 id。
   */
  function fixture(label: string, buses: BusFixture[] = []): LineFixture {
    return {
      lineId: api.fixtureId(label),
      lineName: '夹具线路',
      stops: STOP_NAMES.map(name => ({ name })),
      buses,
    }
  }

  /** 大屏对一条线路的一次定点读数。 */
  function boardRead(lineId: string, query: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const qs = new URLSearchParams({ direction: '0', cityCode: '027', order: String(TARGET_ORDER), ...query })
    return api.inject({ method: 'GET', url: `/api/transit/lines/${encodeURIComponent(lineId)}/live?${qs}` })
  }

  function liveStatusOf(res: LightMyRequestResponse): LiveStatusView {
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: LiveStatusView }).data
  }

  it('同一站台的多条线路各自成行：分钟与车辆只来自它自己那条线的读数', async () => {
    const first = fixture('aggregate-first', [
      { busId: 'A-1', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 180 }] },
    ])
    const second = fixture('aggregate-second', [
      { busId: 'B-1', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 600 }] },
    ])
    installUpstream(api.upstream, { lines: [first, second] })

    const firstBoard = liveStatusOf(await boardRead(first.lineId))
    const secondBoard = liveStatusOf(await boardRead(second.lineId))

    // 两条线在同一个站台上并排成两行，各自的分钟是各自读数里那一个。
    expect(firstBoard.buses.map(bus => bus.id)).toEqual(['A-1'])
    expect(firstBoard.buses[0]!.travelTimeSec).toBe(180)
    expect(secondBoard.buses.map(bus => bus.id)).toEqual(['B-1'])
    expect(secondBoard.buses[0]!.travelTimeSec).toBe(600)
    // 一行只说自己那条线路：另一条的车与分钟不出现在这一行里。
    expect(JSON.stringify(firstBoard)).not.toContain('B-1')
    expect(JSON.stringify(secondBoard)).not.toContain('A-1')
  })

  it('分钟是被请求的那一站的价：换一个站序读数，同一辆车给出另一行自己的数字', async () => {
    // 数据源对同一辆车发布了两个站的价，屏上的排序键必须落在被问的那一站上。
    const line = fixture('per-station', [
      {
        busId: 'b1',
        nextStopOrder: TARGET_ORDER,
        travels: [
          { order: TARGET_ORDER, travelTime: 180 },
          { order: TARGET_ORDER + 2, travelTime: 600 },
        ],
      },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const atStation = liveStatusOf(await boardRead(line.lineId))
    const further = liveStatusOf(await boardRead(line.lineId, { order: String(TARGET_ORDER + 2) }))

    expect(atStation.buses[0]!.travelTimeSec).toBe(180)
    expect(further.buses[0]!.travelTimeSec).toBe(600)
    // 两个站序各自是一行自己的读数：第二次不是第一次的重放（线路末端的价不是本站的价）。
    expect(atStation.buses[0]!.travelTimeSec).not.toBe(further.buses[0]!.travelTimeSec)
  })

  it('一块屏上各行按各自的来源标记：实时读数与排班推演不是同一个标记', async () => {
    // 一条线路由数据源答出实时车辆；另一条此刻没有车，由本系统按时刻表生成列车。
    const live = fixture('provenance-live', [
      { busId: 'live-1', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 180 }] },
    ])
    const generated = fixture('provenance-generated', [])
    installUpstream(api.upstream, { lines: [live, generated] })

    const answered = liveStatusOf(await boardRead(live.lineId))
    const simulated = liveStatusOf(await boardRead(generated.lineId, { simulate: 'true' }))

    // 来源随应答者走：每行带自己那一次的声明，界面据此逐行标注，绝不从线路类型猜。
    expect(answered.dataSource).toBe('chelaile')
    expect(simulated.dataSource).toBe('subway_schedule')
    expect(answered.dataSource).not.toBe(simulated.dataSource)
    for (const status of [answered, simulated]) {
      expect(typeof status.dataSource, 'a board row without a source would be marked as nothing').toBe('string')
    }
  })

  it('「答了但没车」与「读不到」不互相冒充：一块屏上两种结局的形状不同', async () => {
    const answeredEmpty = fixture('answered-empty', [])
    installUpstream(api.upstream, { lines: [answeredEmpty] })
    const empty = await boardRead(answeredEmpty.lineId)

    // 上游没答这条线路：拒绝，且没有任何可以当列表或当来源印出去的值。
    const unreadable = await boardRead(api.fixtureId('unreadable'))

    expect(empty.statusCode, empty.body).toBe(200)
    const emptyStatus = empty.json() as { success: boolean, data: LiveStatusView }
    expect(emptyStatus.success).toBe(true)
    expect(emptyStatus.data.buses).toEqual([])
    // 空列表是关于这条线路的答案：它点名自己说的是谁，且仍带着这次读数的来源与时刻。
    expect(emptyStatus.data.lineId).toBe(answeredEmpty.lineId)
    expect(typeof emptyStatus.data.dataSource).toBe('string')
    expect(typeof emptyStatus.data.updatedAt).toBe('number')

    expect(unreadable.statusCode, `a failed read was served as an answer: ${unreadable.body}`).toBe(404)
    const failed = unreadable.json() as { success: boolean, error?: string }
    expect(failed.success).toBe(false)
    expect(typeof failed.error).toBe('string')
    // 读不到就不该有形状像答案的东西：空列表冒充失败正是这条规则要挡住的。
    expect(unreadable.json().data, 'a failed read handed back an answer').toBeUndefined()
  })

  it('最后更新跟着读数走：重读同一条读数不换时刻，读不到的那一次没有时刻可给', async () => {
    const line = fixture('freshness', [
      { busId: 'b1', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 180 }] },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const first = liveStatusOf(await boardRead(line.lineId))
    const callsAfterFirst = api.upstream.mock.calls.length
    const second = liveStatusOf(await boardRead(line.lineId))

    // 缓存条目在 TTL 内存活期间被原样重放：这一屏的「最后更新」是一次读数，不是一次轮询。
    expect(typeof first.updatedAt).toBe('number')
    expect(second.updatedAt).toBe(first.updatedAt)
    expect(api.upstream.mock.calls.length, 'a re-read of the same instant re-read the upstream').toBe(callsAfterFirst)

    const unreadable = await boardRead(api.fixtureId('freshness-unread'))
    expect(unreadable.statusCode, unreadable.body).toBe(404)
    expect(unreadable.json().data, 'a failed read carried an instant to timestamp rows with').toBeUndefined()
  })
})
