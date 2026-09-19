import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
  Station,
} from '@real-time-transport/shared'
import { getCuratedCityName, CITY_DICTIONARY, cumulativeDistances } from '@real-time-transport/shared'
import type { ITransitProvider } from '../types.js'
import type { AmapGisService } from '../services/amap-gis.service.js'
import type { StationTimetableService } from '../services/station-timetable.service.js'

/**
 * Headway windows for metro lines (in seconds).
 * Generic for all Chinese cities. Applied from origin-station departure time.
 */
const HEADWAY_WINDOWS = [
  { from: 7 * 3600, to: 9.5 * 3600, headway: 210 }, // 早高峰 3.5 min
  { from: 17 * 3600, to: 19.5 * 3600, headway: 210 }, // 晚高峰 3.5 min
  { from: 21.5 * 3600, to: 25 * 3600, headway: 480 }, // 夜间 8 min
] as const

const DEFAULT_HEADWAY = 360 // 平峰 6 min

/** Average inter-station run seconds (2~2.5 min per hop typical for metro). */
const STATION_RUN_SEC = 135

/** Average cruise speed used for LiveBus.speed (m/s), ~54 km/h. */
const CRUISE_SPEED = 15

interface MetroStopNode {
  station: Station
  cumulativeSeconds: number // seconds from origin departure
}

/**
 * Universal Subway Schedule Engine (generic for all cities in China).
 *
 * Physical model (deterministic string chart):
 *   T(station_k) = T_departure(origin) + k * STATION_RUN_SEC
 * Departures are enumerated from firstBusTime..lastBusTime using time-of-day
 * headway rules, so ANY metro line in ANY city gets a live simulation as long
 * as Amap can resolve its station sequence.
 *
 * lineId convention: `subway_<cityCode>_<lineKeyword>` e.g. `subway_027_10`, `subway_amap_440100_3`
 */
/**
 * Resolves a line's static detail from a persistent store (e.g. the server's
 * DB cache). Lets the live path avoid re-deriving station geometry from Amap
 * on every poll — critical because an Amap QPS blip would otherwise turn a
 * perfectly valid line into a 404.
 */
export type DetailResolver = (
  lineId: string,
  direction: number,
  cityCode?: string,
) => Promise<LineDetail | null>

export class UniversalSubwayEngine implements ITransitProvider {
  readonly name: DataSourceType = 'subway_schedule'

  constructor(
    private readonly amap: AmapGisService,
    private readonly timetables?: StationTimetableService,
    private readonly detailResolver?: DetailResolver,
  ) {}

  /**
   * Static detail for simulation purposes: prefer the persistent resolver
   * (DB-cached, survives restarts and Amap outages), fall back to resolving
   * via Amap directly.
   */
  private async resolveDetail(
    lineId: string,
    direction: number,
    cityCode?: string,
  ): Promise<LineDetail | null> {
    if (!this.detailResolver) {
      return this.getLineDetail(lineId, direction, cityCode)
    }
    // The resolver is expected to own the full fallback chain (DB cache ->
    // aggregator -> Amap). Trust its answer instead of issuing a second Amap
    // call, which would double QPS usage during throttling.
    const resolved = await this.detailResolver(lineId, direction, cityCode).catch(() => null)
    return resolved && resolved.stops.length >= 2 ? resolved : null
  }

  async searchLines(_keyword: string, _cityCode: string = '027'): Promise<LineSummary[]> {
    // Subway search is handled by SubwayRouterProvider (regex + Amap resolution)
    return []
  }

