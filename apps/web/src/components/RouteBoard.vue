<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import Konva from 'konva'
import {
  Expand,
  GitCommitHorizontal,
  Minus,
  MoveHorizontal,
  Plus,
  WrapText,
} from '@lucide/vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import type { LineDetail, LiveBus, Station } from '@real-time-transport/shared'
import { distanceToSegment } from '@real-time-transport/shared'
import {
  computeRouteLayout,
  type RouteLayoutMode,
  type RouteLayoutResult,
} from '@/composables/useRouteLayout'

const {
  nearestStation = null,
  selectedStation = null,
  initialLayoutMode = undefined,
  lineDetail,
  buses,
} = defineProps<{
  lineDetail: LineDetail
  buses: LiveBus[]
  nearestStation?: Station | null
  /** Currently selected station, drawn with a highlight ring. */
  selectedStation?: Station | null
  /** Optional initial layout mode ('folded' or 'linear'). Defaults to persisted preference or 'folded'. */
  initialLayoutMode?: RouteLayoutMode
}>()

const emit = defineEmits<{
  (e: 'select-station', station: Station): void
  (e: 'layout-change', mode: RouteLayoutMode): void
}>()

const containerRef = useTemplateRef('containerEl')

// Layout mode: 'folded' (compact multi-row) vs 'linear' (continuous straight line)
function loadPersistedMode(): RouteLayoutMode {
  if (initialLayoutMode) return initialLayoutMode
  try {
    const saved = localStorage.getItem('realtime_transit_layout_mode')
    if (saved === 'linear' || saved === 'folded') return saved
  }
  catch {
    // ignore
  }
  return 'folded'
}

const layoutMode = ref<RouteLayoutMode>(loadPersistedMode())

// Automatic reactive container resize tracking via VueUse
useResizeObserver(containerRef, () => handleResize())
useEventListener(window, 'resize', handleResize)
useEventListener(document, 'visibilitychange', handleVisibilityChange)
useEventListener(containerRef, 'touchstart', onDomTouchStart, { passive: false })
useEventListener(containerRef, 'touchmove', onDomTouchMove, { passive: false })
useEventListener(containerRef, 'touchend', onDomTouchEnd, { passive: false })
useEventListener(containerRef, 'touchcancel', onDomTouchEnd, { passive: false })

/** Zoom limits for wheel / pinch interaction. */
const MIN_SCALE = 0.35
const MAX_SCALE = 3.5

let stage: Konva.Stage | null = null
let trackLayer: Konva.Layer | null = null
let stationLayer: Konva.Layer | null = null
let dynamicLayer: Konva.Layer | null = null
let anim: Konva.Animation | null = null
/** True once the user has zoomed/panned manually; disables further auto-fit. */
let userHasTransformed = false
/** Pinch state for touch zoom. */
let isPinching = false
let isStageDragging = false
let lastPinchDistance: number | null = null
let lastPinchCenter: { x: number, y: number } | null = null

let currentLayout: RouteLayoutResult | null = null
let nearestAuraCircle: Konva.Circle | null = null
let rippleCircle1: Konva.Circle | null = null
let rippleCircle2: Konva.Circle | null = null

interface AnimatedVehicle {
  id: string
  /** Smoothed distance-from-start (meters) currently rendered. */
  displayedDist: number
  /** Latest upstream fix (meters), consumed by the motion loop. */
  fixDist: number | null
  /** True when `fixDist` holds a fix the motion loop has not yet reacted to. */
  fixPending: boolean
  /** Upstream `updatedAt` stamp of the fix currently in `fixDist`. */
  fixUpdatedAt: number
  /** `updatedAt` of the last ACCEPTED fix. */
  lastFixUpdatedAt: number
  /** Active motion mode: cruise, catchup, hold */
  mode: 'cruise' | 'catchup' | 'hold'
  /** Target the 'catchup' mode converges to. */
  convergeTo: number
  /** Real upstream speed in m/s; undefined when the source reports none. */
  speedMs: number | undefined
  /** Parked at a platform (upstream reports ~0 speed): no dead-reckoning. */
  dwell: boolean
  /** Fading out because the vehicle vanished upstream; removed at opacity 0. */
  removing: boolean
  /** Konva frame-time (ms) when the fade-in started; -1 until first frame. */
  spawnAt: number
  /** Konva frame-time (ms) of the last accepted upstream fix. */
  lastFixAt: number
  /** Outer group positioned at (x,y), NOT rotated — keeps the label upright. */
  container: Konva.Group
  /** Inner group holding the bus art, rotated to the heading. */
  body: Konva.Group
  /** Speed label, always rendered above the vehicle in screen space. */
  label: Konva.Text | null
}

const vehicleMap = new Map<string, AnimatedVehicle>()

const CATCHUP_RATE = 0.55
const DEFAULT_SPEED_MS = 6.0
const DWELL_SPEED_THRESHOLD_MS = 1.0
const DWELL_SNAP_M = 15.0
const DWELL_SETTLE_MS = 2.0
const MAX_FREERUN_MS = 45000
const MAX_SEGMENTS_PER_SEC = 1.2
const FADE_SEC = 0.6

