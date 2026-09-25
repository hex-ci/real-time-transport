import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { Database } from '../db/client.js'

/**
 * T2 — 「行在，但四个通勤时刻从未被选过」必须可表达、可报告。
 *
 * 004 给四列声明了 NOT NULL DEFAULT（06:30 / 11:30 / 17:00 / 22:00），于是「只存锚点」
 * 这个写入会把内置时段当真存下来：读侧分得清「没有这一行」，却分不清「行在、时刻用户从没
 * 选过」—— 两件事读出来字节相同，而其中一件是把默认值冒充使用者自己的配置。009 让 NULL
 * 表示「从未选择」，这条测试就是那个状态的四个面：
 *
 *  (a) 只写锚点：四个时刻是 NULL，读侧如实报告，响应体里没有任何内置时刻；
 *  (b) 正对照：选了时刻就存下来、读得回来（一刀切的「什么都返回 null」同样不成立）；
 *  (c) 读-改-写合并：只写锚点不抹掉已选的时刻，只写时刻不抹掉已存的锚点；
 *  (d) 消费方：时刻未配置时，引擎自己的跨度照旧到达使用它的那条判断（锚点未存 → 让用户
 *      去设置），内置时刻一个都不许漏进响应；
 *  (e) 内存存储与 SQL 分支同一套语义（本仓库记录过「内存分支与 SQL 分支不一致」这个坑）。
 */

const BUILT_IN = ['06:30', '11:30', '17:00', '22:00'] as const