  /**
   * Build a simulated line detail using Amap static station sequence.
   * cityCode argument is a hint; the code embedded in lineId always wins
   * (needed because WS subscriptions and caches key on lineId alone).
   */
  async getLineDetail(lineId: string, direction: number = 0, cityCode?: string): Promise<LineDetail | null> {
    if (!this.amap?.isAvailable()) {
      return null
    }
    if (!lineId.startsWith('subway_')) {
      return null
    }

    const resolvedCity = resolveCityFromLineId(lineId) || cityCode || '027'
    const keyword = extractLineKeyword(lineId)
    if (!keyword) {
      return null
    }

    const cityName = getCuratedCityName(resolvedCity)
      || CITY_DICTIONARY.find(c => c.code === resolvedCity)?.name
      || resolvedCity
    const result = await this.amap.getLineByName(cityName, `地铁${keyword}`)
    if (!result || result.stations.length < 2) {
      return null
    }

    const orderedStops = direction === 1 ? [...result.stations].reverse() : [...result.stations]
    const stops: Station[] = orderedStops.map((s, idx) => ({
      ...s,
      order: idx + 1,
    }))

    const terminalName = stops[stops.length - 1]?.name || '终点站'
    // Clean amap suffix like 地铁10号线外环(车道沟--车道沟) -> 地铁10号线外环
    const cleanName = result.lineName.replace(/\(.*?\)/g, '').trim()

    // Real inter-station geometry from the Amap station coordinates (GCJ-02,
    // but distances are internally consistent for the same datum). Gives the
    // client a meter-accurate continuous track for smooth train motion.
    const stationDistances = cumulativeDistances(
      stops.map(s => [s.lat, s.lng] as [number, number]),
    )
    const routeLengthMeters = stationDistances[stationDistances.length - 1] ?? 0

    return {
      lineId,
      lineName: cleanName || `地铁${keyword}`,
      direction,
      directionName: `开往 ${terminalName}`,
      firstBusTime: result.firstTime || '05:30',
      lastBusTime: result.lastTime || '23:00',
      cityCode: resolvedCity,
      type: 'subway',
      stops,
      routeLengthMeters: routeLengthMeters > 0 ? routeLengthMeters : undefined,
      stationDistances: routeLengthMeters > 0 ? stationDistances : undefined,
      otherDirectionLineId: lineId, // Same lineId, opposite direction query param
    }
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    if (!lineId.startsWith('subway_')) {
      return null
    }

    // Resolve static geometry from the persistent cache when wired up. The
    // live path must NOT re-query Amap on every poll: a single QPS throttle
    // would otherwise 404 a line whose data is already known-good.
    const detail = await this.resolveDetail(lineId, direction, cityCode)
    if (!detail || detail.stops.length < 2) {
      return null
    }

    const stops = detail.stops
    const totalStops = stops.length
    const now = Date.now()

    // Convert to Beijing Time (UTC+8) seconds of day
    const bjDate = new Date(now + 8 * 3600 * 1000)
    const hours = bjDate.getUTCHours()
    const minutes = bjDate.getUTCMinutes()
    const seconds = bjDate.getUTCSeconds()
    let currentSecOfDay = hours * 3600 + minutes * 60 + seconds
    if (hours < 4) {
      currentSecOfDay += 24 * 3600
    }

    // First / last bus in seconds of day
    const firstSec = parseHm(detail.firstBusTime) || 5 * 3600 + 30 * 60
    const lastSec = parseHm(detail.lastBusTime) || 23 * 3600

    // Simulate physical station-by-station cumulative runtimes
    const nodes: MetroStopNode[] = stops.map((station, idx) => ({
      station,
      cumulativeSeconds: idx * STATION_RUN_SEC,
    }))

    const totalTripSec = nodes[nodes.length - 1]!.cumulativeSeconds + STATION_RUN_SEC

    const buses: LiveBus[] = []

    if (currentSecOfDay >= firstSec && currentSecOfDay <= lastSec + totalTripSec) {
      // Prefer an official minute-level station timetable when available: it gives
      // real departure seconds at that station, which we shift back to the origin
      // by that station's cumulative run offset. Otherwise fall back to headway sim.
      const departures = this.resolveDepartures(lineId, direction, stops, firstSec, lastSec)

      const isPeak = (hours >= 7 && hours <= 9) || (hours >= 17 && hours <= 19)

      for (let i = 0; i < departures.length; i++) {
        const depTime = departures[i]!
        const elapsedSinceDep = currentSecOfDay - depTime

        if (elapsedSinceDep < 0 || elapsedSinceDep >= totalTripSec) {
          continue
        }

        // Find current segment: last node whose cumulativeSeconds <= elapsed
        let segmentIdx = 0
        for (let n = 0; n < nodes.length; n++) {
          if (elapsedSinceDep >= nodes[n]!.cumulativeSeconds) {
            segmentIdx = n
          }
          else {
            break
          }
        }

        if (segmentIdx >= totalStops - 1) {
          continue
        }

        const segmentStart = nodes[segmentIdx]!.cumulativeSeconds
        const segmentEnd = segmentIdx < nodes.length - 1
          ? nodes[segmentIdx + 1]!.cumulativeSeconds
          : totalTripSec

        const segDuration = Math.max(segmentEnd - segmentStart, 30)
        const segElapsed = elapsedSinceDep - segmentStart
        const progress = Math.min(Math.max(segElapsed / segDuration, 0), 0.99)

        const order = segmentIdx + 1
        const remainingStopsToTerminal = totalStops - 1 - segmentIdx

        // Continuous position on the real track geometry (meters from origin).
        const sd = detail.stationDistances
        let distanceFromStart: number | undefined
        if (sd && sd.length === totalStops) {
          const segStartM = sd[segmentIdx]!
          const segEndM = sd[Math.min(segmentIdx + 1, totalStops - 1)]!
          distanceFromStart = segStartM + (segEndM - segStartM) * progress
        }
        const routeLen = detail.routeLengthMeters

        let distanceToWaitStn: number | undefined
        let travelTimeSec: number | undefined

        if (options?.targetOrder) {
          if (order < options.targetOrder) {
            const stopsToTarget = options.targetOrder - order - progress
            travelTimeSec = Math.max(30, Math.round(stopsToTarget * STATION_RUN_SEC))
            if (sd && typeof distanceFromStart === 'number' && sd[options.targetOrder - 1]) {
              distanceToWaitStn = Math.max(0, sd[options.targetOrder - 1]! - distanceFromStart)
            }
            else {
              distanceToWaitStn = Math.max(0, Math.round(stopsToTarget * 1200))
            }
          }
        }
        else {
          distanceToWaitStn = (typeof routeLen === 'number' && distanceFromStart !== undefined)
            ? Math.max(0, routeLen - distanceFromStart)
            : remainingStopsToTerminal * 1200
          travelTimeSec = Math.max(60, remainingStopsToTerminal * STATION_RUN_SEC)
        }

        buses.push({
          id: `train_${lineId}_d${direction}_dep${i}`,
          order,
          nextOrder: order + 1,
          progress: Number(progress.toFixed(3)),
          lat: stops[segmentIdx]?.lat || 0,
          lng: stops[segmentIdx]?.lng || 0,
          speed: CRUISE_SPEED,
          congestion: isPeak ? 'high' : 'low',
          distanceToWaitStn,
          distanceFromStart,
          travelTimeSec,
          updatedAt: now,
        })
      }
    }

    return {
      lineId,
      direction,
      buses,
      dataSource: 'subway_schedule',
      isDegraded: false,
      updatedAt: now,
    }
  }