const effectiveStationDistances = computed<number[]>(() => {
  const detail = lineDetail
  if (detail?.stationDistances && detail.stationDistances.length >= 2) {
    return detail.stationDistances
  }
  const stops = detail?.stops || []
  if (stops.length < 2) return []
  const L = detail?.routeLengthMeters && detail.routeLengthMeters > 0
    ? detail.routeLengthMeters
    : (stops.length - 1) * 1000
  const step = L / (stops.length - 1)
  return stops.map((_, i) => i * step)
})

function routeLength(): number {
  const sd = effectiveStationDistances.value
  if (sd.length > 0) return sd[sd.length - 1]!
  return lineDetail?.routeLengthMeters || 10000
}

function busDistanceFromStart(b: LiveBus): number | null {
  const L = routeLength()
  const stops = lineDetail?.stops || []
  const N = stops.length
  if (N < 2) return null

  if (typeof b.distanceFromStart === 'number' && Number.isFinite(b.distanceFromStart)) {
    return Math.max(0, Math.min(L, b.distanceFromStart))
  }

  if (typeof b.distanceToWaitStn === 'number' && Number.isFinite(b.distanceToWaitStn)) {
    const s = L - b.distanceToWaitStn
    if (s >= 0 && s <= L * 1.05) {
      return Math.max(0, Math.min(L, s))
    }
  }

  const sd = effectiveStationDistances.value
  const targetOrder = b.nextOrder ?? b.order
  if (typeof targetOrder === 'number' && targetOrder >= 1) {
    const fromIdx = Math.max(0, Math.min(targetOrder - 2, N - 2))
    const toIdx = fromIdx + 1
    const s0 = sd[fromIdx] ?? 0
    const s1 = sd[toIdx] ?? s0
    const prog = typeof b.progress === 'number' ? b.progress : 0.4
    return Math.max(0, Math.min(L, s0 + (s1 - s0) * prog))
  }

  return null
}

function nearestPlatformDist(dist: number): number | null {
  const sd = effectiveStationDistances.value
  if (sd.length < 2) return null
  let best = sd[0]!
  let bestD = Math.abs(dist - best)
  for (let i = 1; i < sd.length; i++) {
    const d = Math.abs(dist - sd[i]!)
    if (d < bestD) {
      bestD = d
      best = sd[i]!
    }
  }
  return best
}

function initStage(): void {
  if (!containerRef.value) return

  const width = containerRef.value.clientWidth || 360
  const height = containerRef.value.clientHeight || 420

  stage = new Konva.Stage({
    container: containerRef.value,
    width,
    height,
    draggable: true,
  })

  // Three-layer separation:
  // Layer 1 (trackLayer): Completely static lines and arcs. No listeners.
  trackLayer = new Konva.Layer({ listening: false })
  // Layer 2 (stationLayer): Static station nodes, click hits and texts.
  stationLayer = new Konva.Layer()
  // Layer 3 (dynamicLayer): ONLY moving vehicles and ripple waves. 60FPS redraw.
  dynamicLayer = new Konva.Layer()

  stage.add(trackLayer)
  stage.add(stationLayer)
  stage.add(dynamicLayer)

  // Wheel zoom
  stage.on('wheel', (e) => {
    e.evt.preventDefault()
    userHasTransformed = true
    if (!stage) return
    const oldScale = stage.scaleX()
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    const direction = e.evt.deltaY > 0 ? -1 : 1
    const factor = 1.12
    const newScale = clampScale(direction > 0 ? oldScale * factor : oldScale / factor)
    applyZoomAt(newScale, pointer)
  })

  // Drag tracking
  stage.on('dragstart', () => {
    isStageDragging = true
  })
  stage.on('dragend', () => {
    userHasTransformed = true
    setTimeout(() => {
      isStageDragging = false
    }, 100)
  })

  renderStaticBoard()
  renderDynamicElements()

  if (layoutMode.value === 'linear') {
    focusKeyStation(false)
  }
  else if (currentLayout && currentLayout.points.length > 0) {
    fitWidth()
  }

  initAnimation()
}

function applyZoomAt(newScale: number, pointer: { x: number, y: number }): void {
  if (!stage) return
  const oldScale = stage.scaleX()
  const mousePointTo = {
    x: (pointer.x - stage.x()) / oldScale,
    y: (pointer.y - stage.y()) / oldScale,
  }
  stage.scale({ x: newScale, y: newScale })
  stage.position({
    x: pointer.x - mousePointTo.x * newScale,
    y: pointer.y - mousePointTo.y * newScale,
  })
  stage.batchDraw()
}

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
}

function onDomTouchStart(e: TouchEvent): void {
  if (e.touches.length >= 2) {
    e.preventDefault()
    isPinching = true
    userHasTransformed = true
    if (stage?.isDragging()) {
      stage.stopDrag()
    }
    stage?.draggable(false)
    handlePinchStart(e.touches)
  }
}

function onDomTouchMove(e: TouchEvent): void {
  if (e.touches.length >= 2) {
    e.preventDefault()
    isPinching = true
    userHasTransformed = true
    if (stage?.isDragging()) {
      stage.stopDrag()
    }
    stage?.draggable(false)
    handlePinch(e.touches)
  }
}

