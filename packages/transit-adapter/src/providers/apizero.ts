import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveBus,
  LiveLineStatus,
} from '@real-time-transport/shared'
import type { ITransitProvider } from '../types.js'

export class ApizeroProvider implements ITransitProvider {
  readonly name: DataSourceType = 'apizero'

  constructor(private readonly apiKey?: string) {}

  async searchLines(_keyword: string, _cityCode: string = '027'): Promise<LineSummary[]> {
    return []
  }

  async getLineDetail(_lineId: string, _direction?: number): Promise<LineDetail | null> {
    return null
  }

  async getLiveStatus(lineId: string, direction: number = 0): Promise<LiveLineStatus | null> {
    if (!this.apiKey) {
      return null
    }

    try {
      const res = await fetch('https://v1.apizero.cn/api/bus-realtime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          city: '北京',
          line: lineId,
          direction: String(direction + 1),
        }),
      })

      if (!res.ok) {
        return null
      }

      const json = await res.json() as any
      if (json.code !== 0 || !Array.isArray(json.data)) {
        return null
      }

      const entry = json.data[0]
      const rawBuses = entry?.buses || []

      // Realtime upstream only exposes stops_remaining / travel_minutes.
      // Fields it does not provide (progress, coordinates, speed, order) are
      // passed through as undefined — the frontend renders 暂无 honestly.
      const buses: LiveBus[] = rawBuses.map((b: any, idx: number) => {
        const stopsRemainingRaw = b.stops_remaining
        const travelMinutes = Number(b.travel_minutes || 0)
        const stopsRemaining = Number.isFinite(Number(stopsRemainingRaw)) && stopsRemainingRaw !== undefined
          ? Number(stopsRemainingRaw)
          : undefined

        return {
          id: String(b.bus_id || `apizero_${idx}`),
          congestion: 'unknown' as const,
          distanceToWaitStn: stopsRemaining !== undefined ? stopsRemaining * 800 : undefined,
          travelTimeSec: travelMinutes > 0 ? travelMinutes * 60 : undefined,
          updatedAt: Date.now(),
        }
      })

      return {
        lineId,
        direction,
        buses,
        dataSource: 'apizero',
        isDegraded: true,
        updatedAt: Date.now(),
      }
    }
    catch {
      return null
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey)
  }
}
