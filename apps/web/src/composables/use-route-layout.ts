import type { Station } from '@real-time-transport/shared'

export type RouteLayoutMode = 'folded' | 'linear'

export interface StationLayoutPoint {
  station: Station
  x: number
  y: number
  row: number
  isReverseRow: boolean
}

export interface UTurnArc {
  fromRow: number
  toRow: number
  centerX: number
  centerY: number
  radius: number
  startAngle: number
  endAngle: number
  isRightSide: boolean
}

export interface RouteLayoutResult {
  mode: RouteLayoutMode
  points: StationLayoutPoint[]
  arcs: UTurnArc[]
  totalWidth: number
  totalHeight: number
  stopsPerRow: number
  totalRows: number
  getInterpolatedPosition: (order: number, progress: number) => { x: number, y: number, angleDeg: number }
}

export interface RouteLayoutOptions {
  mode?: RouteLayoutMode
  viewportWidth?: number
  paddingX?: number
  paddingY?: number
  rowHeight?: number
  linearStepX?: number
}

/** 每行站点数按视口宽度取档：窄屏更少，避免标签拥挤与触点重叠。 */
export function calculateResponsiveStopsPerRow(viewportWidth: number, totalStops: number): number {
  let target: number

  if (viewportWidth < 360) {
    target = 4
  }
  else if (viewportWidth < 640) {
    target = 5
  }
  else if (viewportWidth < 768) {
    target = 6
  }
  else if (viewportWidth < 1024) {
    target = 8
  }
  else if (viewportWidth < 1280) {
    target = 10
  }
  else if (viewportWidth < 1536) {
    target = 12
  }
  else if (viewportWidth < 1920) {
    target = 14
  }
  else {
    target = 16
  }

  if (totalStops > 0) {
    return Math.max(2, Math.min(target, totalStops))
  }
  return target
}