  /**
   * Resolve origin departure seconds for the current operating day.
   *
   * When an official minute-level timetable exists for a station on this line
   * (e.g. Beijing Line 7 群芳站), each departure at that station is shifted back
   * to the origin by the station's cumulative run offset — this makes the whole
   * simulated line phase-locked to the REAL timetable instead of a generic
   * headway grid. Otherwise enumerate departures with headway rules.
   */
  private resolveDepartures(
    lineId: string,
    direction: number,
    stops: Station[],
    firstSec: number,
    lastSec: number,
  ): number[] {
    if (this.timetables) {
      for (const st of stops) {
        const idx = st.order - 1
        if (idx < 0 || idx >= stops.length) continue
        if (!this.timetables.has(lineId, st.name)) continue

        const all = this.timetables.allDeparturesToday(lineId, st.name, direction)
        if (!all || all.departures.length === 0) continue

        // Shift station departures back to origin departures
        const offset = idx * STATION_RUN_SEC
        const origin = all.departures
          .map(sec => sec - offset)
          .filter(sec => sec >= firstSec - 3600 && sec <= lastSec + 3600)

        if (origin.length > 0) {
          return origin
        }
      }
    }

    // Fallback: generic headway enumeration
    const departures: number[] = []
    let t = firstSec
    while (t <= lastSec) {
      departures.push(t)
      t += getHeadwayForTime(t)
    }
    return departures
  }

  async isAvailable(): Promise<boolean> {
    return this.amap?.isAvailable() || false
  }
}

/** Extract embedded city code from `subway_<cityCode>_<keyword>` (supports amap_<adcode> form). */
export function resolveCityFromLineId(lineId: string): string | null {
  const m = /^subway_(amap_\d+|\d+)_/.exec(lineId)
  return m ? m[1]! : null
}

/** Extract line keyword (e.g. '10', '亦庄') from subway lineId. */
export function extractLineKeyword(lineId: string): string {
  const parts = lineId.split('_')
  // subway_<code>_<keyword...> where <code> may itself be amap_<adcode>
  const codeStartIdx = parts[1] === 'amap' ? 3 : 2
  return parts.slice(codeStartIdx).join('_')
}

export function parseHm(timeStr: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim())
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null
  return hh * 3600 + mm * 60
}

export function getHeadwayForTime(secOfDay: number): number {
  for (const w of HEADWAY_WINDOWS) {
    if (secOfDay >= w.from && secOfDay <= w.to) {
      return w.headway
    }
  }
  return DEFAULT_HEADWAY
}
