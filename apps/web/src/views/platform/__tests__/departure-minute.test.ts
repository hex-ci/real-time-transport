import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LiveBusSchema } from '@real-time-transport/shared'
import { departureRowOf } from '../departure-row'
import type { PlatformLineRule } from '../types'

/**
 * H1: the board's 预计到站 column must be able to state a real minute.
 *
 * The column read 「无法估算 / 暂无到站耗时」 on every row at every moment because the
 * request behind it named no target stop, and upstream fills a vehicle's `travelTimeSec`
 * only when the request says which stop it is travelling to. The route now forwards that
 * order (see `apps/server/src/__tests__/live-target-order.test.ts`) and this module turns
 * the answer into a row — so both outcomes are pinned here: a row whose reading carries
 * the platform's own minute, and a row whose reading genuinely carries none.
 *
 * Neither may be fabricated. The unknown state is not a defect to remove: a vehicle with
 * no served travel time has no minute, and inventing one (per-stop arithmetic, a nominal
 * speed) is the fabrication the whole F4 vocabulary exists to prevent. What was broken was
 * that the KNOWN case could not be reached at all.
 */

const rule: PlatformLineRule = {
  lineId: 'bus_027_1',
  lineName: '快线 1 路',
  direction: 0,
  terminal: '开往建国门',
  stationOrder: 4,
  operatingText: '运营中，本方向暂无来车',
}

/** A vehicle reading, validated by the contract it travels as. */
function bus(fields: Record<string, unknown>) {
  return LiveBusSchema.parse({ id: 'v1', updatedAt: 0, ...fields })
}

const answer = (buses: Array<Record<string, unknown>>, dataSource = 'chelaile') => ({
  dataSource,
  buses: buses.map(bus),
})

const rowWith = (buses: Array<Record<string, unknown>>) =>
  departureRowOf({ id: 'dep_1', rule, answer: answer(buses) })

describe('H1: a reading that carries this platform\'s minute is stated as a minute', () => {
  it('takes the minute upstream served for the requested stop', () => {
    // nextOrder === stationOrder: the vehicle's nose is heading to this platform, and
    // 480 s is the source's own travel time for it.
    const row = rowWith([{ order: 2, nextOrder: 3, travelTimeSec: 480, congestion: 'low' }])

    expect(row.etaMinutes).toBe(8)
    expect(row.stopsAway).toBe(1)
    expect(row.unavailable).toBe(false)
    // A minute is not a service fact: the operating text belongs to the rows without one.
    expect(row.operatingText).toBeNull()
    // The kind follows the source, so a served minute is 实时.
    expect(row.provenance).toBe('live')
    expect(row.congestion).toBe('low')
  })

  it('keeps the platform\'s minute, not the terminus one, when both are in the payload', () => {
    // The defect's exact shape: an untargeted reading prices every vehicle to the
    // terminus (here 3 240 s ≈ 54 min), which reads as a real minute and is the wrong
    // question's answer. The targeted reading is the 480 s above; the row must never
    // prefer the larger figure it can also hold.
    const row = rowWith([{ order: 2, nextOrder: 3, travelTimeSec: 480, congestion: 'low' }])
    expect(row.etaMinutes).toBe(8)
    expect(row.etaMinutes).not.toBe(54)
  })

  it('states the minute for a vehicle standing at the platform as the imminent one', () => {
    // Upstream's own 0 means the vehicle is AT the stop: flooring it to 1 分钟 is this
    // app's convention for 「马上」 and it is a reading, not a guess.
    const row = rowWith([{ order: 3, nextOrder: 4, travelTimeSec: 0, congestion: 'high' }])
    expect(row.etaMinutes).toBe(1)
    expect(row.stopsAway).toBe(1)
    expect(row.congestion).toBe('high')
  })
})

