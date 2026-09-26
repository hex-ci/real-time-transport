import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineDetail } from '@real-time-transport/shared'
import { AmapGisService, ChelaileProvider, UniversalSubwayEngine } from '../index.js'

/**
 * 站点只在载荷放置它的地方被放置。
 *
 * 载荷省略坐标字段就是没有位置 —— 不是 (0, 0)：那是大西洋上的一个真实
 * 点，写进去就与上游真发来的坐标无法区分。任一轴为 0 同样是缺省而不是
 * 位置，因为本应用的 GCJ-02 基准上没有任何已放置的站点落在 0 上；规则
 * 在 `statedCoordinate` 里，下面每一次读取都套用它。
 *
 * 载荷自己给出的站序是已存腿所依据的权威；列表中的位置只是载荷未声明
 * 该字段时的兜底。
 *
 * 甲路 / 乙路 / 丙路 是占位符；下面每一次读取都是桩，不触达上游。
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * 把时钟冻结在某个北京墙上时刻。
 *
 * 地铁引擎按它自己的时刻放置列车，所以「车在哪」的测试必须固定被问的
 * 那一刻：同一条线路在 02:00 答「没有在途车」，在 08:00 每个区间都有车。
 */
function freezeAtBeijing(hhmm: string): void {
  const [hh, mm] = hhmm.split(':').map(Number)
  vi.useFakeTimers({ toFake: ['Date'] })
  // 00:00 UTC 即北京 08:00：引擎内部平移 +8h。
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, (hh ?? 0) - 8, mm ?? 0)))
}

function stubAmapBusline(stops: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('/v3/bus/linename')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: '1',
        infocode: '10000',
        info: 'OK',
        buslines: [{
          id: 'L1',
          name: '1路',
          type: '地铁线路',
          start_stop: '甲路',
          end_stop: '丙路',
          busstops: stops,
        }],
      }),
    }
  }))
}

function stubAmapPois(pois: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('/v3/place/around')) throw new Error(`unexpected upstream call: ${href}`)
    return { ok: true, status: 200, json: async () => ({ status: '1', infocode: '10000', info: 'OK', pois }) }
  }))
}

function stubChelaileLine(stations: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonr: {
          data: {
            line: { name: '1路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
            stations,
            // 没有 jxPath：这些测试读的不是这条线路的道路几何。
          },
        },
      }),
    }
  }))
}

