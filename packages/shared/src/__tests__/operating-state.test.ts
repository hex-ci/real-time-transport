import { describe, expect, it } from 'vitest'
import { operatingDaySecondsOf, operatingStatusOf } from '../operating-state.js'

/**
 * F3 的运营状态，作为纯逻辑。
 * 状态由线路**自己**的首末班时刻回答「今天还有没有车」，故过去被压成「暂无来车」的两件事
 * （尚未开班 / 已收班）在此一次性判定，并由测试覆盖，而不是取决于恰好渲染卡片的分支。
 * 下面每个用例都是输入的事实，与机器时钟无关：运营日秒数是入参，故任意时刻跑都得到同样的 01:00 与 04:00。
 */

/** 全篇使用的输入：某线路自己的首末班时刻。 */
const LINE = { firstDeparture: '05:16', lastDeparture: '23:06' }

/** 08:30，运营日内。 */
const SEC_0830 = 8 * 3600 + 30 * 60
/** 22:00，仍在运营日内，晚高峰之后。 */
const SEC_2200 = 22 * 3600
/** 23:59，末班已走。 */
const SEC_2359 = 23 * 3600 + 59 * 60
/** 01:00，运营日秒数越过 24:00 继续（「运营日」模型）。 */
const SEC_0100 = 25 * 3600
/** 04:00，运营日边界本身。 */
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
    // 恰在 05:16 首班正在发出、恰在 23:06 末班正在发出：两个边界都在运营日之内 ——
    // 末班时刻站在站台，与「已经错过服务」不是一回事。
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
    // 半截窗口判不出「还有没有车」：12:00 可能在运营中，也可能远在末班之后。
    // 已知的一端照实回报，另一端保持 null —— 缺失的一半绝不用猜来的时刻补上。
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
    // 23:00 → 05:00 不可能同属本运营日的首班与末班：这对数据自相矛盾，故不从它断言任何状态。
    expect(operatingStatusOf({ firstDeparture: '23:00', lastDeparture: '05:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
  })
})

describe('an operating day that ends at 24:00', () => {
  const LINE_24 = { firstDeparture: '05:00', lastDeparture: '24:00' }

  it('accepts 24:00 as the last departure instead of rejecting the whole window', () => {
    // 「24:00」是运营日终点（跨零点的班表把末班如此打印），不是非法的小时 25。
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: SEC_0830 })).toEqual({
      state: 'operating',
      firstDeparture: '05:00',
      lastDeparture: '24:00',
    })
  })

  it('is still 运营中 at 23:59 and 已过末班 once 24:00 has passed', () => {
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: SEC_2359 }).state).toBe('operating')
    // 00:30 属于该运营日的尾段（即 24:30），在其 24:00 终点之后。
    expect(operatingStatusOf({ ...LINE_24, nowSecOfDay: 24 * 3600 + 30 * 60 }).state).toBe('after_last')
  })

  it('still refuses a time that is not exactly the end of the day', () => {
    for (const last of ['24:01', '24:30', '25:00']) {
      expect(operatingStatusOf({ firstDeparture: '05:00', lastDeparture: last, nowSecOfDay: SEC_0830 }).state)
        .toBe('unknown')
    }
  })

  it('cannot turn a window with no usable first departure into a known one', () => {
    // 半截窗口仍为 unknown；把 24:00 当首班则根本不是窗口，被「终点不晚于起点」的守卫拒绝。
    expect(operatingStatusOf({ firstDeparture: '', lastDeparture: '24:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
    expect(operatingStatusOf({ firstDeparture: '24:00', lastDeparture: '23:00', nowSecOfDay: SEC_0830 }).state)
      .toBe('unknown')
  })
})

/**
 * 本模型无法表达的窗口 —— 这是一条具名限制，不是待办目标。
 * 末班被打印成早晨时刻的服务日（23:20 → 04:50）越过 04:00 这条下一运营日的起点，
 * 其终点落在模型 28:00 的上限之外。安放它就得重新定义该边界，
 * 故这对输入报 未知 而不猜：模型不得用自己无法定位的时刻造出状态。
 * 钉在这里，使这条限制可见而非变成静默的错答，也让未来改动日模型时必须先承认它。
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
    // 末班 00:30 即运营日秒数的 24:30，故 00:00（24:00）仍在运营日内，而不是在首班之前。
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
    // 01:00 与 03:59 属于前一运营日（24:00~28:00）；而 04:00 正是新运营日从零开始的边界。
    expect(at('2026-09-24T01:00:00+08:00')).toBe(SEC_0100)
    expect(at('2026-09-24T03:59:59+08:00')).toBe(27 * 3600 + 59 * 60 + 59)
    expect(at('2026-09-24T04:00:00+08:00')).toBe(SEC_0400)
    expect(at('2026-09-24T00:00:00+08:00')).toBe(24 * 3600)
  })
})