describe('H1: a reading that carries no minute states the honest unknown', () => {
  it('states no minute for a vehicle heading here with no served travel time', () => {
    // The vehicle is real and its nose is heading to this platform — what upstream did
    // not say is when. The row states that, and nothing else: no minute, no service
    // fact (a vehicle IS in range), no failure (the request answered).
    const row = rowWith([{ order: 2, nextOrder: 3, congestion: 'high' }])

    expect(row.etaMinutes).toBeNull()
    expect(row.stopsAway).toBe(1)
    expect(row.operatingText).toBeNull()
    expect(row.unavailable).toBe(false)
    // No number, so no kind: a mark exists only where a minute does.
    expect(row.provenance).toBeNull()
    // The crowding verdict is the vehicle's own and survives the missing minute.
    expect(row.congestion).toBe('high')
  })
})

describe('H1: the row is about the vehicle still heading here', () => {
  it('never prices a vehicle that has already cleared the platform', () => {
    // `nextOrder > stationOrder` is the stop the nose has passed, and chelaile's -1 is
    // the source saying the same thing outright. Either one makes a minute for THIS
    // platform a minute for a place the vehicle is no longer going — so the row is about
    // the vehicle behind it (480 s, 8 min), never the nearer one that has gone by (60 s).
    const row = rowWith([
      { id: 'passed', order: 4, nextOrder: 5, travelTimeSec: 60 },
      { id: 'behind', order: 2, nextOrder: 3, travelTimeSec: 480 },
    ])
    expect(row.etaMinutes).toBe(8)

    const sentinel = rowWith([
      { id: 'gone', order: 3, nextOrder: 4, travelTimeSec: 60, distanceToWaitStn: -1 },
      { id: 'behind', order: 2, nextOrder: 3, travelTimeSec: 480 },
    ])
    expect(sentinel.etaMinutes).toBe(8)
  })

  it('states the operating fact when nothing is heading here, rather than a failure', () => {
    // An answered reading with no vehicle for this platform is not an error: the row
    // reports what the line's own service hours say (the F3 split).
    const row = rowWith([])
    expect(row.etaMinutes).toBeNull()
    expect(row.stopsAway).toBeNull()
    expect(row.unavailable).toBe(false)
    expect(row.operatingText).toBe(rule.operatingText)
    expect(row.provenance).toBeNull()
  })

  it('states the failed request as the failed request, and claims nothing else', () => {
    const row = departureRowOf({ id: 'dep_1', rule, answer: null })
    expect(row.unavailable).toBe(true)
    expect(row.etaMinutes).toBeNull()
    expect(row.operatingText).toBeNull()
    expect(row.provenance).toBeNull()
  })
})

describe('H1: the board asks about the platform it is showing', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** The file with its explanatory prose removed, so code is what is asserted. */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('names the station order in the live request, which is what makes the minute exist', () => {
    // A view that asked for the line's direction alone would receive the terminus figure
    // and state it as this platform's, or (as it did) state no minute at all.
    const view = codeOf(read('../index.vue'))
    expect(view).toContain('order: String(rule.stationOrder)')
    expect(view).toContain('departureRowOf(')
  })

  it('still renders the honest unknown, in exactly one wording', () => {
    // The state stays reachable and stays worded once: a row with no minute, no vehicle
    // fact and no failure falls to the board's last branch, which states it. The WORDS
    // now come from `@/arrival-copy` — the one module every arrivals surface renders —
    // so the board no longer types the sentence itself, and the render is asserted
    // instead of the literal.
    const board = read('../components/departure-board.vue')
    expect(board.match(/无法估算/g)?.length).toBe(1)
    expect(board).toContain('arrival-copy')
    expect(board.match(/\{\{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT \}\}/g)?.length).toBe(1)
    const row = rowWith([{ order: 2, nextOrder: 3 }])
    expect({ minute: row.etaMinutes, operating: row.operatingText, failed: row.unavailable })
      .toEqual({ minute: null, operating: null, failed: false })
  })
})
