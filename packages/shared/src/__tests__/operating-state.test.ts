import { describe, expect, it } from 'vitest'
import { operatingDaySecondsOf, operatingStatusOf } from '../operating-state.js'

/**
 * F3's operating state, as pure logic.
 *
 * The state answers 「今天还有没有车」 from the line's OWN first/last departure
 * times, so the two facts that used to be collapsed into 「暂无来车」 — service
 * has not started, service has ended — are decided here, once, and covered by
 * tests instead of by whichever branch happens to render the card.
 *
 * Every case below is a fact of the inputs, never of the machine's clock: the
 * seconds-of-operating-day is an argument, so 01:00 and 04:00 are reproducible
 * at any hour of the day the suite runs.
 */

/** The pair used throughout: one line's own first and last departure, as inputs. */
const LINE = { firstDeparture: '05:16', lastDeparture: '23:06' }

/** 08:30 — inside the service day. */
const SEC_0830 = 8 * 3600 + 30 * 60
/** 22:00 — still inside the service day, after the evening peak. */
const SEC_2200 = 22 * 3600
/** 23:59 — the last train is gone. */
const SEC_2359 = 23 * 3600 + 59 * 60
/** 01:00 — operating-day seconds continue past 24:00 (「运营日」模型). */
const SEC_0100 = 25 * 3600
/** 04:00 — the operating-day boundary itself. */
const SEC_0400 = 4 * 3600

describe('the operating state comes from the line\'s own first/last times', () => {
  it('is 首班前 before the first departure, naming when service starts', () => {
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: SEC_0400 }))
      .toEqual({ state: 'before_first', firstDeparture: '05:16', lastDeparture: '23:06' })
  })

  it('is 运营中 at 08:30', () => {
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: SEC_0830 }).state).toBe('operating')
  })

  it('is 运营中 at 22:00', () => {
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: SEC_2200 }).state).toBe('operating')
  })

  it('is 已过末班 at 23:59, naming the last departure that has gone', () => {
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: SEC_2359 }))
      .toEqual({ state: 'after_last', firstDeparture: '05:16', lastDeparture: '23:06' })
  })

  it('is 已过末班 at 01:00 — the after-midnight tail belongs to the previous operating day', () => {
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: SEC_0100 }).state).toBe('after_last')
  })

  it('counts the first and last departure themselves as service running', () => {
    // At exactly 05:16 the first train is leaving; at exactly 23:06 the last one
    // is. Both boundaries are inside the service day — being on the platform at
    // the last departure is not the same as having missed the service.
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: 5 * 3600 + 16 * 60 }).state).toBe('operating')
    expect(operatingStatusOf({ ...LINE, nowSecOfDay: 23 * 3600 + 6 * 60 }).state).toBe('operating')
  })
})

