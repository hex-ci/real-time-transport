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

/**
 * Compute the optimal number of stations per row based on viewport width.
 *
 * Requirements:
 * - Narrower screens display FEWER stations per row to prevent cramped labels and touch overlap.
 * - Mobile viewports (320px - 430px) land on 4 to 5 stations per row with generous spacing (~84-97px).
 * - Desktop PC viewports (1024px - 1440px+) maintain the clean, industrial high-density board (10 to 12 stations).
 */
export function calculateResponsiveStopsPerRow(viewportWidth: number, totalStops: number): number {
  let target: number

  // < 640px: Phone (under 360px -> 4, 360-639px -> 5)
  if (viewportWidth < 360) {
    target = 4
  }
  else if (viewportWidth < 640) {
    target = 5
  }
  // 640px - 767px: sm (large phone / foldable)
  else if (viewportWidth < 768) {
    target = 6
  }
  // 768px - 1023px: md (tablet / iPad portrait)
  else if (viewportWidth < 1024) {
    target = 8
  }
  // 1024px - 1279px: lg (laptop / iPad landscape)
  else if (viewportWidth < 1280) {
    target = 10
  }
  // 1280px - 1535px: xl (standard desktop)
  else if (viewportWidth < 1536) {
    target = 12
  }
  // 1536px - 1919px: 2xl (wide desktop)
  else if (viewportWidth < 1920) {
    target = 14
  }
  // >= 1920px: ultrawide / 4K
  else {
    target = 16
  }

  // Never require more stops per row than the line actually has (minimum 2)
  if (totalStops > 0) {
    return Math.max(2, Math.min(target, totalStops))
  }
  return target
}

/**
 * Compute topology board geometry supporting both `folded` (multi-row compact)
 * and `linear` (single-axis continuous) layouts.
 */
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
  // MODE 1: Linear Layout (single continuous horizontal axis)
  // ==========================================
  if (mode === 'linear') {
    const stepX = options.linearStepX ?? (viewportWidth < 640 ? 92 : 115)
    const totalWidth = paddingX * 2 + Math.max(0, total - 1) * stepX
    const fixedY = paddingY + 20
    // Generous vertical room for track, station dot, selection halo, and vertical Chinese station name
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
      arcs: [], // No U-turns in linear mode
      totalWidth,
      totalHeight,
      stopsPerRow: total,
      totalRows: 1,
      getInterpolatedPosition: getInterpolatedPositionLinear,
    }
  }

  // ==========================================
  // MODE 2: Folded Layout (responsive multi-row)
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

  // Compute U-Turn connecting arcs between rows
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
      startAngle: isRightSide ? -Math.PI / 2 : Math.PI / 2,
      endAngle: isRightSide ? Math.PI / 2 : (Math.PI * 3) / 2,
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

    // Same row: linear interpolation along straight line
    if (p1.row === p2.row) {
      const x = p1.x + (p2.x - p1.x) * progress
      const y = p1.y
      const angleDeg = p1.isReverseRow ? 180 : 0
      return { x, y, angleDeg }
    }

    // Cross-row: follow U-Turn arc
    const arc = arcs.find(a => a.fromRow === p1.row && a.toRow === p2.row)
    if (arc) {
      const angleSpan = arc.endAngle - arc.startAngle
      const currentAngle = arc.startAngle + angleSpan * progress
      const x = arc.centerX + arc.radius * Math.cos(currentAngle)
      const y = arc.centerY + arc.radius * Math.sin(currentAngle)

      // Tangent angle in degrees
      const tangentRad = currentAngle + (arc.isRightSide ? Math.PI / 2 : -Math.PI / 2)
      const angleDeg = ((tangentRad * 180) / Math.PI + 360) % 360
      return { x, y, angleDeg }
    }

    // Fallback direct interpolation
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
