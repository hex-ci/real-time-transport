/**
 * 共享的测地计算。纯函数、无 I/O，Node 侧提供方与浏览器共用。
 */

const EARTH_RADIUS_M = 6371000

/**
 * 定位相关半径（米）：「附近」只在这个距离内成立。
 *
 * 业界「附近」都是有半径上限的概念（车来了附近站约 2km、高德 nearby 默认 3km）：
 * 定位城市与所选城市脱钩时（如北京定位看天津的线），最近站可能在几十公里外，
 * 那种「最近」对通勤决策是误导，不如没有。3km 给步行（1~2km）加骑行/接驳留余量；
 * 跨城（>100km）必被拦，同城远郊 5km+ 也不再谎称附近。阈值集中在此一处，要调只改这里。
 */
export const NEARBY_RADIUS_M = 3000

/**
 * 两点间的大圆距离（米）。
 *
 * 两个入参必须在**同一个坐标系**里：本站基准面是 `GCJ-02`（站表、锚点、换算后的定位），
 * 混着 WGS-84 与 GCJ-02 比会得到约 500 米的系统性偏差，排序的头几名都会错。
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLng = (lng2 - lng1) * rad
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 折线各点距首点的累计距离（米）；结果自 0 开始。 */
export function cumulativeDistances(points: Array<[number, number]>): number[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    cum.push(cum[i - 1]! + haversineMeters(a[0], a[1], b[0], b[1]))
  }
  return cum
}

/** 折线总长（米）。 */
export function polylineLengthMeters(points: Array<[number, number]>): number {
  const cum = cumulativeDistances(points)
  return cum[cum.length - 1] ?? 0
}

/**
 * 折线累计距离 → 屏幕绘制用的段原语。
 * index：**驶离**站的 0 基下标，钳制在 [0, n-2]；progress：该段内 0..1 的比例。
 * 末站及之后返回 { index: n-2, progress: 1 }（车停在最后一站）。
 * index 供 getInterpolatedPosition 的 1 基下标使用（传入 index + 1）。
 */
export function distanceToSegment(
  distanceFromStart: number,
  stationDistances: number[],
): { index: number, progress: number } | null {
  const n = stationDistances.length
  if (n < 2) return null
  const total = stationDistances[n - 1]!
  if (!(total > 0)) return null

  const d = Math.max(0, Math.min(distanceFromStart, total))
  let i = 0
  for (let k = 0; k < n; k++) {
    if (stationDistances[k]! <= d) i = k
    else break
  }
  if (i > n - 2) i = n - 2
  const segStart = stationDistances[i]!
  const segEnd = stationDistances[i + 1]!
  const segLen = segEnd - segStart
  const progress = segLen > 0 ? (d - segStart) / segLen : 1
  return { index: i, progress: Math.max(0, Math.min(progress, 1)) }
}

/**
 * 由车辆的 order 与 progress 反推累计距离（米）。
 * order 为 1 基、车辆**所在/刚驶离**的站（与 LiveBusSchema 同一口径），车辆自 order-1 行至 order。
 * 几何退化时返回 null。
 */
export function stationProgressToDistance(
  order: number,
  progress: number,
  stationDistances: number[],
): number | null {
  const n = stationDistances.length
  if (n < 2) return null
  const total = stationDistances[n - 1]!
  if (!(total > 0)) return null

  const fromIdx = Math.max(0, Math.min(order - 1, n - 2))
  const segStart = stationDistances[fromIdx]!
  const segEnd = stationDistances[fromIdx + 1]!
  const p = Math.max(0, Math.min(progress, 1))
  return segStart + (segEnd - segStart) * p
}

/**
 * 上游声明的数字；未声明时为 `undefined`。
 * 本规则只此一份，故各处读取共享一条规则而非多份可能漂移的副本。
 * 接受数字或含数字的字符串；缺字段、空串、非数字、非有限数、`false` 一律 `undefined`。
 * `0` 是真实声明值而非缺省 —— 这也是它不写成 `value || 0` 的原因。
 * 坐标、站序与用户自身点**不得**走这里（0 在那里的含义相反）：
 * 坐标走 `statedCoordinate`，站序走 `statedStopOrder`，用户自身点的缺省各自由
 * NULL 列与 watchPosition 首帧前的无限种子编码。
 */
