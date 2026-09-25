import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commuteLegNoticeOf, commuteLegStateOf } from '../views/overview/commute-leg'
import type { CommuteLegState } from '../views/overview/commute-leg'

/**
 * What a home card says when it cannot read a commute leg.
 *
 * The card has one slot for that and it used to hold one sentence, chosen by "no
 * row came back". An absent row is a symptom, not a state: it is also absent on a
 * line whose boarding stop IS set and whose direction was never chosen, and the
 * card told that user their stop was not set — a claim the favourite's own fields
 * contradict. So the leg's state is read from those fields (the board stop
 * `morningStopName` / `eveningStopName`, and the direction the user chose,
 * `morningDirection` / `eveningDirection`) and it is GIVEN to the card; the card
 * counts no rows to decide it.
 *
 * The wording is pure logic (this app has no DOM test harness), so it is tested
 * here; the guards at the end hold the wiring a unit test cannot see — that the
 * overview establishes the state from those fields, and that the card words none
 * of it itself.
 */

/** A direction's own stop list, in the shape the shared stop rule reads. */
const STOPS = [{ name: '甲站' }, { name: '乙站' }, { name: '丙站' }]

describe('a leg whose boarding stop is set and whose direction is not', () => {
  it('names the direction as the missing fact, never the stop', () => {
    const state = commuteLegStateOf({ direction: null, stopName: '乙站', stops: undefined })
    expect(state).toBe('direction-unset')

    const notice = commuteLegNoticeOf(state, 'morning')
    expect(notice).toBe('未设置上班方向 · 在「设置」中设置')
    // The word this state may not use: the stop is set, and saying otherwise is
    // what the card did for as long as the state was read off an empty row list.
    expect(notice).not.toContain('上车点')
  })

  it('is a different state from a leg with nothing configured at all', () => {
    const nothing = commuteLegStateOf({ direction: null, stopName: null, stops: undefined })
    expect(nothing).toBe('leg-unset')
    expect(commuteLegNoticeOf(nothing, 'morning'))
      .toBe('未设置上班方向和上车点 · 在「设置」中设置')
    expect(commuteLegNoticeOf(nothing, 'morning'))
      .not.toBe(commuteLegNoticeOf('direction-unset', 'morning'))
  })

  it('reads the direction the leg rides, so a one-way route is never stuck here', () => {
    // `effectiveCommuteDirection` resolves a route with a single direction to
    // that direction, so this state is only ever reached on a two-way route.
    expect(commuteLegStateOf({ direction: 1, stopName: '乙站', stops: STOPS })).toBe('ready')
  })
})

describe('a leg whose direction is chosen', () => {
  it('states the stop is unset only when it is unset, in the leg words the card shows', () => {
    const state = commuteLegStateOf({ direction: 1, stopName: null, stops: STOPS })
    expect(state).toBe('stop-unset')
    expect(commuteLegNoticeOf(state, 'morning')).toBe('未设置上班上车点 · 在「设置」中设置')
    expect(commuteLegNoticeOf(state, 'evening')).toBe('未设置下班上车点 · 在「设置」中设置')
  })

  it('says the stop is unread on this direction when the direction skips it', () => {
    const state = commuteLegStateOf({ direction: 0, stopName: '丁站', stops: STOPS })
    expect(state).toBe('stop-unserved')
    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toBe('上班上车点不在本方向停靠 · 在「设置」中重选')
    // The stop exists and is stored: nothing here may say it was never set.
    expect(notice).not.toContain('未设置')
  })

  it('claims no mismatch from a direction that answered with no stops at all', () => {
    // An empty list is "this direction has no stop data", which is neither "your
    // stop is not on it" nor "no stop is set" — both would assert a fact about a
    // list nobody read.
    const state = commuteLegStateOf({ direction: 0, stopName: '乙站', stops: [] })
    expect(state).toBe('stops-unavailable')
    const notice = commuteLegNoticeOf(state, 'morning')!
    expect(notice).toBe('本方向暂无站点数据，无法显示到站时间')
    expect(notice).not.toContain('未设置')
    expect(notice).not.toContain('不在')
  })

  it('has nothing to state once the direction serves the stop', () => {
    const state = commuteLegStateOf({ direction: 0, stopName: '乙站', stops: STOPS })
    expect(state).toBe('ready')
    expect(commuteLegNoticeOf(state, 'morning')).toBeNull()
  })

  it('has nothing to state while that direction has no loaded stop list', () => {
    const state = commuteLegStateOf({ direction: 0, stopName: '乙站', stops: undefined })
    expect(state).toBeNull()
    expect(commuteLegNoticeOf(state, 'morning')).toBeNull()
  })
})

describe('every notice either points at the screen that owns these settings or asks nothing of the user', () => {
  it('names 设置 — never a screen this app does not have', () => {
    const actionable: CommuteLegState[] = ['leg-unset', 'direction-unset', 'stop-unset', 'stop-unserved']
    for (const state of actionable) {
      const notice = commuteLegNoticeOf(state, 'morning')!
      expect(notice, `${state} points nowhere`).toContain('「设置」')
      expect(notice, `${state} names a screen that does not exist`).not.toContain('管理关注')
    }
  })

  it('promises no setting for a direction that has no stop data', () => {
    // No setting on any screen gives an upstream direction its stop list, so this
    // one states the fact and stops instead of sending the user nowhere useful.
    const notice = commuteLegNoticeOf('stops-unavailable', 'morning')!
    expect(notice).not.toContain('「设置」')
  })

  it('stays one short line of body text per state', () => {
    const all: CommuteLegState[] = [
      'leg-unset', 'direction-unset', 'stop-unset', 'stops-unavailable', 'stop-unserved',
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

  /** The card's script, where a state could be inferred from the rows it holds. */
  const script = card.slice(0, card.indexOf('<template>'))

  /** Everything between the SFC's own <template> tags: what reaches the screen. */
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
    // 未设置 was the card's own sentence for every unreadable leg; it belongs to
    // the copy module now, where a state becomes the words for it.
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
    // Two commute branches push a card: one with no direction chosen, one with the
    // direction chosen. Nearby has no commute leg, so its cards carry none.
    expect(overview.match(/commuteLegStateOf\(/g)).toHaveLength(2)
    expect(overview.match(/legState: null/g)).toHaveLength(1)
    expect(grid, 'the card grid drops the state on its way to the card')
      .toContain(':leg-state="line.legState"')
  })

  it('feeds it the board stop it resolved and the stop list of the chosen direction', () => {
    // The facts handed in are the ones the card cannot see: which stop the user
    // set for THIS leg, and whether the direction they chose calls there.
    expect(overview).toMatch(/const boardStop = resolveBoardStop\(f, purpose\)/)
    expect(overview).toContain('stops: detail?.stops')
  })
})
