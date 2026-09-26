import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commuteLegNoticeOf, commuteLegStateOf } from '../views/overview/commute-leg'
import type { CommuteLegState } from '../views/overview/commute-leg'

/**
 * 首页卡片读不出通勤路段时说的话。
 *
 * 卡片的那个槽位只有一个句子。缺行是症状而非状态——站已设置、方向未选时同样缺行。
 * 因此路段状态从卡片看不见的字段读出并交给它（上车点 `morningStopName` /
 * `eveningStopName`，方向 `morningDirection` / `eveningDirection`），卡片不靠数行决定。
 *
 * 措辞是纯逻辑（本应用无 DOM 测试台），故在此测试；末尾的守卫钉单元测试看不到的接线：
 * 总览从这些字段建立状态，卡片自己不造任何词。
 */

/** 某方向的站表，形状与共享站规则读的一致。 */
const STOPS = [
  { name: '甲站', order: 1 },
  { name: '乙站', order: 2 },
  { name: '丙站', order: 3 },
]

describe('a leg whose boarding stop is set and whose direction is not', () => {
  it('names the direction as the missing fact, never the stop', () => {
    const state = commuteLegStateOf({ direction: null, stop: { name: '乙站', order: 4 }, stops: undefined })
    expect(state).toBe('direction-unset')

    const notice = commuteLegNoticeOf(state, 'morning')
    expect(notice).toBe('未设置上班方向 · 在「设置」中设置')
    // 本状态不得使用的词：站已设置，不得说未设置。
    expect(notice).not.toContain('上车点')
  })

  it('is a different state from a leg with nothing configured at all', () => {
    const nothing = commuteLegStateOf({ direction: null, stop: null, stops: undefined })
    expect(nothing).toBe('leg-unset')
    expect(commuteLegNoticeOf(nothing, 'morning'))
      .toBe('未设置上班方向和上车点 · 在「设置」中设置')
    expect(commuteLegNoticeOf(nothing, 'morning'))
      .not.toBe(commuteLegNoticeOf('direction-unset', 'morning'))
  })

  it('reads the direction the leg rides, so a one-way route is never stuck here', () => {
    // `effectiveCommuteDirection` 把单方向线路解析到该方向，因此本状态只在双向线路上到达。
    expect(commuteLegStateOf({ direction: 1, stop: { name: '乙站', order: 2 }, stops: STOPS })).toBe('ready')
  })
})

describe('a leg whose direction is chosen', () => {
  it('states the stop is unset only when it is unset, in the leg words the card shows', () => {
    const state = commuteLegStateOf({ direction: 1, stop: null, stops: STOPS })
    expect(state).toBe('stop-unset')
    expect(commuteLegNoticeOf(state, 'morning')).toBe('未设置上班上车点 · 在「设置」中设置')
    expect(commuteLegNoticeOf(state, 'evening')).toBe('未设置下班上车点 · 在「设置」中设置')
  })

  it('says the stop is unread on this direction when the direction skips it', () => {
    const state = commuteLegStateOf({ direction: 0, stop: { name: '丁站', order: 4 }, stops: STOPS })
    expect(state).toBe('stop-unserved')
    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toBe('上班上车点不在本方向停靠 · 在「设置」中重选')
    // 站存在且已存储：这里的任何措辞都不能说从未设置。
    expect(notice).not.toContain('未设置')
  })

  it('claims no mismatch from a direction that answered with no stops at all', () => {
    // 空列表意为「本方向没有站数据」，既不是「你的站不在其中」也不是「未设置站」，
    // 后两者都在断言一个没人读过的列表。
    const state = commuteLegStateOf({ direction: 0, stop: { name: '乙站', order: 2 }, stops: [] })
    expect(state).toBe('stops-unavailable')
    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toBe('本方向暂无站点数据，无法显示到站时间')
    expect(notice).not.toContain('未设置')
    expect(notice).not.toContain('不在')
  })

  it('has nothing to state once the direction serves the stop', () => {
    const state = commuteLegStateOf({ direction: 0, stop: { name: '乙站', order: 2 }, stops: STOPS })
    expect(state).toBe('ready')
    expect(commuteLegNoticeOf(state, 'morning')).toBeNull()
  })

  it('has nothing to state while that direction has no loaded stop list', () => {
    const state = commuteLegStateOf({ direction: 0, stop: { name: '乙站', order: 2 }, stops: undefined })
    expect(state).toBeNull()
    expect(commuteLegNoticeOf(state, 'morning')).toBeNull()
  })
})

