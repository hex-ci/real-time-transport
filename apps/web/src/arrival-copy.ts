/**
 * F4's unknown-arrival vocabulary — the ONE wording for 「this row has no minute」.
 *
 * A row can state no minute, and that is a fact about the reading rather than a
 * bug to paper over: a targeted upstream request publishes an arrival time only
 * for the vehicles it can price, and this app no longer extrapolates one for the
 * rest from a snapshot speed and a nominal dwell (see
 * `apps/server/src/services/transit.service.ts`). Every surface that lists
 * arrivals therefore has to SAY the absence — the platform board's 预计到站
 * column, the line panel's 后续进站计划, the overview card's leading row and its
 * 后续 sub-list, and the line page's own headline.
 *
 * That is why the words live here rather than as a literal per template: five
 * places rendering the same state is five chances to word it five ways, and a
 * user comparing the board with the card would then have to decide whether two
 * sentences meant the same thing. `暂无到站耗时` is the token the platform board
 * already shipped for it; nothing new is minted, and nothing here reads a clock
 * or a route type.
 *
 * This is a DISPLAY token, not a value: it must contain no digit, because a digit
 * in the absence reads as a minute beside it. A row that states no minute also
 * carries no provenance mark — a mark qualifies a NUMBER — so no surface pairs
 * this token with a mark.
 */
export const ARRIVAL_MINUTE_UNAVAILABLE_TEXT = '暂无到站耗时'