describe('a stop is placed only where the payload placed it', () => {
  it('keeps a chelaile stop the payload left unplaced unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 2 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.stops[0]).toMatchObject({ name: '甲路', order: 1, lat: 39.9, lng: 116.4 })
    expect(detail?.stops[1]?.lat).toBeUndefined()
    expect(detail?.stops[1]?.lng).toBeUndefined()
    // 该站本身仍被答出：缺的只是它的位置。
    expect(detail?.stops[1]).toMatchObject({ name: '乙路', order: 2 })
  })

  it('numbers a chelaile stop by its own position when the payload states no usable order', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 'x', lat: 39.91, lng: 116.41 },
      { sId: 's3', sn: '丙路', lat: 39.92, lng: 116.42 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.stops.map(s => [s.name, s.order])).toEqual([['甲路', 1], ['乙路', 2], ['丙路', 3]])
  })

  it('takes the payload\'s own numbering when it diverges from the position in the list', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 5, lat: 39.9, lng: 116.4 },
      { sId: 's2', sn: '乙路', order: 7, lat: 39.91, lng: 116.41 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.stops.map(s => [s.name, s.order])).toEqual([['甲路', 5], ['乙路', 7]])
  })

  it('keeps a chelaile stop the payload marks with a zero unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: 0, lng: 0 },
      { sId: 's2', sn: '乙路', order: 2, lat: 39.9, lng: 116.4 },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.stops[0]?.lat).toBeUndefined()
    expect(detail?.stops[0]?.lng).toBeUndefined()
    expect(detail?.stops[1]).toMatchObject({ lat: 39.9, lng: 116.4 })
  })

  it('keeps a chelaile stop whose coordinate is not a number unplaced', async () => {
    stubChelaileLine([
      { sId: 's1', sn: '甲路', order: 1, lat: null, lng: '' },
      { sId: 's2', sn: '乙路', order: 2, lat: '39.9', lng: '116.4' },
    ])

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // 载荷带了但没有写成数字的字段不表示位置；数字字符串是载荷写出的数。
    expect(detail?.stops[0]?.lat).toBeUndefined()
    expect(detail?.stops[0]?.lng).toBeUndefined()
    expect(detail?.stops[1]).toMatchObject({ lat: 39.9, lng: 116.4 })
  })

  it('keeps an Amap stop whose payload states no location unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 2 },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    expect(line?.stations[0]).toMatchObject({ name: '甲路', order: 1, lat: 39.9, lng: 116.4 })
    expect(line?.stations[1]?.lat).toBeUndefined()
    expect(line?.stations[1]?.lng).toBeUndefined()
    expect(line?.stations[1]).toMatchObject({ name: '乙路', order: 2 })
  })

  it('keeps an Amap stop whose location is not a pair unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000' },
      { id: 's2', name: '乙路', sequence: 2, location: 'abc,def' },
      { id: 's3', name: '丙路', sequence: 3, location: '116.5,' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // 半个坐标对、非数字的一半与空的一半都是「没有位置」，都不会变成 0。
    for (const stop of line?.stations ?? []) {
      expect(stop.lat, stop.name).toBeUndefined()
      expect(stop.lng, stop.name).toBeUndefined()
    }
  })

  it('reads a location Amap states as a two-element array', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: [116.4, 39.9] },
      { id: 's2', name: '乙路', sequence: 2, location: [116.41] },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    // 数组与字符串写的是同一个坐标对，所以读法相同 ——
    // 只带半个经度的数组同样是半个坐标对。
    expect(line?.stations[0]).toMatchObject({ lat: 39.9, lng: 116.4 })
    expect(line?.stations[1]?.lat).toBeUndefined()
    expect(line?.stations[1]?.lng).toBeUndefined()
  })

  it('keeps an Amap stop the payload marks with a zero on either half unplaced', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '0,0' },
      { id: 's2', name: '乙路', sequence: 2, location: '0,39.9' },
      { id: 's3', name: '丙路', sequence: 3, location: '116.4,0' },
      { id: 's4', name: '丁路', sequence: 4, location: '116.400000,39.900000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    for (const stop of line?.stations.slice(0, 3) ?? []) {
      expect(stop.lat, stop.name).toBeUndefined()
      expect(stop.lng, stop.name).toBeUndefined()
    }
    expect(line?.stations[3]).toMatchObject({ name: '丁路', lat: 39.9, lng: 116.4 })
  })

  it('keeps an Amap POI the radar could not place unplaced', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000', distance: '120' },
      { name: '乙路(公交站)', type: '公交车站', distance: '300' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    expect(pois[0]).toMatchObject({ name: '甲路(公交站)', lat: 39.9, lng: 116.4, distanceMeters: 120 })
    expect(pois[1]?.lat).toBeUndefined()
    expect(pois[1]?.lng).toBeUndefined()
    // 它仍是一个带已声明距离的站名，而这个雷达要读的正是后者。
    expect(pois[1]).toMatchObject({ name: '乙路(公交站)', distanceMeters: 300 })
  })

  it('keeps an Amap POI the radar marks with a zero unplaced', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '0,0', distance: '120' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    expect(pois[0]?.lat).toBeUndefined()
    expect(pois[0]?.lng).toBeUndefined()
    expect(pois[0]).toMatchObject({ name: '甲路(公交站)', distanceMeters: 120 })
  })

  it('leaves a POI whose distance the radar never stated distance-less', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    expect(pois[0]?.distanceMeters).toBeUndefined()
  })

  it('keeps a distance the radar states as 0', async () => {
    stubAmapPois([
      { name: '甲路(公交站)', type: '公交车站', location: '116.400000,39.900000', distance: '0' },
    ])

    const pois = await new AmapGisService('test-key').getNearbyStations(116.4, 39.9, 800)

    // 「写出的数就是读数」的另一半：0 米是合法答案（POI 就在测点上），
    // 所以缺省需要自己的编码而不是 0 —— 这条规则在 `statedNumber` 里。
    expect(pois[0]?.distanceMeters).toBe(0)
  })

  it('numbers a stop by its own position when the payload states no usable sequence', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 'x', location: '116.410000,39.910000' },
      { id: 's3', name: '丙路', sequence: 0, location: '116.420000,39.920000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    expect(line?.stations.map(s => [s.name, s.order])).toEqual([['甲路', 1], ['乙路', 2], ['丙路', 3]])
  })

  it('takes the payload\'s own sequence when it diverges from the position in the list', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 5, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 7, location: '116.410000,39.910000' },
    ])

    const line = await new AmapGisService('test-key').getLineByName('北京', '1路')

    expect(line?.stations.map(s => [s.name, s.order])).toEqual([['甲路', 5], ['乙路', 7]])
  })
})

/**
 * 一条两站线路，其中第一站是上游放不下的那一站。模型生成的每一列车
 * 都在唯一的那一个区间里，所以它报出的位置永远是那一站自己的。
 */
