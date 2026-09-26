import { afterEach, beforeEach, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 哨兵值只在一处解析，且不得被印成数字。
 *
 * 上游用哨兵表达「不是数值」这件事，本仓库对每一种都只有一个处置处：
 *
 *  - `distanceToWaitStn === -1`（车来了：这辆车**已过**目标站）—— 它在
 *    `TransitService.vehicleArrivals` 里被读成「这一行不属于本次读数」，因此那辆车不出现在
 *    到达行里，也绝不会以 `-1` 的形式出现在响应的任何数字里；
 *  - `travelTime === 0`（上游自己的事实：车正停在被请求的站上）—— 0 说的是**位置**，
 *    不是时长，因此那一行是「正在进站」而不是「0 分钟」；
 *  - `(0, 0)` 锚点对（设备定位失败时报的值）—— 在写入边界 `anchorPatchToGcj02` 里成对拒绝，
 *    既不入库也不参与换算；单轴为 0 是真实坐标，照旧合法。
 *
 * 正对照与拒绝同等重要：同一批读数里没有被标哨兵的车照常出行 —— 否则「哨兵车没出现」这条
 * 断言在一个空夹具上也成立，什么也没说明。
 */
describeEachStore('哨兵值只在一处解析：0 与 -1 都不是数字', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  const LINE = 'line_027_1'
  const STATION = '丁路'
  /** 读数定价到的那一站：夹具的第四站。 */
  const ORDER = 4
  const STATIONS = ['甲路', '乙路', '丙路', '丁路', '戊路'].map((name, idx) => ({
    sId: `s${idx + 1}`,
    sn: name,
    order: idx + 1,
    lat: 39.9 + idx * 0.01,
    lng: 116.4 + idx * 0.01,
  }))

  /** 让上游答这条线路的读数；`buses` 就是此刻的在途车辆（原样进桩，不加工）。 */
  function answerWith(buses: unknown[]): void {
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
              buses,
            },
          },
        }),
      }
    })
  }

  const arrivals = () => api.inject({
    method: 'GET',
    url: `/api/transit/lines/${LINE}/stations/${encodeURIComponent(STATION)}/arrivals`
      + `?direction=0&cityCode=027&order=${ORDER}&count=6`,
  })

  /** 载荷里出现过的每一个数字，递归取出来 —— 哨兵一旦被印出数字就在这里现形。 */
  function numbersIn(value: unknown, out: number[] = []): number[] {
    if (typeof value === 'number') out.push(value)
    else if (Array.isArray(value)) for (const item of value) numbersIn(item, out)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) numbersIn(item, out)
    return out
  }

  it('已过目标站的哨兵车不出现在到达行里，同批别的车照常出行', async () => {
    answerWith([
      { busId: 'b-served', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 120 }] },
      // 上游说这辆车已过目标站：它不是一行读数，也不是一行 -1。
      { busId: 'b-passed', order: ORDER, speed: 5, distanceToWaitStn: -1, travels: [{ order: ORDER, travelTime: 90 }] },
    ])

    const res = await arrivals()
    expect(res.statusCode, res.body).toBe(200)
    const rows = res.json().data.arrivals as Array<{ busId: string }>

    // 正对照先成立：这批读数里有车正开向这一站，下面那条「哨兵车没出现」才有意义。
    expect(rows.map(row => row.busId), 'the sentinel bus was served as a reading').toEqual(['b-served'])
  })

  it('哨兵不印出数字：整个到达载荷里没有一个 -1', async () => {
    answerWith([
      { busId: 'b-served', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 120 }] },
      { busId: 'b-passed', order: ORDER, speed: 5, distanceToWaitStn: -1, travels: [{ order: ORDER, travelTime: 90 }] },
    ])

    const res = await arrivals()
    expect(res.statusCode, res.body).toBe(200)

    // 哨兵的含义在服务端就被消化掉了：它既不是一条读数，也不是一个可以照着用的数字。
    expect(numbersIn(res.json()), 'a sentinel was printed as a number').not.toContain(-1)
  })

  it('上游的 travelTime 0 说的是车在站台上，不是「0 分钟」', async () => {
    answerWith([
      { busId: 'b-served', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 120 }] },
      // 上游自己的 0：车正停在被请求的这一站上。
      { busId: 'b-at-platform', order: ORDER, speed: 0, travels: [{ order: ORDER, travelTime: 0 }] },
    ])

    const res = await arrivals()
    expect(res.statusCode, res.body).toBe(200)
    const rows = res.json().data.arrivals as Array<{
      busId: string
      time?: string
      etaSeconds?: number
      isAtStation?: boolean
    }>

    const atPlatform = rows.find(row => row.busId === 'b-at-platform')
    expect(atPlatform, 'the at-platform vehicle was not served at all').toBeTruthy()
    expect(atPlatform!.time, 'the place was printed as a clock').toBe('正在进站')
    expect(atPlatform!.time).not.toMatch(/\d{2}:\d{2}/)
    expect(atPlatform!.isAtStation, 'the at-platform observation must say so').toBe(true)
    expect(atPlatform!.etaSeconds, 'the upstream 0 is not minutes of travel').toBe(0)

    // 正对照：同一批读数里另一辆车带真分钟，照常给时刻 —— 上面那条不是「管线不出时刻」。
    const served = rows.find(row => row.busId === 'b-served')
    expect(served!.time, 'a vehicle with a stated travel time got no clock').toMatch(/^\d{2}:\d{2}$/)
  })

  it('(0, 0) 的锚点对被拒在边界上，且一行都没落进存储', async () => {
    // 两个锚点对走同一条规则：单轴为 0 是真实坐标，成对为 0 是定位失败。
    for (const pair of [
      { label: '家', lat: 'homeLat', lng: 'homeLng' },
      { label: '公司', lat: 'workLat', lng: 'workLng' },
    ]) {
      const res = await api.inject({
        method: 'PATCH',
        url: '/api/transit/settings?userId=fx-sentinel-anchor',
        payload: { [pair.lat]: 0, [pair.lng]: 0 },
      })
      expect(res.statusCode, `${pair.label}: ${res.body}`).toBe(400)
      expect(res.json().error, pair.label).toContain('定位失败')
    }

    // 哨兵没有被存下来 —— 不是「存了 0」：
    const saved = await api.rows<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_settings WHERE home_lat = 0 OR home_lng = 0 OR work_lat = 0 OR work_lng = 0',
    )
    expect(saved[0]!.n, 'a refused sentinel pair was stored as a coordinate').toBe(0)
  })

  it('单轴为 0 是坐标而不是哨兵：写入照常落在存储上', async () => {
    const res = await api.inject({
      method: 'PATCH',
      url: '/api/transit/settings?userId=fx-sentinel-single',
      payload: { homeLat: 0, homeLng: 116.4 },
    })
    expect(res.statusCode, `a single zero axis was refused: ${res.body}`).toBe(200)
    expect(res.json().data.homeLat, 'the zero axis was dropped instead of stored').not.toBeNull()
    expect(Number.isFinite(res.json().data.homeLat)).toBe(true)

    if (store === 'sql') {
      const rows = await api.rows<{ home_lat: string | null }>(
        'SELECT home_lat FROM user_settings WHERE user_id = $1',
        ['fx-sentinel-single'],
      )
      expect(rows, 'the write never reached the row it names').toHaveLength(1)
      expect(rows[0]!.home_lat, 'a real zero axis was stored as nothing').not.toBeNull()
    }
  })

  it('读数真的经过存储的线路缓存（SQL 路径）', async () => {
    // 差分：这条读数读的是线路详情，SQL 路径会把它落进缓存表；内存路径不该在库里留行。
    answerWith([{ busId: 'b-served', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 120 }] }])
    const res = await arrivals()
    expect(res.statusCode, res.body).toBe(200)

    const cached = await api.rows<{ line_id: string }>('SELECT line_id FROM cached_transit_lines WHERE line_id = $1', [LINE])
    expect(
      cached,
      store === 'sql' ? '读数没有经过存储的线路缓存' : '内存路径不该在库里留下行',
    ).toHaveLength(store === 'sql' ? 1 : 0)
  })
})
