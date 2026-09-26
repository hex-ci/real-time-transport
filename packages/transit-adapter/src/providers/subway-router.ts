import type {
  DataSourceType,
  LineDetail,
  LineSummary,
  LiveLineStatus,
} from '@real-time-transport/shared'
import type { ITransitProvider } from '../types.js'
import type { UniversalSubwayEngine } from './universal-subway.js'
import type { ChelaileProvider } from './chelaile.js'

const CN_NUM: Record<string, string> = {
  一: '1', 二: '2', 三: '3', 四: '4', 五: '5',
  六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
  十一: '11', 十二: '12', 十三: '13', 十四: '14', 十五: '15',
  十六: '16', 十七: '17', 十八: '18', 十九: '19', 二十: '20',
}

const NAMED_LINE_RE = /^(机场线|磁悬浮|首都机场线|大兴机场线|亦庄线|房山线|昌平线|燕房线|西郊线|s\d+线)$/i

function normalizeLineNo(raw: string): string {
  const t = raw.trim().replace(/\s+/g, '')
  if (CN_NUM[t]) return CN_NUM[t]!
  return t.replace(/号线$/, '').replace(/号$/, '')
}

export class SubwayRouterProvider implements ITransitProvider {
  readonly name: DataSourceType = 'subway_schedule'

  constructor(
    private readonly subwayEngine: UniversalSubwayEngine,
    private readonly chelaile: ChelaileProvider,
  ) {}

  async searchLines(keyword: string, cityCode: string = '027'): Promise<LineSummary[]> {
    const kw = keyword.trim()
    if (!kw) return []

    const bare = kw.replace(/^地铁/, '').replace(/^(subway|metro)\s*/i, '').replace(/^line\s*/i, '').trim()

    const isNumbered = /^\d{1,2}号?线?$/.test(bare)
      || /^[一二三四五六七八九十]{1,3}号?线?$/.test(bare)
    const isNamed = NAMED_LINE_RE.test(bare)
    if (!isNumbered && !isNamed) return []

    const lineKey = isNamed ? bare : normalizeLineNo(bare)
    if (!lineKey) return []

    const lineId = `subway_${cityCode}_${lineKey}`

    // 只做一次高德查询：方向 1 由站点序列倒序推导
    const d0 = await this.subwayEngine.getLineDetail(lineId, 0, cityCode).catch(() => null)
    if (!d0) return []

    const first = d0.stops[0]?.name || ''
    const last = d0.stops[d0.stops.length - 1]?.name || ''

    return [
      {
        lineId,
        lineName: d0.lineName,
        direction: 0,
        startStop: first,
        endStop: last,
        // 与地铁引擎的 getLineDetail 同一条规则：终点站决定方向名，
        // 使搜索行与方向选择器给出的方向名一致。
        directionName: `开往 ${last || '终点站'}`,
        cityCode,
      },
      {
        lineId,
        lineName: d0.lineName,
        direction: 1,
        startStop: last,
        endStop: first,
        directionName: `开往 ${first || '终点站'}`,
        cityCode,
      },
    ]
  }

  async getLineDetail(lineId: string, direction: number = 0, cityCode?: string): Promise<LineDetail | null> {
    if (lineId.startsWith('subway_')) {
      return this.subwayEngine.getLineDetail(lineId, direction, cityCode)
    }
    return this.chelaile.getLineDetail(lineId, direction, cityCode)
  }

  async getLiveStatus(
    lineId: string,
    direction: number = 0,
    cityCode?: string,
    options?: { targetOrder?: number },
  ): Promise<LiveLineStatus | null> {
    if (lineId.startsWith('subway_')) {
      return this.subwayEngine.getLiveStatus(lineId, direction, cityCode, options)
    }
    return this.chelaile.getLiveStatus(lineId, direction, cityCode, options)
  }

  async isAvailable(): Promise<boolean> {
    const [subwayOk, busOk] = await Promise.all([
      this.subwayEngine.isAvailable().catch(() => false),
      this.chelaile.isAvailable().catch(() => false),
    ])
    return subwayOk || busOk
  }
}
