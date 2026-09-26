import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commuteLegNoticeOf, commuteLegStateOf, commuteStopOf } from '../views/overview/commute-leg'

/**
 * 首页通勤卡 + F1 参考行：读哪一站，由存下来的 (站名, 站序) 决定。
 *
 * 钉两件事：读侧的判据（`commuteStopOf` —— 站序在就用站序，同名两站而没有站序就**读不出来**），
 * 以及卡片真正用了它（源码守卫，因为这个包没有 DOM 测试台）。
 */

const DUP = '和平东桥'

/** 300内 方向 0：同一个名字在首末两站各出现一次。 */
const DIR0 = [
  { name: DUP, order: 1 },
  { name: '安贞桥东', order: 2 },
  { name: DUP, order: 36 },
]

/** 同一线路的另一侧完全不停这个名字。 */
const DIR1 = [
  { name: '安贞桥东', order: 1 },
  { name: '安慧桥', order: 2 },
]

describe('卡片读到的站，是存下来的那一站', () => {
  it('存了第36站：读到第36站，不是同名里的第1站', () => {
    expect(commuteStopOf({ morningStopName: DUP, morningStopOrder: 36 }, 'morning', DIR0))
      .toEqual({ name: DUP, order: 36 })
    // 正对照：规则是「存下来的那一站」，不是「总是取后面那个」。
    expect(commuteStopOf({ morningStopName: DUP, morningStopOrder: 1 }, 'morning', DIR0))
      .toEqual({ name: DUP, order: 1 })
  })

  it('只存了名字、而这个方向同名两站：读不出来，绝不取第一个', () => {
    // 开发实例里的行（300内, 和平东桥, 无站序）：按首个同名站解析会给出第 1 站，那是错的站。
    expect(commuteStopOf({ morningStopName: DUP }, 'morning', DIR0)).toBeNull()
  })

  it('只存了名字、而这个方向只有一站叫这个名字：读得出来，那不是猜', () => {
    expect(commuteStopOf({ morningStopName: '安贞桥东' }, 'morning', DIR0))
      .toEqual({ name: '安贞桥东', order: 2 })
  })

  it('站序与名字对不上（上游改了站表）：读不出来，也不回退成按名字匹配', () => {
    // 存下来的是 (和平东桥, 36)，而本方向只在站序 1 有这个名字：
    // 退回按名字会静默移动用户的站。
    expect(commuteStopOf({ morningStopName: DUP, morningStopOrder: 36 }, 'morning', [DIR0[0]!, DIR0[1]!]))
      .toBeNull()
  })

  it('改了方向到不停该站的一侧：读不出来，且站还在行里', () => {
    // 存下来的 (站名, 站序) 不因方向改变而改变（那是用户的选择），新方向只是定位不到它；
    // 绝不能取「新方向里首个同名站」，那是另一个站台。
    const fav = { morningStopName: DUP, morningStopOrder: 36, morningDirection: 1 }
    expect(commuteStopOf(fav, 'morning', DIR1)).toBeNull()
    // 行里仍持有 (站名, 站序)：读取不会把它清掉。
    expect(fav).toEqual({ morningStopName: DUP, morningStopOrder: 36, morningDirection: 1 })
  })

  it('两个用途各读各自的那一对', () => {
    const fav = {
      morningStopName: DUP,
      morningStopOrder: 36,
      eveningStopName: '安慧桥',
      eveningStopOrder: 2,
    }
    expect(commuteStopOf(fav, 'morning', DIR0)).toEqual({ name: DUP, order: 36 })
    expect(commuteStopOf(fav, 'evening', DIR1)).toEqual({ name: '安慧桥', order: 2 })
  })

  it('站点表还没读到：读不出来（不是「没停靠」）', () => {
    expect(commuteStopOf({ morningStopName: DUP, morningStopOrder: 36 }, 'morning', undefined)).toBeNull()
  })
})

