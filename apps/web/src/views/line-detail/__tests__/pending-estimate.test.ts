import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as pendingEstimate from '../pending-estimate'
import {
  ARRIVAL_ESTIMATE_FLOOR_SECONDS,
  estimateSubwayArrivalSeconds,
} from '../pending-estimate'

/**
 * F-E: the page's own pending-window estimate must be the SERVER's arithmetic.
 *
 * The line page prices a minute for itself in the window before the arrivals
 * answer lands (and when it never does), from the same vehicle the live board
 * describes. TWO models used to exist on both sides. One of them — the
 * position/dwell estimate (`remainingMeters / speed + (stopsAway - 1) * 30`) — is
 * gone from both, because the server no longer states that minute at all: it
 * extrapolated a snapshot speed and a nominal dwell across every remaining stop,
 * and its error had no fixed sign (~12 min mean, 28 min worst). A client copy of a
 * number the server refuses to state is worse than dead code; it is a second
 * surface contradicting the first.
 *
 * What remains is the subway model, and it is shared EXACTLY. Both sides once had
 * it, but the client was missing the server's `Math.max(30, …)` floor — the two
 * stated different numbers for the same vehicle in the same instant, and only the
 * rounding to whole minutes hid it. That is why the pin is on SECONDS: a 5-second
 * raw estimate has to come out as the floor, not as 5.
 *
 * The numbers asserted here are `vehicleArrivals`'s own (135 s/station), so a
 * change on either side of the wire fails here.
 */

describe('the estimated seconds are floored, as the server floors them', () => {
  it('floors the subway model instead of stating the raw 14 seconds', () => {
    // One stop away with 0.9 of the hop made: 0.1 × 135 = 13.5 → 14 raw.
    expect(estimateSubwayArrivalSeconds(1, 0.9)).toBe(ARRIVAL_ESTIMATE_FLOOR_SECONDS)
    expect(estimateSubwayArrivalSeconds(1, 0.9)).not.toBe(14)
  })

  it('states the model\'s own seconds above the floor, unchanged', () => {
    // Three full hops: 405 s — the server's number, passed through.
    expect(estimateSubwayArrivalSeconds(3, 0)).toBe(405)
  })
})

/**
 * And the wiring: the page must COMPUTE through this module rather than keep a
 * second copy of the arithmetic inline (the copy is how the floor went missing,
 * and the wiring is the half a logic-only test cannot see).
 */
describe('the line page prices only the model the server still states', () => {
  const view = readFileSync(fileURLToPath(new URL('../index.vue', import.meta.url)), 'utf8')

  it('imports the subway estimate from the module instead of inlining the arithmetic', () => {
    expect(view).toContain('estimateSubwayArrivalSeconds')
    // Regression: the inlined copy that lacked the floor.
    expect(view).not.toContain('(stops - progress) * 135')
  })

  it('exports no position/dwell estimate at all', () => {
    // The bus minute this page used to price for itself was the server's own
    // extrapolation, and the server states it nowhere now. The page's half of that
    // rule — the absence it states instead — is pinned in
    // `src/__tests__/absent-arrival-minute-display.test.ts`.
    expect(Object.keys(pendingEstimate)).not.toContain('estimatePositionArrivalSeconds')
  })
})
