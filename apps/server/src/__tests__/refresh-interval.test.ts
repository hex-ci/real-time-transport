import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { RefreshLiveResultSchema } from '@real-time-transport/shared'
import { buildApp } from '../app.js'
import { Database } from '../db/client.js'
import {
  POLL_INTERVAL_SEC_DEFAULT,
  POLL_INTERVAL_SEC_MAX,
  POLL_INTERVAL_SEC_MIN,
  TransitService,
  normalizePollIntervalSec,
  resolvePollIntervalSec,
} from '../services/transit.service.js'

/**
 * 实时刷新间隔（014 的列、设置页那一页）的服务端契约。
 *
 * 三件事在这里钉住：
 *  - 取值被钳在 10~120 秒、非法输入回退 18 —— 下限保护上游（车来了 H5 刷太快有被限流的风险），
 *    上限免得太旧；
 *  - 手动刷新的冷却**就是**当前的节拍：窗口从**尝试**那一刻起算，跨过整段节拍才再次放行；
 *  - 热切换只改那三处同源的东西（轮询节拍、聚合器缓存 TTL、刷新冷却），不重启服务 ——
 *    判据是切换之后窗口的长度立刻跟着变。
 *
 * 本文件让上游一律不答（`fetch` 抛错）：它问的是节拍与窗口，不是读数。读不到的刷新照样
 * 花掉了这个窗口，故窗口长度照旧可断言。
 *
 * 最后一段用真 app 起服务，钉住「生效的节拍」这件事：`GET /api/transit/settings` 答出的
 * `effectiveRefreshIntervalSec` 必须**就是此刻在跑的那个数**（界面照它说「默认每 N 秒」），
 * 而清空选择之后它与重启后的答案一致。
 */

const T0 = '2026-09-24T08:30:00'
const T0_MS = new Date(T0).getTime()

function freezeAt(localIso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(localIso))
}

/** 一条线路的一次刷新请求。 */
const request = (userId = 'user-a') => ({
  userId,
  lines: [{ lineId: '101', direction: 0, cityCode: '027' }],
})

/** 一个新服务：上游不答，节拍按传入值。 */
function serviceWith(pollIntervalSec: number | undefined): TransitService {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('本文件不让上游作答')
  }))
  return new TransitService(new Database(undefined), { pollIntervalSec })
}

const opened = new Set<TransitService>()
function serviceWithTracked(pollIntervalSec: number | undefined): TransitService {
  const service = serviceWith(pollIntervalSec)
  opened.add(service)
  return service
}

