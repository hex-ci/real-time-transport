import { afterEach, beforeEach, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 零假数据：上游不给分钟，响应里就不出现分钟字段。
 *
 * 位置/停站推算一个分钟都不许给。给不出上游到达时刻的行仍然是一行读数 —— 车确实在途 ——
 * 但它没有数字可印：`etaSeconds` 与 `time` 两个键都不存在，`provenance` 为 null（标记限定
 * 的是一个数字，这一行没有数字）。**不是** 0，也**不是** null：三个都是「一个可以照着用的
 * 分钟」的不同写法，而这里根本没有人发布过分钟。
 *
 * 正对照（同一条路线、同一批读数里的另一辆车带上游真分钟）与缺分钟同等重要：它证明
 * 「没有 `etaSeconds`」是那次沉默的结果，而不是这条管线一律不出分钟。
 */
describeEachStore('零假数据：上游不给分钟就不出现分钟字段', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  const LINE = 'line_027_1'
  const STATION = '丁路'
  const ORDER = 4
  const STATIONS = ['甲路', '乙路', '丙路', '丁路', '戊路'].map((name, idx) => ({
    sId: `s${idx + 1}`,
    sn: name,
    order: idx + 1,
    lat: 39.9 + idx * 0.01,
    lng: 116.4 + idx * 0.01,
  }))

  /** 让上游答这条线路的读数；`buses` 原样进桩，因此「上游没说什么」也照原样。 */
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

  interface ArrivalRow {
    busId: string
    time?: string
    etaSeconds?: number
    stopsAway?: number
    provenance?: string | null
  }

  async function rowsOf(): Promise<ArrivalRow[]> {
    const res = await api.inject({
      method: 'GET',
      url: `/api/transit/lines/${LINE}/stations/${encodeURIComponent(STATION)}/arrivals`
        + `?direction=0&cityCode=027&order=${ORDER}&count=6`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data.arrivals as ArrivalRow[]
  }

  it('上游没有发布到站时间的车：行还在，分钟与时刻都不在', async () => {
    // 这辆车在途、正开向这一站，而上游对它的到达时刻什么都没说（没有 travels 条目）。
    answerWith([{ busId: 'b-silent', order: ORDER, speed: 5 }])
    const rows = await rowsOf()

    expect(rows, 'the vehicle in transit should still be a row').toHaveLength(1)
    const row = rows[0]!
    expect(row.busId, 'the row must still name the vehicle it observed').toBe('b-silent')
    expect(row.stopsAway, 'the observation it did make travels with it').toBe(1)

    // 键本身不存在 —— 不是 0，也不是 null：那两种都是「一个可以照着用的分钟」。
    expect('etaSeconds' in row, 'a minute nobody published was served').toBe(false)
    expect('time' in row, 'a clock nobody published was served').toBe(false)
    expect(row.etaSeconds, 'a minutes-shaped placeholder was served').toBeUndefined()
    expect(row.time).toBeUndefined()
    expect(row.provenance, 'a provenance mark rode on a row that states no number').toBeNull()
  })

  it('正对照：同一路线上带真分钟的车照常给分钟与实时标记', async () => {
    answerWith([{ busId: 'b-stated', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 300 }] }])
    const rows = await rowsOf()

    expect(rows).toHaveLength(1)
    expect(rows[0]!.etaSeconds, 'the minute the payload carried was swallowed').toBe(300)
    expect(rows[0]!.time).toMatch(/^\d{2}:\d{2}$/)
    expect(rows[0]!.provenance, 'a served minute must be marked as 实时').toBe('live')
  })

  it('同一批读数里两种行并存：沉默的那一行不会借到相邻车辆的分钟', async () => {
    answerWith([
      { busId: 'b-stated', order: ORDER, speed: 5, travels: [{ order: ORDER, travelTime: 120 }] },
      { busId: 'b-silent', order: ORDER, speed: 5 },
    ])
    const rows = await rowsOf()

    const silent = rows.find(row => row.busId === 'b-silent')
    const stated = rows.find(row => row.busId === 'b-stated')
    expect(silent, 'the silent vehicle was dropped instead of served as an observation').toBeTruthy()
    expect(stated, 'the stated vehicle was not served').toBeTruthy()

    // 沉默的行既没有数字也没有标记；有数字的那一行两样都有。二者不可互换。
    expect('etaSeconds' in silent!, 'the silent row borrowed a minute').toBe(false)
    expect(silent!.provenance).toBeNull()
    expect(stated!.etaSeconds).toBe(120)
    expect(stated!.provenance).toBe('live')
  })

  it('差分：这条读数经过存储的线路缓存（SQL 路径）', async () => {
    answerWith([{ busId: 'b-silent', order: ORDER, speed: 5 }])
    await rowsOf()

    const cached = await api.rows<{ line_id: string }>(
      'SELECT line_id FROM cached_transit_lines WHERE line_id = $1',
      [LINE],
    )
    expect(
      cached,
      store === 'sql' ? '读数没有经过存储的线路缓存' : '内存路径不该在库里留下行',
    ).toHaveLength(store === 'sql' ? 1 : 0)
  })
})