function onDomTouchEnd(e: TouchEvent): void {
  if (e.touches.length < 2) {
    lastPinchDistance = null
    lastPinchCenter = null
    if (isPinching) {
      stage?.draggable(true)
      setTimeout(() => {
        isPinching = false
      }, 150)
    }
  }
}

function handlePinchStart(touches: TouchList): void {
  if (!stage || touches.length < 2) return
  const box = stage.container()?.getBoundingClientRect()
  if (!box) return
  const t0 = touches[0]!
  const t1 = touches[1]!
  lastPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
  lastPinchCenter = {
    x: (t0.clientX + t1.clientX) / 2 - box.left,
    y: (t0.clientY + t1.clientY) / 2 - box.top,
  }
}

function handlePinch(touches: TouchList): void {
  if (!stage || touches.length < 2) return
  const box = stage.container()?.getBoundingClientRect()
  if (!box) return

  const t0 = touches[0]!
  const t1 = touches[1]!
  const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
  const center = {
    x: (t0.clientX + t1.clientX) / 2 - box.left,
    y: (t0.clientY + t1.clientY) / 2 - box.top,
  }

  if (lastPinchDistance === null || !lastPinchCenter) {
    lastPinchDistance = dist
    lastPinchCenter = center
    return
  }

  if (dist > 0 && lastPinchDistance > 0) {
    const scaleRatio = dist / lastPinchDistance
    const newScale = clampScale(stage.scaleX() * scaleRatio)
    applyZoomAt(newScale, center)

    const dx = center.x - lastPinchCenter.x
    const dy = center.y - lastPinchCenter.y
    if (dx !== 0 || dy !== 0) {
      stage.position({
        x: stage.x() + dx,
        y: stage.y() + dy,
      })
      stage.batchDraw()
    }
  }

  lastPinchDistance = dist
  lastPinchCenter = center
}

function initAnimation(): void {
  if (anim) {
    anim.stop()
  }

  anim = new Konva.Animation((frame) => {
    if (!frame || !currentLayout) return

    const dt = (frame.timeDiff || 16.6) / 1000
    const time = frame.time || 0

    // 1. Station Water Ripple Wave Animation
    if (nearestAuraCircle && rippleCircle1 && rippleCircle2) {
      const scale = 1 + 0.12 * Math.sin(time / 350)
      nearestAuraCircle.scale({ x: scale, y: scale })

      const phase1 = (time % 1800) / 1800
      rippleCircle1.radius(6 + 18 * phase1)
      rippleCircle1.opacity(Math.max(0, 0.6 * (1 - phase1)))

      const phase2 = ((time + 900) % 1800) / 1800
      rippleCircle2.radius(6 + 18 * phase2)
      rippleCircle2.opacity(Math.max(0, 0.6 * (1 - phase2)))
    }

    // 2. Predict-correct vehicle motion
    const L = routeLength()
    for (const [id, v] of vehicleMap.entries()) {
      if (!currentLayout) continue

      if (v.spawnAt < 0) v.spawnAt = time
      if (v.lastFixAt < 0) v.lastFixAt = time
      const ageSec = (time - v.spawnAt) / 1000
      if (v.removing) {
        const op = v.container.opacity() - dt / FADE_SEC
        if (op <= 0) {
          v.container.destroy()
          vehicleMap.delete(id)
        }
        else {
          v.container.opacity(op)
        }
        continue
      }
      if (ageSec < FADE_SEC) {
        v.container.opacity(Math.max(0, Math.min(1, ageSec / FADE_SEC)))
      }
      else if (v.container.opacity() !== 1) {
        v.container.opacity(1)
      }

      const base = v.dwell ? 0 : (v.speedMs ?? DEFAULT_SPEED_MS)

      if (v.fixPending && v.fixDist !== null) {
        const isNewObservation = v.fixUpdatedAt !== v.lastFixUpdatedAt
        v.fixPending = false

        if (isNewObservation) {
          v.lastFixUpdatedAt = v.fixUpdatedAt
          v.lastFixAt = time

          const delta = v.fixDist - v.displayedDist
          if (delta > 0) {
            v.mode = 'catchup'
            v.convergeTo = v.fixDist
          }
          else if (delta < -15) {
            v.mode = 'hold'
            v.convergeTo = v.fixDist
          }
          else {
            v.mode = 'cruise'
            v.convergeTo = v.fixDist
          }
        }
      }

      const sinceLastFix = time - v.lastFixAt
      const canExtrapolate = sinceLastFix < MAX_FREERUN_MS

      let effectiveSpeed: number
      if (v.mode === 'catchup') {
        const remaining = v.convergeTo - v.displayedDist
        if (remaining <= 0.5) {
          v.mode = 'cruise'
          effectiveSpeed = canExtrapolate ? base : 0
        }
        else {
          effectiveSpeed = Math.max(base, remaining * CATCHUP_RATE)
        }
      }
      else if (v.mode === 'hold') {
        if (v.fixDist !== null && v.displayedDist <= v.fixDist + 0.5) {
          v.mode = 'cruise'
          effectiveSpeed = canExtrapolate ? base : 0
        }
        else {
          effectiveSpeed = 0
        }
      }
      else {
        effectiveSpeed = canExtrapolate ? base : 0
      }

      if (effectiveSpeed > 0 && dt > 0) {
        const sd = effectiveStationDistances.value
        if (sd.length >= 2) {
          const seg = distanceToSegment(v.displayedDist, sd)
          if (seg) {
            const s0 = sd[seg.index] ?? 0
            const s1 = sd[seg.index + 1] ?? s0
            const segLen = Math.max(1, s1 - s0)
            const maxSpeed = segLen * MAX_SEGMENTS_PER_SEC
            if (effectiveSpeed > maxSpeed) {
              effectiveSpeed = maxSpeed
            }
          }
        }
      }

      v.displayedDist = Math.max(0, Math.min(L, v.displayedDist + effectiveSpeed * dt))

      if (v.dwell) {
        const plat = nearestPlatformDist(v.displayedDist)
        if (plat !== null && Math.abs(v.displayedDist - plat) < DWELL_SNAP_M) {
          v.displayedDist += (plat - v.displayedDist) * Math.min(1, dt * DWELL_SETTLE_MS)
        }
      }

      const pos = layoutPosition(v.displayedDist)
      v.container.position({ x: pos.x, y: pos.y })
      v.body.rotation(pos.angleDeg)
    }
  }, dynamicLayer)

  anim.start()
}