afterEach(() => {
  for (const service of opened) service.stop()
  opened.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('实时刷新间隔的取值：10~120 秒，非法回退 18', () => {
  it('区间内的整数原样保留', () => {
    expect(normalizePollIntervalSec(10)).toBe(POLL_INTERVAL_SEC_MIN)
    expect(normalizePollIntervalSec(45)).toBe(45)
    expect(normalizePollIntervalSec(120)).toBe(POLL_INTERVAL_SEC_MAX)
  })

  it('越界被钳到两端，小数四舍五入', () => {
    expect(normalizePollIntervalSec(5)).toBe(POLL_INTERVAL_SEC_MIN)
    expect(normalizePollIntervalSec(500)).toBe(POLL_INTERVAL_SEC_MAX)
    expect(normalizePollIntervalSec(18.6)).toBe(19)
  })

  it('环境变量给的是字符串也算数', () => {
    expect(normalizePollIntervalSec('30')).toBe(30)
    expect(normalizePollIntervalSec(' 12 ')).toBe(12)
  })

  it('读不出数就回退默认，绝不写成 NaN 或 0', () => {
    for (const garbage of [undefined, null, 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizePollIntervalSec(garbage), `${String(garbage)} 没有被回退`).toBe(POLL_INTERVAL_SEC_DEFAULT)
    }
    // 空串是个例外：`Number('')` 是 0，于是它被钳到下限而不是回退默认。两个入口都到不了这里 ——
    // 环境变量那侧先做真值判断（空串走 undefined），PATCH 那侧由 schema 钳在 10~120。
    expect(normalizePollIntervalSec('')).toBe(POLL_INTERVAL_SEC_MIN)
  })
})

describe('节拍听谁的：设置页的选择 > 环境变量 > 启动参数 > 默认', () => {
  it('三处都给了：用设置页那个（用户的选择最高）', () => {
    expect(resolvePollIntervalSec({ stored: 10, fromEnv: '30', explicit: 60 })).toBe(10)
  })

  it('设置页没选过（NULL）：落到环境变量', () => {
    expect(resolvePollIntervalSec({ stored: null, fromEnv: '30', explicit: 60 })).toBe(30)
  })

  it('设置页与环境变量都没有：用启动参数', () => {
    expect(resolvePollIntervalSec({ stored: null, fromEnv: undefined, explicit: 60 })).toBe(60)
  })

  it('三处都没有：undefined，交给构造时落默认 18', () => {
    expect(resolvePollIntervalSec({})).toBeUndefined()
    expect(resolvePollIntervalSec({ stored: null, fromEnv: '', explicit: null })).toBeUndefined()
  })

  it('环境变量读不出数就当它没给，不吃掉后面的来源', () => {
    // 顺序若写成「先 Number(env) 再看是否有值」，`abc`/`0`/空串都会被当成给出过的值。
    expect(resolvePollIntervalSec({ stored: null, fromEnv: 'abc', explicit: 60 })).toBe(60)
  })

  it('这条链不钳制取值：越界的照旧出口，由 normalize 一处钳', () => {
    expect(resolvePollIntervalSec({ stored: 500 })).toBe(500)
    expect(normalizePollIntervalSec(resolvePollIntervalSec({ stored: 500 }))).toBe(POLL_INTERVAL_SEC_MAX)
    expect(normalizePollIntervalSec(resolvePollIntervalSec({}))).toBe(POLL_INTERVAL_SEC_DEFAULT)
  })
})

describe('手动刷新的冷却就是当前的节拍', () => {
  it('按 30 秒配置：窗口开在尝试那一刻，29 999ms 拒、30 000ms 放行', async () => {
    freezeAt(T0)
    const service = serviceWithTracked(30)

    const first = await service.refreshLive(request())
    expect(RefreshLiveResultSchema.safeParse(first.result).success).toBe(true)
    expect(first.result.nextAllowedAt).toBe(T0_MS + 30_000)
    expect(first.result.retryAfterSeconds).toBe(30)

    vi.setSystemTime(T0_MS + 29_999)
    const early = await service.refreshLive(request())
    expect(early.outcome).toBe('throttled')
    expect(early.result.throttled).toBe(true)

    vi.setSystemTime(T0_MS + 30_000)
    const again = await service.refreshLive(request())
    expect(again.outcome).not.toBe('throttled')
    expect(again.result.nextAllowedAt).toBe(T0_MS + 60_000)
  })

  it('换成 10 秒：同一个进程里立刻按新的节拍算窗口', async () => {
    freezeAt(T0)
    const service = serviceWithTracked(60)
    expect(service.getPollIntervalSec()).toBe(60)

    const before = await service.refreshLive(request())
    expect(before.result.retryAfterSeconds).toBe(60)

    // 设置页保存：热切换，不重启服务。
    expect(service.setPollIntervalSec(10)).toBe(10)
    expect(service.getPollIntervalSec()).toBe(10)

    // 已开的窗口保留它自己的到期时刻：切换节拍不改写别人手里那个已经在跑的窗口。
    const held = await service.refreshLive(request())
    expect(held.outcome).toBe('throttled')
    expect(held.result.nextAllowedAt).toBe(T0_MS + 60_000)

    // 另一个用户（另一个窗口）第一次尝试就按新节拍开：10 秒。
    const fresh = await service.refreshLive(request('user-b'))
    expect(fresh.outcome).not.toBe('throttled')
    expect(fresh.result.retryAfterSeconds).toBe(10)

    // 旧窗口一到期，那个用户的窗口也按新的节拍重开。
    vi.setSystemTime(T0_MS + 60_000)
    const after = await service.refreshLive(request())
    expect(after.outcome).not.toBe('throttled')
    expect(after.result.nextAllowedAt).toBe(T0_MS + 70_000)
    expect(after.result.retryAfterSeconds).toBe(10)
  })

  it('保存一个非法值时回退默认 18，而不是让节拍变成 0 秒', async () => {
    freezeAt(T0)
    const service = serviceWithTracked(30)

    expect(service.setPollIntervalSec('abc')).toBe(POLL_INTERVAL_SEC_DEFAULT)
    expect(service.getPollIntervalSec()).toBe(POLL_INTERVAL_SEC_DEFAULT)

    const res = await service.refreshLive(request())
    expect(res.result.retryAfterSeconds).toBe(POLL_INTERVAL_SEC_DEFAULT)
  })
})

describe('接线：buildApp 把三个来源喂给那条链，且没有第二处自己解析', () => {
  /** 去掉说明性文字的文件，故被断言的是代码。 */
  function codeOf(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('三个来源都在同一个调用里给出', () => {
    const app = codeOf('../app.ts')

    expect(app, 'buildApp 不再把节拍来源喂给那条链').toContain('resolvePollIntervalSec({')
    expect(app, '设置页的选择（DB）没被喂进去').toMatch(/stored:\s*storedSettings\?\.refreshIntervalSec/)
    expect(app, '环境变量没被喂进去').toMatch(/fromEnv:\s*process\.env\.TRANSIT_POLL_INTERVAL_SEC/)
    expect(app, '显式启动参数没被喂进去').toMatch(/explicit:\s*options\.pollIntervalSec/)
  })

  it('环境变量只在那一处被读：index.ts 不再自己解析一份', () => {
    // 两处各写一份时，两边对「无效值」的判法还不一样（一处 Number.isFinite && > 0，一处只管非空）。
    expect(codeOf('../index.ts'), 'index.ts 又开始自己解析节拍了')
      .not.toContain('TRANSIT_POLL_INTERVAL_SEC')
  })

  it('app.ts 里也只读一次：启动的解析与清空选择时的回落共用同一个值', () => {
    const app = codeOf('../app.ts')
    const reads = app.match(/TRANSIT_POLL_INTERVAL_SEC/g) ?? []

    expect(reads, 'app.ts 里那个环境变量被读了不止一处').toHaveLength(1)
    expect(app, '清空选择时没走启动那一个回落值').toMatch(/refreshIntervalSec \?\? pollIntervalFallbackSec/)
  })
})

describe('生效的节拍：接口答出的就是此刻在跑的那个数', () => {
  const apps: FastifyInstance[] = []

  /** 起一个真 app：环境变量在构造时被读进节拍，故必须先设好它。 */
  async function appWithEnv(envValue: string): Promise<FastifyInstance> {
    vi.stubEnv('TRANSIT_POLL_INTERVAL_SEC', envValue)
    const app = await buildApp()
    apps.push(app)
    return app
  }

  afterEach(async () => {
    for (const app of apps) await app.close()
    apps.length = 0
    vi.unstubAllEnvs()
  })

  async function settingsOf(app: FastifyInstance): Promise<Record<string, unknown>> {
    return (await app.inject({ method: 'GET', url: '/api/transit/settings' })).json()
  }

  async function patch(app: FastifyInstance, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await app.inject({ method: 'PATCH', url: '/api/transit/settings', payload })).json()
  }

  it('没选过 + 环境变量 30 → 答 30，而不是存储行说的 18', async () => {
    const answer = await settingsOf(await appWithEnv('30'))

    expect(answer.settingsState, '没选过仍要如实说没选过').toBe('unset')
    expect(answer.effectiveRefreshIntervalSec).toBe(30)
  })

  it('选过 10 → 答 10：环境变量的 30 盖不掉使用者的选择', async () => {
    const app = await appWithEnv('30')

    expect((await patch(app, { refreshIntervalSec: 10 })).effectiveRefreshIntervalSec).toBe(10)
    expect((await settingsOf(app)).effectiveRefreshIntervalSec).toBe(10)
  })

  it('清空选择（PATCH null）→ 回到环境变量的 30，与重启后同一个答案', async () => {
    const app = await appWithEnv('30')
    await patch(app, { refreshIntervalSec: 10 })

    const cleared = await patch(app, { refreshIntervalSec: null })
    const after = await settingsOf(app)

    // 清空 ≠ 删掉行，也 ≠ 选了 18：行还在，那一列回到 NULL。
    expect(after.settingsState).toBe('stored')
    expect(after.data, '清空之后那一列必须是 NULL').toMatchObject({ refreshIntervalSec: null })
    expect(cleared.effectiveRefreshIntervalSec).toBe(30)
    expect(after.effectiveRefreshIntervalSec).toBe(30)
  })

  it('两个来源都没有 → 18', async () => {
    expect((await settingsOf(await appWithEnv(''))).effectiveRefreshIntervalSec).toBe(18)
  })
})
