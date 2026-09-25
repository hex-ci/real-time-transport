/**
 * Crowding is shown as a badge. `unknown` is a state of its own, never a
 * synonym for "not crowded": upstream omits crowding for most vehicles, so
 * folding the two together would report an unobserved bus as empty.
 *
 * The words are the upstream's own: 「不拥挤」 is the title it serves for
 * `拥挤度_1` and 「拥挤」 the one it serves for `拥挤度_3` (the sampled vocabulary
 * recorded in `realtime-transit-apps/references/chelaile-api.md`). A degree is
 * never synthesised for a level nobody has sampled — 「畅通」 / 「适中」 / 「较拥挤」
 * were exactly that — and a level upstream never reported stays 「未知」.
 */

/** Badge text. Each verdict uses the wording upstream itself served. */
export function congestionLabel(level: string): string {
  switch (level) {
    case 'low':
      return '不拥挤'
    case 'high':
      return '拥挤'
    default:
      return '未知'
  }
}

/** Badge classes. `unknown` stays neutral grey — colour must not imply a verdict. */
export function congestionClass(level: string): string {
  switch (level) {
    case 'low':
      return 'bg-emerald-500/20 text-emerald-300'
    case 'high':
      return 'bg-rose-500/20 text-rose-300'
    default:
      return 'bg-slate-800 text-slate-400'
  }
}

/**
 * The crowding chip's colour for one board row, decided by the verdict ALONE.
 *
 * The chip states a crowding verdict, and the row can carry a genuine verdict
 * with no arrival minute at the same time — a vehicle that reports its crowding
 * while its travel time cannot be computed. Taking the minute as an input would
 * grey the chip exactly when the verdict IS known, leaving the colour to argue
 * with the word printed on it. The level is therefore the only input this
 * function has, so a minute cannot re-enter the decision; the neutral default
 * keeps an unknown level from being read as 「not crowded」.
 */
export function congestionChipClass(level: string): string {
  return congestionClass(level)
}