function layoutPosition(dist: number): { x: number, y: number, angleDeg: number } {
  if (!currentLayout) return { x: 0, y: 0, angleDeg: 0 }
  const sd = effectiveStationDistances.value
  const seg = distanceToSegment(dist, sd)
  if (!seg) return { x: 0, y: 0, angleDeg: 0 }
  return currentLayout.getInterpolatedPosition(seg.index + 1, seg.progress)
}

interface BoardMetrics {
  paddingX: number
  paddingY: number
  rowHeight: number
  labelFontSize: number
  labelWidth: number
  stationRadius: number
  hitRadius: number
  trackWidth: number
  linearStepX: number
  fitPadding: number
  fitTopMargin: number
}

function boardMetrics(): BoardMetrics {
  const w = stage?.width() ?? 0
  const isMobile = w > 0 && w < 640
  if (isMobile) {
    return {
      paddingX: 20,
      paddingY: 24,
      rowHeight: 64,
      labelFontSize: 11,
      labelWidth: 54,
      stationRadius: 6.5,
      hitRadius: 20,
      trackWidth: 5,
      linearStepX: 96,
      fitPadding: 12,
      fitTopMargin: 28,
    }
  }
  return {
    paddingX: 40,
    paddingY: 50,
    rowHeight: 95,
    labelFontSize: 10,
    labelWidth: 64,
    stationRadius: 6,
    hitRadius: 18,
    trackWidth: 6,
    linearStepX: 120,
    fitPadding: 24,
    fitTopMargin: 40,
  }
}

