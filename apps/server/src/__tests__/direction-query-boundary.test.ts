import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * F-D 在 HTTP 边界：契约不接受的方向在这里就被拒绝，并点名可接受的值。
 *
 * 应用自己的契约（`LineDetail`、`LiveLineStatus` 与 WS 消息上的 `z.number().int().min(0)
 * .max(1)`）规定了方向是什么，所以不符合它的值是一个请求错误，该在边界上回答，好让调用方
 * 知道什么可以接受。引擎侧的守卫（`statedDirection`）继续挡住畸形数字进入生成的 id。
 *
 * 钉住两件事：拒绝本身（400，点名 0 与 1），以及没有任何被接受的请求会用畸形方向推导出的
 * id 作答。
 */

/** 北京 08:00：落在夹具线路的营运窗口内，实时答案才有车。 */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

const LINE_ID = 'subway_027_7'
const STATION_NAME = '群芳'
/**
 * 一个「有车正在接近」的站台，供下面的到达扫描用：起点站不行，下一站是起点站的车
 * 已经离开它了（`nextOrder > targetOrder` 会丢弃）—— 群芳 会答出空列表，而扫它的
 * busId 会一无所获地通过。
 */
const ARRIVALS_STATION = '万盛西'

/** 一个包住夹具线路的 Amap v3 成功响应外壳。 */
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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function directionRoutes(direction: string): Array<{ route: string, url: string }> {
  const q = `direction=${encodeURIComponent(direction)}`
  return [
    { route: 'line detail', url: `/api/transit/lines/${LINE_ID}?${q}` },
    { route: 'live status', url: `/api/transit/lines/${LINE_ID}/live?${q}` },
    {
      route: 'station arrivals',
      url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION_NAME)}/arrivals?${q}`,
    },
    {
      route: 'walk decision',
      url: '/api/transit/gis/walk-decision?originLng=116.4&originLat=39.9'
        + `&lineId=${LINE_ID}&stationName=${encodeURIComponent(STATION_NAME)}&${q}`,
    },
  ]
}

describe('G1: a direction the contracts do not accept is refused at the boundary', () => {
  it('answers 400 naming the accepted values for every route that takes one', async () => {
    for (const direction of ['abc', '9', '-1', '1e0', '0x1', '', ' ']) {
      for (const { route, url } of directionRoutes(direction)) {
        stubUpstream()
        freezeAtBeijingMorning()
        const app = await buildApp({ amapKey: 'test-key' })
        try {
          const res = await app.inject({ method: 'GET', url })
          expect(res.statusCode, `${route} accepted direction=${JSON.stringify(direction)}`).toBe(400)
          expect(JSON.parse(res.body).success).toBe(false)
          // 拒绝里点名 schema 接受的两个值，调用方不必读源码
          // 就能改对请求。
          expect(JSON.parse(res.body).error, route).toBe('direction must be 0 or 1')
        }
        finally {
          await app.close()
        }
      }
    }
  })

  it('refuses before any upstream is read', async () => {
    stubUpstream()
    freezeAtBeijingMorning()
    const app = await buildApp({ amapKey: 'test-key' })
    try {
      await app.inject({ method: 'GET', url: `/api/transit/lines/${LINE_ID}/live?direction=abc` })
      // 边界无法表达其含义的请求不得花掉上游配额 —— 更糟的是，
      // 用一次 NaN 调用去作答。
      expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    }
    finally {
      await app.close()
    }
  })

  it('accepts the two stated values, and the absent one as its declared default', async () => {
    for (const url of [
      `/api/transit/lines/${LINE_ID}?direction=0`,
      `/api/transit/lines/${LINE_ID}?direction=1`,
      `/api/transit/lines/${LINE_ID}`,
    ]) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, url).toBe(200)
        expect(JSON.parse(res.body).data.direction, url).toBeLessThanOrEqual(1)
      }
      finally {
        await app.close()
      }
    }
  })
})

describe('G1: no accepted request answers with an id derived from a malformed direction', () => {
  it('names every generated train with the stated direction it was answered under', async () => {
    for (const direction of ['0', '1']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/live?direction=${direction}&cityCode=027`,
        })
        expect(res.statusCode, res.body).toBe(200)
        const data = JSON.parse(res.body).data as {
          direction: number
          buses: Array<{ id: string }>
        }
        expect(data.direction, 'the answer states a direction the contracts accept').toBe(Number(direction))
        // 边界接受的方向必须仍然产出车，否则这条断言
        // 会在空列表上通过，什么也证明不了。
        expect(data.buses.length, `direction=${direction} answered no train`).toBeGreaterThan(0)
        for (const bus of data.buses) {
          expect(bus.id, `id carries a malformed direction: ${bus.id}`).not.toMatch(/NaN|undefined|null/)
          expect(bus.id).toMatch(new RegExp(`^train_${LINE_ID}_d${direction}_dep\\d+$`))
        }
      }
      finally {
        await app.close()
      }
    }
  })

  it('carries no NaN-derived busId in the arrivals rows either', async () => {
    // 到达行的 `busId` 也不许带 NaN 推导出来的 id ——
    // 同一批生成的 id，只是更外一层契约；两个面都扫，
    // 让这条不变量钉在它被看见的地方。
    for (const direction of ['0', '1']) {
      stubUpstream()
      freezeAtBeijingMorning()
      const app = await buildApp({ amapKey: 'test-key' })
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(ARRIVALS_STATION)}/arrivals`
            + `?direction=${direction}&count=6&cityCode=027`,
        })
        expect(res.statusCode, res.body).toBe(200)
        const rows = JSON.parse(res.body).data.arrivals as Array<{ busId?: string }>
        const generated = rows.filter(r => r.busId?.startsWith('train_'))
        expect(generated.length, `direction=${direction} answered no generated row`).toBeGreaterThan(0)
        for (const row of generated) {
          expect(row.busId, `row carries a malformed direction: ${row.busId}`).not.toMatch(/NaN|undefined|null/)
          expect(row.busId).toMatch(new RegExp(`^train_${LINE_ID}_d[01]_dep\\d+$`))
        }
      }
      finally {
        await app.close()
      }
    }
  })
})
