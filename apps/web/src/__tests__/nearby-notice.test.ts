import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nearbyEmptyNoticeOf, nearbyLocationStateOf } from '../views/overview/nearby-notice'

/**
 * The nearby card's empty state, and the two causes it must not confuse.
 *
 * A nearby card shows no platform for two different reasons: the app has no
 * position at all (never asked, refused, or a request still in flight), or it HAS
 * one and no stop of this line resolves near it. The card decided this from
 * `mode === 'nearby' && rows.length === 0`, which is true of both — so it said
 * 「开启定位后显示离你最近的站点车辆」 to a user who had already granted location,
 * naming a cause that was not theirs and hiding the one that was.
 *
 * The position fact therefore travels from the location store, through the view,
 * into the card as an explicit input, in the three states the store can tell
 * apart; the wording lives here, and the guards at the end hold the wiring a unit
 * test cannot see.
 */

describe('the two causes of an empty nearby card are worded as what they are', () => {
  it('does not claim 「开启定位」 for a card that already has a position', () => {
    const noFix = nearbyEmptyNoticeOf('absent')
    const hasFix = nearbyEmptyNoticeOf('fix')

    expect(hasFix, 'the position and no-position causes read the same').not.toBe(noFix)
    // The sentence this defect was: enabling location is not the missing thing
    // when a fix is already in hand, so the state may not name it.
    expect(hasFix).not.toContain('开启定位')
    expect(hasFix).toContain('站台')
    expect(noFix).toContain('开启定位')
  })

  it('names a fix that has not arrived yet as a request, not as an unset permission', () => {
    const locating = nearbyEmptyNoticeOf('locating')
    // Nothing is missing from the user here: the fix is on its way, so the state
    // says so and asks for no setting. Distinct from both other causes, because a
    // user waiting for a fix and a user who never granted one are different
    // situations with different next steps.
    expect(locating).not.toBe(nearbyEmptyNoticeOf('absent'))
    expect(locating).not.toBe(nearbyEmptyNoticeOf('fix'))
    expect(locating).not.toContain('开启定位')
  })

  it('keeps every notice one short line of body text', () => {
    for (const state of ['absent', 'locating', 'fix', 'unsupported'] as const) {
      expect(nearbyEmptyNoticeOf(state).length, state).toBeLessThanOrEqual(24)
    }
  })

  it('reads every state as a sentence of its own, so no two can be confused', () => {
    const states = ['absent', 'locating', 'fix', 'unsupported'] as const
    const notices = states.map(state => nearbyEmptyNoticeOf(state))
    expect(new Set(notices).size, 'two states word the same situation').toBe(notices.length)
  })
})

/**
 * A browser with no geolocation API at all.
 *
 * `useGeolocation` reports it through `isSupported`, and the store already names
 * it in `locationError`; the nearby card mapped every failure to `absent`, whose
 * sentence tells the user to enable location — the one thing that browser cannot
 * do, because the capability is absent rather than withheld. So the case gets its
 * own state, and its sentence says what is true of THAT browser.
 *
 * Permission-denied and never-asked are deliberately NOT split: `absent` tells
 * both to grant permission (via the browser prompt or the 定位最近站 button), and
 * that is the correct next step for each — only the capability being absent has a
 * different next step, and only that case is worth its own words.
 */
describe('a browser that cannot locate at all is told what is true of it', () => {
  it('reads a browser with no geolocation support as its own state', () => {
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: false, supported: false }))
      .toBe('unsupported')
    // A refusal and a question never asked are both 「no permission yet」: the same
    // next step (grant it, or tap the button that asks), so they stay together.
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: true, supported: true }))
      .toBe('absent')
  })

  it('lets a fix in hand outrank the capability read', () => {
    // The state answers 「是否有定位」 first: a position already reported is a
    // position, whatever the store says the browser supports.
    expect(nearbyLocationStateOf({ hasFix: true, requesting: false, failed: false, supported: false }))
      .toBe('fix')
  })

  it('words that state as the browser lacking the capability, not as a setting', () => {
    const unsupported = nearbyEmptyNoticeOf('unsupported')
    expect(unsupported, 'a browser with no geolocation was told to enable location')
      .not.toContain('开启定位')
    expect(unsupported).not.toBe(nearbyEmptyNoticeOf('absent'))
    // It names the missing capability and where it is missing, so the user is not
    // sent looking for a permission that would not help.
    expect(unsupported).toContain('浏览器')
    expect(unsupported).toContain('不支持定位')
  })
})

