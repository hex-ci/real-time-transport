import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D2 在 HTTP 边界：PRESENT 但不是行数的 `count` 被拒绝，而不是被悄悄变成一块空站牌。
 *
 * 与本仓库已在边界拒绝的 `direction` 和 `order` 同族：答案携带的值必须是调用方陈述的值，
 * 否则就不该有答案。畸形的值会让 `Math.min(Number('abc'), 20)` —— 即 NaN —— 流进
 * `vehicleArrivals(...).slice(0, NaN)`，也就是 `[]`：一个读起来正好像「这条线路此刻没有
 * 车」的空状态。
 *
 * 两面都钉住：畸形值 400 并点名可接受的形式，合法值照旧答出行。缺参也钉住，因为它是唯一
 * 不是拒绝的情形 —— 它保持今天的默认值。
 *
 * 甲路..辛路 与 `line_027_1` 都是占位：这里不出现任何真实线路或上游 id，也触不到任何上游
 * —— 下面的每次读取都是替身。
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LINE_ID = 'line_027_1'
/** 下面这些读数关于的站台：夹具的第四站。 */
const STATION = '丁路'
const STATION_ORDER = 4

const STATIONS = ['甲路', '乙路', '丙路', '丁路', '戊路', '己路', '庚路', '辛路'].map((name, idx) => ({
  sId: `s${idx + 1}`,
  sn: name,
  order: idx + 1,
  lat: 39.9 + idx * 0.01,
  lng: 116.4 + idx * 0.01,
}))

/**
 * 这条线路的上游答案：线路存在、站点已知，八辆车正开向第四站并带陈述过的行程时间 —— 所以
 * 正确的到达答案是一串行，其长度等于调用方要的 `count`（最多到存在的八辆），空列表只能是
 * 编造。八辆而不是一辆：只有一辆车时 `count=6`、`count=1` 与缺参都答同样的一行，任何对行
 * 的断言都分不出路由的默认值与调用方陈述的值。
 */
function stubUpstream(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
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
              travels: [{ order: STATION_ORDER, travelTime: 60 * (idx + 1) }],
            })),
          },
        },
      }),
    }
  }))
}

function arrivalsUrl(query: string): string {
  return `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION)}/arrivals`
    + `?direction=0&cityCode=027&order=${STATION_ORDER}${query}`
}

function rowsOf(body: string): unknown[] {
  return (JSON.parse(body).data?.arrivals ?? []) as unknown[]
}

