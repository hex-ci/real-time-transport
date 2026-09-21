/** One followed line/direction as rendered on the kiosk board. */
export interface KioskCard {
  lineId: string
  lineName: string
  direction: number
  directionName: string
  isSubway: boolean
  targetStationName: string | null
  targetOrder: number | null
  etaMinutes: number | null
  etaTime: string | null
  arrivalCount: number
}