// 1. Static Board
function renderStaticBoard(): void {
  if (!stage || !trackLayer || !stationLayer) return

  trackLayer.destroyChildren()
  stationLayer.destroyChildren()

  const width = stage.width()
  const stops = lineDetail?.stops || []
  if (stops.length === 0) return

  const m = boardMetrics()

  const layout = computeRouteLayout(stops, {
    mode: layoutMode.value,
    viewportWidth: width,
    paddingX: m.paddingX,
    paddingY: m.paddingY,
    rowHeight: m.rowHeight,
    linearStepX: m.linearStepX,
  })
  currentLayout = layout

  // Render Track Lines
  for (let r = 0; r < layout.totalRows; r++) {
    const rowPoints = layout.points.filter(p => p.row === r)
    if (rowPoints.length < 2) continue

    const first = rowPoints[0]!
    const last = rowPoints[rowPoints.length - 1]!

    // Base track
    trackLayer.add(new Konva.Line({
      points: [first.x, first.y, last.x, last.y],
      stroke: '#1e293b',
      strokeWidth: m.trackWidth,
      lineCap: 'round',
    }))

    // Inner guide
    trackLayer.add(new Konva.Line({
      points: [first.x, first.y, last.x, last.y],
      stroke: '#0ea5e9',
      strokeWidth: Math.max(1.5, m.trackWidth / 3),
      opacity: 0.7,
      lineCap: 'round',
    }))
  }

  // Render U-Turn Arcs (folded mode only)
  for (const arc of layout.arcs) {
    trackLayer.add(new Konva.Arc({
      x: arc.centerX,
      y: arc.centerY,
      innerRadius: arc.radius - m.trackWidth / 2,
      outerRadius: arc.radius + m.trackWidth / 2,
      angle: 180,
      rotation: arc.isRightSide ? -90 : 90,
      fill: '#1e293b',
    }))

    trackLayer.add(new Konva.Arc({
      x: arc.centerX,
      y: arc.centerY,
      innerRadius: arc.radius - m.trackWidth / 6,
      outerRadius: arc.radius + m.trackWidth / 6,
      angle: 180,
      rotation: arc.isRightSide ? -90 : 90,
      fill: '#0ea5e9',
      opacity: 0.7,
    }))
  }

  // Render Station Nodes
  for (const pt of layout.points) {
    const isNearest = nearestStation && nearestStation.id === pt.station.id
    const isInterchange = pt.station.interchanges && pt.station.interchanges.length > 0
    const isSelected = selectedStation?.id === pt.station.id

    // Interchange marker ring
    if (isInterchange && !isNearest) {
      stationLayer.add(new Konva.Circle({
        x: pt.x,
        y: pt.y,
        radius: m.stationRadius + 3,
        stroke: 'rgba(56, 189, 248, 0.55)',
        strokeWidth: 2,
        listening: false,
      }))
    }

    // Selected-station highlight ring
    if (isSelected) {
      stationLayer.add(new Konva.Circle({
        x: pt.x,
        y: pt.y,
        radius: m.stationRadius + 6,
        stroke: '#22d3ee',
        strokeWidth: 2.5,
        listening: false,
      }))
    }

    // Purely visual node: listening: false delegates all hits to `hit` circle
    const circle = new Konva.Circle({
      x: pt.x,
      y: pt.y,
      radius: m.stationRadius,
      fill: isNearest ? '#facc15' : isSelected ? '#22d3ee' : '#cbd5e1',
      stroke: '#0f172a',
      strokeWidth: 2,
      listening: false,
    })

    // Sized hit area for mouse & touch
    const hit = new Konva.Circle({
      x: pt.x,
      y: pt.y,
      radius: m.hitRadius,
      fill: 'rgba(0, 0, 0, 0.001)',
    })

    let touchStartX = 0
    let touchStartY = 0
    let isTouchMoved = false

    hit.on('touchstart mousedown', (e: any) => {
      if (isPinching || (e.evt?.touches && e.evt.touches.length > 1)) {
        return
      }
      const touch = e.evt?.touches ? e.evt.touches[0] : e.evt
      touchStartX = touch?.clientX ?? 0
      touchStartY = touch?.clientY ?? 0
      isTouchMoved = false
      circle.scale({ x: 1.45, y: 1.45 })
      circle.strokeWidth(3)
    })

    hit.on('touchmove mousemove', (e: any) => {
      if (isTouchMoved) return
      const touch = e.evt?.touches ? e.evt.touches[0] : e.evt
      if (touch) {
        const dist = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY)
        if (dist > 8 || (e.evt?.touches && e.evt.touches.length > 1) || isPinching) {
          isTouchMoved = true
          circle.scale({ x: 1, y: 1 })
          circle.strokeWidth(2)
        }
      }
    })

    const select = (e: any) => {
      if (isPinching || isTouchMoved || isStageDragging || (e.evt?.touches && e.evt.touches.length > 1)) {
        return
      }
      emit('select-station', pt.station)
    }
    hit.on('click tap', select)

    const release = () => {
      circle.scale({ x: 1, y: 1 })
      circle.strokeWidth(2)
    }
    hit.on('touchend touchcancel mouseup mouseleave', release)
    hit.on('mouseenter', () => stage?.container()?.style.setProperty('cursor', 'pointer'))
    hit.on('mouseleave', () => stage?.container()?.style.setProperty('cursor', ''))

    stationLayer.add(circle)
    stationLayer.add(hit)

    // Station Label
    stationLayer.add(new Konva.Text({
      x: pt.x - m.labelWidth / 2,
      y: pt.y + m.stationRadius + 4,
      text: pt.station.name,
      fontSize: m.labelFontSize,
      fontFamily: 'system-ui, sans-serif',
      fill: isNearest ? '#fde047' : isSelected ? '#67e8f9' : '#94a3b8',
      width: m.labelWidth,
      align: 'center',
      listening: false,
    }))
  }

  trackLayer.batchDraw()
  stationLayer.batchDraw()
}

// 2. Dynamic Elements
let rippleGroup: Konva.Group | null = null

function renderDynamicElements(): void {
  if (!stage || !dynamicLayer || !currentLayout) return

  dynamicLayer.destroyChildren()
  for (const v of vehicleMap.values()) {
    v.container.destroy()
  }
  vehicleMap.clear()
  rippleGroup = null
  nearestAuraCircle = null
  rippleCircle1 = null
  rippleCircle2 = null

  const stops = lineDetail?.stops || []
  if (stops.length === 0) return

  renderRipple()
  syncVehicles()

  dynamicLayer.batchDraw()
}

function renderRipple(): void {
  if (!dynamicLayer || !currentLayout) return

  rippleGroup?.destroy()
  rippleGroup = new Konva.Group({ listening: false })
  dynamicLayer.add(rippleGroup)
  nearestAuraCircle = null
  rippleCircle1 = null
  rippleCircle2 = null

  if (nearestStation) {
    const pt = currentLayout.points.find(p => p.station.id === nearestStation?.id)
    if (pt) {
      rippleCircle1 = new Konva.Circle({
        x: pt.x,
        y: pt.y,
        radius: 6,
        stroke: '#facc15',
        strokeWidth: 1.5,
        opacity: 0.6,
      })
      rippleCircle2 = new Konva.Circle({
        x: pt.x,
        y: pt.y,
        radius: 6,
        stroke: '#facc15',
        strokeWidth: 1,
        opacity: 0.4,
      })
      nearestAuraCircle = new Konva.Circle({
        x: pt.x,
        y: pt.y,
        radius: 12,
        fill: '#facc15',
        opacity: 0.2,
      })

      rippleGroup.add(nearestAuraCircle)
      rippleGroup.add(rippleCircle1)
      rippleGroup.add(rippleCircle2)
    }
  }
}

