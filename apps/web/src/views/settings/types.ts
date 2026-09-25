import type { Station } from '@real-time-transport/shared'

/**
 * 设置's view models for F10's chain editor.
 *
 * The engine's own answer types (`CommuteChain*`) are the CONTRACT's and stay where
 * they are; what lives here is only what the editor needs to offer a choice and to
 * read a stored chain back.
 */

/**
 * Why a chosen line's stop list is not there to pick from — three different facts
 * that must not be worded as one:
 *
 * - `ready`       the list is here; a (station, order) pair can be checked against it
 * - `loading`     not read yet; it may still arrive
 * - `unavailable` the API answered for this direction and listed no stops at all
 * - `unfollowed`  the line is not among the followed routes, so no list can be read
 *                 for it — the state a stored chain's leg lands in after its line is
 *                 unfollowed, and the one cause that will not fix itself by waiting
 */
export type ChainStopsState = 'ready' | 'loading' | 'unavailable' | 'unfollowed'

/**
 * A stop as a CHOICE: its name AND its order in the one line+direction it was picked
 * from.
 *
 * Both halves or it is not a stop. 线上同名站不止一个 (PRD), so a name alone does not
 * locate one: a value carried as a name and resolved back against the list with a
 * `find(name)` becomes the FIRST of its occurrences, silently — the user sees the pair
 * they picked in the trigger while the record holds another, and nothing on screen
 * contradicts it. The pair is therefore the value everywhere a stop is chosen.
 */
export interface StationChoice {
  name: string
  /**
   * The stop's position in that line+direction's own numbering, or null when the pair
   * is half-recorded (a name with no order). Never filled in by guessing.
   */
  order: number | null
}

/**
 * One line+direction a ride leg may name.
 *
 * The source is the user's FOLLOWED routes of the active city, one entry per
 * direction, and that choice is deliberate:
 *
 * - the editor's job is to guarantee a (station, order) pair is real, which needs the
 *   line's OWN stop list — and this page already loads exactly that list, per
 *   direction, for the pins above. A second source for the same fact could disagree
 *   with the picker the user just used;
 * - a chain records the lines the user actually rides; those are the followed ones.
 *   A search box here would let a chain name a line the home screen knows nothing
 *   about, for no gain — the user follows what they ride;
 * - the pair's locator is per direction: a bus route's two directions are two
 *   upstream line ids, and a subway's two directions number the same stations
 *   oppositely. One entry per direction is what lets the user pick the numbering they
 *   mean.
 *
 * The cost is stated rather than hidden: a line that is not followed cannot be
 * recorded as a leg, so the editor names the followed-lines card when there is
 * nothing to choose from.
 */
export interface ChainLineOption {
  /** Identifies the option: the followed route's id plus the direction it rides. */
  key: string
  /**
   * The direction this option's stop list is numbered for, or null when it cannot be
   * read at all — the state a stored leg's line lands in once that line is no longer
   * followed, where which direction it was recorded from is exactly what is unknowable.
   */
  direction: 0 | 1 | null
  lineId: string
  lineName: string
  cityCode: string
  /** The upstream's own 「开往 X」 for this direction, or null when it stated none. */
  directionLabel: string | null
  /** This direction's stops in travel order. Empty unless `stops` is `ready`. */
  stations: Station[]
  stops: ChainStopsState
}
