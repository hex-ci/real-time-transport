import { afterEach, beforeEach, expect, it } from 'vitest'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * 通勤时段的一次读有三个互不相同的状态，它们不能互换（`docs/PRD.md` §4.1）：
 * 没存过行（`unset` + `data: null`）、存过行但四个时刻全空（`unchosen`）、已选时段（`stored`）。
 *
 * 这里唯一的失败模式是**用内置默认值冒充使用者的配置**：只写了锚点的行若读出一组内置时刻，
 * 使用者会看到一套自己从未选过、也无法与真选过的区分开的时段。因此每例都断言读到的**值**，
 * 而不只是 `success` 或状态词。
 *
 * 同一份主体对内存与 SQL 各跑一遍：两条路径的 NULL 语义不同（`NULL` 列 vs 内存行字段），
 * 「没存过」与「存过但没选」的区分必须两边都成立。
 */

/** 四个时刻都用实测之外的字面量：与任何内置默认值都不像，冒充时一眼看得出。 */
const CHOSEN = {
  morningStart: '05:40',
  morningEnd: '07:25',
  eveningStart: '20:10',
  eveningEnd: '22:55',
}

const HOUR_KEYS = ['morningStart', 'morningEnd', 'eveningStart', 'eveningEnd'] as const

describeEachStore('通勤时段的三态', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  async function readSettings(): Promise<{ settingsState: string, data: Record<string, unknown> | null }> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/settings' })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as { settingsState: string, data: Record<string, unknown> | null }
  }

  async function readWindowState(): Promise<{ windowState: string, description: string }> {
    const res = await api.inject({ method: 'GET', url: '/api/transit/commute-profile' })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: { windowState: string, description: string } }).data
  }

  /** 只写锚点：这一次 PATCH 不命名任何时刻，因此一个时刻都不该从读侧冒出来。 */
  async function writeAnchorsOnly() {
    const res = await api.inject({
      method: 'PATCH',
      url: '/api/transit/settings',
      payload: { homeLat: 39.9, homeLng: 116.4 },
    })
    expect(res.statusCode, res.body).toBe(200)
  }

  it('第一态：从没存过行 —— unset、data 为 null、档案说未设置', async () => {
    expect(await readSettings()).toEqual({ success: true, settingsState: 'unset', data: null })

    const profile = await readWindowState()
    expect(profile.windowState).toBe('unset')
    expect(profile.description).toBe('未设置通勤时段')

    // SQL 路径的「没存过」就是库里没有这一行；内存路径本来就不该在库里留下行。
    expect(await api.rows('SELECT user_id FROM user_settings')).toHaveLength(0)
  })

  it('第二态：存过行但没选过时刻 —— unchosen、四个时刻都是 null，不给内置时段', async () => {
    await writeAnchorsOnly()

    const settings = await readSettings()
    expect(settings.settingsState).toBe('stored')
    expect(settings.data, '存过的行必须答出内容，而不是 null').not.toBeNull()
    for (const key of HOUR_KEYS) {
      expect(settings.data![key], `${key} 被填上了使用者没选过的时刻`).toBeNull()
    }

    const profile = await readWindowState()
    expect(profile.windowState).toBe('unchosen')
    expect(profile.description).toBe('未设置通勤时段')

    if (store === 'sql') {
      const rows = await api.rows<Record<string, unknown>>(
        'SELECT morning_start, morning_end, evening_start, evening_end FROM user_settings',
      )
      expect(rows).toHaveLength(1)
      for (const key of ['morning_start', 'morning_end', 'evening_start', 'evening_end']) {
        expect(rows[0]![key]).toBeNull()
      }
    }
  })

  it('第三态：已选时段 —— stored，读回的就是选下的那两组', async () => {
    const wrote = await api.inject({ method: 'PATCH', url: '/api/transit/settings', payload: CHOSEN })
    expect(wrote.statusCode, wrote.body).toBe(200)

    const settings = await readSettings()
    expect(settings.settingsState).toBe('stored')
    for (const key of HOUR_KEYS) {
      expect(settings.data![key]).toBe(CHOSEN[key])
    }

    const profile = await readWindowState()
    expect(profile.windowState).toBe('stored')
    // 文案命名的是时段这回事，绝不说「未设置」；具体落在哪个时段由墙钟决定，不进断言。
    expect(['早通勤时段', '晚通勤时段', '非通勤时段']).toContain(profile.description)
  })

  it('三个状态的读法两两不同', async () => {
    const unset = await readWindowState()
    await writeAnchorsOnly()
    const unchosen = await readWindowState()
    await api.inject({ method: 'PATCH', url: '/api/transit/settings', payload: CHOSEN })
    const stored = await readWindowState()

    expect(new Set([unset.windowState, unchosen.windowState, stored.windowState]).size).toBe(3)
    expect([unset.windowState, unchosen.windowState, stored.windowState])
      .toEqual(['unset', 'unchosen', 'stored'])
  })

  it('半个时段写不进来（400）：三态之外没有第四个状态', async () => {
    const rejected = await api.inject({
      method: 'PATCH',
      url: '/api/transit/settings',
      payload: { morningStart: '07:00' },
    })
    expect(rejected.statusCode, rejected.body).toBe(400)

    // 被拒的写什么都没留下：状态仍是第一态。
    expect((await readSettings()).settingsState).toBe('unset')
    expect(await api.rows('SELECT user_id FROM user_settings')).toHaveLength(0)
  })

  it('清空时段回到第二态，落回的是「没选过」而不是内置时段', async () => {
    await api.inject({ method: 'PATCH', url: '/api/transit/settings', payload: CHOSEN })
    const cleared = await api.inject({
      method: 'PATCH',
      url: '/api/transit/settings',
      payload: { morningStart: null, morningEnd: null, eveningStart: null, eveningEnd: null },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)

    const settings = await readSettings()
    expect(settings.settingsState).toBe('stored')
    for (const key of HOUR_KEYS) expect(settings.data![key]).toBeNull()
    expect((await readWindowState()).windowState).toBe('unchosen')
  })
})