type App = Awaited<ReturnType<typeof buildApp>>

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Freeze the clock at a Beijing wall-clock time. */
function freezeAt(isoLocal: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${isoLocal}+08:00`))
}

async function patch(app: App, payload: Record<string, unknown>): Promise<{ status: number, body: string, json: any }> {
  const res = await app.inject({ method: 'PATCH', url: '/api/transit/settings', payload })
  return { status: res.statusCode, body: res.body, json: JSON.parse(res.body) }
}

async function read(app: App): Promise<{ status: number, body: string, json: any }> {
  const res = await app.inject({ method: 'GET', url: '/api/transit/settings' })
  return { status: res.statusCode, body: res.body, json: JSON.parse(res.body) }
}

async function profile(app: App): Promise<any> {
  const res = await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })
  expect(res.statusCode, res.body).toBe(200)
  return JSON.parse(res.body).data
}

/** A device fix in WGS-84, the form the browser sends — one anchor pair. */
const ANCHOR_PAYLOAD = { homeLat: 39.90931, homeLng: 116.3974 }

/** No payload field is a built-in hour, anywhere in the body. */
function expectNoBuiltInHours(body: string, where: string): void {
  for (const invented of BUILT_IN) {
    expect(body.includes(invented), `${where} carries the built-in ${invented}`).toBe(false)
  }
}

describe('(a) 只写锚点：四个时刻保持 NULL，读侧如实报告', () => {
  it('写入的响应里四个时刻是 null，不是内置时段', async () => {
    const app = await buildApp({})
    try {
      const saved = await patch(app, { ...ANCHOR_PAYLOAD })
      expect(saved.status, saved.body).toBe(200)

      for (const field of ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const) {
        expect(saved.json.data[field], `the anchors-only write invented ${field}`).toBeNull()
      }
      expectNoBuiltInHours(saved.body, 'the PATCH answer')
    }
    finally {
      await app.close()
    }
  })

  it('读回来还是四个 null，行仍然在（stored），并且响应体里没有任何内置时刻', async () => {
    const app = await buildApp({})
    try {
      await patch(app, { ...ANCHOR_PAYLOAD })
      const readBack = await read(app)

      expect(readBack.status, readBack.body).toBe(200)
      // 行在：锚点存进去了，这不是「未设置」那一档。
      expect(readBack.json.settingsState).toBe('stored')
      for (const field of ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const) {
        expect(readBack.json.data[field], `the read reported ${field} as a value`).toBeNull()
      }
      expect(readBack.json.data.homeLat).not.toBeNull()
      expectNoBuiltInHours(readBack.body, 'the settings read')
    }
    finally {
      await app.close()
    }
  })

  it('空 PATCH 造出的行同样是「时段从未选择」，不是内置时段', async () => {
    const app = await buildApp({})
    try {
      const saved = await patch(app, {})
      expect(saved.status, saved.body).toBe(200)
      expect(saved.json.data.morningStart).toBeNull()
      expectNoBuiltInHours(saved.body, 'the empty PATCH answer')
    }
    finally {
      await app.close()
    }
  })

  it('commute-profile 报告时段未配置，而不是把当时钟落进内置窗口', async () => {
    // 08:30 正落在内置早高峰里，而这恰恰是它不能声称的原因：没有人配置过窗口。
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({})
    try {
      await patch(app, { ...ANCHOR_PAYLOAD })
      const data = await profile(app)

      expect(data.windowState, 'a row whose hours were never chosen was reported as a stored window').toBe('unchosen')
      expect(data.mode).toBe('auto')
      expect(data.description).toBe('未设置通勤时段')
    }
    finally {
      await app.close()
    }
  })
})

describe('(b) 正对照：选了时刻就存下来、读得回来', () => {
  it('一次写入四个时刻，读侧报 stored 且原样返回', async () => {
    const app = await buildApp({})
    try {
      const saved = await patch(app, {
        morningStart: '07:15',
        morningEnd: '09:45',
        eveningStart: '18:00',
        eveningEnd: '21:30',
      })
      expect(saved.status, saved.body).toBe(200)
      expect(saved.json.data).toMatchObject({
        morningStart: '07:15',
        morningEnd: '09:45',
        eveningStart: '18:00',
        eveningEnd: '21:30',
      })

      const readBack = await read(app)
      expect(readBack.json.settingsState).toBe('stored')
      expect(readBack.json.data).toMatchObject({
        morningStart: '07:15',
        morningEnd: '09:45',
        eveningStart: '18:00',
        eveningEnd: '21:30',
      })
    }
    finally {
      await app.close()
    }
  })

  it('只要一个窗口，另一个窗口仍然是「从未选择」', async () => {
    const app = await buildApp({})
    try {
      await patch(app, { morningStart: '07:15', morningEnd: '09:45' })
      const data = (await read(app)).json.data

      expect(data.morningStart).toBe('07:15')
      expect(data.morningEnd).toBe('09:45')
      // 没被写的那个窗口不许借内置值补上。
      expect(data.eveningStart, 'the untouched window was filled with the built-in value').toBeNull()
      expect(data.eveningEnd, 'the untouched window was filled with the built-in value').toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('commute-profile 在已配置窗口内报 stored 并说出是哪个时段', async () => {
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({})
    try {
      await patch(app, { morningStart: '08:00', morningEnd: '09:00' })
      const data = await profile(app)

      expect(data.windowState).toBe('stored')
      expect(data.mode).toBe('work')
      expect(data.description).toBe('早通勤时段')
    }
    finally {
      await app.close()
    }
  })
})

describe('(c) 读-改-写合并：一组字段的写入不动另一组', () => {
  it('只写时刻不会抹掉已存的锚点', async () => {
    const app = await buildApp({})
    try {
      await patch(app, { ...ANCHOR_PAYLOAD })
      const anchors = (await read(app)).json.data
      // NON-EMPTY FIRST: the comparison below would pass for free if the anchor had
      // never been stored and both sides were null.
      expect(anchors.homeLat, 'this test needs a stored anchor to protect').not.toBeNull()

      await patch(app, { morningStart: '07:15', morningEnd: '09:45' })
      const after = (await read(app)).json.data

      expect(after.morningStart).toBe('07:15')
      expect(after.homeLat, 'an hours-only write erased the anchor').toBe(anchors.homeLat)
      expect(after.homeLng).toBe(anchors.homeLng)
    }
    finally {
      await app.close()
    }
  })

  it('只写锚点不会把已经选过的时刻改回 NULL 或内置值', async () => {
    const app = await buildApp({})
    try {
      await patch(app, { morningStart: '07:15', morningEnd: '09:45' })
      await patch(app, { ...ANCHOR_PAYLOAD })

      const data = (await read(app)).json.data
      expect(data.morningStart, 'an anchors-only write reissued the hours').toBe('07:15')
      expect(data.morningEnd).toBe('09:45')
      expect(data.eveningStart, 'an anchors-only write invented the untouched window').toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

describe('(d) 时刻未配置时，引擎自己的跨度照旧到达消费方', () => {
  /** A bus line that exists, with one vehicle heading for the fourth stop. */
  function stubBusLine(): void {
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
              stations: ['甲路', '乙路', '丙路', '丁路'].map((name, idx) => ({
                sId: `s${idx + 1}`,
                sn: name,
                order: idx + 1,
                lat: 39.9 + idx * 0.01,
                lng: 116.4 + idx * 0.01,
              })),
              buses: [{ busId: 'b1', order: 3, speed: 5, travels: [{ order: 4, travelTime: 120 }] }],
            },
          },
        }),
      }
    }))
  }

  it('行在、时刻从未选择：跨度仍然决定问哪个锚点，并且不问 GPS 要一段路', async () => {
    // 引擎需要一个跨度才能枚举它问的是哪个锚点（和地铁引擎的 `serviceWindowSeconds`
    // 同一个模式），这个跨度是它自己的具名参数，不是使用者的时段。它必须照旧用得上：
    // 一个没有时刻的行，与一个没有行的人，问出来的句子都成立 —— 「未保存『家』位置」。
    freezeAt('2026-09-24T08:30:00')
    stubBusLine()
    const app = await buildApp({})
    try {
      await patch(app, {}) // 行在，四个时刻都是 NULL，也没有锚点
      const res = await app.inject({
        method: 'GET',
        url: '/api/transit/lines/line_027_1/stations/%E4%B8%81%E8%B7%AF/arrivals?direction=0&count=3&order=4&cityCode=027',
      })
      expect(res.statusCode, res.body).toBe(200)
      const data = JSON.parse(res.body).data

      expect(data.reference).toEqual({ status: 'anchor-unset', anchor: 'home' })
      // 这是关于存储行的一句话，不花任何上游请求。
      expect(vi.mocked(fetch).mock.calls.filter(c => !String(c[0]).includes('encryptedLineDetail'))).toHaveLength(0)
      expectNoBuiltInHours(res.body, 'the arrivals answer')
    }
    finally {
      await app.close()
    }
  })

  it('跨度之外不画结论，和没有行时一样', async () => {
    freezeAt('2026-09-24T15:00:00')
    stubBusLine()
    const app = await buildApp({})
    try {
      await patch(app, {})
      const res = await app.inject({
        method: 'GET',
        url: '/api/transit/lines/line_027_1/stations/%E4%B8%81%E8%B7%AF/arrivals?direction=0&count=3&order=4&cityCode=027',
      })
      expect(res.statusCode, res.body).toBe(200)
      expect(JSON.parse(res.body).data.reference).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

describe('(e) 内存存储与 SQL 分支同一套语义', () => {
  it('内存分支里，只写锚点的行四个时刻也是 null', async () => {
    const db = new Database()
    const saved = await db.saveUserSettings('mirror_probe', { homeLat: 39.9, homeLng: 116.4 })

    expect(saved.morningStart).toBeNull()
    expect(saved.eveningEnd).toBeNull()

    const readBack = await db.getUserSettings('mirror_probe')
    expect(readBack?.morningStart).toBeNull()
    expect(readBack?.homeLat).toBe(39.9)
  })

  it('内存分支里，只写时刻不会抹掉锚点、也不会给没写的窗口补内置值', async () => {
    const db = new Database()
    await db.saveUserSettings('mirror_probe', { homeLat: 39.9, homeLng: 116.4 })
    await db.saveUserSettings('mirror_probe', { morningStart: '07:15', morningEnd: '09:45' })

    const readBack = await db.getUserSettings('mirror_probe')
    expect(readBack?.morningStart).toBe('07:15')
    expect(readBack?.homeLat).toBe(39.9)
    expect(readBack?.eveningStart).toBeNull()
  })

  it('内存分支里，一个没写过的用户仍然没有行', async () => {
    const db = new Database()
    expect(await db.getUserSettings('never_saved_mirror_probe')).toBeNull()
  })
})
