import { describe, expect, it } from 'vitest'
import { arrivalMinutes, statedArrivalMinutes } from '../departure.js'
import { ArrivalRowSchema } from '../schemas/transit.js'
import type { ArrivalRow } from '../schemas/transit.js'

/**
 * The minute a row states, or the fact that it states none — decided ONCE.
 *
 * `ArrivalRowSchema` makes `etaSeconds` optional, because a targeted reading that
 * published no arrival time for a vehicle yields a row with no minute (see
 * `apps/server/src/__tests__/no-estimated-arrival-minute.test.ts`: this app no
 * longer extrapolates one from a snapshot speed and a nominal dwell). Every
 * surface that shows an arrivals list therefore has three states per row — at the
 * platform, a minute, no minute — and each of them must render what the row
 * actually says. Two ways to get this wrong, both of them on screen:
 *
 *  - `Math.round(undefined / 60)` or `Math.max(1, NaN)` painted next to 「分」, a
 *    minute nobody stated, which is the same lie as the estimate it replaced;
 *  - `null分` / `NaN分` — a broken number where an honest absence belongs.
 *
 * So the rule lives here, next to `arrivalMinutes` — the ONE rounding the whole
 * app uses — and the surfaces render either the number it answers or the token
 * `@/arrival-copy` carries for 「no minute」.
 */

describe('a row states a minute or it does not', () => {
  it('answers the rounded minute for a row that carries one, by the app-wide rule', () => {
    expect(statedArrivalMinutes({ etaSeconds: 420 })).toBe(7)
    expect(statedArrivalMinutes({ etaSeconds: 417 })).toBe(7)
    // 30 s reads as 1 minute, never as 0 — the same floor `arrivalMinutes` states.
    expect(statedArrivalMinutes({ etaSeconds: 30 })).toBe(1)
    expect(statedArrivalMinutes({ etaSeconds: 420 })).toBe(arrivalMinutes(420))
  })

  it('answers 0 for the at-platform row, which is an arrival and not a missing value', () => {
    // The server prices this state with `etaSeconds: 0` — upstream's own statement
    // that the vehicle is here. `null` here would hide a vehicle standing at the
    // platform behind 「暂无到站耗时」.
    expect(statedArrivalMinutes({ etaSeconds: 0, isAtStation: true })).toBe(0)
    // And the state is the observation, so it stands even if a producer omitted
    // the zero that goes with it.
    expect(statedArrivalMinutes({ isAtStation: true })).toBe(0)
  })

  it('answers null for a row that states no minute', () => {
    // The shape the server now serves for a vehicle whose targeted reading
    // published no arrival time.
    const row: ArrivalRow = { stopsAway: 2, busId: 'b1' }
    expect(statedArrivalMinutes(row)).toBeNull()
    // Defensive against the other half of the contract: a non-finite or negative
    // duration is not a duration, and must not become 「NaN分」 or 「-1分」.
    expect(statedArrivalMinutes({ etaSeconds: Number.NaN })).toBeNull()
    expect(statedArrivalMinutes({ etaSeconds: Number.POSITIVE_INFINITY })).toBeNull()
    // A literal `null` reaches the browser: the web reads the arrivals payload's
    // JSON without validating it against the schema at that boundary.
    expect(statedArrivalMinutes({ etaSeconds: null })).toBeNull()
    expect(statedArrivalMinutes({ etaSeconds: undefined })).toBeNull()
  })

  it('reads the row the wire actually serves, minute or no minute', () => {
    // Both shapes through the contract they travel as, so the helper and the
    // schema cannot drift.
    const withMinute = ArrivalRowSchema.parse({ time: '14:07', etaSeconds: 420, stopsAway: 2, provenance: 'live' })
    expect(statedArrivalMinutes(withMinute)).toBe(7)

    const withoutMinute = ArrivalRowSchema.parse({ stopsAway: 2, busId: 'b1' })
    expect(statedArrivalMinutes(withoutMinute)).toBeNull()
  })
})
