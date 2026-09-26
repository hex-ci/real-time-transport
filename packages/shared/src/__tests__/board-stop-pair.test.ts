import { describe, expect, it } from 'vitest'
import { placeBoardStop, resolveBoardStopRef } from '../line-group.js'

/**
 * 收藏的上车站是一个 (站名, 站序) **配对**，读回时绝不能回落到第一个重名的站。
 *
 * 此处钉住的规则与仓库对换乘链路段车站的规则同一条（007：站名与站序同生同灭，
 * 二者同在或同缺，「未选择」即 NULL）：身份就是这对值；只留下站名的旧行**没有**站序
 * （绝不猜），站名在一次停靠中出现多次而又没有已存站序时**不可用** ——
 * 拒绝，绝不解析到第一个匹配。
 */

const DUP = '和平东桥'

/** 环线方向 0：同一站名出现在两端。 */
const LOOP_DIR0 = [
  { name: DUP, order: 1 },
  { name: '安贞桥东', order: 2 },
  { name: DUP, order: 36 },
]

/** 同一线路的另一方向完全不经过该站名。 */
const LOOP_DIR1 = [
  { name: '安贞桥东', order: 1 },
  { name: '安慧桥', order: 2 },
]

describe('a stored stop carries its order, and a legacy row never has one invented', () => {
  it('reads the pair a row stores — name AND order', () => {
    const fav = { morningStopName: DUP, morningStopOrder: 36 }
    expect(resolveBoardStopRef(fav, 'morning')).toEqual({ name: DUP, order: 36 })
  })

  it('reads a purpose-keyed row independently, so the two legs cannot borrow each other', () => {
    const fav = {
      morningStopName: DUP,
      morningStopOrder: 36,
      eveningStopName: '安慧桥',
      eveningStopOrder: 4,
    }
    expect(resolveBoardStopRef(fav, 'morning')).toEqual({ name: DUP, order: 36 })
    expect(resolveBoardStopRef(fav, 'evening')).toEqual({ name: '安慧桥', order: 4 })
  })

  it('reports order null for a row written before the order columns existed', () => {
    // 旧行的站序确实未知：null 就是这个事实。0 或 1 都是凭空造的站，
    // 而拿站名去列表里解析，正是让选了第36站的人落到第1站的做法。
    expect(resolveBoardStopRef({ morningStopName: DUP }, 'morning')).toEqual({ name: DUP, order: null })
  })

  it('treats a stored empty name as no stop at all, never as a stop named ""', () => {
    // 空串既不是站也不是清除，必须读成「什么都没存」。
    expect(resolveBoardStopRef({ morningStopName: '' }, 'morning')).toBeNull()
    expect(resolveBoardStopRef({}, 'morning')).toBeNull()
  })

  it('drops an order that is not a non-negative integer rather than using it', () => {
    // 该列是可空 INT；读到非整数只能是存储写不出来的值，故视为未知而非站序。
    for (const order of [-1, 1.5, Number.NaN]) {
      expect(resolveBoardStopRef({ morningStopName: DUP, morningStopOrder: order }, 'morning'))
        .toEqual({ name: DUP, order: null })
    }
  })
})

describe('resolution against a direction\'s own stop list', () => {
  it('resolves a stored pair to THAT stop, not to the first stop of the same name', () => {
    // RED-first 钉点：已存配对是第36站，而列表里第一个和平东桥是第1站；
    // 首个匹配会报 1 —— 那就是缺陷。
    expect(placeBoardStop(LOOP_DIR0, { name: DUP, order: 36 }))
      .toEqual({ state: 'placed', name: DUP, order: 36 })
    // 正向对照：规则是「已存站序」，不是「总取靠后的那个」。
    expect(placeBoardStop(LOOP_DIR0, { name: DUP, order: 1 }))
      .toEqual({ state: 'placed', name: DUP, order: 1 })
  })

  it('refuses an ambiguous name with no stored order as NOT USABLE', () => {
    // RED-first 钉点：站名出现两次而该行没有站序。解析不出来，故如实报告两个候选站序，
    // 交由界面说明混的是哪几站 —— 两者都不声称属于用户。
    expect(placeBoardStop(LOOP_DIR0, { name: DUP, order: null }))
      .toEqual({ state: 'ambiguous', name: DUP, orders: [1, 36] })
  })

  it('still resolves a name-only row when the name is unambiguous in this direction', () => {
    // 唯一可以诚实读出的旧行：只有一个候选，点名它不算猜。
    // 这是唯一允许用站名定位一站的情形。
    expect(placeBoardStop(LOOP_DIR0, { name: '安贞桥东', order: null }))
      .toEqual({ state: 'placed', name: '安贞桥东', order: 2 })
  })

  it('reports a stored order the list no longer carries as stale, never re-resolved by name', () => {
    // RED-first 钉点：上游重编了站序 —— 站名只剩在下标 1，而行里存的是 36。
    // 回落到站名匹配会悄悄挪走用户的站；诚实的答案是「不可用」。
    expect(placeBoardStop([{ name: DUP, order: 1 }, { name: '安贞桥东', order: 2 }], { name: DUP, order: 36 }))
      .toEqual({ state: 'stale', name: DUP, order: 36 })
    // 站名整条从列表里消失是另一件事、另一句话 —— 那里「不在本方向停靠」恰好为真，
    // 而「站序已变」会是凭空编的。两种情形都不按站名重新解析。
    expect(placeBoardStop(LOOP_DIR1, { name: DUP, order: 36 }))
      .toEqual({ state: 'absent', name: DUP })
  })

  it('reports a name this direction does not serve as absent', () => {
    expect(placeBoardStop(LOOP_DIR1, { name: DUP, order: null }))
      .toEqual({ state: 'absent', name: DUP })
  })

  it('reports an unread list as unknown, never as absent', () => {
    // 「未加载」与「不在本方向停靠」是不同的事实：
    // 在没人读过的那份列表还在路上时，方向变更警告不得触发。
    expect(placeBoardStop(undefined, { name: DUP, order: 36 })).toEqual({ state: 'not-loaded' })
    expect(placeBoardStop(null, { name: DUP, order: null })).toEqual({ state: 'not-loaded' })
  })

  it('says unset when nothing is stored, whatever the list holds', () => {
    expect(placeBoardStop(LOOP_DIR0, null)).toEqual({ state: 'unset' })
    expect(placeBoardStop(undefined, null)).toEqual({ state: 'unset' })
  })

  it('places nothing in a direction that answered with no stops at all', () => {
    expect(placeBoardStop([], { name: DUP, order: 36 })).toEqual({ state: 'absent', name: DUP })
    expect(placeBoardStop([], { name: DUP, order: null })).toEqual({ state: 'absent', name: DUP })
  })
})
