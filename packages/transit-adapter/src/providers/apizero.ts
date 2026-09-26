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
      // 空的 `data` 表示上游没有这条线路的记录，是未命中而不是读数：
      // 据此构造 `{buses: []}` 与「线路存在但此刻无车」无法区分，
      // 而后者正是 live 路由必须能拒绝的形态。
      if (!entry) {
        return null
      }
      const rawBuses = entry?.buses || []

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
        // 这条声明本身就是「备用」这个事实：聚合层报告的是 provider
        // 对自身答案的说法，不按列表位置推导降级，所以别处无法标记它。
        // apizero 只在车来了答不出时作答，因此这里必须声明 true。
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
