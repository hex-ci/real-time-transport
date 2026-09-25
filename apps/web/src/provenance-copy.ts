import type { DataProvenance } from '@real-time-transport/shared'

/**
 * F4: the mark, as the user reads it.
 *
 * A number's kind is decided in the data layer (`@real-time-transport/shared`:
 * `vehicleProvenanceOf` / `arrivalProvenanceOf` / `listProvenanceOf`) and only
 * WORDED here, so the vocabulary is a tested fact rather than a template only a
 * browser can check — this app has no DOM test harness.
 *
 * The four marks describe the NATURE of the number and name no vendor, no
 * upstream and no internal mechanism. 实时 / 排班推演 / 精确时刻表 are the
 * sanctioned three; 位置推算 is the live bus path's own case, which neither of
 * the model marks describes: the minute is one this app computed, so 实时 would
 * claim a value the payload never carried and 排班推演 would claim a schedule
 * that does not exist for a bus. HOW it was computed varies — a real vehicle's
 * position and speed with a nominal dwell, or, when the payload carries no
 * usable geometry, a nominal per-stop hop — so those arithmetics are examples of
 * the mark, never its definition.
 *
 * `null` for an unstated provenance, and the caller renders nothing. That is the
 * whole point: 「没有来源」 and 「实时」 are different facts, and an unknown must
 * never be rounded up to the flattering one.
 */
export function provenanceLabelOf(provenance: DataProvenance | null | undefined): string | null {
  switch (provenance) {
    case 'live':
      return '实时'
    case 'position_estimate':
      return '位置推算'
    case 'schedule_simulation':
      return '排班推演'
    case 'exact_timetable':
      return '精确时刻表'
    default:
      return null
  }
}
