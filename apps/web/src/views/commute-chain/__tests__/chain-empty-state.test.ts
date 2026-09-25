import { describe, expect, it } from 'vitest'
import { anchorForPurpose, emptyStateOf } from '../empty-state'
import { anchorUnsetSentenceOf } from '../refusal'

/**
 * The page's empty state: nothing recorded for this purpose.
 *
 * The rule is that an empty screen names a cause the USER can act on, and that the
 * cause is not hidden by another one. Two facts can be true at once here — the
 * purpose has no chain, and the anchor a chain would start from was never saved —
 * and BOTH now have a screen behind them (设置's 位置锚点 page, and its 通勤链路 page),
 * so the anchor's fact is stated first: a chain recorded from an unsaved anchor has
 * no walking time, which is the repair that has to come first.
 *
 * The third state is the one this page has to be careful about: a settings read
 * that FAILED is not "the anchor is missing". Nothing may be claimed about a row
 * nobody read, and the empty state then says only what it actually knows — which is
 * the chain fact, whose screen claims nothing about the anchor either way.
 *
 * ONE TEST BELOW WAS REWRITTEN, and the reason is in its name: it used to pin that the
 * empty state offers no action at all, because this build had no screen for recording a
 * chain and the app's rule is that no state promises a control that does not exist. That
 * surface exists now (设置's 通勤链路 page), so the truth changed with it — the rule that
 * produced the old assertion is the rule that requires the new one.
 */

describe('an empty purpose names the cause the user can act on', () => {
  it('sends them to 设置 when the anchor a chain would start from was never saved', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: false })
    expect(view.headline).toBe('这个时段还没有换乘链')
    // F1's own sentence for the same fact, word for word: one vocabulary for one
    // settings row across the two features that read it.
    expect(view.detail).toBe(anchorUnsetSentenceOf('home'))
    expect(view.detail).toBe('未设置「家」位置 · 在「设置」中设置')
    expect(view.action).toBe('settings')
  })

  it('names the anchor the purpose actually starts from', () => {
    expect(emptyStateOf({ purpose: 'evening', anchorSaved: false }).detail).toContain('公司')
    expect(anchorForPurpose('morning')).toBe('home')
    expect(anchorForPurpose('evening')).toBe('work')
  })

  it('states the anchor fact beside the chain fact rather than in place of it', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: false })
    expect(view.headline).toContain('换乘链')
    expect(view.detail).not.toBeNull()
  })
})

describe('an anchor state nobody read is claimed neither way', () => {
  it('says nothing about the anchor when the settings read failed, and offers the screen that claims nothing about it', () => {
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: null })
    expect(view.detail).not.toContain('未设置')
    // The recording page is not a claim about the anchor row: it is where a chain is
    // recorded whatever that row holds, so offering it stays silent about the one thing
    // nobody read.
    expect(view.action).toBe('chains')
    expect(view.headline).toBe('这个时段还没有换乘链')
  })

  it('never reports an unread anchor state as a missing one', () => {
    const unread = emptyStateOf({ purpose: 'evening', anchorSaved: null })

    // A NEGATIVE does not pin a value: `not.toBe('settings')` holds for 'chains', for null, and
    // for any invalid value a later edit might introduce, so the action is asserted as the exact
    // one the landed behaviour takes.
    expect(unread.action).toBe('chains')
    // And nothing about the anchor is claimed: the detail is the chain-composition sentence
    // character for character, and the anchor's own words do not appear in it.
    expect(unread.detail).toBe('换乘链由使用者逐段录入：线路 + 上车站 + 下车站')
    expect(unread.detail).not.toContain('未设置')
    expect(unread.detail).not.toContain('位置')
    // An unread row and a saved row therefore read alike, and that is deliberate:
    // neither may claim anything about a settings row this page did not read, and
    // the anchor fact is only ever stated when it was read AND found missing.
    expect(unread).toEqual(emptyStateOf({ purpose: 'evening', anchorSaved: true }))
  })
})

describe('with the anchor in place the empty state still guides', () => {
  it('states what a chain is made of AND names the screen that does it — the surface exists now', () => {
    // This test used to assert `action: null` under the name 「promises no screen that does
    // not exist」, and that was true then: recording a chain had no page of its own, so
    // naming one would have been a control nobody could press. 设置's 通勤链路 page is that
    // screen now, so the old assertion pinned a truth the build has outgrown — the rule
    // that required it is the rule that requires this one.
    const view = emptyStateOf({ purpose: 'morning', anchorSaved: true })
    expect(view.detail).toBe('换乘链由使用者逐段录入：线路 + 上车站 + 下车站')
    expect(view.action).toBe('chains')
  })
})
