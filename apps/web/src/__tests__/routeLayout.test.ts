import { describe, expect, it } from 'vitest'
import type { Station } from '@real-time-transport/shared'
import {
  calculateResponsiveStopsPerRow,
  computeRouteLayout,
} from '../composables/useRouteLayout'

describe('Route Layout Algorithm', () => {
  const sampleStops: Station[] = Array.from({ length: 57 }, (_, i) => ({
    id: `stop_${i + 1}`,
    name: `站点 ${i + 1}`,
    order: i + 1,
    lat: 39.7 + i * 0.001,
    lng: 116.3 + i * 0.002,
    interchanges: [],
  }))

  describe('calculateResponsiveStopsPerRow', () => {
    it('adapts stops per row across screen widths', () => {
      // Narrow mobile
      expect(calculateResponsiveStopsPerRow(320, 57)).toBe(4)
      // Standard mobile
      expect(calculateResponsiveStopsPerRow(375, 57)).toBe(5)
      expect(calculateResponsiveStopsPerRow(390, 57)).toBe(5)
      expect(calculateResponsiveStopsPerRow(430, 57)).toBe(5)
      // Small tablet
      expect(calculateResponsiveStopsPerRow(640, 57)).toBe(7)
      // Tablet
      expect(calculateResponsiveStopsPerRow(768, 57)).toBe(8)
      // Desktop PC
      expect(calculateResponsiveStopsPerRow(1024, 57)).toBe(10)
      expect(calculateResponsiveStopsPerRow(1280, 57)).toBe(11)
      expect(calculateResponsiveStopsPerRow(1920, 57)).toBe(14)
    })

    it('respects small line station counts without exceeding line total', () => {
      expect(calculateResponsiveStopsPerRow(1280, 3)).toBe(3)
      expect(calculateResponsiveStopsPerRow(375, 2)).toBe(2)
    })
  })

  describe('Folded Mode', () => {
    it('computes folded multi-row layout for a 57-station line', () => {
      const layout = computeRouteLayout(sampleStops, {
        mode: 'folded',
        viewportWidth: 375,
        paddingX: 20,
        paddingY: 28,
        rowHeight: 64,
      })

      expect(layout.mode).toBe('folded')
      expect(layout.points.length).toBe(57)
      expect(layout.stopsPerRow).toBe(5) // On 375px viewport
      expect(layout.arcs.length).toBeGreaterThan(0)

      // Row 0 is left-to-right
      expect(layout.points[0]!.x).toBeLessThan(layout.points[1]!.x)

      // Row 1 should be right-to-left
      const stopsInRow = layout.stopsPerRow
      const row1First = layout.points[stopsInRow]!
      const row1Second = layout.points[stopsInRow + 1]!
      expect(row1First.x).toBeGreaterThan(row1Second.x)

      // Interpolated position along track
      const pos = layout.getInterpolatedPosition(5, 0.5)
      expect(pos.x).toBeGreaterThan(0)
      expect(pos.y).toBeGreaterThan(0)
    })
  })

  describe('Linear Mode', () => {
    it('computes single-axis horizontal layout for all stations', () => {
      const layout = computeRouteLayout(sampleStops, {
        mode: 'linear',
        viewportWidth: 375,
        paddingX: 20,
        paddingY: 30,
        linearStepX: 90,
      })

      expect(layout.mode).toBe('linear')
      expect(layout.points.length).toBe(57)
      expect(layout.totalRows).toBe(1)
      expect(layout.arcs).toEqual([]) // Zero U-turns in linear mode

      // All points share the same Y
      const firstY = layout.points[0]!.y
      expect(layout.points.every(p => p.y === firstY)).toBe(true)

      // Monotonically increasing X coordinates
      for (let i = 1; i < layout.points.length; i++) {
        expect(layout.points[i]!.x).toBeGreaterThan(layout.points[i - 1]!.x)
      }

      // Interpolation produces angle 0 and exact Y
      const pos = layout.getInterpolatedPosition(10, 0.4)
      expect(pos.y).toBe(firstY)
      expect(pos.angleDeg).toBe(0)
      expect(pos.x).toBeGreaterThan(layout.points[9]!.x)
      expect(pos.x).toBeLessThan(layout.points[10]!.x)
    })
  })

  describe('Edge cases', () => {
    it('handles empty stops gracefully', () => {
      const layout = computeRouteLayout([])
      expect(layout.points).toEqual([])
      expect(layout.arcs).toEqual([])
      expect(layout.getInterpolatedPosition(1, 0)).toEqual({ x: 0, y: 0, angleDeg: 0 })
    })
  })
})
