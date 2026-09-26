import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * 实时路由必须转发调用方的目标站序，否则一块只问一个站台的站牌会被用线路终点的答案
 * 作答。
 *
 * 上游只有在请求点名车辆要去的站时才计算它的行程时间；没有那个参数，读数仍带着一个
 * `travelTimeSec` —— 到终点站的距离 —— 读起来像一个真实的分钟，却是另一个问题的答案。
 * provider、service 与聚合器都已经接受 `options.targetOrder`，而丢掉参数的路由会让它们
 * 全对、屏幕全错。
 *
 * 用地铁引擎做夹具：有目标时它算到那一站的跳数，没有时算到终点的跳数，所以同一趟车、
 * 同一个答案，在转发站序后给出的分钟严格更小。
 */

/** 北京 08:00，落在夹具线路的窗口内，实时答案才有车。 */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

const LINE_ID = 'subway_027_7'
/** 站牌正在显示的站台。不是第一站：必须还有车正开向它。 */
const TARGET_ORDER = 4

function stubUpstream(): void {
  const stops = [
    ['群芳', '116.392540,39.924299'],
    ['万盛东', '116.399999,39.930001'],
    ['万盛西', '116.405000,39.935000'],
    ['高楼金', '116.410000,39.940000'],
    ['花庄', '116.415000,39.945000'],
    ['环球度假区', '116.420000,39.950000'],
    ['土桥', '116.425000,39.955000'],
    ['乙站', '116.430000,39.960000'],
  ] as const
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    const body = href.includes('/v3/bus/linename')
      ? {
          buslines: [{
            id: 'BJ_7',
            name: '地铁7号线',
            type: '地铁线路',
            start_stop: stops[0][0],
            end_stop: stops[stops.length - 1][0],
            start_time: '0516',
            end_time: '2306',
            busstops: stops.map(([name, location], idx) => ({
              id: `s${idx + 1}`,
              name,
              sequence: idx + 1,
              location,
            })),
          }],
        }
      : {}
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', ...body }) }
  }))
}

async function liveBuses(query: string): Promise<Array<{
  id: string
  order: number
  travelTimeSec?: number
}>> {
  const app = await buildApp({ amapKey: 'test-key' })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027${query}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return JSON.parse(res.body).data.buses
  }
  finally {
    await app.close()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live route forwards a target order to the reading it asks for', () => {
  it('answers the platform\'s minute instead of the terminus one, per vehicle', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const terminal = await liveBuses('')
    stubUpstream()
    freezeAtBeijingMorning()
    const targeted = await liveBuses(`&order=${TARGET_ORDER}`)

    // 同一批车，所以逐车比较就是同一趟车的比较。
    const terminalById = new Map(terminal.map(bus => [bus.id, bus.travelTimeSec]))
    expect(terminalById.size, 'the fixture line answered no train').toBeGreaterThan(0)

    const stated = targeted.filter(bus => typeof bus.travelTimeSec === 'number')
    // 先看非空：一个带了站序却什么也没定价的请求会让
    // 下面的循环在一无所测的情况下通过。
    expect(stated.length, 'the targeted read stated no minute at all').toBeGreaterThan(0)

    for (const bus of stated) {
      const terminus = terminalById.get(bus.id)
      expect(terminus, `${bus.id} is missing from the untargeted reading`).toBeTypeOf('number')
      // 严格更小：这个分钟是到被请求站台的跳数，不是
      // 到线路末端的跳数。丢掉参数的路由在这里会答终点站的
      // 数字，这正是这条断言抓的东西。
      expect(bus.travelTimeSec!, `${bus.id} states the terminus figure, not the platform's`)
        .toBeLessThan(terminus!)
    }

    // ……而已过站台的车一辆都不给，而不是给出一个关于
    // 已经驶过的站的数字：那样的行会是一个错地方的分钟。
    for (const bus of targeted) {
      if (bus.order >= TARGET_ORDER) {
        expect(bus.travelTimeSec, `${bus.id} has cleared the platform but states a minute`).toBeUndefined()
      }
    }
  })

  it('states no minute for a platform no train is heading to, rather than one about the terminus', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    // 站序 1 是线路自己的起点：没有车正开向它，所以每辆车都在它之后，
    // 一辆都不许给分钟。丢掉参数会给它们全体答终点站的
    // 数字 —— 编造分钟的形态，只是站台错了。
    const atOrigin = await liveBuses('&order=1')
    expect(atOrigin.length, 'the fixture line answered no train').toBeGreaterThan(0)
    for (const bus of atOrigin) {
      expect(bus.travelTimeSec, `${bus.id} states a minute at the line's origin`).toBeUndefined()
    }
  })

  it('refuses an order that is not a station ordinal, before reading upstream', async () => {
    // 以 NaN 传播的目标会是「问一个站台、答另一个站台的数字」，
    // 所以边界无法表达其含义的值被拒绝，而不是归一化成
    // 「没有目标」—— 与 `direction` 遵循同一条规则。
    for (const order of ['abc', '0', '-1', '1e0', '2.5', '', ' ']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027&order=${encodeURIComponent(order)}`,
        })
        expect(res.statusCode, `accepted order=${JSON.stringify(order)}`).toBe(400)
        expect(JSON.parse(res.body).error).toBe('order must be a positive integer station ordinal')
        expect(vi.mocked(fetch), `order=${JSON.stringify(order)} spent an upstream read`).not.toHaveBeenCalled()
      }
      finally {
        await app.close()
      }
    }
  })

  it('still answers a reading that names no target, which is what a line board shows', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/transit/lines/${LINE_ID}/live?direction=0&cityCode=027`,
      })
      expect(res.statusCode, res.body).toBe(200)
      // 没有目标时每辆车都定价到终点站 —— 这是线路页
      // 自己的站牌消费的读数，不是错误。
      const buses = JSON.parse(res.body).data.buses as Array<{ travelTimeSec?: number }>
      expect(buses.length).toBeGreaterThan(0)
      for (const bus of buses) {
        expect(bus.travelTimeSec, 'an untargeted reading states no minute').toBeTypeOf('number')
      }
    }
    finally {
      await app.close()
    }
  })
})
