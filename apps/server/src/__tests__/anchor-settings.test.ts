import { describe, expect, it } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { haversineMeters } from '@real-time-transport/shared/geo'
import { buildApp } from '../app.js'
import { definedOnly, storedCoord } from '../db/client.js'
import type { FastifyInstance } from 'fastify'

/**
 * `/api/transit/settings` 的锚点写入路径。
 *
 * `navigator.geolocation` 报的是 WGS-84，浏览器不做任何换算，所以定位原样到达本接口。
 * 本接口是唯一做换算的地方 —— 与已经换算 GIS 路由设备定位的是同一条边界 —— 此后锚点
 * 就是 GCJ-02，由 `GET /settings` 读回，每条步行路径原样使用。
 *
 * 方向错了代价不对称：重复换算会把步行腿量长一倍以上，而 F1 拿 `walk` 与 3 分钟的
 * 等车容忍度比较，足以把 出门结论 颠倒过来。
 */

/** 一份原始 WGS-84 设备定位，与 GIS 边界测试用的是同一个起点。 */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/**
 * 本仓自己的 `wgs84ToGcj02` 对它的结果，在此算出而非写死：存下来的值必须等于换算结果，
 * 而不是一个碰巧接近的固定值。
 */
const [GCJ_LNG, GCJ_LAT] = wgs84ToGcj02(DEVICE_FIX.lng, DEVICE_FIX.lat)

const DATUM_SHIFT_M = haversineMeters(DEVICE_FIX.lat, DEVICE_FIX.lng, GCJ_LAT, GCJ_LNG)

/**
 * 设置应答一律经 API 读出，而不是读存储本身。
 *
 * 只有已存储的那一行会被交回：没有写入过的存储以 `settingsState: 'unset'` 与
 * `data: null` 作答（见 `settings-read-state.test.ts`），而没有的那一行带不了锚点。
 * 要断言「什么都没写」的测试，请经 `readSettings` 读状态本身。
 */
async function getSettings(app: FastifyInstance): Promise<Record<string, unknown>> {
  const body = await readSettings(app)
  expect(body.settingsState, 'this test needs a STORED row to read anchors from').toBe('stored')
  return body.data as Record<string, unknown>
}

async function readSettings(app: FastifyInstance): Promise<{ settingsState: string, data: unknown }> {
  const res = await app.inject({ method: 'GET', url: '/api/transit/settings' })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body) as { settingsState: string, data: unknown }
}

async function patchSettings(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'PATCH', url: '/api/transit/settings', payload })
}

/**
 * 断言被拒的写入没有留下任何行。
 *
 * `unset` 加 `data: null` 比「锚点是 null」更强：锚点不存在，而且没有一行让它不存在于其中。
 */
async function expectNothingStored(app: FastifyInstance): Promise<void> {
  const body = await readSettings(app)
  expect(body.settingsState, 'a refused write created a row').toBe('unset')
  expect(body.data).toBeNull()
}

