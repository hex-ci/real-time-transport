import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * F3/F4 on the platform board: a row whose request failed states that failure ONCE.
 *
 * The failure used to be keyed off a display word. The view set `statusText: '离线'`,
 * the numbers column branched on `item.statusText === '离线'` to print 无法获取 /
 * 数据暂不可用, and the crowding chip rendered the same field — so the SAME row said
 * 「无法获取」 in one column and 「离线」 in the other: two words for one fact, and a
 * third word waiting to happen the next time the chip's field was reused. The failure
 * is now a named state the row carries, and the chip's label comes from the crowding
 * level, so the numbers column owns the failure and the chip states a different fact.
 *
 * The board is a browser-only SFC and this repo has no DOM harness, so the wiring is
 * asserted against the source — the same way congestion.test.ts checks its bindings.
 *
 * A ROW'S FIELDS ARE DECIDED IN `departure-row.ts` now (H1: the board's minute needed a
 * request that names the platform's stop order, and the builder moved out of the view with
 * it), so the counts below are taken from there. What the view still owes is that it hands
 * the builder a failure state rather than a message.
 */

const board = readFileSync(
  fileURLToPath(new URL('../components/departure-board.vue', import.meta.url)),
  'utf8',
)
const view = readFileSync(
  fileURLToPath(new URL('../index.vue', import.meta.url)),
  'utf8',
)
const rows = readFileSync(
  fileURLToPath(new URL('../departure-row.ts', import.meta.url)),
  'utf8',
)

describe('the failed-request row states its failure once', () => {
  it('keys the failure off a named state, never off a word meant for a human', () => {
    // The numbers column branches on the state the row carries…
    expect(board).toContain('item.unavailable')
    // …and the sentinel it used to branch on survives nowhere.
    expect(board).not.toContain('离线')
    expect(view).not.toContain('离线')
    expect(rows).not.toContain('离线')
    // The field that carried a rendered word is gone with it, so no branch can
    // key on a string again without saying so here.
    expect(board).not.toContain('statusText')
    expect(view).not.toContain('statusText')
    expect(rows).not.toContain('statusText')
  })

  it('states the failure in the numbers column, in one wording', () => {
    expect(board.match(/无法获取/g)?.length, 'the failure word is stated more than once')
      .toBe(1)
    expect(board.match(/数据暂不可用/g)?.length).toBe(1)
  })

  it('does not echo the failure on the chip — the chip is the crowding verdict', () => {
    expect(board).toContain('congestionLabel(item.congestion)')
  })

  it('marks exactly the failed row as unavailable', () => {
    // One state, set once, in the row builder. A row with a vehicle and a row with an
    // operating fact both have an answer; only the request that failed is unavailable.
    expect(rows.match(/unavailable:\s*true/g)?.length).toBe(1)
    expect(rows.match(/unavailable:\s*false/g)?.length).toBe(2)
  })
})
