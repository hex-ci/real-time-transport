import { afterEach, beforeEach, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'
import { installUpstream, type BusFixture, type LineFixture } from './support/upstream-mock.js'

/**
 * F1：`?order=` 契约与到站读数。
 *
 * 这一层的价值在于断言的**位置**：`?order=` 的出现与缺席、`-1` 哨兵、`nextOrder` 判据、
 * `travelTimeSec 0` 的优先级都发生在 HTTP 边界与读侧解释之间，只有从 `app.inject()` 打进去
 * 才能证明它们连成了一条契约。上游一律桩掉，读侧因此拿到的正是夹具写下的口径。
 *
 * 高德客户端只在构造时读一次 key：key 为空时步行路线不会发出请求（直接答 null），参考行就永远
 * 走不到「有步行价」的那条分支。补一个占位 key（已有真 key 时不覆盖），真实网络由上游桩拦住。
 */
if (!process.env.AMAP_MAPS_API_KEY) process.env.AMAP_MAPS_API_KEY = 'test-amap-key'

/** 到站读数钉在站序 5 上。 */
const TARGET_ORDER = 5
const STATION = '站5'
const STOP_NAMES = ['站1', '站2', '站3', '站4', STATION, '站6', '站7', '站8']

function stationArrivalsUrl(lineId: string): string {
  return `/api/transit/lines/${lineId}/stations/${encodeURIComponent(STATION)}/arrivals`
}

interface ArrivalRowView {
  busId?: string
  time?: string
  etaSeconds?: number
  stopsAway?: number
  isAtStation?: boolean
  provenance?: string | null
}

describeEachStore('F1 · 参考行与到站读数', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /**
   * 站序 5 的线路夹具；站名与坐标齐备，使参考行也有可定价的站台。
   * `label` 必须逐条不同：夹具 id 是「本次运行 + 标签」，同标签的两条线路会撞成同一个 id。
   */
  function fixture(label: string, buses: BusFixture[] = []): LineFixture {
    return {
      lineId: api.fixtureId(label),
      lineName: '夹具线路',
      stops: STOP_NAMES.map((name, index) => ({
        name,
        lat: 39.9 + index * 0.001,
        lng: 116.4 + index * 0.001,
      })),
      buses,
    }
  }

  function arrivalsOf(res: LightMyRequestResponse): ArrivalRowView[] {
    return (res.json() as { data: { arrivals: ArrivalRowView[] } }).data.arrivals
  }

  it('没有 order 的读数不带 travelTimeSec，带了才有', async () => {
    const line = fixture('order-contract', [
      { busId: 'b1', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 300 }] },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const bare = await api.inject({ method: 'GET', url: `/api/transit/lines/${line.lineId}/live` })
    expect(bare.statusCode, bare.body).toBe(200)
    const bareBuses = (bare.json() as { data: { buses: Record<string, unknown>[] } }).data.buses
    expect(bareBuses).toHaveLength(1)
    // 没有目标站就没有定向到站时间：整键缺席，而不是一个 0 或 null。
    expect(Object.hasOwn(bareBuses[0]!, 'travelTimeSec')).toBe(false)

    const targeted = await api.inject({
      method: 'GET',
      url: `/api/transit/lines/${line.lineId}/live?order=${TARGET_ORDER}`,
    })
    expect(targeted.statusCode, targeted.body).toBe(200)
    const targetedBuses = (targeted.json() as { data: { buses: Record<string, unknown>[] } }).data.buses
    expect(targetedBuses[0]!.id).toBe('b1')
    expect(targetedBuses[0]!.travelTimeSec).toBe(300)
  })

  it('order 必须是正整数：别的值直接拒绝，不归一化', async () => {
    for (const raw of ['0', '-1', 'abc', '1.5']) {
      const res = await api.inject({
        method: 'GET',
        url: `/api/transit/lines/${api.fixtureId('line')}/live?order=${raw}`,
      })
      expect(res.statusCode, `order=${raw} → ${res.body}`).toBe(400)
      expect((res.json() as { error: string }).error)
        .toBe('order must be a positive integer station ordinal')
    }
    // 拒绝发生在边界上：没有为畸形请求读过任何上游。
    expect(api.upstream).not.toHaveBeenCalled()
  })

  it('到站行只收服务目标站的车：-1 哨兵与已过目标站的车都不在', async () => {
    const line = fixture('sentinel', [
      { busId: 'serving', nextStopOrder: TARGET_ORDER },
      { busId: 'passed-sentinel', nextStopOrder: TARGET_ORDER, distanceToWaitStn: -1 },
      { busId: 'past-target', nextStopOrder: TARGET_ORDER + 2 },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const res = await api.inject({ method: 'GET', url: stationArrivalsUrl(line.lineId) })
    expect(res.statusCode, res.body).toBe(200)
    expect(arrivalsOf(res).map(row => row.busId)).toEqual(['serving'])
  })

  it('来源声明车已在站台（travelTimeSec 0）时按在站处理，并排在其它车之前', async () => {
    const line = fixture('at-platform', [
      { busId: 'approaching', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 300 }] },
      { busId: 'at-platform', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 0 }] },
    ])
    installUpstream(api.upstream, { lines: [line] })

    const res = await api.inject({ method: 'GET', url: stationArrivalsUrl(line.lineId) })
    expect(res.statusCode, res.body).toBe(200)
    const rows = arrivalsOf(res)
    // 0 说的是「车在哪」（在站台），不是时长：这一行成行、排最前，读作 0 秒而不是缺席 ——
    // 若按「只有 > 0 才是到站时间」解释，这辆正停在站台上的车会整行消失。
    expect(rows[0]).toMatchObject({ busId: 'at-platform', etaSeconds: 0, isAtStation: true, stopsAway: 0 })
    expect(rows[1]).toMatchObject({ busId: 'approaching', etaSeconds: 300 })
  })

  it('没有上游到站时间的车仍然成行，但不给任何分钟', async () => {
    const line = fixture('no-minutes', [{ busId: 'no-eta', nextStopOrder: TARGET_ORDER }])
    installUpstream(api.upstream, { lines: [line] })

    const res = await api.inject({ method: 'GET', url: stationArrivalsUrl(line.lineId) })
    expect(res.statusCode, res.body).toBe(200)
    const row = arrivalsOf(res)[0]!
    // 车确实在途：观测到的东西照常给出。
    expect(row).toMatchObject({ busId: 'no-eta', stopsAway: 1 })
    // 分钟没有任何来源发布或建模：这一行不给数字，也不给一个「0 分」。
    expect(Object.hasOwn(row, 'etaSeconds')).toBe(false)
    expect(Object.hasOwn(row, 'time')).toBe(false)
  })

  it('参考行只在有到站分钟时给结论；缺分钟时不给数字', async () => {
    // 早高峰窗口覆盖全天：无论用例在几点跑，「你现在在哪」都是家。
    const saved = await api.inject({
      method: 'PATCH',
      url: '/api/transit/settings',
      payload: { morningStart: '00:00', morningEnd: '23:59', homeLat: 39.9, homeLng: 116.4 },
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const priced = fixture('priced', [
      { busId: 'eta', nextStopOrder: TARGET_ORDER, travels: [{ order: TARGET_ORDER, travelTime: 300 }] },
    ])
    const unpriced = fixture('unpriced', [{ busId: 'no-eta', nextStopOrder: TARGET_ORDER }])
    installUpstream(api.upstream, {
      lines: [priced, unpriced],
      // 锚点到站台步行 5 分钟（300 秒）。
      amap: url => url.pathname.endsWith('/v3/direction/walking')
        ? { status: '1', infocode: '10000', route: { paths: [{ distance: '480', duration: '300' }] } }
        : undefined,
    })

    const withMinutes = (await api.inject({ method: 'GET', url: stationArrivalsUrl(priced.lineId) })).json() as {
      data: { reference: { status: string, anchor: string, advice: Record<string, unknown> } | null }
    }
    expect(withMinutes.data.reference?.status).toBe('advice')
    expect(withMinutes.data.reference?.anchor).toBe('home')
    // 步行 5 分、这班车 5 分：余量落在容忍值（默认 3 分）之内 → 现在就走。
    expect(withMinutes.data.reference?.advice).toMatchObject({
      state: 'hurry',
      walkMinutes: 5,
      nextArrivalMinutes: 5,
      leaveInMinutes: 0,
    })

    const withoutMinutes = (await api.inject({ method: 'GET', url: stationArrivalsUrl(unpriced.lineId) })).json() as {
      data: { reference: unknown }
    }
    // 没有分钟就没有结论：参考行缺席，而不是给一个「不用着急」。
    expect(withoutMinutes.data.reference).toBeNull()
  })
})
