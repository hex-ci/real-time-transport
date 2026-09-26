import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAIT_TOLERANCE_MINUTES,
  STALE_ARRIVAL_SECONDS,
  anchorLegAt,
  arrivalMinutes,
  arrivalTrust,
  departureAdvice,
  walkingMinutes,
} from '../departure.js'
import { DEFAULT_COMMUTE_HOURS } from '../constants.js'
import { CatchDecisionSchema } from '../schemas/gis.js'
import type { DepartureState } from '../departure.js'

/**
 * F1 的出门结论，在其边界上。
 * 公式刻意是纯的：参考行陈述的每个判定都在此完成，故两个真正带风险的边界
 * （等待容忍值、这班车开始赶不上的那一点）由测试钉住，而不是靠阅读 UI。
 * `walk` 与所有 ETA 都是真实上游数据的秒；算不出结论就扣留（null）而不猜。
 */

/** 6 分钟真实步行，取自 PRD 参考行的算例。 */
const WALK_6_MIN = 6 * 60

/** 按卡片展示口径换算的分钟数。 */
function minutes(n: number): number {
  return n * 60
}

describe('F1 departure advice: the wait tolerance T decides 现在就走', () => {
  it('leaves now when the slack is exactly the tolerance', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(9) })
    expect(a?.state).toBe('hurry')
    expect(a?.leaveInMinutes).toBe(0)
  })

  it('waits one minute longer when the slack is one minute above the tolerance', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(10) })
    expect(a?.state).toBe('comfortable')
    expect(a?.leaveInMinutes).toBe(1)
  })

  it('leaves now when the slack is one minute below the tolerance', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(8) })
    expect(a?.state).toBe('hurry')
    expect(a?.leaveInMinutes).toBe(0)
  })

  it('says 赶不上这班 when the bus arrives before the walk is done', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(5) })
    expect(a?.state).toBe('missed')
    expect(a?.leaveInMinutes).toBeNull()
  })

  it('treats a bus at the platform now as missed, not as catchable', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: 0 })
    expect(a?.state).toBe('missed')
  })

  it('catches a bus that is exactly the walk away', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(6) })
    expect(a?.state).toBe('hurry')
    expect(a?.leaveInMinutes).toBe(0)
  })

  it('follows a configured tolerance instead of the default', () => {
    const short = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(11), waitToleranceMinutes: 5 })
    expect(short?.state).toBe('hurry')

    const long = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(14), waitToleranceMinutes: 5 })
    expect(long?.state).toBe('comfortable')
    expect(long?.leaveInMinutes).toBe(3)
  })

  it('defaults the tolerance to 3 minutes', () => {
    expect(DEFAULT_WAIT_TOLERANCE_MINUTES).toBe(3)
    // 与上面恰好边界的用例同一输入：判定它的正是那个默认值。
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(9) })
    expect(a?.state).toBe('hurry')
  })
})

describe('F1 departure advice: the missed cost is the next bus, in real data', () => {
  it('reports the cost of missing this bus as eta2 - eta1', () => {
    const a = departureAdvice({
      walkSeconds: WALK_6_MIN,
      nextArrivalSeconds: minutes(5),
      followingArrivalSeconds: minutes(17),
    })
    expect(a?.missCostMinutes).toBe(12)
  })

  it('still gives the verdict when eta2 is unknown, with no invented cost', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(10) })
    expect(a?.state).toBe('comfortable')
    expect(a?.missCostMinutes).toBeNull()

    const missed = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4) })
    expect(missed?.state).toBe('missed')
    expect(missed?.missCostMinutes).toBeNull()
  })
})

describe('F1 departure advice: no conclusion without real data', () => {
  it('gives nothing when the walking time is unknown', () => {
    expect(departureAdvice({ walkSeconds: null, nextArrivalSeconds: minutes(10) })).toBeNull()
  })

  it('gives nothing when there is no vehicle to walk to', () => {
    expect(departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: null })).toBeNull()
  })

  it('gives nothing on stale arrival data', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4), trust: 'stale' })
    expect(a).toBeNull()
  })

  it('gives nothing on a degraded response', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4), trust: 'degraded' })
    expect(a).toBeNull()
  })

  it('gives the conclusion on data that is present and trusted', () => {
    const a = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4), trust: 'ok' })
    expect(a?.state).toBe('missed')
  })
})

