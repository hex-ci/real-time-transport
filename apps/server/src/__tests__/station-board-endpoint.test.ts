import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { StationBoardSchema } from '@real-time-transport/shared'
import { buildApp } from '../app.js'

/**
 * 电子站牌（PRD F5）的服务端契约：`GET /api/transit/stations/:stationId/board`。
 *
 * 三件事在这里钉住：
 *  - **站台上的线路不由关注列表决定**：本端点压根不知道谁被关注，故夹具里那条谁都没关注的线路
 *    必须照样在答复里 —— 这条断言就是「不再只投影已关注线路」的证明；
 *  - **到站时刻与发车间隔预报是两种东西**：一个有在途车的行与一个只有预报的行，形状不同；
 *  - 一次站台读取**只打一次上游**，重复读在节拍内由缓存作答（页面的重读不该比轮询更密）。
 *
 * `NNN路` / `NN站` / `010-00001` 都是占位：本文件不出现真实线路、站名或上游 id。
 */

const STATION_ID = '010-00001'
const CITY = '027'

const apps: FastifyInstance[] = []
const upstreamCalls: string[] = []

/** 上游那条站台接口的线上形态：若干组站台，第一组带线路身份与在途车。 */
function stationBody(lines: unknown[]): string {
  return JSON.stringify({
    jsonr: {
      data: {
        stationList: [
          { lat: 39.9, distance: -1, lines },
          { lat: 39.91, distance: -1, lines: [{ line: { name: 'NNN路', direction: 0 } }] },
        ],
      },
    },
  })
}

/** 一条线路记录：`states` 是它在途的车，`forecast` 是它没有车时的发车间隔预报。 */
function lineOf(params: {
  lineId: string
  name: string
  direction?: number
  forecast?: string
  states?: unknown[]
}): unknown {
  return {
    line: {
      lineId: params.lineId,
      name: params.name,
      direction: params.direction ?? 0,
      endSn: 'NN终点站',
      firstTime: '05:00',
      lastTime: '22:00',
    },
    preArrivalTime: params.forecast,
    stnStates: params.states ?? [],
  }
}

/** 用替身驱动上游；`body` 为 null 表示上游读不到。 */
function stubUpstream(body: string | null): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    upstreamCalls.push(url)
    if (!url.includes('encryptedPhyStnDetail')) {
      return { ok: false, status: 404, text: async () => '' }
    }
    if (body === null) throw new Error('上游读不到')
    return { ok: true, status: 200, text: async () => body }
  }))
}

async function app(): Promise<FastifyInstance> {
  const built = await buildApp()
  apps.push(built)
  return built
}

async function readBoard(instance: FastifyInstance, stationId = STATION_ID) {
  return instance.inject({ method: 'GET', url: `/api/transit/stations/${stationId}/board?cityCode=${CITY}` })
}

afterEach(async () => {
  for (const built of apps) await built.close()
  apps.length = 0
  upstreamCalls.length = 0
  vi.unstubAllGlobals()
})

describe('一屏站台读数的形状', () => {
  it('站台上的线路全部列出，含谁都没关注的那条', async () => {
    stubUpstream(stationBody([
      lineOf({ lineId: '101', name: '101路', states: [{ busId: 'b1', arrivalTime: Date.now() + 300_000 }] }),
      lineOf({ lineId: '202', name: '202路', forecast: '16:41~16:51' }),
      lineOf({ lineId: '303', name: '303路' }),
    ]))

    const res = await readBoard(await app())
    expect(res.statusCode, res.body).toBe(200)

    const board = StationBoardSchema.parse(res.json().data)
    expect(board.lines.map(line => line.lineName), '站台上的线路被关注列表截住了')
      .toEqual(['101路', '202路', '303路'])
    expect(board.stationId).toBe(STATION_ID)
    expect(board.dataSource).toBe('chelaile')
    // 读取时刻是这次读数自己的时刻，不是作答的时刻：它必须是个数。
    expect(typeof board.readAt).toBe('number')
  })

  it('到站时刻与发车间隔预报各说各的：有车的行不会有预报，有预报的行没有车', async () => {
    stubUpstream(stationBody([
      lineOf({ lineId: '101', name: '101路', states: [{ busId: 'b1', arrivalTime: Date.now() + 300_000 }] }),
      lineOf({ lineId: '202', name: '202路', forecast: '16:41~16:51' }),
    ]))

    const board = StationBoardSchema.parse((await readBoard(await app())).json().data)
    const withBus = board.lines.find(line => line.lineName === '101路')!
    const forecastOnly = board.lines.find(line => line.lineName === '202路')!

    expect(withBus.arrivals).toHaveLength(1)
    expect(withBus.arrivals[0]!.remainSeconds).toBeGreaterThan(0)
    expect(withBus.intervalForecast).toBeNull()
    expect(forecastOnly.arrivals).toEqual([])
    expect(forecastOnly.intervalForecast).toBe('16:41~16:51')
  })

  it('这辆车距本站还有多少米照上游带上，-1 哨兵不编成 0 米', async () => {
    stubUpstream(stationBody([
      lineOf({
        lineId: '101',
        name: '101路',
        states: [
          { busId: 'b1', arrivalTime: Date.now() + 484_000, distanceToDest: 2408 },
          { busId: 'b2', arrivalTime: Date.now() + 600_000, distanceToDest: -1 },
        ],
      }),
    ]))

    const board = StationBoardSchema.parse((await readBoard(await app())).json().data)
    expect(board.lines[0]!.arrivals.map(arrival => arrival.distanceToStationMeters)).toEqual([2408, null])
  })

  it('已经过去的那一班不进列表：它在屏上会被读成「正进站」', async () => {
    stubUpstream(stationBody([
      lineOf({
        lineId: '101',
        name: '101路',
        states: [
          { busId: 'stale', arrivalTime: Date.now() - 600_000, travelTime: -1, distanceToDest: 3789 },
          { busId: 'live', arrivalTime: Date.now() + 300_000, distanceToDest: 2408 },
        ],
      }),
    ]))

    const board = StationBoardSchema.parse((await readBoard(await app())).json().data)
    expect(board.lines[0]!.arrivals.map(arrival => arrival.busId)).toEqual(['live'])
  })
})