function createVehicleNode(id: string): { container: Konva.Group, body: Konva.Group, label: Konva.Text } {
  const container = new Konva.Group({ id: `veh-${id}`, opacity: 0 })
  const body = new Konva.Group({ listening: false })

  const chassis = new Konva.Rect({
    x: -12,
    y: -7,
    width: 24,
    height: 14,
    cornerRadius: 4,
    fill: '#0284c7',
    stroke: '#38bdf8',
    strokeWidth: 1.5,
  })
  const windshield = new Konva.Rect({
    x: 4,
    y: -4,
    width: 4,
    height: 8,
    cornerRadius: 1,
    fill: '#bae6fd',
  })
  const headlightL = new Konva.Circle({ x: 10, y: -4, radius: 1.2, fill: '#fef08a' })
  const headlightR = new Konva.Circle({ x: 10, y: 4, radius: 1.2, fill: '#fef08a' })

  body.add(chassis)
  body.add(windshield)
  body.add(headlightL)
  body.add(headlightR)

  const label = new Konva.Text({
    x: -24,
    y: -24,
    width: 48,
    text: '',
    fontSize: 9,
    fontFamily: 'monospace',
    fontStyle: 'bold',
    fill: '#38bdf8',
    align: 'center',
    listening: false,
  })

  container.add(body)
  container.add(label)
  dynamicLayer?.add(container)

  return { container, body, label }
}

function syncVehicles(): void {
  if (!stage || !dynamicLayer || !currentLayout) return

  const seenIds = new Set<string>()
  const incoming = buses || []

  for (const bus of incoming) {
    const rawId = bus.id || bus.license || `b-${bus.order}`
    const id = String(rawId)
    seenIds.add(id)

    const fixDist = busDistanceFromStart(bus)
    const speedMs = typeof bus.speed === 'number' && Number.isFinite(bus.speed)
      ? bus.speed
      : undefined
    const dwell = speedMs !== undefined && speedMs < DWELL_SPEED_THRESHOLD_MS
    const fixUpdatedAt = bus.updatedAt ?? Date.now()

    let v = vehicleMap.get(id)
    if (!v) {
      const initialDist = fixDist ?? 0
      const node = createVehicleNode(id)
      const initialPos = layoutPosition(initialDist)
      node.container.position({ x: initialPos.x, y: initialPos.y })
      node.body.rotation(initialPos.angleDeg)

      v = {
        id,
        displayedDist: initialDist,
        fixDist,
        fixPending: fixDist !== null,
        fixUpdatedAt,
        lastFixUpdatedAt: fixUpdatedAt,
        mode: 'cruise',
        convergeTo: initialDist,
        speedMs,
        dwell,
        removing: false,
        spawnAt: -1,
        lastFixAt: -1,
        container: node.container,
        body: node.body,
        label: node.label,
      }
      vehicleMap.set(id, v)
    }
    else {
      if (v.removing) {
        v.removing = false
        v.spawnAt = -1
      }
      v.fixDist = fixDist
      v.fixPending = true
      v.fixUpdatedAt = fixUpdatedAt
      v.speedMs = speedMs
      v.dwell = dwell
    }

    if (v.label) {
      if (typeof bus.speed === 'number' && Number.isFinite(bus.speed)) {
        v.label.text(`${Math.round(bus.speed * 3.6)}km/h`)
      }
      else {
        v.label.text('')
      }
    }
  }

  for (const [id, v] of vehicleMap.entries()) {
    if (!seenIds.has(id) && !v.removing) {
      v.removing = true
    }
  }

  dynamicLayer.batchDraw()
}

/** Focus the camera on the key station (selected > nearest > first bus > first station). */
function focusKeyStation(smooth = false): void {
  if (!stage || !currentLayout || currentLayout.points.length === 0) return

  let targetId = selectedStation?.id ?? nearestStation?.id
  if (!targetId && buses.length > 0) {
    const b = buses[0]!
    const targetOrder = b.nextOrder ?? b.order
    const found = lineDetail?.stops.find(s => s.order === targetOrder)
    if (found) targetId = found.id
  }
  if (!targetId && lineDetail?.stops.length) {
    targetId = lineDetail.stops[0]!.id
  }

  const targetPt = currentLayout.points.find(p => p.station.id === targetId) ?? currentLayout.points[0]!
  const viewW = stage.width()
  const viewH = stage.height()
  const scale = clampScale(viewW < 640 ? 1.0 : 1.0)

  const targetX = (viewW / 2) - targetPt.x * scale
  const targetY = (viewH / 2) - targetPt.y * scale

  if (smooth) {
    stage.to({
      x: targetX,
      y: targetY,
      scaleX: scale,
      scaleY: scale,
      duration: 0.28,
      easing: Konva.Easings.EaseInOut,
    })
  }
  else {
    stage.scale({ x: scale, y: scale })
    stage.position({ x: targetX, y: targetY })
    stage.batchDraw()
  }
}