describe('G-D2: a malformed count is refused at the boundary', () => {
  it('answers rows for a valid count, so the refusal below is not measured on an empty fixture', async () => {
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=6') })
      expect(res.statusCode, res.body).toBe(200)
      // 夹具自己的对照：这条线路确实有车正开向这个
      // 站台，所以下一条断言里的 0 行只可能来自 count。
      expect(rowsOf(res.body).length, res.body).toBeGreaterThan(0)
    }
    finally {
      await app.close()
    }
  })

  it('answers 400 naming the accepted form for every malformed spelling', async () => {
    for (const raw of ['abc', '0', '-1', '3.7', '1e2', '0x6', '', ' ', '+6', '6.0', '21', '999']) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url: arrivalsUrl(`&count=${encodeURIComponent(raw)}`) })
        expect(res.statusCode, `count=${JSON.stringify(raw)} was accepted`).toBe(400)
        const body = JSON.parse(res.body)
        expect(body.success, `count=${JSON.stringify(raw)}`).toBe(false)
        // 拒绝点名了所在的域，调用方不必读源码
        // 就能改对请求。
        expect(body.error, `count=${JSON.stringify(raw)}`).toContain('count')
        expect(body.error, `count=${JSON.stringify(raw)}`).toContain('20')
      }
      finally {
        await app.close()
      }
    }
  })

  it('refuses before any upstream is read', async () => {
    stubUpstream()
    const app = await buildApp({})
    try {
      await app.inject({ method: 'GET', url: arrivalsUrl('&count=abc') })
      // 边界无法表达其含义的请求不得花掉上游配额 —— 也不能
      // 用一次 NaN 调用去作答。
      expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    }
    finally {
      await app.close()
    }
  })

  it('never answers 200 with an empty board for a malformed count', async () => {
    // 线路有车时答 200 + 0 行是必须避免的形状。作为独立用例
    // 陈述，因为只看状态的断言可以被一个仍然答了响应体的
    // 拒绝满足。
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=abc') })
      const accidentallyEmpty = res.statusCode === 200 && rowsOf(res.body).length === 0
      expect(accidentallyEmpty, `a fabricated empty board was served: ${res.body}`).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D2: the domain itself, both halves', () => {
  it('answers rows for every count in 1..20', async () => {
    for (const count of Array.from({ length: 20 }, (_, i) => i + 1)) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const res = await app.inject({ method: 'GET', url: arrivalsUrl(`&count=${count}`) })
        expect(res.statusCode, `count=${count}`).toBe(200)
        // 存在八辆车，所以不超过八的 count 就是那么多行：
        // 调用方陈述的值就是它拿到的长度，而忽略 `count` 的路由
        // 在一行的那些情形下也会答八行。
        expect(rowsOf(res.body).length, `count=${count}`).toBe(Math.min(count, 8))
      }
      finally {
        await app.close()
      }
    }
  })

  it('does not answer more rows than the upper bound allows', async () => {
    // 路由本来就隐含的上界（`Math.min(..., 20)`），现在被说出来
    // 而不是默默施加。这个夹具只有一辆车，所以行数分不出两个
    // 上界 —— 钉住的是边界拒绝一个 ABOVE 上界的值，
    // 而不是悄悄把它截断。
    stubUpstream()
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: arrivalsUrl('&count=25') })
      expect(res.statusCode, res.body).toBe(400)
    }
    finally {
      await app.close()
    }
  })

  it('keeps today\'s default when count is ABSENT', async () => {
    // 唯一不是拒绝的情形：没有陈述 count，于是由路由自己的
    // 默认值决定。用长度对着夹具携带的八辆车钉住，
    // 所以默认值一旦改变必须在这里说明：路由答的是六行，
    // 五行或七行就是另一个默认值。
    stubUpstream()
    const app = await buildApp({})
    try {
      const absent = await app.inject({ method: 'GET', url: arrivalsUrl('') })
      expect(absent.statusCode, absent.body).toBe(200)
      expect(rowsOf(absent.body).length, 'the absent-count default is no longer 6').toBe(6)
      // 两次读取走的是同一个构建：实时缓存可能答第二
      // 次，这没问题 —— 两种情况下行都是同一个读数。
      const explicit = await app.inject({ method: 'GET', url: arrivalsUrl('&count=6') })
      expect(rowsOf(absent.body)).toEqual(rowsOf(explicit.body))
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D2: the same route\'s other parameters are held to the same rule', () => {
  it('refuses a malformed order instead of dropping it', async () => {
    // `order` 是读数所定价的站，这条路由过去用 `Number(q.order)` 读它：
    // `?order=abc` 变成 NaN，没过服务的 `typeof === 'number' && > 0` 判断，
    // 被悄悄丢掉 —— 调用方问的是一个站台，答的却是整条线路。
    // 实时路由本来就拒绝它（`targetOrderQueryOf`）；这条现在也一致。
    for (const raw of ['abc', '0', '-1', '2.5']) {
      stubUpstream()
      const app = await buildApp({})
      try {
        const url = `/api/transit/lines/${LINE_ID}/stations/${encodeURIComponent(STATION)}/arrivals`
          + `?direction=0&cityCode=027&count=6&order=${encodeURIComponent(raw)}`
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode, `order=${JSON.stringify(raw)} was accepted`).toBe(400)
        expect(JSON.parse(res.body).error).toContain('order')
      }
      finally {
        await app.close()
      }
    }
  })
})
