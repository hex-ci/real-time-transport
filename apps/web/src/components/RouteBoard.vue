<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  shallowRef,
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
  SlidersHorizontal,
  WrapText,
  X,
} from '@lucide/vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import type { LineDetail, LiveBus, Station } from '@real-time-transport/shared'
import { distanceToSegment } from '@real-time-transport/shared/geo'
import {
  computeRouteLayout,
  type RouteLayoutMode,
  type RouteLayoutResult,
} from '@/composables/use-route-layout'
import UiTooltip from '@/components/ui/UiTooltip.vue'

const {
  nearestStation = null,
  selectedStation = null,
  initialLayoutMode = undefined,
  lineDetail,
  buses,
  morningStopName = null,
  eveningStopName = null,
} = defineProps<{
  lineDetail: LineDetail
  buses: LiveBus[]
  nearestStation?: Station | null
  /** Currently selected station, drawn with a highlight ring. */
  selectedStation?: Station | null
  /** Optional initial layout mode ('folded' or 'linear'). Defaults to persisted preference or 'folded'. */
  initialLayoutMode?: RouteLayoutMode
  /** Commute board stop names, marked on the diagram when they appear in this direction. */
  morningStopName?: string | null
  eveningStopName?: string | null
}>()

export interface StationAnchor {
  screenX: number
  screenY: number
  radius: number
  x: number
  y: number
}

const emit = defineEmits<{
  (e: 'select-station', station: Station, anchor?: StationAnchor): void
  (e: 'close-station'): void
  (e: 'station-anchor-change', anchor: StationAnchor): void
  (e: 'layout-change', mode: RouteLayoutMode): void
}>()

const containerRef = useTemplateRef('containerEl')

/**
 * Floating mobile controls. They are absolutely positioned overlays, so the
 * canvas box starts underneath them and a fit has to inset by their real
 * height. Desktop's HUD sits in normal flow and is already excluded from the
 * canvas box; these elements are `display: none` there, which measures as a
 * zero-size rect — so one measurement covers both cases, with no breakpoint
 * check that could drift from the `md:` visibility classes.
 */
const mobileModePillRef = useTemplateRef('mobileModePillEl')
/**
 * The FAB trigger only, not its container: the container grows when the tool
 * list expands, and insetting by that transient stack would push the board
 * down for chrome the user just opened deliberately.
 */
const mobileFabTriggerRef = useTemplateRef('mobileFabTriggerEl')

/** Clearance kept between the toolbar's lower edge and the first row of stops. */
const TOOLBAR_GAP = 8

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

const layoutMode = shallowRef<RouteLayoutMode>(loadPersistedMode())
const mobileToolsOpen = shallowRef(false)

// Automatic reactive container resize tracking via VueUse
useResizeObserver(containerRef, () => handleResize())
useEventListener(window, 'resize', handleResize)
useEventListener(document, 'visibilitychange', handleVisibilityChange)
useEventListener(containerRef, 'touchstart', onDomTouchStart, { passive: false })
useEventListener(containerRef, 'touchmove', onDomTouchMove, { passive: false })
useEventListener(containerRef, 'touchend', onDomTouchEnd, { passive: false })
useEventListener(containerRef, 'touchcancel', onDomTouchEnd, { passive: false })

let stationClickedThisTurn = false

function onContainerClick(): void {
  if (isStageDragging || isPinching) return
  if (stationClickedThisTurn) {
    stationClickedThisTurn = false
    return
  }
  emit('close-station')
}

useEventListener(containerRef, 'click', onContainerClick)

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
let selectionRing: Konva.Circle | null = null
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