describe('F1 departure advice: the minutes match what the card shows', () => {
  it('rounds the walk up to at least one minute, never to zero', () => {
    expect(walkingMinutes(20)).toBe(1)
    expect(walkingMinutes(6 * 60)).toBe(6)
    expect(walkingMinutes(340)).toBe(6)
  })

  it('shows a vehicle pulling in as 0 minutes, and never as two', () => {
    expect(arrivalMinutes(0)).toBe(0)
    expect(arrivalMinutes(30)).toBe(1)
    expect(arrivalMinutes(329)).toBe(5)
  })

  it('decides on the rounded minutes the user reads, not on raw seconds', () => {
    // 结论必须与屏上数字一致：5 分 29 秒读作 5、5 分 40 秒读作 6，故 5 - 6 < 0。
    const a = departureAdvice({ walkSeconds: 340, nextArrivalSeconds: 329 })
    expect(a?.walkMinutes).toBe(6)
    expect(a?.nextArrivalMinutes).toBe(5)
    expect(a?.state).toBe('missed')
  })
})

describe('F1 departure advice: the three verdicts reuse the catch-the-bus vocabulary', () => {
  it('states comfortable / hurry / missed, and nothing else', () => {
    const produced: DepartureState[] = [
      departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(20) })!.state,
      departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(9) })!.state,
      departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4) })!.state,
    ]
    expect([...produced].sort()).toEqual(['comfortable', 'hurry', 'missed'])
    for (const state of produced) expect(CatchDecisionSchema.options).toContain(state)
  })

  it('carries a departure time only where one exists', () => {
    // 结论自身的形状把「还没有答案」挡在行外：comfortable 必有时刻、missed 必无，
    // 两者都不是会被渲染成答案的 null。
    const comfortable = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(12) })!
    expect(comfortable.state).toBe('comfortable')
    expect(typeof comfortable.leaveInMinutes).toBe('number')

    const missed = departureAdvice({ walkSeconds: WALK_6_MIN, nextArrivalSeconds: minutes(4) })!
    expect(missed.state).toBe('missed')
    expect(missed.leaveInMinutes).toBeNull()
  })
})

describe('the anchor a user is standing at comes from the commute windows', () => {
  it('uses 家 across the morning window, endpoints included', () => {
    expect(anchorLegAt('06:30', DEFAULT_COMMUTE_HOURS)).toBe('home')
    expect(anchorLegAt('09:00', DEFAULT_COMMUTE_HOURS)).toBe('home')
    expect(anchorLegAt('11:30', DEFAULT_COMMUTE_HOURS)).toBe('home')
  })

  it('uses 公司 across the evening window, endpoints included', () => {
    expect(anchorLegAt('17:00', DEFAULT_COMMUTE_HOURS)).toBe('work')
    expect(anchorLegAt('21:59', DEFAULT_COMMUTE_HOURS)).toBe('work')
    expect(anchorLegAt('22:00', DEFAULT_COMMUTE_HOURS)).toBe('work')
  })

  it('names no anchor outside both windows, rather than guessing one', () => {
    expect(anchorLegAt('11:31', DEFAULT_COMMUTE_HOURS)).toBeNull()
    expect(anchorLegAt('16:59', DEFAULT_COMMUTE_HOURS)).toBeNull()
    expect(anchorLegAt('22:01', DEFAULT_COMMUTE_HOURS)).toBeNull()
    expect(anchorLegAt('03:00', DEFAULT_COMMUTE_HOURS)).toBeNull()
  })

  it('follows the windows the user configured', () => {
    const hours = { morningStart: '07:00', morningEnd: '10:00', eveningStart: '18:00', eveningEnd: '23:00' }
    expect(anchorLegAt('06:59', hours)).toBeNull()
    expect(anchorLegAt('07:00', hours)).toBe('home')
    expect(anchorLegAt('18:00', hours)).toBe('work')
    expect(anchorLegAt('23:00', hours)).toBe('work')
  })
})

describe('arrival data is trusted only while it is fresh and not degraded', () => {
  const now = 1_700_000_000_000

  it('trusts a fresh reading', () => {
    expect(arrivalTrust({ updatedAt: now, now })).toBe('ok')
    expect(arrivalTrust({ updatedAt: now - 18_000, now })).toBe('ok')
  })

  it('trusts a reading exactly at the staleness limit, and not one second past it', () => {
    expect(arrivalTrust({ updatedAt: now - STALE_ARRIVAL_SECONDS * 1000, now })).toBe('ok')
    expect(arrivalTrust({ updatedAt: now - STALE_ARRIVAL_SECONDS * 1000 - 1000, now })).toBe('stale')
  })

  it('marks a response served by a fallback source as degraded', () => {
    expect(arrivalTrust({ isDegraded: true, updatedAt: now, now })).toBe('degraded')
  })
})