export function statedNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 上游声明的、位于本应用基准面上的坐标；未声明时为 `undefined`。
 * 本规则只此一份。任一轴为 0 即视为**没有坐标**：本基准面上没有落点站会落在 0 上，
 * 而把 0 当成坐标会向大西洋某点计价步行路线，还让未落点的站台看起来足以推出结论。
 * 只适用于**上游**坐标（线路详情、实时车辆、道路轨迹、amap 停靠表与雷达、地铁引擎站表等）。
 * 用户自身点（已存锚点、设备定位）**不得**走这里：其缺省由 NULL 列编码，
 * 读成 0 即「未设置」等于为用户从未清除的行凭空造出第二种缺省写法。
 */
export function statedCoordinate(value: unknown): number | undefined {
  const stated = statedNumber(value)
  return stated === undefined || stated === 0 ? undefined : stated
}

/**
 * 上游声明的文本；未声明时为 `undefined`。
 *
 * 本规则只此一份，与 `statedNumber` 同族：高德把「它没有这一项」写成空串、空数组或直接缺字段
 * （`district: ""`、`address: []`），三种都是**没声明**。空串不是「一个空的名字」——
 * 把它当成值会往界面上印一个空白的地址行，而那正是「编造」的另一种形态：看起来有内容，
 * 实际什么也没说。**绝不用占位文案顶上**（那是替上游发言）。
 */
export function statedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * WGS-84 → GCJ-02（国测局坐标），以及它的反函数。
 *
 * 放在共享包而不是服务端：换算要在**两个入口边界**各做一次 —— 设备定位进入浏览器应用时
 * （定位 store，供本地测距用）与进入服务端时（`app.ts` 的 `deviceFixToGcj02`）—— 两边都要
 * 这份纯函数，而浏览器不能引 `transit-adapter`（那是 Node 包）。
 *
 * 两侧的规则是同一条：**只吃原始设备定位，绝不换算已经换算过的值**；站点坐标与锚点本身已是
 * `GCJ-02`，一律原样转发。换算两次会把点位挪到几百米之外，而界面上看不出区别。
 */
const GCJ_PI = Math.PI
const GCJ_A = 6378245.0
const GCJ_EE = 0.006693421622965943

function gcjTransformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * GCJ_PI) + 40.0 * Math.sin((y / 3.0) * GCJ_PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * GCJ_PI) + 320 * Math.sin((y * GCJ_PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function gcjTransformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * GCJ_PI) + 40.0 * Math.sin((x / 3.0) * GCJ_PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * GCJ_PI) + 300.0 * Math.sin((x / 30.0) * GCJ_PI)) * 2.0) / 3.0
  return ret
}

/** 境外没有偏移：算法在国界外会把点推向别处，故原样返回。 */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) {
    return [lng, lat]
  }
  let dLat = gcjTransformLat(lng - 105.0, lat - 35.0)
  let dLng = gcjTransformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * GCJ_PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * GCJ_PI)
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * GCJ_PI)
  return [lng + dLng, lat + dLat]
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) {
    return [lng, lat]
  }
  let dLat = gcjTransformLat(lng - 105.0, lat - 35.0)
  let dLng = gcjTransformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * GCJ_PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * GCJ_PI)
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * GCJ_PI)
  const mgLat = lat + dLat
  const mgLng = lng + dLng
  return [lng * 2 - mgLng, lat * 2 - mgLat]
}

/**
 * 站在其线路上的站序：上游声明的正整数优先，否则取该站在停靠列表中的下标。
 * 列表本身即按站序构造（各提供方都按站序读取停靠），故下标就是真实站序，不是替代值。
 * 缺字段、非数字或 0 都会以 NaN/0 出行，指到一个该线并不存在的站序。
 */
export function statedStopOrder(value: unknown, position: number): number {
  const stated = statedNumber(value)
  return stated !== undefined && Number.isInteger(stated) && stated > 0 ? stated : position
}