describe('an unknown first/last time is 未知, never a default', () => {
  it('is unknown when the line carries neither time', () => {
    expect(operatingStatusOf({ firstDeparture: '', lastDeparture: '', nowSecOfDay: SEC_0830 }))
      .toEqual({ state: 'unknown', firstDeparture: null, lastDeparture: null })
  })

  it('is unknown for absent fields, not just empty ones', () => {
    expect(operatingStatusOf({ nowSecOfDay: SEC_0830 }).state).toBe('unknown')
    expect(operatingStatusOf({ firstDeparture: null, lastDeparture: null, nowSecOfDay: SEC_2359 }).state)
      .toBe('unknown')
  })

  it('is unknown when only one end is known, and repeats only the known one', () => {
    // Half a service window cannot decide「还有没有车」: 12:00 could be mid-service
    // or long after the last train. The known end is reported as held, the other
    // stays null — the absent half is never filled in with a guessed clock.
    expect(operatingStatusOf({ firstDeparture: '05:16', lastDeparture: '', nowSecOfDay: SEC_0830 }))
      .toEqual({ state: 'unknown', firstDeparture: '05:16', lastDeparture: null })
  })

  it('is unknown for a malformed time instead of parsing what it can', () => {
    expect(operatingStatusOf({ firstDeparture: '早班', lastDeparture: '23:06', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
    expect(operatingStatusOf({ firstDeparture: '05:16', lastDeparture: '25:99', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
  })

  it('never reports 运营中 from missing data', () => {
    for (const nowSecOfDay of [SEC_0400, SEC_0830, SEC_2200, SEC_2359, SEC_0100]) {
      expect(operatingStatusOf({ firstDeparture: '', lastDeparture: '', nowSecOfDay }).state).not.toBe('operating')
    }
  })

  it('is unknown for a window that ends before it starts', () => {
    // 23:00 → 05:00 cannot both be this operating day's first and last train:
    // the pair is contradictory data, so no state is asserted from it.
    expect(operatingStatusOf({ firstDeparture: '23:00', lastDeparture: '05:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
  })
})

describe('an operating day that ends at 24:00', () => {
  const LINE_24 = { firstDeparture: '05:00', lastDeparture: '24:00' }

  it('accepts 24:00 as the last departure instead of rejecting the whole window', () => {
    // 「24:00」 is the end of the operating day, not a malformed 25th hour: a feed
    // that runs past midnight prints it as the last departure.
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: SEC_0830 })).toEqual({
      state: 'operating',
      firstDeparture: '05:00',
      lastDeparture: '24:00',
    })
  })

  it('is still 运营中 at 23:59 and 已过末班 once 24:00 has passed', () => {
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: SEC_2359 }).state).toBe('operating')
    // 00:30 belongs to that operating day's tail (24:30), after its 24:00 end.
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: 24 * 3600 + 30 * 60 }).state).toBe('after_last')
  })

  it('still refuses a time that is not exactly the end of the day', () => {
    for (const last of ['24:01', '24:30', '25:00']) {
      expect(operatingStatusOf({ firstDeparture: '05:00', lastDeparture: last, nowSecOfDay: SEC_0830 }).state)
        .toBe('unknown')
    }
  })

  it('cannot turn a window with no usable first departure into a known one', () => {
    // Half a window is still unknown; 24:00 as the FIRST departure is not a window
    // at all, and is refused by the ends-before-it-starts guard.
    expect(operatingStatusOf({ firstDeparture: '', lastDeparture: '24:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
    expect(operatingStatusOf({ firstDeparture: '24:00', lastDeparture: '23:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
  })
})

/**
 * The window this model cannot express — a NAMED LIMITATION, not a target.
 *
 * A service day whose LAST departure is printed as a morning hour (23:20 → 04:50)
 * runs past the 04:00 boundary at which the next operating day starts, so its end
 * lands beyond the model's 28:00 ceiling. Placing it would need that boundary
 * redefined, so the pair is reported 未知 rather than guessed at: the model must
 * not invent a state from hours it cannot place. Pinned here so the limitation is
 * visible rather than a silent wrong answer, and so a future day-model change has
 * to acknowledge it.
 */
describe('a window whose last departure crosses the 04:00 day boundary is unknown', () => {
  const OVERNIGHT = { firstDeparture: '23:20', lastDeparture: '04:50' }

  it('states no state at any hour, rather than a wrong one', () => {
    for (const nowSecOfDay of [SEC_0400, SEC_0830, SEC_2200, SEC_2359, SEC_0100]) {
      expect(operatingStatusOf({ ...OVERNIGHT, nowSecOfDay }).state).toBe('unknown')
    }
  })
})

describe('the operating-day model is the one the timetable already uses', () => {
  it('shifts an after-midnight departure into the previous operating day', () => {
    // 末班 00:30 is 24:30 in operating-day seconds, so 00:00 (24:00) is still
    // inside the service day rather than before its first train.
    expect(operatingStatusOf({ firstDeparture: '05:16', lastDeparture: '00:30', nowSecOfDay: 24 * 3600 }).state)
      .toBe('operating')
    expect(operatingStatusOf({ firstDeparture: '05:16', lastDeparture: '00:30', nowSecOfDay: SEC_0100 }).state)
      .toBe('after_last')
  })

  it('reads a Beijing instant as operating-day seconds, with 04:00 as the day boundary', () => {
    const at = (iso: string) => operatingDaySecondsOf(new Date(iso))
    expect(at('2026-09-24T08:30:00+08:00')).toBe(SEC_0830)
    expect(at('2026-09-24T22:00:00+08:00')).toBe(SEC_2200)
    expect(at('2026-09-24T23:59:00+08:00')).toBe(SEC_2359)
    // 01:00 and 03:59 belong to the previous operating day (24:00~28:00)...
    expect(at('2026-09-24T01:00:00+08:00')).toBe(SEC_0100)
    expect(at('2026-09-24T03:59:59+08:00')).toBe(27 * 3600 + 59 * 60 + 59)
    // ...and 04:00 is exactly the boundary where the new day starts at zero.
    expect(at('2026-09-24T04:00:00+08:00')).toBe(SEC_0400)
    expect(at('2026-09-24T00:00:00+08:00')).toBe(24 * 3600)
  })
})