describe('这一腿的状态与它说的话', () => {
  it('同名两站而没有站序：状态是「同名」，话里说的是同名，不是「不在本方向停靠」', () => {
    const state = commuteLegStateOf({
      direction: 0,
      stop: { name: DUP, order: null },
      stops: DIR0,
    })
    expect(state).toBe('stop-ambiguous')

    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toContain('同名')
    expect(notice).toContain('「设置」')
    expect(notice, 'a stop this direction does serve was worded as unserved').not.toContain('不在')
    expect(notice.length, 'long enough to crowd a 375px card').toBeLessThanOrEqual(24)
  })

  it('站序对不上：状态是「站序已变」，说的是站序变了，不是一个假的不停靠', () => {
    const state = commuteLegStateOf({
      direction: 0,
      stop: { name: DUP, order: 36 },
      stops: [DIR0[0]!, DIR0[1]!],
    })
    expect(state).toBe('stop-stale')

    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toContain('站序')
    expect(notice).toContain('「设置」')
    expect(notice, 'a stale order was worded as an unserved stop').not.toContain('不在')
    expect(notice.length).toBeLessThanOrEqual(24)
  })

  it('存下来的那一站在这个方向：可以读，什么也不用说', () => {
    expect(commuteLegStateOf({ direction: 0, stop: { name: DUP, order: 36 }, stops: DIR0 })).toBe('ready')
    expect(commuteLegNoticeOf('ready', 'morning')).toBeNull()
  })

  it('这个方向真的不停这一站：仍然是「不在本方向停靠」', () => {
    const state = commuteLegStateOf({ direction: 1, stop: { name: DUP, order: null }, stops: DIR1 })
    expect(state).toBe('stop-unserved')
    expect(commuteLegNoticeOf(state, 'morning')).toBe('上班上车点不在本方向停靠 · 在「设置」中重选')
  })
})

describe('卡片与 F1 参考行真的走了这条判据', () => {
  const overview = readFileSync(
    fileURLToPath(new URL('../views/overview/index.vue', import.meta.url)),
    'utf8',
  )

  it('卡片读的站来自 commuteStopOf，而不是按名字 find 出来的第一个', () => {
    expect(overview).toContain('commuteStopOf(f, purpose')
    expect(overview, 'the card still resolves the stored stop by name, taking the first match')
      .not.toMatch(/stops\.find\(s => s\.name ===/)
    // 站的序号随之传递：到站请求以它发起（`?order=`），服务端由此读到用户真正选的站台。
    expect(overview).toContain('stopOrder: stop.order')
  })

  it('这一腿的判据读的是 (站名, 站序) 一对，不是一个名字', () => {
    expect(overview).toContain('commuteLegStateOf({ direction')
    expect(overview).not.toContain('stopName: boardStop')
    expect(overview).toContain('resolveBoardStopRef(f, purpose)')
  })
})

describe('另外两处按名字认站的地方，也改成按 (站名, 站序) 认', () => {
  const detail = readFileSync(
    fileURLToPath(new URL('../views/line-detail/index.vue', import.meta.url)),
    'utf8',
  )
  const board = readFileSync(
    fileURLToPath(new URL('../views/line-detail/components/route-board.vue', import.meta.url)),
    'utf8',
  )

  it('报站板的「上/下」角标：同名两站里只标存下来的那一站', () => {
    // Konva 的静态层没有测试台，所以这里钉的是源码：旧的比较是 `name === morningStopName`，
    // 它在 300内 方向 0 上把两个「和平东桥」都标成上班上车点 —— 其中一个是使用者没选的站台。
    expect(board).toContain('storedStopAt(pt.station, morningStopName, morningStopOrder)')
    expect(board, 'the board badges every station that shares the stored name')
      .not.toContain('pt.station.name === morningStopName')
    expect(board, 'the order is not part of what forces a redraw, so the badge can go stale')
      .toContain('morningStopOrder, eveningStopName, eveningStopOrder')
  })

  it('详情页把站序交给了报站板', () => {
    expect(detail).toContain(':morning-stop-order="matchingFavorite?.morningStopOrder ?? null"')
    expect(detail).toContain(':evening-stop-order="matchingFavorite?.eveningStopOrder ?? null"')
  })

  it('弹窗里的「上班上车点 ✓」比的是一对，不是一个名字', () => {
    expect(detail).toContain('isStoredStop(fav, \'morning\', station)')
    expect(detail, 'the popover badge is placed by name, so both same-named stops claim it')
      .not.toContain('fav.morningStopName === selectedStation.value.name')
  })
})