function lineWithUnplacedFirstStop(): LineDetail {
  return {
    lineId: 'subway_027_88',
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 乙路',
    // 窗口覆盖引擎归一化后的整个日范围，所以下面的答案与套件何时运行无关。
    firstBusTime: '01:00',
    lastBusTime: '30:00',
    cityCode: '027',
    type: 'subway',
    stops: [
      { id: 's1', name: '甲路', order: 1, interchanges: [] },
      { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
    ],
  }
}

describe('a subway line whose stop list has an unplaced stop states no geometry', () => {
  it('leaves the cumulative profile and the route length unstated', async () => {
    // 冻结在高峰窗口内，发车间隔短于全程走行时间，所以总有车在途，
    // 下面的断言不会因为车队为空而通过。
    freezeAtBeijing('08:00')
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => lineWithUnplacedFirstStop())
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    // 本用例钉的是模型确实放得下车的那个情形：车队为空会让下面的
    // 位置断言变得空洞。
    expect(live!.buses.length).toBeGreaterThan(0)
    for (const bus of live!.buses) {
      expect(bus.lat).toBeUndefined()
      expect(bus.lng).toBeUndefined()
    }
    // 模型照常运行：缺一个坐标不影响 order、progress 与时刻表。
    for (const bus of live!.buses) {
      expect(typeof bus.order).toBe('number')
      expect(typeof bus.travelTimeSec).toBe('number')
      expect(bus.distanceFromStart).toBeUndefined()
    }
  })

  it('states geometry only when the payload placed every stop', async () => {
    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1 },
      { id: 's2', name: '乙路', sequence: 2, location: '116.410000,39.910000' },
    ])
    const unplaced = await new UniversalSubwayEngine(new AmapGisService('test-key'))
      .getLineDetail('subway_027_88', 0, '027')

    expect(unplaced?.stops).toHaveLength(2)
    expect(unplaced?.stationDistances).toBeUndefined()
    expect(unplaced?.routeLengthMeters).toBeUndefined()

    stubAmapBusline([
      { id: 's1', name: '甲路', sequence: 1, location: '116.400000,39.900000' },
      { id: 's2', name: '乙路', sequence: 2, location: '116.410000,39.910000' },
    ])
    const placed = await new UniversalSubwayEngine(new AmapGisService('test-key'))
      .getLineDetail('subway_027_88', 0, '027')

    expect(placed?.stationDistances).toHaveLength(2)
    expect(placed?.routeLengthMeters).toBeGreaterThan(0)
  })

  it('states no geometry for a stop the list marks with a zero', async () => {
    freezeAtBeijing('08:00')
    const zeroed: LineDetail = {
      ...lineWithUnplacedFirstStop(),
      stops: [
        { id: 's1', name: '甲路', order: 1, lat: 0, lng: 0, interchanges: [] },
        { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
      ],
    }
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => zeroed)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    // 本用例钉的是模型确实放得下车的那个情形：车队为空会让下面的
    // 断言变得空洞。
    expect(live!.buses.length).toBeGreaterThan(0)
    // 列车的位置就是它所在站的位置，所以被标成 0 的站让列车没有
    // 位置，而不是落在赤道上。
    for (const bus of live!.buses) {
      expect(bus.lat).toBeUndefined()
      expect(bus.lng).toBeUndefined()
      expect(bus.distanceFromStart).toBeUndefined()
    }
  })
})

/**
 * 一条三站线路，每站都已放置，用来对照读取列车的位置。
 *
 * 窗口覆盖引擎归一化后的整个日范围，且时刻冻结在高峰间隔窗口内，
 * 所以车队与每列车所在的区间都与套件何时运行无关。
 */
