/**
 * The user id a request that names no user is about — the ONE literal.
 *
 * This app has no user system: every route that takes a user id takes it from the
 * caller and falls back to this id, and both the writes and the reads of a row are
 * keyed by it. It lives here, in the contract layer, because the id is part of the
 * wire contract: the three write-side schemas below in `schemas/api.ts` carry it as
 * their default, the server's `resolveUserId` resolves to it, and the web client
 * sends it. A second copy of the string in any of those places is a second fact
 * waiting to disagree with the first — which is exactly how a write for one user
 * came to be invisible to the read for the same user.
 */
export const DEFAULT_USER_ID = 'default_user'

export const DEFAULT_COMMUTE_HOURS = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
} as const

/** Chelaile cityId of the fallback city, used before the user picks one. */
export const DEFAULT_CITY_CODE = '027'
