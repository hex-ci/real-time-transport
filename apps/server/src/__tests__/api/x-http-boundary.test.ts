import { afterEach, beforeEach, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * HTTP 边界：每个以前踩过的洞都拿真响应钉住。
 *
 * 边界无法表达其含义的请求一律拒绝，而且**在花掉上游配额之前**拒绝：
 *
 *  - `?count=abc` → 400，并点名可接受的形式（`Math.min(Number('abc'), 20)` 是 NaN，交给
 *    `slice` 就是一块读起来像「此刻没车」的空站牌）；
 *  - `?order=abc` → 400（以前被 `Number()` 读成 NaN 后悄悄丢掉，于是调用方问的是一个站台、
 *    答的是整条线路）；
 *  - `?direction=9` → 400，点名 0 与 1；
 *  - 上游没有记录的线路 id → 四条路线一致的 404；
 *  - 重复关注 → 409，且答复里带着本服务端持有的那一行。
 *
 * 正对照与拒绝同等重要：存在的线路、缺省的参数、合法的取值照旧 200 —— 一刀切的拒绝比缺陷更糟。
 * 上游一律桩掉（默认桩拒绝一切调用），因此「拒绝发生在读上游之前」是可断言的。
 */
describeEachStore('HTTP 边界：400 / 404 / 409 都拿真响应钉住', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  const LINE = 'line_027_1'
  const GHOST = 'NO_SUCH_LINE_999'
  const STATION = '丁路'
  const ORDER = 4

  const STATIONS = ['甲路', '乙路', '丙路', '丁路', '戊路', '己路', '庚路', '辛路'].map((name, idx) => ({
    sId: `s${idx + 1}`,
    sn: name,
    order: idx + 1,
    lat: 39.9 + idx * 0.01,
    lng: 116.4 + idx * 0.01,
  }))

  /** 八辆车正开向第四站：只有多辆车时才分得出「路由的默认值」与「调用方陈述的 count」。 */
  function answerWithEightBuses(): void {
    api.upstream.mockImplementation(async (url: unknown) => {
      const href = String(url)
      if (!href.includes('encryptedLineDetail')) throw new Error(`TEST: 未桩掉的上游调用 ${href}`)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonr: {
            data: {
              line: { name: '甲路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
              stations: STATIONS,
              buses: Array.from({ length: 8 }, (_, idx) => ({
                busId: `b${idx + 1}`,
                order: 3,
                speed: 5,
                travels: [{ order: ORDER, travelTime: 60 * (idx + 1) }],
              })),
            },
          },
        }),
      }
    })
  }

  /** 只带 cityCode 的基地址：`direction` 由每个用例按需给出（缺省即默认 0）。 */
  const arrivalsUrl = (query: string) =>
    `/api/transit/lines/${LINE}/stations/${encodeURIComponent(STATION)}/arrivals?cityCode=027${query}`

  const arrivalsRows = (res: { body: string }) => res.json().data?.arrivals as unknown[]

  it('畸形的 count 一律 400，并点名所在的域与上界', async () => {
    for (const raw of ['abc', '0', '-1', '3.7', '21', '1e2', '6.0', ' ']) {
      const res = await api.inject({ method: 'GET', url: arrivalsUrl(`&direction=0&order=${ORDER}&count=${encodeURIComponent(raw)}`) })
      expect(res.statusCode, `count=${JSON.stringify(raw)} was accepted: ${res.body}`).toBe(400)
      const body = res.json()
      expect(body.success, `count=${JSON.stringify(raw)}`).toBe(false)
      expect(body.error, `count=${JSON.stringify(raw)}`).toContain('count')
      expect(body.error, `count=${JSON.stringify(raw)}`).toContain('20')
    }
  })

  it('畸形的 order 一律 400，不把它丢掉去答整条线路', async () => {
    for (const raw of ['abc', '0', '-1', '2.5']) {
      const res = await api.inject({ method: 'GET', url: arrivalsUrl(`&count=6&order=${encodeURIComponent(raw)}`) })
      expect(res.statusCode, `order=${JSON.stringify(raw)} was accepted: ${res.body}`).toBe(400)
      expect(res.json().error, `order=${JSON.stringify(raw)}`).toContain('order')
    }
  })

  it('direction=9 在每条接受方向的路线上一律 400，并点名 0 与 1', async () => {
    const routes = [
      { route: 'line detail', url: `/api/transit/lines/${LINE}?direction=9` },
      { route: 'live status', url: `/api/transit/lines/${LINE}/live?direction=9` },
      { route: 'station arrivals', url: arrivalsUrl('&direction=9&order=4&count=6') },
    ]
    for (const { route, url } of routes) {
      const res = await api.inject({ method: 'GET', url })
      expect(res.statusCode, `${route} accepted direction=9: ${res.body}`).toBe(400)
      expect(res.json().error, route).toBe('direction must be 0 or 1')
    }
  })

  it('畸形参数不花上游配额：拒绝在读上游之前发生', async () => {
    for (const url of [
      arrivalsUrl('&order=4&count=abc'),
      arrivalsUrl('&count=6&order=abc'),
      arrivalsUrl('&direction=9&order=4&count=6'),
    ]) {
      const res = await api.inject({ method: 'GET', url })
      expect(res.statusCode, res.body).toBe(400)
    }
    // 边界无法表达其含义的请求不得花掉上游配额，更不得用一次 NaN 调用去作答。
    expect(api.upstream, 'a refused request still spent an upstream call').not.toHaveBeenCalled()
  })

  it('缺参是唯一不拒绝的情形：默认值照旧作答', async () => {
    answerWithEightBuses()

    const noCount = await api.inject({ method: 'GET', url: arrivalsUrl(`&order=${ORDER}`) })
    expect(noCount.statusCode, noCount.body).toBe(200)
    // 默认 6 条：夹具里有八辆车，五条或七条就是另一个默认值。
    expect(arrivalsRows(noCount).length, 'the absent-count default is no longer 6').toBe(6)

    const explicit = await api.inject({ method: 'GET', url: arrivalsUrl(`&order=${ORDER}&count=6`) })
    expect(arrivalsRows(explicit).length).toBe(6)

    const noOrder = await api.inject({ method: 'GET', url: arrivalsUrl('&count=6') })
    expect(noOrder.statusCode, noOrder.body).toBe(200)

    const noDirection = await api.inject({ method: 'GET', url: `/api/transit/lines/${LINE}/live` })
    expect(noDirection.statusCode, noDirection.body).toBe(200)
  })

  it('幽灵线路 id 在每条以线路为键的路线上 404，存在的线路照旧 200', async () => {
    // 上游没有记录的 id：四条路线说同一件事。
    for (const url of [
      `/api/transit/lines/${GHOST}`,
      `/api/transit/lines/${GHOST}/live`,
      `/api/transit/lines/${GHOST}/stations/${encodeURIComponent(STATION)}/arrivals`,
    ]) {
      const res = await api.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} answered ${res.statusCode} for a line the upstream does not know`).toBe(404)
      expect(res.json().success, url).toBe(false)
      expect(res.json().data, 'a refusal must not hand back a value').toBeUndefined()
    }

    // 正对照：同一条路线上，存在的线路答 200 —— 上面的 404 是关于线路的，不是一刀切。
    answerWithEightBuses()
    const real = await api.inject({ method: 'GET', url: `/api/transit/lines/${LINE}/live` })
    expect(real.statusCode, real.body).toBe(200)
  })

  it('重复关注 409：答复带着本服务端持有的那一行，库里也只有一行', async () => {
    const lineId = api.fixtureId('line')
    const payload = { cityCode: '027', lineId, lineName: '夹具线路', reverseLineId: `${lineId}-r` }

    const first = await api.inject({ method: 'POST', url: '/api/transit/favorites', payload })
    expect(first.statusCode, first.body).toBe(200)
    const heldId = first.json().data.id as string

    const again = await api.inject({ method: 'POST', url: '/api/transit/favorites', payload })
    expect(again.statusCode, `a duplicate follow was served as a new one: ${again.body}`).toBe(409)
    const body = again.json()
    expect(body.success).toBe(false)
    expect(body.alreadyFollowed, 'the refusal must say the line is already followed').toBe(true)
    expect(body.error).toBe('已关注')
    // `data` 是**本服务端持有的那一行**：调用方要它才能把这条线路显示为已关注。
    expect(body.data.id, 'the refusal did not name the row it holds').toBe(heldId)

    const rows = await api.rows<{ n: number }>('SELECT count(*)::int AS n FROM user_favorite_lines')
    expect(
      rows[0]!.n,
      store === 'sql' ? 'a duplicate follow landed a second row' : '内存路径不该在库里留下行',
    ).toBe(store === 'sql' ? 1 : 0)
  })

  it('PATCH 一个不存在的关注 id 是 404，不是一个编出来的行', async () => {
    const res = await api.inject({
      method: 'PATCH',
      url: '/api/transit/favorites/3f1c2f9e-0000-4000-8000-0000000000ff',
      payload: { isPinned: true },
    })
    expect(res.statusCode, res.body).toBe(404)
    expect(res.json().success).toBe(false)
  })
})