describe('读不到与读到了是两件事', () => {
  it('上游读不到时 404，且答复里没有一行读数', async () => {
    stubUpstream(null)

    const res = await readBoard(await app())
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ success: false })
    expect(res.json().data).toBeUndefined()
  })
})

describe('站点详情要一个非空的 lineId 才给全站视图', () => {
  it('每次读取都带上它 —— 少了它，同一条线路只会剩一个方向', async () => {
    // 上游的怪癖：`lineId` 为空时只答「本侧平台」那几条线（每线一个方向），
    // 给了（值本身不参与取数）才答两侧站牌的并集。这是这条规则唯一该被写下的地方。
    stubUpstream(stationBody([lineOf({ lineId: '101', name: '101路' })]))
    const instance = await app()

    await readBoard(instance)

    const url = upstreamCalls.find(call => call.includes('encryptedPhyStnDetail')) ?? ''
    const lineId = new URL(url).searchParams.get('lineId')
    expect(lineId, `上游请求没带 lineId：${url.slice(0, 120)}`).toBeTruthy()
  })
})

describe('节拍：一次站台读取只打一次上游', () => {
  it('节拍内重复读由缓存作答，上游只被读一次', async () => {
    stubUpstream(stationBody([lineOf({ lineId: '101', name: '101路' })]))
    const instance = await app()

    const first = await readBoard(instance)
    const second = await readBoard(instance)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(upstreamCalls.filter(url => url.includes('encryptedPhyStnDetail'))).toHaveLength(1)
    // 缓存重放的是同一次读数：时刻与内容都不重新打戳。
    expect(second.json().data.readAt).toBe(first.json().data.readAt)
  })
})

describe('手动刷新（F11）：这一次点名的是一个站台', () => {
  async function refresh(instance: FastifyInstance) {
    return instance.inject({
      method: 'POST',
      url: '/api/transit/refresh',
      payload: { station: { stationId: STATION_ID, cityCode: CITY } },
    })
  }

  it('按下刷新：失效站台缓存并真读一次，时刻取自这次读数自己的 readAt', async () => {
    stubUpstream(stationBody([lineOf({ lineId: '101', name: '101路' })]))
    const instance = await app()
    const before = (await readBoard(instance)).json().data.readAt

    const res = await refresh(instance)
    expect(res.statusCode, res.body).toBe(200)

    const result = res.json().data
    expect(result).toMatchObject({ dataClass: 'live', throttled: false })
    expect(result.lastUpdatedAt).toBeGreaterThanOrEqual(before)
    // 逐线路的结果这一半为空：这次点名的不是线路。
    expect(result.lines).toEqual([])
    // 缓存被失效，故这一按确实又打了一次上游（第一次读 + 这一次）。
    expect(upstreamCalls.filter(url => url.includes('encryptedPhyStnDetail'))).toHaveLength(2)
  })

  it('节拍内再按一次被冷却拒绝：429，且没读任何东西', async () => {
    stubUpstream(stationBody([lineOf({ lineId: '101', name: '101路' })]))
    const instance = await app()
    await refresh(instance)

    const res = await refresh(instance)
    expect(res.statusCode).toBe(429)
    expect(res.json().data).toMatchObject({ throttled: true })
    expect(res.json().data.retryAfterSeconds).toBeGreaterThan(0)
    // 被拒的那一次不花上游：只有第一次刷新那一次真的读了。
    expect(upstreamCalls.filter(url => url.includes('encryptedPhyStnDetail'))).toHaveLength(1)
  })

  it('一次都没点名时被拒：空按压不是一次刷新', async () => {
    stubUpstream(stationBody([]))
    const res = await (await app()).inject({ method: 'POST', url: '/api/transit/refresh', payload: {} })
    expect(res.statusCode).toBe(400)
  })
})
