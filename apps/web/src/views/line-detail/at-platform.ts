/**
 * F-A: the one wording for 「the vehicle is at this platform」.
 *
 * Three branches of this page state that same fact about the same vehicle — the
 * arrivals answer's first row, and the two live-board fallbacks in the window
 * before that answer lands. It is a statement about WHERE a vehicle is, not a
 * number: the panel renders it with no mark and no minute, which is the whole
 * point of the state (a minute beside it would be this app's arithmetic dressed
 * as the source's observation).
 *
 * One constant rather than three literals, so the wording can be asserted
 * without a DOM (this app has no jsdom harness) and so the three branches cannot
 * drift into three different sentences for one fact.
 */
export const AT_PLATFORM_ETA_TEXT = '车辆正在本站 (即将发车)'