function lineWithThreePlacedStops(): LineDetail {
  return {
    lineId: 'subway_027_88',
    lineName: '地铁88号线',
    direction: 0,
    directionName: '开往 丙路',
    firstBusTime: '01:00',
    lastBusTime: '30:00',
    cityCode: '027',
    type: 'subway',
    stops: [
      { id: 's1', name: '甲路', order: 1, lat: 39.9, lng: 116.4, interchanges: [] },
      { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
      { id: 's3', name: '丙路', order: 3, lat: 39.92, lng: 116.42, interchanges: [] },
    ],
  }
}

/**
 * 已放置的列车会给出位置 —— 这是本文件所钉规则的另一半。
 *
 * 引擎对停在站上的列车给出该站自己的坐标，也就是它的 `order` 所指的
 * 那一站，所以未放置的列车只可能是停在未放置站点上的列车（上面的几何
 * 套件钉的就是这一例）。没有下面这一例，一个从不报位置的引擎也能满足
 * 那个套件的每一条断言：「处处 undefined」能通过只问 undefined 的测试。
 */
describe('a train states the position of the stop it is at', () => {
  it('carries the stop\'s own coordinate for every train the model places', async () => {
    freezeAtBeijing('08:00')
    const line = lineWithThreePlacedStops()
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => line)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(live!.buses.length).toBeGreaterThan(0)
    // 这一分钟线路的两个区间都有车，所以下面的循环会读到停在甲路以外的
    // 列车，而不是碰巧停在始发站的那一辆。
    expect(new Set(live!.buses.map(b => b.order))).toEqual(new Set([1, 2]))
    for (const bus of live!.buses) {
      const stop = line.stops[bus.order! - 1]!
      expect(bus.lat, `train at order ${bus.order}`).toBe(stop.lat)
      expect(bus.lng, `train at order ${bus.order}`).toBe(stop.lng)
    }
  })

  it('carries a placed stop\'s coordinate even when another stop is unplaced', async () => {
    freezeAtBeijing('08:00')
    // 未放置的是最后一站，所以上面的列车仍停在已放置的站点上：一个未
    // 放置的站点不会拿走别的站点上列车的位置，它只让整条线路的几何无从
    // 表述 —— 两个答案说的是不同的事。
    const line: LineDetail = {
      ...lineWithThreePlacedStops(),
      stops: [
        { id: 's1', name: '甲路', order: 1, lat: 39.9, lng: 116.4, interchanges: [] },
        { id: 's2', name: '乙路', order: 2, lat: 39.91, lng: 116.41, interchanges: [] },
        { id: 's3', name: '丙路', order: 3, interchanges: [] },
      ],
    }
    const engine = new UniversalSubwayEngine(new AmapGisService(''), undefined, async () => line)
    const live = await engine.getLiveStatus('subway_027_88', 0, '027')

    expect(live).not.toBeNull()
    expect(new Set(live!.buses.map(b => b.order))).toEqual(new Set([1, 2]))
    for (const bus of live!.buses) {
      const stop = line.stops[bus.order! - 1]!
      expect(bus.lat, `train at order ${bus.order}`).toBe(stop.lat)
      expect(bus.lng, `train at order ${bus.order}`).toBe(stop.lng)
    }
  })
})

/** 桩详情所声明的轨迹 URL；其它主机都不可达。 */
const JXPATH_URL = 'https://traj.example/road'

/**
 * 一个带 jxPath 轨迹的车来了 line detail，以及它指向的原始轨迹 —— 由
 * 同一个桩提供，因为两者都是同一条线路的读取。
 */
function stubChelaileTrajectory(tra: string): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('encryptedLineDetail')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonr: {
            data: {
              line: { name: '1路', direction: 0, firstTime: '05:00', lastTime: '23:00' },
              stations: [
                { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
                { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
                { sId: 's3', sn: '丙路', order: 3, lat: 39.92, lng: 116.42 },
              ],
              jxPath: JXPATH_URL,
            },
          },
        }),
      }
    }
    if (href === JXPATH_URL) {
      // 以原始文本作答，带上游自己的分隔符。
      return {
        ok: true,
        status: 200,
        text: async () => `**YGKJ${JSON.stringify({ jsonr: { data: { tra } } })}YGKJ##`,
      }
    }
    throw new Error(`unexpected upstream call: ${href}`)
  }))
}

/**
 * 道路折线只在它的顶点被放置的地方被放置。
 *
 * `tra` 的顶点写法是 `lng,lat[,tag]`，它们的累计弧长定位道路上的每一站，
 * 所以一个上游从未放置的顶点就足以让那段路失去意义 —— 穿过它量出的弧长
 * 谈的是一条线路并不走的道路 —— 因此几何答作无从表述，调用方保留它的
 * 等距兜底，与完全取不到轨迹时一样。
 *
 * 「处处已放置」是阳性对照：「永远没有几何」与「0 是位置」一样错。下面
 * 三个无法放置的夹具分别钉住两个轴与缺失的一半，因为只对一半生效的规则
 * 仍会漏读另一半。
 */
describe('a road polyline is placed only where its vertices are', () => {
  it('states a geometry the trajectory placed on every vertex', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000,39.905000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.routeLengthMeters).toBeGreaterThan(0)
    expect(detail?.stationDistances).toHaveLength(3)
  })

  it('states no geometry when a vertex puts its longitude at 0', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;0,39.905000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })

  it('states no geometry when a vertex puts its latitude at 0', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000,0;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })

  it('states no geometry when a vertex states only half of its pair', async () => {
    stubChelaileTrajectory('116.400000,39.900000,1;116.405000;116.410000,39.910000,2;116.420000,39.920000')

    const detail = await new ChelaileProvider().getLineDetail('line_1', 0, '027')

    // 半个坐标对就是没有位置，且绝不能用 0 补齐：载荷只写出一半的顶点
    // 让整条道路无从表述，与写出 0 同理。
    expect(detail?.routeLengthMeters).toBeUndefined()
    expect(detail?.stationDistances).toBeUndefined()
  })
})