/** Fit the board to the canvas WIDTH (top-aligned, folded mode default). */
function fitWidth(): void {
  if (!stage || !trackLayer || !stationLayer || !currentLayout) return
  if (currentLayout.points.length === 0) return

  if (layoutMode.value === 'linear') {
    focusKeyStation(false)
    return
  }

  const box = contentBounds()
  if (!box) return

  const viewW = Math.max(1, stage.width())
  const m = boardMetrics()
  const scale = clampScale((viewW - m.fitPadding * 2) / box.w)

  stage.scale({ x: scale, y: scale })
  stage.position({
    x: (viewW - box.w * scale) / 2 - box.minX * scale,
    y: m.fitTopMargin - box.minY * scale,
  })
  stage.batchDraw()
}

/** Fit entire board into current viewport. */
function fitToViewport(): void {
  if (!stage || !trackLayer || !stationLayer || !currentLayout) return
  if (currentLayout.points.length === 0) return

  const box = contentBounds()
  if (!box) return

  const viewW = Math.max(1, stage.width())
  const viewH = Math.max(1, stage.height())
  const m = boardMetrics()

  const scale = clampScale(
    Math.min(
      (viewW - m.fitPadding * 2) / box.w,
      (viewH - m.fitTopMargin - m.fitPadding) / box.h,
    ),
  )

  stage.scale({ x: scale, y: scale })
  stage.position({
    x: (viewW - box.w * scale) / 2 - box.minX * scale,
    y: layoutMode.value === 'linear'
      ? (viewH - box.h * scale) / 2 - box.minY * scale
      : m.fitTopMargin - box.minY * scale,
  })
  stage.batchDraw()
}

function contentBounds(): { minX: number, minY: number, w: number, h: number } | null {
  if (!trackLayer || !stationLayer) return null

  const boxes = [trackLayer, stationLayer].map(l => l.getClientRect({ skipTransform: true }))
  const minX = Math.min(...boxes.map(b => b.x))
  const minY = Math.min(...boxes.map(b => b.y))
  const maxX = Math.max(...boxes.map(b => b.x + b.width))
  const maxY = Math.max(...boxes.map(b => b.y + b.height))

  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  return { minX, minY, w, h }
}

function handleFitWidth(): void {
  userHasTransformed = false
  if (layoutMode.value === 'linear') {
    focusKeyStation(true)
  }
  else {
    fitWidth()
  }
}

function handleFitScreen(): void {
  userHasTransformed = false
  fitToViewport()
}

function zoomIn(): void {
  if (!stage) return
  userHasTransformed = true
  const center = { x: stage.width() / 2, y: stage.height() / 2 }
  const newScale = clampScale(stage.scaleX() * 1.25)
  applyZoomAt(newScale, center)
}

function zoomOut(): void {
  if (!stage) return
  userHasTransformed = true
  const center = { x: stage.width() / 2, y: stage.height() / 2 }
  const newScale = clampScale(stage.scaleX() / 1.25)
  applyZoomAt(newScale, center)
}

function toggleLayoutMode(): void {
  const next: RouteLayoutMode = layoutMode.value === 'folded' ? 'linear' : 'folded'
  setLayoutMode(next)
}

function setLayoutMode(mode: RouteLayoutMode): void {
  if (layoutMode.value === mode) return
  layoutMode.value = mode
  try {
    localStorage.setItem('realtime_transit_layout_mode', mode)
  }
  catch {
    // ignore
  }

  userHasTransformed = false
  renderStaticBoard()
  renderDynamicElements()

  if (mode === 'linear') {
    focusKeyStation(false)
  }
  else {
    fitWidth()
  }

  emit('layout-change', mode)
}

defineExpose({
  layoutMode,
  setLayoutMode,
  toggleLayoutMode,
  fitWidth,
  fitToViewport,
  focusKeyStation,
})

function handleVisibilityChange(): void {
  if (document.hidden) {
    if (anim?.isRunning()) anim.stop()
  }
  else {
    if (anim && !anim.isRunning()) anim.start()
  }
}

watch(
  () => [lineDetail?.lineId, lineDetail?.direction],
  () => {
    userHasTransformed = false
    renderStaticBoard()
    renderDynamicElements()
    if (layoutMode.value === 'linear') {
      focusKeyStation(false)
    }
    else {
      fitWidth()
    }
  },
)

watch(
  () => selectedStation?.id,
  () => {
    renderStaticBoard()
    stationLayer?.batchDraw()
    if (layoutMode.value === 'linear' && selectedStation) {
      focusKeyStation(true)
    }
  },
)

watch(
  () => buses,
  () => {
    syncVehicles()
  },
  { deep: true },
)

watch(
  () => nearestStation,
  () => {
    renderRipple()
    dynamicLayer?.batchDraw()
  },
)

onMounted(() => {
  initStage()
})

onUnmounted(() => {
  if (anim) {
    anim.stop()
    anim = null
  }
  stage?.destroy()
})

function handleResize(): void {
  if (!containerRef.value || !stage) return

  const w = containerRef.value.clientWidth
  const h = containerRef.value.clientHeight
  if (w <= 0 || h <= 0) return
  if (w === stage.width() && h === stage.height()) return

  stage.width(w)
  stage.height(h)
  renderStaticBoard()
  renderDynamicElements()
  if (!userHasTransformed) {
    if (layoutMode.value === 'linear') {
      focusKeyStation(false)
    }
    else {
      fitWidth()
    }
  }
}
</script>

