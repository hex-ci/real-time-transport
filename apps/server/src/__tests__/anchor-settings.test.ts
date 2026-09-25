import { describe, expect, it } from 'vitest'
import { wgs84ToGcj02 } from '@real-time-transport/transit-adapter'
import { haversineMeters } from '@real-time-transport/shared/geo'
import { buildApp } from '../app.js'
import { definedOnly, storedCoord } from '../db/client.js'
import type { FastifyInstance } from 'fastify'

/**
 * The anchor write path on `/api/transit/settings`.
 *
 * `navigator.geolocation` reports WGS-84 and the browser converts nothing, so
 * the fix arrives at this endpoint raw. THIS endpoint is the one place it is
 * converted — the same boundary that already converts the GIS routes' incoming
 * device fix — and from then on the anchor is GCJ-02, read back by `GET
 * /settings` and consumed unconverted by every walking route.
 *
 * Getting this wrong twice is the expensive direction: the double-converted
 * walking leg measured 1208 m/16.1 min as 2680 m/35.7 min, and F1 compares
 * `walk` against a 3-minute wait tolerance, so ~500 m of coordinate error is
 * enough to invert the 出门结论.
 */

/** A raw device fix in WGS-84 — the same origin the GIS boundary tests use. */
const DEVICE_FIX = { lng: 116.3974, lat: 39.90931 }

/**
 * What this repo's own `wgs84ToGcj02` makes of that fix, computed here rather
 * than typed in: the stored value must equal the conversion, not a fixture that
 * happens to be near it.
 */
const [GCJ_LNG, GCJ_LAT] = wgs84ToGcj02(DEVICE_FIX.lng, DEVICE_FIX.lat)

/** The shift the two datums differ by at this location, in metres. */
const DATUM_SHIFT_M = haversineMeters(DEVICE_FIX.lat, DEVICE_FIX.lng, GCJ_LAT, GCJ_LNG)

/**
 * Every settings answer, read through the API rather than the store.
 *
 * Only a STORED row is handed back. A store nothing has been written to answers
 * `data: null` with `settingsState: 'unset'` (the read found no row — see
 * `settings-read-state.test.ts`), and the row it does not have cannot carry
 * anchors: reading one out of it would be exactly the fabrication this endpoint
 * used to serve. A test that wants to assert 「nothing was written」 reads the
 * state itself, through `readSettings`.
 */
async function getSettings(app: FastifyInstance): Promise<Record<string, unknown>> {
  const body = await readSettings(app)
  expect(body.settingsState, 'this test needs a STORED row to read anchors from').toBe('stored')
  return body.data as Record<string, unknown>
}

/** The whole settings answer: the state of the read and whatever it carried. */
async function readSettings(app: FastifyInstance): Promise<{ settingsState: string, data: unknown }> {
  const res = await app.inject({ method: 'GET', url: '/api/transit/settings' })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body) as { settingsState: string, data: unknown }
}

async function patchSettings(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'PATCH', url: '/api/transit/settings', payload })
}