export function computeRouteLayout(
  stops: Station[],
  options: RouteLayoutOptions = {},
): RouteLayoutResult {
  const mode: RouteLayoutMode = options.mode ?? 'folded'
  const viewportWidth = options.viewportWidth ?? 1024
  const paddingX = options.paddingX ?? (viewportWidth < 768 ? 20 : 40)
  const paddingY = options.paddingY ?? (viewportWidth < 768 ? 28 : 50)
  const rowHeight = options.rowHeight ?? (viewportWidth < 768 ? 64 : 90)

  const total = stops.length
  if (total === 0) {
    return {
      mode,
      points: [],
      arcs: [],
      totalWidth: viewportWidth,
      totalHeight: 200,
      stopsPerRow: 10,
      totalRows: 1,
      getInterpolatedPosition: () => ({ x: 0, y: 0, angleDeg: 0 }),
    }
  }

  // ==========================================
  // 模式 1：linear 布局（单条连续横轴）
  // ==========================================
  if (mode === 'linear') {
    const stepX = options.linearStepX ?? (viewportWidth < 640 ? 92 : 115)
    const totalWidth = paddingX * 2 + Math.max(0, total - 1) * stepX
    const fixedY = paddingY + 20
    // 纵向留出轨道、站点圆点、选中光晕与竖排站名的空间。
    const totalHeight = fixedY + 160

    const points: StationLayoutPoint[] = stops.map((st, i) => ({
      station: st,
      x: paddingX + i * stepX,
      y: fixedY,
      row: 0,
      isReverseRow: false,
    }))

    function getInterpolatedPositionLinear(order: number, progress: number): { x: number, y: number, angleDeg: number } {
      const idx = Math.max(0, Math.min(order - 1, total - 1))
      const nextIdx = Math.min(idx + 1, total - 1)

      const p1 = points[idx]
      const p2 = points[nextIdx]
      if (!p1 || !p2) {
        return { x: paddingX, y: fixedY, angleDeg: 0 }
      }

      const x = p1.x + (p2.x - p1.x) * progress
      return { x, y: fixedY, angleDeg: 0 }
    }

    return {
      mode: 'linear',
      points,
      arcs: [], // linear 模式无折返
      totalWidth,
      totalHeight,
      stopsPerRow: total,
      totalRows: 1,
      getInterpolatedPosition: getInterpolatedPositionLinear,
    }
  }

  // ==========================================
  // 模式 2：folded 布局（响应式多行）
  // ==========================================
  const availableWidth = Math.max(viewportWidth - paddingX * 2, 160)
  const stopsPerRow = calculateResponsiveStopsPerRow(viewportWidth, total)
  const totalRows = Math.ceil(total / stopsPerRow)
  const totalHeight = paddingY * 2 + (totalRows - 1) * rowHeight + 40
  const stepX = stopsPerRow > 1 ? availableWidth / (stopsPerRow - 1) : availableWidth

  const points: StationLayoutPoint[] = []
  const arcs: UTurnArc[] = []

  for (let i = 0; i < total; i++) {
    const row = Math.floor(i / stopsPerRow)
    const col = i % stopsPerRow
    const isReverseRow = row % 2 === 1

    let x: number
    if (!isReverseRow) {
      x = paddingX + col * stepX
    }
    else {
      x = paddingX + (stopsPerRow - 1 - col) * stepX
    }
    const y = paddingY + row * rowHeight

    const st = stops[i]!
    points.push({
      station: st,
      x,
      y,
      row,
      isReverseRow,
    })
  }

  for (let r = 0; r < totalRows - 1; r++) {
    const isRightSide = r % 2 === 0
    const arcRadius = rowHeight / 2
    const centerY = paddingY + r * rowHeight + arcRadius
    const centerX = isRightSide ? paddingX + (stopsPerRow - 1) * stepX : paddingX

    arcs.push({
      fromRow: r,
      toRow: r + 1,
      centerX,
      centerY,
      radius: arcRadius,
      startAngle: isRightSide ? -Math.PI / 2 : -Math.PI / 2,
      endAngle: isRightSide ? Math.PI / 2 : -Math.PI * 1.5,
      isRightSide,
    })
  }

  function getInterpolatedPositionFolded(order: number, progress: number): { x: number, y: number, angleDeg: number } {
    const idx = Math.max(0, Math.min(order - 1, total - 1))
    const nextIdx = Math.min(idx + 1, total - 1)

    const p1 = points[idx]
    const p2 = points[nextIdx]

    if (!p1 || !p2) {
      return { x: paddingX, y: paddingY, angleDeg: 0 }
    }

    // 同一行：沿直线线性插值
    if (p1.row === p2.row) {
      const x = p1.x + (p2.x - p1.x) * progress
      const y = p1.y
      const angleDeg = p1.isReverseRow ? 180 : 0
      return { x, y, angleDeg }
    }

    // 跨行：沿折返弧线插值
    const arc = arcs.find(a => a.fromRow === p1.row && a.toRow === p2.row)
    if (arc) {
      const angleSpan = arc.endAngle - arc.startAngle
      const currentAngle = arc.startAngle + angleSpan * progress
      const x = arc.centerX + arc.radius * Math.cos(currentAngle)
      const y = arc.centerY + arc.radius * Math.sin(currentAngle)

      const tangentRad = currentAngle + (arc.isRightSide ? Math.PI / 2 : -Math.PI / 2)
      const angleDeg = ((tangentRad * 180) / Math.PI + 360) % 360
      return { x, y, angleDeg }
    }

    return {
      x: p1.x + (p2.x - p1.x) * progress,
      y: p1.y + (p2.y - p1.y) * progress,
      angleDeg: p1.isReverseRow ? 180 : 0,
    }
  }

  return {
    mode: 'folded',
    points,
    arcs,
    totalWidth: viewportWidth,
    totalHeight,
    stopsPerRow,
    totalRows,
    getInterpolatedPosition: getInterpolatedPositionFolded,
  }
}
