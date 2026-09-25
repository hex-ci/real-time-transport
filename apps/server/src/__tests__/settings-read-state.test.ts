import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

/**
 * G-D3 at the HTTP boundary: a settings read says whether there is a stored row
 * at all, and the surfaces that ask for the commute window take the honest branch.
 *
 * Measured live: `GET /api/transit/settings?userId=never_saved_probe_xyz`
 * answered 200 with a complete, plausible set of windows —
 * `{morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00',
 * eveningEnd: '22:00', homeLat: null, ...}` — byte-identical to what a user who
 * HAD configured those hours would read, and marked as nothing. Every surface
 * downstream treated them as stored configuration: the 设置 index row printed
 * 「06:30–11:30 · 17:00–22:00」 as the user's own hours, and
 * `GET /api/transit/commute-profile` answered 「早通勤时段」 at 08:30 for a user
 * who had never opened 设置.
 *
 * `apps/web/src/read-state.ts` already states the rule this violates (§4.1:
 * 读失败与确实为空必须分得开). The fix is the same shape one level down: the
 * response carries the state of the read as a WORD, and the value of an unset
 * row as nothing at all — so a consumer that ignores the word cannot print
 * plausible hours, only an obviously empty one.
 *
 * Both halves are pinned: an unset read states 'unset' with no row, and a saved
 * read states 'stored' with the row it read. The positive control matters as much
 * here as in G-D1: a blanket \"no settings\" would break every configured user.
 */

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

/** GET /settings through the real route. */
async function readSettings(app: Awaited<ReturnType<typeof buildApp>>, userId?: string) {
  const url = userId ? `/api/transit/settings?userId=${encodeURIComponent(userId)}` : '/api/transit/settings'
  const res = await app.inject({ method: 'GET', url })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { success: boolean, settingsState?: string, data: unknown }
}

/** GET /commute-profile through the real route. */
async function readProfile(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'GET', url: '/api/transit/commute-profile' })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().data as { mode: string, description: string, windowState?: string }
}

/** PATCH the stored settings through the real endpoint. */
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
      // The value level says nothing, so a consumer that ignores the state prints
      // an empty row rather than a plausible one.
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

      // The strongest form of the rule: the built-in 06:30–11:30 / 17:00–22:00
      // must not appear ANYWHERE in the payload. A default that travels is a
      // default some surface will print as the user's own configuration — the
      // 设置 index row did exactly that.
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

      // §4.1's two states are told apart by the status and the `success` flag the
      // app already uses: nothing was read for a FAILED read, and this read
      // answered — it found no row.
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
      // 08:30 is inside the built-in morning window, and that is precisely why
      // this answer may not claim it: nobody configured one.
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

  async function arrivals(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/lines/line_027_1/stations/%E4%B8%81%E8%B7%AF/arrivals?direction=0&count=3&order=4&cityCode=027',
    })
    expect(res.statusCode, res.body).toBe(200)
    return res
  }

  it('names the anchor to go and set, and spends no walk on it', async () => {
    // F1's reference resolves which anchor means 「where you are」 through the
    // commute window. With NO stored row there is no window OF THE USER'S, so the
    // engine uses its own named span — the same pattern `serviceWindowSeconds`
    // uses for a line whose hours nobody stated — and the answer it gives is the
    // actionable one: this leg's anchor was never saved (真话: no row means no
    // stored anchor at all, so whichever leg it names, the sentence is true).
    //
    // What must NOT happen is the built-in window travelling as configuration.
    freezeAt('2026-09-24T08:30:00')
    stubBusLine()
    const app = await buildApp({})
    try {
      const res = await arrivals(app)
      const data = JSON.parse(res.body).data

      expect(data.reference).toEqual({ status: 'anchor-unset', anchor: 'home' })
      // No walking request: this is a statement about the stored row.
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
    // 15:00 is between the two windows the engine's own span draws, and with no
    // stored row there is nothing to tell the user about where they are: the
    // reference row is absent rather than priced from an invented leg.
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
