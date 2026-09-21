/**
 * Screen-space anchor for a station marker on the route board.
 *
 * Emitted by RouteBoard so a popover can be positioned against the marker
 * without reaching into the canvas: screenX/screenY are viewport pixels,
 * x/y are the board's own coordinate space.
 */
export interface StationAnchor {
  screenX: number
  screenY: number
  radius: number
  x: number
  y: number
}

/** One of the line's two travel directions, as a tab in the direction switcher. */
export interface DirectionOption {
  direction: number
  lineId: string
  label: string
}
