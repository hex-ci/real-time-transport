import { describe, expect, it } from 'vitest'
import type { Station } from '@real-time-transport/shared'
import {
  calculateResponsiveStopsPerRow,
  computeRouteLayout,
} from '../composables/use-route-layout'

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
      // 窄屏手机（<360）
      expect(calculateResponsiveStopsPerRow(320, 57)).toBe(4)
      // 标准手机（<640）
      expect(calculateResponsiveStopsPerRow(375, 57)).toBe(5)
      expect(calculateResponsiveStopsPerRow(390, 57)).toBe(5)
      expect(calculateResponsiveStopsPerRow(430, 57)).toBe(5)
      // sm：大屏手机 / 折叠屏（640 - 767）
      expect(calculateResponsiveStopsPerRow(640, 57)).toBe(6)
      // md：平板 / iPad（768 - 1023）
      expect(calculateResponsiveStopsPerRow(768, 57)).toBe(8)
      // lg：笔记本（1024 - 1279）
      expect(calculateResponsiveStopsPerRow(1024, 57)).toBe(10)
      // xl：桌面 PC（1280 - 1535）
      expect(calculateResponsiveStopsPerRow(1280, 57)).toBe(12)
      // 2xl：宽桌面（1536 - 1919）
      expect(calculateResponsiveStopsPerRow(1600, 57)).toBe(14)
      // 超宽（>= 1920）
      expect(calculateResponsiveStopsPerRow(1920, 57)).toBe(16)
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
      expect(layout.stopsPerRow).toBe(5) // 375px 视口下
      expect(layout.arcs.length).toBeGreaterThan(0)

      // 第 0 行从左到右
      expect(layout.points[0]!.x).toBeLessThan(layout.points[1]!.x)

      // 第 1 行应从右到左
      const stopsInRow = layout.stopsPerRow
      const row1First = layout.points[stopsInRow]!
      const row1Second = layout.points[stopsInRow + 1]!
      expect(row1First.x).toBeGreaterThan(row1Second.x)

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
      expect(layout.arcs).toEqual([]) // 线性模式零 U 形回折

      const firstY = layout.points[0]!.y
      expect(layout.points.every(p => p.y === firstY)).toBe(true)

      for (let i = 1; i < layout.points.length; i++) {
        expect(layout.points[i]!.x).toBeGreaterThan(layout.points[i - 1]!.x)
      }

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