/**
 * Assert that a refused write left NO row behind.
 *
 * A store with nothing in it answers `unset` with `data: null` — a stronger
 * statement than 「the anchor is null」: the anchor is absent AND there is no row
 * for it to be absent from. Before the settings read carried its state, this case
 * was indistinguishable from a row full of nulls, and the endpoint answered the
 * built-in hours beside those nulls as if the user had configured them.
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

      // The read succeeded and found no row for this user. Before this, the
      // endpoint answered the built-in hours here — `morningStart: '06:30'` —
      // so 「没有这一行」 and 「保存过 06:30」 were the same bytes, and the 设置
      // index row printed the built-in window as the user's own configuration.
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
      // The anchors' own rule, held on a row that exists: null, never 0 and never
      // undefined — (0, 0) is a real coordinate in the Gulf of Guinea,
      // indistinguishable from an anchor the user saved, and it would silently
      // become the origin of every walking route.
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
      // The untouched anchor stays a real "not set", not a copy of its sibling.
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

      // Not merely "a value was stored": the raw fix must not survive into the
      // column, and the stored point is the converted one.
      expect(stored.homeLat).not.toBe(DEVICE_FIX.lat)
      expect(stored.homeLng).not.toBe(DEVICE_FIX.lng)
      expect(stored.homeLat).toBeCloseTo(GCJ_LAT, 6)
      expect(stored.homeLng).toBeCloseTo(GCJ_LNG, 6)

      // The magnitude of the move, measured: the datum shift for Beijing, not
      // an arbitrary difference. A missing conversion reads as 0 m here and a
      // double conversion as roughly twice this.
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
      // The origin F1 will walk from, in the one system the GIS layer takes.
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

      // A second fix ~1 km north-east of the first, still a raw WGS-84 fix.
      const otherFix = { lat: 39.91831, lng: 116.4074 }
      const res = await patchSettings(app, { workLat: otherFix.lat, workLng: otherFix.lng })
      expect(res.statusCode).toBe(200)

      const after = await getSettings(app)
      expect(after.homeLat).toBe(home.homeLat)
      expect(after.homeLng).toBe(home.homeLng)
      const [workLng, workLat] = wgs84ToGcj02(otherFix.lng, otherFix.lat)
      expect(after.workLat).toBeCloseTo(workLat, 6)
      expect(after.workLng).toBeCloseTo(workLng, 6)
      // The two anchors are told apart by their own coordinates.
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
      // An anchor-only PATCH carries no hours and must not reset them.
      expect(data.morningStart).toBe('07:15')
      expect(data.morningEnd).toBe('10:45')
      // And the window the request did NOT name stays 「从未选择」 — it USED to read
      // back `17:00`, the built-in hour 004's NOT NULL DEFAULT had stored as if the
      // user had picked it. That value is exactly the defect 009 removes: nothing
      // about this request said anything about the evening window.
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
      // A window is ONE value, so both ends travel together (a lone end is refused
      // by the contract — see `settings-windows.test.ts`).
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

      // Rejected means not written — a half-written anchor would be worse than
      // a rejected request, because every later walking route would use it. Here
      // that means no row at all was created.
      await expectNothingStored(app)
    }
    finally {
      await app.close()
    }
  })

  it('rejects a non-finite coordinate', async () => {
    const app = await buildApp()
    try {
      // `1e999` survives JSON.parse as Infinity, so this is the wire form of the
      // non-finite input the schema has to refuse.
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
      // The WGS-84 -> GCJ-02 offset depends on BOTH axes, so a lone latitude
      // cannot be converted. Storing it raw would leave a WGS-84 value in a
      // column everything downstream reads as GCJ-02.
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
 * The failed-fix pair, refused by the write path.
 *
 * (0, 0) is what a device reports when a fix could not be made — and it is a real
 * coordinate in the Gulf of Guinea, so a stored one is indistinguishable from an
 * anchor the user saved and becomes the origin of every walking route. It is
 * rejected as a PAIR only: a single axis of 0 is the equator or the prime
 * meridian, a real coordinate that a device can legally report.
 *
 * The precedent for the opposite direction is `statedCoordinate` in
 * `@real-time-transport/shared/geo`, which reads a 0 as absence for UPSTREAM
 * station data. That is a different rule for a different source: absence on the
 * user's own path is a NULL column, not a zero, so the write path refuses the
 * sentinel rather than re-reading the rule here.
 */
describe('PATCH /settings refuses the failed-fix sentinel as a pair', () => {
  it('rejects a (0, 0) anchor pair and stores nothing', async () => {
    const app = await buildApp()
    try {
      const res = await patchSettings(app, { homeLat: 0, homeLng: 0 })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toContain('定位')

      // Rejected means not written: a stored (0, 0) would be walked from.
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
      // A fix on the equator with a real longitude is not a failed fix, and
      // refusing it would invent a rule about where a user may stand.
      const res = await patchSettings(app, { homeLat: 0, homeLng: DEVICE_FIX.lng })
      expect(res.statusCode).toBe(200)

      const stored = JSON.parse(res.body).data
      const [gcjLng, gcjLat] = wgs84ToGcj02(DEVICE_FIX.lng, 0)
      expect(stored.homeLat).toBeCloseTo(gcjLat, 6)
      expect(stored.homeLng).toBeCloseTo(gcjLng, 6)
      // Read back through the endpoint, the anchor is still there.
      expect((await getSettings(app)).homeLng).not.toBeNull()
    }
    finally {
      await app.close()
    }
  })

  it('keeps a single axis of 0 legal for the other axis too', async () => {
    const app = await buildApp()
    try {
      // The prime meridian: longitude 0, a real latitude.
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
 * The SQL branch of `user_settings` cannot run in this suite (a test process
 * never accepts an ambient `DATABASE_URL`, and a test must never write the dev
 * database), so its READ mapping is pinned directly: the values it produces are
 * what the endpoint hands out and what a walking route would use as an origin.
 */
describe('the stored row cannot hand out a poisoned coordinate', () => {
  it('reads an unset or non-finite column as unset, never as a coordinate', () => {
    expect(storedCoord(null)).toBeNull()
    expect(storedCoord(undefined)).toBeNull()
    // Postgres stores NaN in a DOUBLE PRECISION column, so this is the shape a
    // poisoned row has when it comes back: it must read as unset rather than
    // become an origin that turns every walking distance into NaN.
    expect(storedCoord(Number.NaN)).toBeNull()
    expect(storedCoord(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('passes a real stored coordinate through unchanged', () => {
    expect(storedCoord(GCJ_LAT)).toBe(GCJ_LAT)
    expect(storedCoord(0)).toBe(0)
  })

  it('writes only the fields the request carried, and keeps an explicit null', () => {
    // `undefined` means "leave it alone"; `null` means "clear it". Collapsing
    // the two would either erase a saved anchor or make clearing impossible.
    expect(definedOnly({ homeLat: 39.9, workLat: undefined })).toEqual({ homeLat: 39.9 })
    expect(definedOnly({ homeLat: null })).toEqual({ homeLat: null })
    expect(definedOnly({})).toEqual({})
  })
})