describe('every notice either points at the screen that owns these settings or asks nothing of the user', () => {
  it('names 设置 — never a screen this app does not have', () => {
    const actionable: CommuteLegState[] = [
      'leg-unset', 'direction-unset', 'stop-unset', 'stop-unserved', 'stop-ambiguous', 'stop-stale',
    ]
    for (const state of actionable) {
      const notice = commuteLegNoticeOf(state, 'morning')!
      expect(notice, `${state} points nowhere`).toContain('「设置」')
      expect(notice, `${state} names a screen that does not exist`).not.toContain('管理关注')
    }
  })

  it('promises no setting for a direction that has no stop data', () => {
    // 任何界面的设置都不给上游方向配站表，因此这里陈述事实后停下，不把用户送往无用之地。
    const notice = commuteLegNoticeOf('stops-unavailable', 'morning')!
    expect(notice).not.toContain('「设置」')
  })

  it('stays one short line of body text per state', () => {
    const all: CommuteLegState[] = [
      'leg-unset', 'direction-unset', 'stop-unset', 'stops-unavailable', 'stop-unserved',
      'stop-ambiguous', 'stop-stale',
    ]
    for (const state of all) {
      const notice = commuteLegNoticeOf(state, 'morning')!
      expect(notice.length, `${state} is long enough to crowd a 375px card`).toBeLessThanOrEqual(24)
    }
  })
})

describe('the card is handed the state and words none of it', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )

  /** 卡片的 script：此处本可从它持有的行推断状态。 */
  const script = card.slice(0, card.indexOf('<template>'))

  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    return sfc.slice(start)
  }

  it('renders the notice for the state it was given', () => {
    const template = templateOf(card)
    expect(template, 'the card renders no state-derived notice').toContain('{{ legNotice }}')
    expect(script, 'the card words the notice itself').toContain('commuteLegNoticeOf(')
  })

  it('takes the state as a prop rather than counting its own rows', () => {
    expect(card, 'the card does not receive the leg state').toContain('legState')
    expect(script, 'the card still infers a commute state from an empty row list')
      .not.toContain('awaitingBoardStop')
  })

  it('words no leg state in its template', () => {
    // 「未设置」现在属于 copy 模块：状态在那里变成措辞。
    expect(templateOf(card), 'the card template states a leg state itself').not.toContain('未设置')
  })
})

describe('the overview reads the leg state off the favourite fields it already holds', () => {
  const overview = readFileSync(
    fileURLToPath(new URL('../views/overview/index.vue', import.meta.url)),
    'utf8',
  )
  const grid = readFileSync(
    fileURLToPath(new URL('../views/overview/components/card-grid.vue', import.meta.url)),
    'utf8',
  )

  it('establishes it for both commute branches, and claims none for nearby', () => {
    expect(overview.match(/commuteLegStateOf\(/g)).toHaveLength(2)
    expect(overview.match(/legState: null/g)).toHaveLength(1)
    expect(grid, 'the card grid drops the state on its way to the card')
      .toContain(':leg-state="line.legState"')
  })

  it('feeds it the board stop it resolved and the stop list of the chosen direction', () => {
    // 交给卡片的是它看不见的事实：用户为**本段**设了哪一站，以及所选方向是否停靠那里。
    expect(overview).toMatch(/const boardStop = resolveBoardStopRef\(f, purpose\)/)
    expect(overview).toContain('stops: detail?.stops')
  })
})