describe('GET /settings states whether there is a row at all, and carries no invented one', () => {
  it('answers state=unset with NO row on a store with nothing saved', async () => {
    const app = await buildApp()
    try {
      const body = await readSettings(app)

      expect(body.settingsState).toBe('unset')
      expect(body.data).toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('answers state=stored with the row once one is written, and null anchors inside it', async () => {
    const app = await buildApp()
    try {
      // 锚点自己的规则：null，从不是 0 也不是 undefined —— (0, 0) 是几内亚湾的真实坐标，
      // 会静默成为每一条步行路径的起点。
      await patchSettings(app, { morningStart: '06:30', morningEnd: '11:30' })

      const data = await getSettings(app)
      expect(data.homeLat).toBeNull()
      expect(data.homeLng).toBeNull()
      expect(data.workLat).toBeNull()
      expect(data.workLng).toBeNull()
      expect(data.homeLat).not.toBe(0)
    }
    finally {
      await app.close()
    }
  })

  it('keeps an unset anchor null after the other one has been saved', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })

      const data = await getSettings(app)
      expect(data.homeLat).toBeCloseTo(GCJ_LAT, 6)
      expect(data.workLat).toBeNull()
      expect(data.workLng).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

describe('PATCH /settings converts each anchor exactly once', () => {
  it('stores the GCJ-02 pair, ~500 m from the raw fix the browser sent', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })
      expect(res.statusCode).toBe(200)
      const stored = JSON.parse(res.body).data

      expect(stored.homeLat).not.toBe(DEVICE_FIX.lat)
      expect(stored.homeLng).not.toBe(DEVICE_FIX.lng)
      expect(stored.homeLat).toBeCloseTo(GCJ_LAT, 6)
      expect(stored.homeLng).toBeCloseTo(GCJ_LNG, 6)

      // 位移的量级：北京两个基准之间的偏移，不是任意差值 —— 漏做换算是 0 m，
      // 重复换算是它的约两倍。
      const shiftM = haversineMeters(DEVICE_FIX.lat, DEVICE_FIX.lng, stored.homeLat, stored.homeLng)
      expect(DATUM_SHIFT_M).toBeGreaterThan(300)
      expect(DATUM_SHIFT_M).toBeLessThan(700)
      expect(shiftM).toBeCloseTo(DATUM_SHIFT_M, 6)
    }
    finally {
      await app.close()
    }
  })

  it('reads the stored anchor back as GCJ-02, unconverted', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { workLat: DEVICE_FIX.lat, workLng: DEVICE_FIX.lng })

      const data = await getSettings(app)
      expect([data.workLng, data.workLat]).toEqual([GCJ_LNG, GCJ_LAT])
      // F1 将要起步的起点，落在 GIS 层唯一接受的基准上。
      expect(haversineMeters(data.workLat as number, data.workLng as number, GCJ_LAT, GCJ_LNG))
        .toBeCloseTo(0, 6)
    }
    finally {
      await app.close()
    }
  })

  it('writes each anchor independently, leaving the other one as it was', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })
      const home = await getSettings(app)

      const otherFix = { lat: 39.91831, lng: 116.4074 }
      const res = await patchSettings(app, { workLat: otherFix.lat, workLng: otherFix.lng })
      expect(res.statusCode).toBe(200)

      const after = await getSettings(app)
      expect(after.homeLat).toBe(home.homeLat)
      expect(after.homeLng).toBe(home.homeLng)
      const [workLng, workLat] = wgs84ToGcj02(otherFix.lng, otherFix.lat)
      expect(after.workLat).toBeCloseTo(workLat, 6)
      expect(after.workLng).toBeCloseTo(workLng, 6)
      expect(after.workLat).not.toBe(after.homeLat)
    }
    finally {
      await app.close()
    }
  })

  it('does not reissue the commute hours when only an anchor is patched', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { morningStart: '07:15', morningEnd: '10:45' })
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })

      const data = await getSettings(app)
      expect(data.morningStart).toBe('07:15')
      expect(data.morningEnd).toBe('10:45')
      // 请求没有点名的窗口保持「从未选择」：关于晚间窗口，这个请求什么都没说。
      expect(data.eveningStart, 'an untouched window was invented for a user who never chose one').toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('does not erase the anchors when only the hours are patched', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })
      // 窗口是一个值，两端必须一起走（单独的端点被契约拒绝，见 `settings-windows.test.ts`）。
      await patchSettings(app, { eveningStart: '17:30', eveningEnd: '21:30' })

      const data = await getSettings(app)
      expect(data.eveningStart).toBe('17:30')
      expect(data.homeLat).toBeCloseTo(GCJ_LAT, 6)
    }
    finally {
      await app.close()
    }
  })

  it('clears an anchor with an explicit null pair, and only then', async () => {
    const app = await buildApp()
    try {
      await patchSettings(app, { homeLat: DEVICE_FIX.lat, homeLng: DEVICE_FIX.lng })
      const res = await patchSettings(app, { homeLat: null, homeLng: null })
      expect(res.statusCode).toBe(200)

      const data = await getSettings(app)
      expect(data.homeLat).toBeNull()
      expect(data.homeLng).toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

describe('PATCH /settings refuses to poison an anchor', () => {
  it('rejects an out-of-range coordinate and stores nothing', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { homeLat: 999, homeLng: DEVICE_FIX.lng })
      expect(res.statusCode).toBe(400)

      // 被拒就是没写：写了一半的锚点比被拒的请求更糟，之后每条步行路径都会用到它。
      // 这里尤其意味着连一行都没有建。
      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('rejects a non-finite coordinate', async () => {
    const app = await buildApp()
    try {
      // `1e999` 经 JSON.parse 之后是 Infinity，所以这是模式必须拒绝的非有限输入的线上形式。
      expect(JSON.parse('{"homeLat":1e999}').homeLat).toBe(Number.POSITIVE_INFINITY)
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/transit/settings',
        headers: { 'content-type': 'application/json' },
        payload: '{"homeLat":1e999,"homeLng":116.3974}',
      })
      expect(res.statusCode).toBe(400)

      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('rejects a lone half of a pair, which has no conversion', async () => {
    const app = await buildApp()
    try {
      // WGS-84 -> GCJ-02 的偏移同时依赖两个轴，所以单独的纬度无法换算：原样存下，
      // 会在一个下游全部按 GCJ-02 读的列里留下一个 WGS-84 值。
      const res = await patchSettings(app, { homeLat: DEVICE_FIX.lat })
      expect(res.statusCode).toBe(400)

      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('rejects a mixed pair rather than writing half of it', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { homeLat: null, homeLng: DEVICE_FIX.lng })
      expect(res.statusCode).toBe(400)
      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })
})

/**
 * 失败定位的那一对，被写入路径拒绝。
 *
 * (0, 0) 是设备做不出定位时报的值，而它本身又是真实坐标：存下来就与用户自己保存的锚点
 * 无从区分，并成为每一条步行路径的起点。
 *
 * 只按「一对」拒绝：单独一个轴为 0 是赤道或本初子午线，是设备可以合法报出的真实坐标。
 */
describe('PATCH /settings refuses the failed-fix sentinel as a pair', () => {
  it('rejects a (0, 0) anchor pair and stores nothing', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { homeLat: 0, homeLng: 0 })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('定位')

      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('rejects it for the 公司 pair too, on the same rule', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { workLat: 0, workLng: 0 })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('公司')
      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('keeps a single axis of 0 legal — the equator is a real coordinate', async () => {
    const app = await buildApp()
    try {
      // 赤道上带真实经度的定位不是失败的定位；拒绝它等于凭空规定用户能站在哪里。
      const res = await patchSettings(app, { homeLat: 0, homeLng: DEVICE_FIX.lng })
      expect(res.statusCode).toBe(200)

      const stored = JSON.parse(res.body).data
      const [gcjLng, gcjLat] = wgs84ToGcj02(DEVICE_FIX.lng, 0)
      expect(stored.homeLat).toBeCloseTo(gcjLat, 6)
      expect(stored.homeLng).toBeCloseTo(gcjLng, 6)
      expect((await getSettings(app)).homeLng).not.toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('keeps a single axis of 0 legal for the other axis too', async () => {
    const app = await buildApp()
    try {
      // 本初子午线：经度 0，纬度真实。
      const res = await patchSettings(app, { workLat: DEVICE_FIX.lat, workLng: 0 })
      expect(res.statusCode).toBe(200)
      expect((await getSettings(app)).workLat).not.toBeNull()
    }
    finally {
      await app.close()
    }
  })
})

/**
 * `user_settings` 的 SQL 分支在本套件里跑不了（测试进程不接受环境里的 `DATABASE_URL`，
 * 测试也绝不能写开发库），所以它的读映射直接钉在这里：它产出的值就是接口交出的值，
 * 也是步行路径会当作起点的值。
 */
describe('the stored row cannot hand out a poisoned coordinate', () => {
  it('reads an unset or non-finite column as unset, never as a coordinate', () => {
    expect(storedCoord(null)).toBeNull()
    expect(storedCoord(undefined)).toBeNull()
    // Postgres 能把 NaN 存进 DOUBLE PRECISION 列，这就是中毒行回来时的形状：
    // 必须读成「未设置」，而不是变成一个把每条步行距离都变成 NaN 的起点。
    expect(storedCoord(Number.NaN)).toBeNull()
    expect(storedCoord(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('passes a real stored coordinate through unchanged', () => {
    expect(storedCoord(GCJ_LAT)).toBe(GCJ_LAT)
    expect(storedCoord(0)).toBe(0)
  })

  it('writes only the fields the request carried, and keeps an explicit null', () => {
    // `undefined` 是「别动它」，`null` 是「清掉它」：把两者混同，要么抹掉已保存的锚点，
    // 要么让清空无法进行。
    expect(definedOnly({ homeLat: 39.9, workLat: undefined })).toEqual({ homeLat: 39.9 })
    expect(definedOnly({ homeLat: null })).toEqual({ homeLat: null })
    expect(definedOnly({})).toEqual({})
  })
})