const MAX_BUS_SPEED_MS = 16.0 // 57.6 km/h physical speed limit for city transit
const CATCHUP_CONVERGE_SEC = 3.5 // Smoothly close position gap over 3.5 seconds
const DEFAULT_SPEED_MS = 6.0
const DWELL_SPEED_THRESHOLD_MS = 1.0
const DWELL_SNAP_M = 15.0
const DWELL_SETTLE_MS = 2.0
const FREERUN_CRUISE_MS = 8000 // 8s at full cruise speed
const MAX_FREERUN_MS = 20000 // 20s total with smooth dampening to 0
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

  if (typeof b.distanceToWaitStn === 'number' && b.distanceToWaitStn > 0 && Number.isFinite(b.distanceToWaitStn)) {
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
  stage.on('dragmove', () => {
    notifyAnchorChange()
  })
  stage.on('dragend', () => {
    userHasTransformed = true
    notifyAnchorChange()
    setTimeout(() => {
      isStageDragging = false
    }, 100)
  })

  // Tapping on empty board canvas closes active station popover
  stage.on('click tap', (e) => {
    if (isStageDragging) return
    if (e.target === stage) {
      emit('close-station')
    }
  })

  renderStaticBoard()
  renderDynamicElements()

  if (layoutMode.value === 'linear') {
    focusKeyStation(false)
  }
  else if (currentLayout && currentLayout.points.length > 0) {
    fitWidth()
  }

  // A station may already be selected by the time the stage finishes initialising
  // (the GPS-nearest stop is chosen as soon as the fix and line detail exist).
  // The selection watchers ran before this layout existed, so their
  // notifyAnchorChange was a no-op — emit now that the anchor can be measured.
  notifyAnchorChange()

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
  notifyAnchorChange()
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
      // Smooth extrapolation damping:
      // 0 ~ 8s: full speed (100%)
      // 8 ~ 20s: linear decay from 100% to 0% (simulating approaching intersections / signals)
      // > 20s: 0% (gracefully hold position until new live fix arrives)
      let extrapolationFactor = 0
      if (sinceLastFix < FREERUN_CRUISE_MS) {
        extrapolationFactor = 1.0
      }
      else if (sinceLastFix < MAX_FREERUN_MS) {
        extrapolationFactor = Math.max(0, 1.0 - (sinceLastFix - FREERUN_CRUISE_MS) / (MAX_FREERUN_MS - FREERUN_CRUISE_MS))
      }

      let effectiveSpeed: number
      if (v.mode === 'catchup') {
        const remaining = v.convergeTo - v.displayedDist
        if (remaining <= 0.5) {
          v.mode = 'cruise'
          effectiveSpeed = base * extrapolationFactor
        }
        else {
          // Bounded smooth catchup: closes gap gently over 3.5s, strictly capped by MAX_BUS_SPEED_MS (16 m/s = 57.6 km/h)
          const targetCatchup = Math.max(base, remaining / CATCHUP_CONVERGE_SEC)
          effectiveSpeed = Math.min(MAX_BUS_SPEED_MS, targetCatchup)
        }
      }
      else if (v.mode === 'hold') {
        // If real bus was held at a light/station, wait gently at 0 speed until real position advances
        if (v.fixDist !== null && v.displayedDist <= v.fixDist + 0.5) {
          v.mode = 'cruise'
          effectiveSpeed = base * extrapolationFactor
        }
        else {
          effectiveSpeed = 0
        }
      }
      else {
        effectiveSpeed = base * extrapolationFactor
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

      const prevDist = v.displayedDist
      let nextDist = prevDist + effectiveSpeed * dt

      if (v.dwell) {
        const plat = nearestPlatformDist(nextDist)
        // Forward-only dwell snap: only glide forward into the platform if approaching from behind.
        // Never pull backwards!
        if (plat !== null && plat > nextDist && (plat - nextDist) < DWELL_SNAP_M) {
          nextDist += (plat - nextDist) * Math.min(1, dt * DWELL_SETTLE_MS)
        }
      }

      // Golden Rule: Strict Monotonic Non-Decreasing Invariant (0 backwards motion, ever)
      v.displayedDist = Math.max(prevDist, Math.min(L, nextDist))

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
      // Sized for the worst real label: a 14-character name
      // (江场村（鲜活农产品流通中心）) wraps to 4 lines in a 54px column, which at
      // lineHeight 1.4 needs ~62px. The row must clear stationRadius + 4 label
      // offset + those 4 lines + a gap + the next row's dot radius — the original
      // 64px did not, leaving that label overlapping the row below by 8px.
      rowHeight: 86,
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
    labelFontSize: 11,
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

    // Purely visual node: listening: false delegates all hits to `hit` circle
    const circle = new Konva.Circle({
      id: `station-visual-${pt.station.id}`,
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
      stationClickedThisTurn = true
      if (isPinching || isTouchMoved || isStageDragging || (e.evt?.touches && e.evt.touches.length > 1)) {
        return
      }
      const anchor = getStationAnchor(pt.station.id)
      emit('select-station', pt.station, anchor || undefined)
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
    // lineHeight 1.4: CJK glyphs fill nearly the whole em box, so the default
    // lineHeight of 1 leaves two-line names touching (measured clear ink between
    // lines: 0px). 1.4 measures 2-4px, the value chosen visually. Antialiasing
    // eats most of the nominal leading, so this is not the CSS intuition of 1.4.
    // Taller labels need a taller row — see the rowHeight budget in boardMetrics().
    stationLayer.add(new Konva.Text({
      id: `station-label-${pt.station.id}`,
      x: pt.x - m.labelWidth / 2,
      y: pt.y + m.stationRadius + 4,
      text: pt.station.name,
      fontSize: m.labelFontSize,
      fontFamily: 'system-ui, sans-serif',
      lineHeight: 1.4,
      fill: isNearest ? '#fde047' : isSelected ? '#67e8f9' : '#94a3b8',
      width: m.labelWidth,
      align: 'center',
      listening: false,
    }))

    // Commute board-stop marker. A separate node rather than a prefix on the
    // label text: station names already wrap to four lines at their worst
    // (14-character names in the mobile column), and widening the label would
    // break the row-height budget. Both board stops are marked whenever they
    // appear in this direction's stop list — seeing them together is what makes
    // the direction verdict legible, since the leg is derived from their order.
    const boardStop = pt.station.name === morningStopName
      ? { text: '上', fill: '#34d399' }
      : pt.station.name === eveningStopName
        ? { text: '下', fill: '#c084fc' }
        : null
    if (boardStop) {
      const badgeR = m.stationRadius + 5
      stationLayer.add(new Konva.Circle({
        id: `board-stop-badge-${pt.station.id}`,
        x: pt.x + badgeR + 1,
        y: pt.y - badgeR + 1,
        radius: 6,
        fill: boardStop.fill,
        stroke: '#020617',
        strokeWidth: 1.5,
        listening: false,
      }))
      stationLayer.add(new Konva.Text({
        id: `board-stop-badge-text-${pt.station.id}`,
        x: pt.x + badgeR - 4,
        y: pt.y - badgeR - 4,
        text: boardStop.text,
        fontSize: 8,
        fontFamily: 'system-ui, sans-serif',
        fontStyle: 'bold',
        fill: '#020617',
        width: 10,
        align: 'center',
        listening: false,
      }))
    }
  }

  // Dedicated selection highlight ring
  selectionRing = new Konva.Circle({
    radius: m.stationRadius + 6,
    stroke: '#22d3ee',
    strokeWidth: 2.5,
    listening: false,
    visible: false,
  })
  stationLayer.add(selectionRing)

  updateSelectionVisual()

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

  // Push the first row below the floating toolbar. max() keeps this from
  // shrinking the inset on desktop, where the controls are hidden (0).
  // fitWidth is folded-only: linear mode returns early via focusKeyStation.
  const topInset = Math.max(m.fitTopMargin, toolbarInsetTop())

  stage.scale({ x: scale, y: scale })
  stage.position({
    x: (viewW - box.w * scale) / 2 - box.minX * scale,
    y: topInset - box.minY * scale,
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

  // The floating toolbar only overlaps the top of a folded (serpentine) board.
  // Linear mode's single row is centred vertically, well clear of it, so it
  // keeps the plain margin and its behaviour is untouched.
  const topInset = layoutMode.value === 'folded'
    ? Math.max(m.fitTopMargin, toolbarInsetTop())
    : m.fitTopMargin

  const scale = clampScale(
    Math.min(
      (viewW - m.fitPadding * 2) / box.w,
      (viewH - topInset - m.fitPadding) / box.h,
    ),
  )

  stage.scale({ x: scale, y: scale })
  stage.position({
    x: (viewW - box.w * scale) / 2 - box.minX * scale,
    y: layoutMode.value === 'linear'
      ? (viewH - box.h * scale) / 2 - box.minY * scale
      : topInset - box.minY * scale,
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

/**
 * Vertical space the floating mobile controls occupy inside the canvas box, or
 * 0 when they are hidden (desktop). Measured from the live DOM rather than
 * hardcoded, so the inset cannot drift from the `md:` visibility classes.
 */
function toolbarInsetTop(): number {
  const els = [mobileModePillRef.value, mobileFabTriggerRef.value].filter(Boolean) as HTMLElement[]
  if (els.length === 0) return 0
  const containerTop = containerRef.value?.getBoundingClientRect().top ?? 0
  let inset = 0
  for (const el of els) {
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue // display:none on desktop
    // Distance from the canvas top down to this overlay's lower edge.
    inset = Math.max(inset, rect.bottom - containerTop)
  }
  return inset > 0 ? inset + TOOLBAR_GAP : 0
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

function getStationAnchor(stationId: string): StationAnchor | null {
  if (!stage || !currentLayout) return null
  const pt = currentLayout.points.find(p => p.station.id === stationId)
  if (!pt) return null
  const scale = stage.scaleX()
  const m = boardMetrics()

  const stageBox = stage.container().getBoundingClientRect()
  const screenX = stageBox.left + stage.x() + pt.x * scale
  const screenY = stageBox.top + stage.y() + pt.y * scale

  // Visual station radius in screen pixels (outer edge of selection ring)
  const radius = (m.stationRadius + 7.25) * scale

  const container = containerRef.value
  const root = container?.parentElement
  const offsetX = (container && root) ? (container.getBoundingClientRect().left - root.getBoundingClientRect().left) : 0
  const offsetY = (container && root) ? (container.getBoundingClientRect().top - root.getBoundingClientRect().top) : 0

  return {
    screenX,
    screenY,
    radius,
    x: stage.x() + pt.x * scale + offsetX,
    y: stage.y() + pt.y * scale + offsetY,
  }
}

function notifyAnchorChange(): void {
  if (selectedStation) {
    const anchor = getStationAnchor(selectedStation.id)
    if (anchor) {
      emit('station-anchor-change', anchor)
    }
  }
}

defineExpose({
  layoutMode,
  setLayoutMode,
  toggleLayoutMode,
  fitWidth,
  fitToViewport,
  focusKeyStation,
  getStationAnchor,
})

function handleVisibilityChange(): void {
  if (document.hidden) {
    if (anim?.isRunning()) anim.stop()
  }
  else {
    if (anim && !anim.isRunning()) anim.start()
  }
}

function updateSelectionVisual(): void {
  if (!stage || !stationLayer || !currentLayout) return

  const m = boardMetrics()
  const selId = selectedStation?.id

  // 1. Position & toggle the selection ring without destroying nodes
  if (selectionRing) {
    if (selId) {
      const pt = currentLayout.points.find(p => p.station.id === selId)
      if (pt) {
        selectionRing.position({ x: pt.x, y: pt.y })
        selectionRing.radius(m.stationRadius + 6)
        selectionRing.visible(true)
        selectionRing.moveToTop()
      }
      else {
        selectionRing.visible(false)
      }
    }
    else {
      selectionRing.visible(false)
    }
  }

  // 2. Refresh node fills and labels
  for (const pt of currentLayout.points) {
    const isNearest = nearestStation && nearestStation.id === pt.station.id
    const isSelected = selId === pt.station.id
    const visualCircle = stationLayer.findOne<Konva.Circle>(`#station-visual-${pt.station.id}`)
    if (visualCircle) {
      visualCircle.fill(isNearest ? '#facc15' : isSelected ? '#22d3ee' : '#cbd5e1')
    }
    const label = stationLayer.findOne<Konva.Text>(`#station-label-${pt.station.id}`)
    if (label) {
      label.fill(isNearest ? '#fde047' : isSelected ? '#67e8f9' : '#94a3b8')
    }
  }

  stationLayer.batchDraw()
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
    // A station can be selected before the board lays out (the GPS-nearest stop
    // is set as soon as the fix and the line detail both exist, either order).
    // Re-emit now that currentLayout exists, otherwise the popover anchor stays
    // null and the popover never opens.
    if (selectedStation) notifyAnchorChange()
  },
)

watch(
  () => selectedStation?.id,
  () => {
    updateSelectionVisual()
    notifyAnchorChange()
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
    // The nearest-stop marker is applied in two places: the static render (which
    // may run before a fix exists) and updateSelectionVisual. Refresh the fills
    // here too, otherwise a fix arriving after the board laid out would move the
    // ripple but leave the stop unmarked.
    updateSelectionVisual()
    renderRipple()
    dynamicLayer?.batchDraw()
  },
  // The board's layout is built in renderStaticBoard, which runs after this
  // watcher can first fire (the store already holds a fix when the view mounts),
  // so defer to post-flush to observe the layout the render just produced.
  { flush: 'post' },
)

// Board-stop markers live on the static layer and depend on which stops are
// set, so a change (or a different direction's detail) needs a redraw.
watch(
  () => [morningStopName, eveningStopName, lineDetail.lineId, lineDetail.direction].join('|'),
  () => {
    renderStaticBoard()
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
    <!-- Desktop Top HUD / Legend bar (md: and up) -->
    <div class="hidden md:flex shrink-0 items-center justify-between gap-2 border-b border-slate-800/80 bg-slate-900/60 px-4 py-2 text-xs backdrop-blur-md">
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
        <UiTooltip :content="layoutMode === 'linear' ? '聚焦当前关注站' : '按画布宽度撑开，纵向拖动查看'">
          <button
            class="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
            @click="handleFitWidth"
          >
            <MoveHorizontal class="h-3.5 w-3.5 text-cyan-400" />
            <span>{{ layoutMode === 'linear' ? '聚焦站点' : '适应宽度' }}</span>
          </button>
        </UiTooltip>
        <UiTooltip content="缩小到整条线路全部可见">
          <button
            class="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
            @click="handleFitScreen"
          >
            <Expand class="h-3.5 w-3.5 text-cyan-400" />
            <span>适应屏幕</span>
          </button>
        </UiTooltip>
        <UiTooltip content="放大画布">
          <button
            class="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
            aria-label="放大画布"
            @click="zoomIn"
          >
            <Plus class="h-3.5 w-3.5" />
          </button>
        </UiTooltip>
        <UiTooltip content="缩小画布">
          <button
            class="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-700 active:scale-95"
            aria-label="缩小画布"
            @click="zoomOut"
          >
            <Minus class="h-3.5 w-3.5" />
          </button>
        </UiTooltip>
      </div>
    </div>

    <!-- Mobile Floating Controls (screens < md) -->
    <!-- Mode pill badge: tap to toggle layout instantly on mobile -->
    <div
      ref="mobileModePillEl"
      class="md:hidden absolute left-2.5 top-2.5 z-10 flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-900/85 px-2.5 py-1 text-xs text-slate-300 backdrop-blur-md shadow-md"
    >
      <button
        type="button"
        class="flex items-center gap-1 text-slate-300 active:scale-95"
        @click="toggleLayoutMode"
      >
        <component :is="layoutMode === 'folded' ? WrapText : GitCommitHorizontal" class="h-3.5 w-3.5 text-cyan-400" />
        <span class="font-medium text-slate-200">{{ layoutMode === 'folded' ? '折返' : '直线' }}</span>
      </button>
      <span class="text-slate-500">|</span>
      <span class="flex items-center gap-1 text-slate-300">
        <span class="inline-block h-2 w-2 rounded-full bg-amber-400"></span>
        定位
      </span>
    </div>

    <!-- Mobile Right FAB Action Buttons: Collapsible to save visual area on mobile (default collapsed) -->
    <div class="md:hidden absolute right-2.5 top-2.5 z-10 flex flex-col items-end gap-1.5">
      <!-- Toggle Trigger Button -->
      <button
        ref="mobileFabTriggerEl"
        type="button"
        class="flex h-9 w-9 items-center justify-center rounded-xl border text-xs shadow-lg backdrop-blur-md transition active:scale-95"
        :class="mobileToolsOpen
          ? 'border-cyan-500/50 bg-slate-800 text-cyan-400'
          : 'border-slate-700/80 bg-slate-900/90 text-slate-300 hover:text-white'"
        :aria-label="mobileToolsOpen ? '收起线路工具' : '展开线路工具'"
        :title="mobileToolsOpen ? '收起线路工具' : '展开线路工具'"
        @click="mobileToolsOpen = !mobileToolsOpen"
      >
        <SlidersHorizontal v-if="!mobileToolsOpen" class="h-4 w-4" />
        <X v-else class="h-4 w-4" />
      </button>

      <!-- Expandable Tool List -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-2 scale-95"
        enter-to-class="opacity-100 translate-y-0 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0 scale-100"
        leave-to-class="opacity-0 -translate-y-2 scale-95"
      >
        <div v-if="mobileToolsOpen" class="flex flex-col gap-1.5">
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
            class="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/90 text-xs text-slate-200 shadow-lg backdrop-blur-md active:scale-95"
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
      </Transition>
    </div>

    <!-- Canvas Container -->
    <div
      ref="containerEl"
      class="min-h-0 w-full flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
    ></div>
  </div>
</template>
