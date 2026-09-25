/**
 * The three states a read leaves a value in, and the one sentence a read that failed is
 * stated as when its subject is the followed lines.
 *
 * WHY THIS IS ONE MODULE. A read has three outcomes, not two: still reading, READ AND
 * FAILED, read. `transit.store.ts`'s `fetchFavorites` returns the failed half of that as a
 * boolean, and the array it leaves behind is empty either way — so every surface that renders
 * that array has the same choice to make, and the wrong choice is the same lie on each of
 * them: an empty array rendered as 「还没有关注线路」 tells the user they follow nothing when
 * nobody read their list, and it sends them to re-follow lines they already follow.
 *
 * The fact is shared and the consequence is not: 设置's 关注线路 page cannot show a list,
 * the home screen cannot show cards, the platform board cannot say whether any followed line
 * passes the stop, the chain editor has no line to offer a leg. So the STATE model and the
 * fact clause live here, once, and each surface states its own consequence.
 *
 * Nothing here reads a clock, a store or a response: the surface that made the read says
 * which of the three states it is in.
 */

/** A read's own state, without the value it may have produced. */
export type ReadState = 'reading' | 'unreadable' | 'read'

/**
 * A value a surface may state: pending, unreadable, or read — the last one being the only
 * one that carries a value, because there is nothing else to carry.
 */
export type ReadValue<T>
  = | { state: 'reading' }
    | { state: 'unreadable' }
    | { state: 'read', value: T }

/**
 * What a surface says when the followed-lines read FAILED, for the surfaces whose subject
 * is that list.
 *
 * The clause 「未读到关注线路」 is the fact and is identical everywhere — 未读到 is the word
 * §4.1 uses for a read that did not answer, and it is deliberately not 「没有」, which is a
 * claim about what is stored. `consequence` is the surface's own: what it cannot show
 * without that list. A surface that words the fact itself, in its own words, is how one
 * failure comes to read as two different things on two screens.
 */
export function followedLinesUnreadableText(consequence: string): string {
  return `未读到关注线路，${consequence}`
}
