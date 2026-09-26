import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LiveLineStatus } from '@real-time-transport/shared'
import { createApiHarness, describeEachStore, type ApiHarness } from './support/api-harness.js'

/**
 * F12 车厢拥挤度：只映射**实测到**的等级，而证据只有上游 tag 自身的 `title` —— 按全串精确相等。
 *
 * 两处最容易出错的判断各有一例：「不拥挤」里含「拥挤」，任何子串匹配都会把它判成 `high`
 * （上游 14 辆车全为「不拥挤」时接口曾全返回 `high`）；没实测过的词（含「适中」这类中间档措辞）
 * 一律 `unknown`，不猜成某一档，`unknown` 也不是「不拥挤」的同义词。
 *
 * 地铁没有实时拥挤度，一律 `unknown` —— 时刻表推得出车在哪，推不出人多不多。
 *
 * 本文件断言的是 **HTTP 边界给出的等级**，不是 `parseCongestion` 的返回值：上游答在 `fetch` 上，
 * 走的是「路由 → 提供方 → 契约」那条真路径。同一份主体对内存与 SQL 各跑一遍。
 */

const CITY_CODE = '027'
const BUS_LINE_ID = '101'
const SUBWAY_LINE_ID = 'subway_027_88'

/** 上游一个 busTagList 项。`sort` / `dispatch` 与判决无关，给上只是让载荷是真的形状。 */
function tag(imageUrlKey: string, title: string) {
  return { imageUrlKey, title, sort: 5, dispatch: false }
}

/**
 * 每辆车带自己标签，以及它**应当**被读成的那一档 —— 两侧写在同一个字面量里，
 * 断言处一眼看得出期望值来自哪个标签。
 */
const BUSES = [
  // 非拥挤标签在前：拥挤度按标题选中，而不是按下标。
  { busId: 'v1', busTagList: [tag('无障碍', '无障碍'), tag('拥挤度_1', '不拥挤')], expected: 'low' },
  { busId: 'v2', busTagList: [tag('拥挤度_3', '拥挤')], expected: 'high' },
  // 键没实测过、标题实测过：信号在标题上。
  { busId: 'v4', busTagList: [tag('拥挤度_9', '不拥挤')], expected: 'low' },
  // 没实测过的词：`拥挤度_N` 的 N 不连续，枚举键会把这条静默降级。
  { busId: 'v5', busTagList: [tag('拥挤度_2', '适中')], expected: 'unknown' },
  // 完全没上报：不知道，不是不拥挤。
  { busId: 'v6', expected: 'unknown' },
] as const

const LEVELS = ['unknown', 'low', 'high']

/** 上游的线上形状：明文信封（没有 `encryptResult` 时提供方就直接读 `jsonr.data`）。 */
function busBody(): string {
  return JSON.stringify({
    jsonr: {
      data: {
        line: { name: BUS_LINE_ID, direction: 0, firstTime: '05:00', lastTime: '23:00' },
        stations: [
          { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
          { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
          { sId: 's3', sn: '丙路', order: 3, lat: 39.92, lng: 116.42 },
        ],
        buses: BUSES.map(bus => ({
          busId: bus.busId,
          order: 2,
          distanceToWaitStn: 900,
          mileage: 1200,
          speed: 6,
          ...('busTagList' in bus ? { busTagList: bus.busTagList } : {}),
        })),
      },
    },
  })
}

/** 地铁引擎经 Amap 取静态线路：两站以上、服务窗口覆盖被冻结的那个上午。 */
const subwayLine = {
  id: 'BJ_88',
  name: '地铁88号线',
  type: '地铁线路',
  start_stop: '甲站',
  end_stop: '丙站',
  start_time: '0500',
  end_time: '2300',
  busstops: [
    { id: 's1', name: '甲站', sequence: 1, location: '116.392540,39.924299' },
    { id: 's2', name: '乙站', sequence: 2, location: '116.399999,39.930001' },
    { id: 's3', name: '丙站', sequence: 3, location: '116.405000,39.935000' },
  ],
}

/**
 * 冻结在北京上午：地铁引擎按时刻表放车，冻结在一个没有车的时刻会让「一律 unknown」这一钉
 * 落空。用 UTC 构造，任何时区的 worker 读到同一小时。只伪造 `Date`，应用自己的定时器照常走。
 */
function freezeAtBeijingMorning(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 0, 0, 0)))
}

afterEach(() => {
  vi.useRealTimers()
})

describeEachStore('F12 拥挤度：上游标签决定等级', (store) => {
  let api: ApiHarness

  beforeEach(async () => {
    api = await createApiHarness({ store })
  })

  afterEach(async () => {
    await api?.close()
  })

  /**
   * 本套件能触到的两个上游（车来了、Amap）。任何别的调用当场抛错：真跑到上游既花配额，
   * 也让断言描述的不是夹具。
   */
  function stubUpstream() {
    api.upstream.mockImplementation(async (url: unknown) => {
      const href = String(url)
      if (href.includes('encryptedLineDetail')) {
        return { ok: true, status: 200, text: async () => busBody() }
      }
      if (href.includes('/v3/bus/linename')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: '1', infocode: '10000', info: 'OK', buslines: [subwayLine] }),
        }
      }
      throw new Error(`未桩掉的上游调用：${href}`)
    })
  }

  async function live(lineId: string): Promise<LiveLineStatus> {
    const res = await api.inject({
      method: 'GET',
      url: `/api/transit/lines/${lineId}/live?direction=0&cityCode=${CITY_CODE}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as { data: LiveLineStatus }).data
  }

  it('每辆车按自己的标签归档：「不拥挤」绝不被读成拥挤', async () => {
    stubUpstream()
    const status = await live(BUS_LINE_ID)

    const byId = new Map(status.buses.map(bus => [bus.id, bus.congestion]))
    expect([...byId.keys()].sort()).toEqual(BUSES.map(bus => bus.busId).sort())
    for (const bus of BUSES) {
      expect(byId.get(bus.busId), `${bus.busId} 的标签被读成了别的档`).toBe(bus.expected)
    }
  })

  it('等级只取实测到的那几个，没有中间档', async () => {
    stubUpstream()
    const status = await live(BUS_LINE_ID)

    for (const bus of status.buses) {
      expect(LEVELS, `${bus.id} 的等级 ${bus.congestion} 不在实测词表里`).toContain(bus.congestion)
    }
    // 三种读法在同一份载荷里都出现：映射没有把整个字段塌成一个值。
    expect(new Set(status.buses.map(bus => bus.congestion))).toEqual(new Set(['low', 'high', 'unknown']))
  })

  it('地铁一律 unknown：时刻表推不出人多不多', async () => {
    freezeAtBeijingMorning()
    stubUpstream()
    const status = await live(SUBWAY_LINE_ID)

    expect(status.buses.length, '引擎没给出车次，这一钉就落空了').toBeGreaterThan(0)
    for (const bus of status.buses) {
      expect(bus.congestion, `${bus.id} 被推了一个拥挤度`).toBe('unknown')
    }

    // 两条存储路径在这一读上的差别：SQL 把静态线路落进缓存表，内存路径不落。等级与它无关，
    // 但差别的存在说明这一遍真的走了那条路。
    const cached = await api.rows('SELECT line_id FROM cached_transit_lines WHERE line_id = $1', [SUBWAY_LINE_ID])
    expect(cached, store === 'sql' ? '静态线路没有落进缓存表' : '内存路径不该在缓存表里留下行')
      .toHaveLength(store === 'sql' ? 1 : 0)
  })
})
