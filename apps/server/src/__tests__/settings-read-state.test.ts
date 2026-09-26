import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D3 在 HTTP 边界：设置读取要说清到底有没有存下来的行，而追问通勤窗口的那些界面走的是
 * 诚实的那条分支。
 *
 * 规则本身在 `apps/web/src/read-state.ts` §4.1（读失败与确实为空必须分得开）。修法是同一
 * 形状降一层：响应用一个**词**携带这次的读取状态，未设置行的值就是「什么都没有」—— 于是
 * 忽略这个词的消费者不可能印出看似合理的时刻，只能印出明显为空的。
 *
 * 两面都钉住：未设置的读取说 'unset' 且无行，存过的读取说 'stored' 并带上读到的行。正对照
 * 与 G-D1 一样重要：一刀切的「没有设置」会打断每一个配置过的用户。
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 把时钟冻结在北京的墙上时间。 */
function freezeAt(isoLocal: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${isoLocal}+08:00`))
}

async function readSettings(app: Awaited<ReturnType<typeof buildApp>>, userId?: string) {
  const url = userId ? `/api/transit/settings?userId=${encodeURIComponent(userId)}` : '/api/transit/settings'
  const res = await app.inject({ method: 'GET', url })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { success: boolean, settingsState?: string, data: unknown }
}

async function readProfile(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().data as { mode: string, description: string, windowState?: string }
}

async function saveSettings(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/transit/settings', payload: body })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

describe('G-D3: a read that found nothing says so, and carries nothing to print', () => {
  it('answers state=unset with NO row for a user who never saved anything', async () => {
    const app = await buildApp({})
    try {
      const body = await readSettings(app, 'never_saved_user')

      expect(body.settingsState, body.data === undefined ? 'the answer carries no state at all' : undefined).toBe('unset')
      // 值这一层什么也不说，所以忽略状态的消费者印出的是
      // 空行，而不是一行看似合理的东西。
      expect(body.data).toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('carries none of the built-in hours in an unset answer', async () => {
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: '/api/transit/settings?userId=never_saved_user' })
      const raw = res.body

      // 这条规则最强的形式：内置的 06:30–11:30 / 17:00–22:00
      // 不许出现在载荷里的任何地方。会传出去的默认值就是
      // 某个界面会当成使用者自己的配置印出来的默认值。
      for (const invented of ['06:30', '11:30', '17:00', '22:00']) {
        expect(raw.includes(invented), `the unset answer carries ${invented}`).toBe(false)
      }
    }
    finally {
      await app.close()
    }
  })

  it('answers state=stored with the row it read for a user who saved hours', async () => {
    const app = await buildApp({})
    try {
      await saveSettings(app, { morningStart: '07:15', morningEnd: '09:45' })

      const body = await readSettings(app)
      expect(body.settingsState).toBe('stored')
      expect(body.data).toMatchObject({ morningStart: '07:15', morningEnd: '09:45' })
    }
    finally {
      await app.close()
    }
  })

  it('keeps 未设置 and 未读到 apart: an unset row is a 200 with a state, not a failure', async () => {
    const app = await buildApp({})
    try {
      const res = await app.inject({ method: 'GET', url: '/api/transit/settings?userId=never_saved_user' })
      const body = JSON.parse(res.body)

      // §4.1 的两个状态靠状态码与应用已有的 `success` 标志
      // 区分：读取失败时什么都没读到，而这次读取
      // 是作答了 —— 它没找到行。
      expect(res.statusCode).toBe(200)
      expect(body.success).toBe(true)
      expect(body.error).toBeUndefined()
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D3: the commute profile does not invent a window the user never set', () => {
  it('answers state=unset and names no commute window for a user who never saved one', async () => {
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({})
    try {
      const profile = await readProfile(app)

      expect(profile.windowState).toBe('unset')
      // 08:30 落在那段内置早高峰里，而这正是这个答案
      // 不能声称它的原因：没有人配置过窗口。
      expect(profile.mode).not.toBe('work')
      expect(profile.description).not.toContain('早通勤时段')
    }
    finally {
      await app.close()
    }
  })

  it('answers state=stored and the window it is in for a user who saved one', async () => {
    freezeAt('2026-09-24T08:30:00')
    const app = await buildApp({})
    try {
      await saveSettings(app, { morningStart: '08:00', morningEnd: '09:00' })

      const profile = await readProfile(app)
      expect(profile.windowState).toBe('stored')
      expect(profile.mode).toBe('work')
      expect(profile.description).toBe('早通勤时段')
    }
    finally {
      await app.close()
    }
  })

  it('names the window it is outside of, for a stored row the clock is not in', async () => {
    freezeAt('2026-09-24T15:00:00')
    const app = await buildApp({})
    try {
      await saveSettings(app, { morningStart: '07:00', morningEnd: '09:00' })

      const profile = await readProfile(app)
      expect(profile.windowState).toBe('stored')
      expect(profile.mode).toBe('auto')
      expect(profile.description).toBe('非通勤时段')
    }
    finally {
      await app.close()
    }
  })
})

describe('G-D3: the departure reference keeps its own honest answer with no stored row', () => {
  /** 一条存在的公交线路，有一辆车正开向第 4 站。 */
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

  async function arrivals(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/lines/line_027_1/stations/%E4%B8%81%E8%B7%AF/arrivals?direction=0&count=3&order=4&cityCode=027',
    })
    expect(res.statusCode, res.body).toBe(200)
    return res
  }

  it('names the anchor to go and set, and spends no walk on it', async () => {
    // F1 的参考行通过通勤窗口解析「你在哪里」指哪个锚点。
    // 没有存下来的行时，就不存在属于使用者的窗口，于是引擎
    // 用它自己的具名跨度 —— 与 `serviceWindowSeconds` 对没人
    // 声明时刻的线路所用的同一模式 —— 而它给出的答案是可行动的那个：
    // 这一段乘车的锚点从未存过（真话：没有行就等于根本没有存下的
    // 锚点，所以无论它点名哪一段，这句话都成立）。
    //
    // 不许发生的是内置窗口作为配置传出去。
    freezeAt('2026-09-24T08:30:00')
    stubBusLine()
    const app = await buildApp({})
    try {
      const res = await arrivals(app)
      const data = JSON.parse(res.body).data

      expect(data.reference).toEqual({ status: 'anchor-unset', anchor: 'home' })
      // 没有步行请求：这句话说的是存下来的行。
      expect(vi.mocked(fetch).mock.calls.filter(c => !String(c[0]).includes('encryptedLineDetail'))).toHaveLength(0)
      for (const invented of ['06:30', '11:30', '17:00', '22:00']) {
        expect(res.body.includes(invented), `the arrivals answer carries ${invented}`).toBe(false)
      }
    }
    finally {
      await app.close()
    }
  })

  it('draws no conclusion outside the span the engine uses for an unconfigured user', async () => {
    // 15:00 落在引擎自己的跨度划出的两个窗口之间，而没有
    // 存下来的行时，关于使用者在哪里没有任何话可说：
    // 参考行就是缺失，而不是拿一段编出来的乘车去定价。
    freezeAt('2026-09-24T15:00:00')
    stubBusLine()
    const app = await buildApp({})
    try {
      const data = JSON.parse((await arrivals(app)).body).data
      expect(data.reference).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})
