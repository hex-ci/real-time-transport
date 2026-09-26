import type { Mock } from 'vitest'

/**
 * 上游（车来了 / 高德）在本层的替身：把回答按 URL 装到 harness 的 `fetch` 桩上。
 *
 * 为什么必须自己装：真调上游在 CI 里既慢又不可复现，还会拿真实密钥打到别人家的服务上 ——
 * harness 的默认桩就是拒绝一切调用。这里只回答用例声明过的线路与端点，其余 URL 一律抛错，
 * 使「没桩掉的调用」在超时前就失败，而不是悄悄拿到一个空读数。
 *
 * 载荷按上游自己的口径写（`nextStopOrder` 是「正前往的下一站」，`travels[].travelTime` 是秒），
 * 因此夹具能钉住读侧对上游口径的解释，而不是绕开它。
 */

/** 一条站点夹具。缺坐标即上游没有放置该站 —— 与真实载荷同样处理。 */
export interface StopFixture {
  name: string
  lat?: number
  lng?: number
}

export interface BusFixture {
  busId: string
  /** 车辆正前往的下一站（上游口径，1 基）。 */
  nextStopOrder: number
  /** 到下一等待站的米数；`-1` 是「已驶过请求的目标站」的哨兵。 */
  distanceToWaitStn?: number
  /** 自线路起点的米数；给了就不再看距离反推。 */
  mileage?: number
  /** 定向到站时间表：只对它命名的站给到站时间，0 表示车就在该站。 */
  travels?: Array<{ order: number, travelTime: number }>
  busTagList?: Array<{ title: string }>
}

export interface LineFixture {
  lineId: string
  lineName?: string
  firstTime?: string
  lastTime?: string
  otherDirectionLineId?: string
  stops: StopFixture[]
  buses?: BusFixture[]
}

export interface UpstreamRoutes {
  /** 车来了的线路表：只回答这里声明过的 lineId。 */
  lines?: LineFixture[]
  /** 高德端点：返回该 URL 的 JSON 载荷，`undefined` 视为这个端点没有装回答。 */
  amap?: (url: URL) => unknown
}

/**
 * 一次线路读取的载荷信封：读侧只读 `jsonr.data`。
 * 线路身份（名字或站点表）是「上游认识这条线路」的判据，因此未声明的 lineId 回一个**没有身份**的
 * 信封 —— 那是未命中，不是一条空线路。
 */
function detailPayload(fixture: LineFixture | undefined): unknown {
  if (!fixture) return {}

  return {
    line: {
      name: fixture.lineName ?? fixture.lineId,
      direction: 0,
      firstTime: fixture.firstTime ?? '',
      lastTime: fixture.lastTime ?? '',
      endSn: '终点站',
    },
    stations: fixture.stops.map((stop, index) => ({
      sId: `st_${index + 1}`,
      sn: stop.name,
      order: index + 1,
      lat: stop.lat,
      lng: stop.lng,
    })),
    buses: (fixture.buses ?? []).map(bus => ({
      busId: bus.busId,
      order: bus.nextStopOrder,
      distanceToWaitStn: bus.distanceToWaitStn,
      mileage: bus.mileage,
      travels: bus.travels,
      busTagList: bus.busTagList,
    })),
    otherlines: fixture.otherDirectionLineId ? [{ lineId: fixture.otherDirectionLineId }] : [],
  }
}

/** 上游读侧只用 `ok` / `text()` / `json()`，因此不必造一个真正的 Response。 */
function jsonResponse(payload: unknown): {
  ok: true
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
} {
  const body = JSON.stringify(payload)
  return { ok: true, status: 200, json: async () => payload, text: async () => body }
}

/** 把 `routes` 装到 harness 的上游桩上。 */
export function installUpstream(upstream: Mock, routes: UpstreamRoutes): void {
  upstream.mockImplementation(async (rawUrl: unknown) => {
    const url = new URL(String(rawUrl))

    if (url.hostname.endsWith('chelaile.net.cn')) {
      if (url.pathname.endsWith('encryptedLineDetail.action')) {
        const lineId = url.searchParams.get('lineId') ?? ''
        const fixture = routes.lines?.find(line => line.lineId === lineId)
        return jsonResponse({ jsonr: { data: detailPayload(fixture) } })
      }
      throw new Error(`TEST: 未桩掉的车来了端点 ${url.pathname}`)
    }

    if (url.hostname === 'restapi.amap.com') {
      const payload = routes.amap?.(url)
      if (payload === undefined) throw new Error(`TEST: 未桩掉的高德端点 ${url.pathname}`)
      return jsonResponse(payload)
    }

    throw new Error(`TEST: 未桩掉的上游调用 ${url.toString()}`)
  })
}