describe('the state comes from what the location store already reports', () => {
  // `supported: true` throughout this block: the capability read is now a required
  // input, and these cases are all about a browser that CAN locate — the fix, the
  // request in flight, and the request that failed. A caller that omits it is
  // answered as a browser that cannot locate, which is why it is not optional.
  it('reads a fix in hand as the fix state, whatever else is in flight', () => {
    // `isLocating` is `tracking && no fix`, so the two agree by construction —
    // pinned here because the card's wording flips on this one value.
    expect(nearbyLocationStateOf({ hasFix: true, requesting: true, failed: false, supported: true }))
      .toBe('fix')
    expect(nearbyLocationStateOf({ hasFix: true, requesting: false, failed: true, supported: true }))
      .toBe('fix')
  })

  it('reads a request with no fix yet as locating', () => {
    expect(nearbyLocationStateOf({ hasFix: false, requesting: true, failed: false, supported: true }))
      .toBe('locating')
  })

  it('reads a failed or never-made request as absent rather than still coming', () => {
    // A refused request keeps `tracking` true in the store, so the request flag
    // alone would say 「正在获取定位…」 forever over a fix that is never arriving.
    expect(nearbyLocationStateOf({ hasFix: false, requesting: true, failed: true, supported: true }))
      .toBe('absent')
    expect(nearbyLocationStateOf({ hasFix: false, requesting: false, failed: false, supported: true }))
      .toBe('absent')
  })
})

describe('the card is handed the position fact and words none of it itself', () => {
  const card = readFileSync(
    fileURLToPath(new URL('../views/overview/components/line-mini-card.vue', import.meta.url)),
    'utf8',
  )
  const script = card.slice(0, card.indexOf('<template>'))

  it('takes the state as a prop and words the notice from it', () => {
    expect(card, 'the card does not receive the position state').toContain('nearbyLocation')
    expect(script, 'the card does not word the notice through the module')
      .toContain('nearbyEmptyNoticeOf(')
  })

  it('words no location cause in its own template', () => {
    // 开启定位 was the card's own sentence for every empty nearby card; it belongs
    // to the copy module now, where a state becomes the words for it.
    expect(card.slice(card.indexOf('<template>')), 'the card template states a location cause itself')
      .not.toContain('开启定位')
    // Same rule for the browser-lacks-geolocation cause: the card renders the
    // module's sentence, it does not carry one of its own.
    expect(card.slice(card.indexOf('<template>')), 'the card template words the unsupported case itself')
      .not.toContain('不支持定位')
  })
})

describe('the overview reads the position fact from the location store', () => {
  const overview = readFileSync(
    fileURLToPath(new URL('../views/overview/index.vue', import.meta.url)),
    'utf8',
  )
  const grid = readFileSync(
    fileURLToPath(new URL('../views/overview/components/card-grid.vue', import.meta.url)),
    'utf8',
  )

  it('derives it from the store\'s own reads', () => {
    // The store's distinction, reused rather than re-invented: the fix, the
    // request in flight, and the request that failed.
    expect(overview).toContain('locationStore.userCoords')
    expect(overview).toContain('locationStore.isLocating')
    expect(overview).toContain('locationStore.locationError')
    expect(overview).toContain('nearbyLocationStateOf(')
  })

  it('takes the capability reading from the store too, not from a guess', () => {
    // Whether the browser can locate at all is a fact the STORE holds
    // (`geo.isSupported`); a view that inferred it from a failure would call a
    // denied permission 「不支持」 and send the user to another browser.
    expect(overview).toContain('locationStore.isSupported')
    expect(overview).toContain('supported:')
  })

  it('passes it to the grid, which passes it to every card', () => {
    expect(overview, 'the overview does not pass the position state').toContain(':nearby-location=')
    expect(grid, 'the card grid drops the position state on its way to the card')
      .toContain(':nearby-location="nearbyLocation"')
  })
})