<template>
  <div class="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
    <!-- Desktop Top HUD / Legend bar -->
    <div class="hidden sm:flex shrink-0 items-center justify-between gap-2 border-b border-slate-800/80 bg-slate-900/60 px-4 py-2 text-xs backdrop-blur-md">
      <div class="flex items-center gap-3">
        <span class="flex items-center gap-1.5 font-medium text-slate-300">
          <span class="inline-block h-2.5 w-2.5 rounded-full bg-cyan-400"></span>
          拓扑线路
        </span>
        <span class="flex items-center gap-1.5 text-slate-400">
          <span class="inline-block h-2.5 w-2.5 rounded-full bg-amber-400"></span>
          当前定位
        </span>
        <div class="ml-2 flex items-center rounded-lg border border-slate-700/80 bg-slate-800/80 p-0.5">
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition active:scale-95"
            :class="layoutMode === 'folded' ? 'bg-cyan-500/20 font-medium text-cyan-300' : 'text-slate-400 hover:text-slate-200'"
            @click="setLayoutMode('folded')"
          >
            <WrapText class="h-3.5 w-3.5" />
            <span>折返排布</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition active:scale-95"
            :class="layoutMode === 'linear' ? 'bg-cyan-500/20 font-medium text-cyan-300' : 'text-slate-400 hover:text-slate-200'"
            @click="setLayoutMode('linear')"
          >
            <GitCommitHorizontal class="h-3.5 w-3.5" />
            <span>直线排布</span>
          </button>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
          :title="layoutMode === 'linear' ? '聚焦当前关注站' : '按画布宽度撑开，纵向拖动查看'"
          @click="handleFitWidth"
        >
          <MoveHorizontal class="h-3.5 w-3.5 text-cyan-400" />
          <span>{{ layoutMode === 'linear' ? '聚焦站点' : '适应宽度' }}</span>
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
          title="缩小到整条线路全部可见"
          @click="handleFitScreen"
        >
          <Expand class="h-3.5 w-3.5 text-cyan-400" />
          <span>适应屏幕</span>
        </button>
        <button
          class="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
          title="放大"
          aria-label="放大画布"
          @click="zoomIn"
        >
          <Plus class="h-3.5 w-3.5" />
        </button>
        <button
          class="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
          title="缩小"
          aria-label="缩小画布"
          @click="zoomOut"
        >
          <Minus class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>

    <!-- Mobile Floating Controls -->
    <!-- Mode pill badge: tap to toggle layout instantly on mobile -->
    <div class="sm:hidden absolute left-2.5 top-2.5 z-10 flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-900/85 px-2.5 py-1 text-xs text-slate-300 backdrop-blur-md shadow-md">
      <button
        type="button"
        class="flex items-center gap-1 text-slate-300 active:scale-95"
        @click="toggleLayoutMode"
      >
        <component :is="layoutMode === 'folded' ? WrapText : GitCommitHorizontal" class="h-3.5 w-3.5 text-cyan-400" />
        <span class="font-medium text-slate-200">{{ layoutMode === 'folded' ? '折返' : '直线' }}</span>
      </button>
      <span class="text-slate-600">|</span>
      <span class="flex items-center gap-1 text-slate-300">
        <span class="inline-block h-2 w-2 rounded-full bg-amber-400"></span>
        定位
      </span>
    </div>

    <!-- Mobile Right FAB Action Buttons: WCAG min touch target 36-40px -->
    <div class="sm:hidden absolute right-2.5 top-2.5 z-10 flex flex-col gap-1.5">
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-500/40 bg-slate-900/90 text-xs text-cyan-300 shadow-lg backdrop-blur-md active:scale-95"
        :title="layoutMode === 'folded' ? '切换为直线排布' : '切换为折返排布'"
        :aria-label="layoutMode === 'folded' ? '切换为直线排布' : '切换为折返排布'"
        @click="toggleLayoutMode"
      >
        <component :is="layoutMode === 'folded' ? GitCommitHorizontal : WrapText" class="h-4 w-4" />
      </button>
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/90 text-xs text-slate-200 shadow-lg backdrop-blur-md active:scale-95"
        :title="layoutMode === 'linear' ? '聚焦当前站' : '适应宽度'"
        :aria-label="layoutMode === 'linear' ? '聚焦当前站' : '适应宽度'"
        @click="handleFitWidth"
      >
        <MoveHorizontal class="h-4 w-4" />
      </button>
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/90 text-xs text-slate-200 shadow-lg backdrop-blur-md active:scale-95"
        title="适应屏幕"
        aria-label="适应屏幕"
        @click="handleFitScreen"
      >
        <Expand class="h-4 w-4" />
      </button>
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/90 text-slate-200 shadow-lg backdrop-blur-md active:scale-95"
        title="放大"
        aria-label="放大"
        @click="zoomIn"
      >
        <Plus class="h-4 w-4" />
      </button>
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/90 text-slate-200 shadow-lg backdrop-blur-md active:scale-95"
        title="缩小"
        aria-label="缩小"
        @click="zoomOut"
      >
        <Minus class="h-4 w-4" />
      </button>
    </div>

    <!-- Canvas Container -->
    <div
      ref="containerEl"
      class="min-h-0 w-full flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
    ></div>
  </div>
</template>
