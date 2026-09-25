/**
 * What a nearby card says when it has no platform to report — chosen by WHY it
 * has none.
 *
 * The card used to word this from its own empty row list, which cannot tell the
 * causes apart: a card with no rows is empty BOTH before the app has a position
 * AND after a position arrives that no stop of this line can be resolved from.
 * The wording 「开启定位后…」 asserted the first cause for both, sending a user who
 * had already granted location off to enable it, and leaving the real answer —
 * this line has no platform near them — unsaid. A browser with no geolocation API
 * at all got that same sentence too, telling the user to switch on a capability
 * the browser does not have.
 *
 * So the position fact reaches the card as an explicit input, in the states the
 * location store can actually tell apart. This module turns that state into the
 * words; the card words none of it itself.
 */

/**
 * The states of the app's position, as the store reports them.
 *
 * `unsupported` is a browser with no geolocation API — nothing the user can switch
 * on. Permission-denied and never-asked stay together under `absent`, because for
 * both the next step is the same: grant the permission (through the browser
 * prompt, or the 定位最近站 button). `absent`'s sentence names exactly that step,
 * so splitting the refusal out would add a state whose wording says what `absent`
 * already says. Only a capability the browser lacks changes what the user can do,
 * which is why that case alone earns its own sentence.
 */
export type NearbyLocationState = 'absent' | 'locating' | 'fix' | 'unsupported'

/**
 * The store's answer to 「是否有定位」, in those states.
 *
 * Composed from the store's OWN reads rather than a second flag invented here:
 * `userCoords` is the fix, `isLocating` is a request in flight, `locationError` is
 * a request that answered with a failure, and `isSupported` is whether this
 * browser can locate at all. A failure is `absent`, never `locating` — a request
 * already refused is not one still coming, and saying 「正在获取定位…」 over it
 * would promise a fix that will not arrive.
 *
 * Read order is the answer's order: a fix in hand is read first, because a
 * reported position is a position whatever the capability read says; the
 * capability is read next, because a browser with no API is not a request that
 * failed to answer and must not be worded as one.
 */
export function nearbyLocationStateOf(input: {
  hasFix: boolean
  requesting: boolean
  failed: boolean
  supported: boolean
}): NearbyLocationState {
  if (input.hasFix) return 'fix'
  if (!input.supported) return 'unsupported'
  return input.requesting && !input.failed ? 'locating' : 'absent'
}

/** What a card with no platform to report says, by why it has none. */
export function nearbyEmptyNoticeOf(state: NearbyLocationState): string {
  // Four causes, four sentences: two of them can be told apart only by the
  // position state, and a user who HAS a position must never be sent to enable
  // one. Only `absent` has an action for the user (the page's 定位最近站 button /
  // the browser permission); the other three state the fact and stop — and
  // `unsupported` names the one thing that would change the outcome, a browser
  // that can locate.
  const notices: Record<NearbyLocationState, string> = {
    absent: '开启定位后显示离你最近的站点车辆',
    locating: '正在获取定位…',
    fix: '已定位，但附近没有该线路的站台',
    unsupported: '当前浏览器不支持定位，请换用其他浏览器',
  }
  return notices[state]
}
