/**
 * 共享的测地计算。纯函数、无 I/O，Node 侧提供方与浏览器共用。
 */

const EARTH_RADIUS_M = 6371000

/** 两点间的大圆距离（米）；入参为 WGS-84 坐标。 */
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
 * 站在其线路上的站序：上游声明的正整数优先，否则取该站在停靠列表中的下标。
 * 列表本身即按站序构造（各提供方都按站序读取停靠），故下标就是真实站序，不是替代值。
 * 缺字段、非数字或 0 都会以 NaN/0 出行，指到一个该线并不存在的站序。
 */
export function statedStopOrder(value: unknown, position: number): number {
  const stated = statedNumber(value)
  return stated !== undefined && Number.isInteger(stated) && stated > 0 ? stated : position
}
