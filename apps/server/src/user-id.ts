import { DEFAULT_USER_ID } from '@real-time-transport/shared'

/**
 * THE user id a request is about — one resolution, for every route that takes or
 * defaults one.
 *
 * Before this, each route resolved its own user inline
 * (`(req.query as any)?.userId || 'default_user'`), and `PATCH /settings` resolved
 * none at all: it wrote the default id while its GET honoured `?userId=`, so a
 * write for one user was invisible to the read for that same user and the literal
 * was hand-copied in the routes, the db layer, the contract layer and the web
 * client. Read and write cannot disagree here because they call the same function.
 *
 * WHERE the id travels is the caller's shape, not a second contract: a read names
 * it in the query string, a write in the body (the two write schemas declare it).
 * This reads the query first and the body second, so a route never has to say which
 * one it is looking at — and a route that takes no id resolves to the one default
 * (`DEFAULT_USER_ID`, the only copy of that literal).
 *
 * A value that is NOT a non-empty string names no user: an empty `?userId=`, a
 * repeated parameter (which arrives as an array), or a non-string of any kind. It is
 * treated as 「没命名用户」 and resolves to the default, which is the row the app's
 * own client reads — the alternative, refusing the request, was not taken because
 * this app has no user system and no route here can leak anything a default read
 * would not already return. What must not happen is what used to: a route resolving
 * such a request to something that is not an id at all (an array) and asking the
 * store about it.
 */
export interface UserIdCarrier {
  /** The query string, as a request carries it for a read. */
  query?: unknown
  /** The parsed body, as a request carries it for a write. */
  body?: unknown
}

/** The id a request names, or the one default. */
export function resolveUserId(request: UserIdCarrier = {}): string {
  return userIdIn(request.query) ?? userIdIn(request.body) ?? DEFAULT_USER_ID
}

/** The `userId` of a query object or a body, when it is one. */
function userIdIn(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null
  const value = (source as { userId?: unknown }).userId
  return typeof value === 'string' && value.length > 0 ? value : null
}
