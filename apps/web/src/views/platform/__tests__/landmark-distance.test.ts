import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { statedDistanceSuffix } from '../landmark-distance'

/**
 * The radar's distance, on the one surface that renders it: the landmark hint
 * under the platform board's GPS button.
 *
 * The value comes from `NearbyStationResult.distanceMeters`, which the wire makes
 * optional because Amap leaves the field out for a POI it did not measure. That
 * absence is NOT a distance of zero — 「0m」 claims the user is standing on the
 * platform — and it is not a number this screen may invent either: the view's own
 * `Math.round(...)` printed 「NaNm」 for it. So the hint renders the distance when
 * the radar stated one (a stated 0 included: that IS a measurement) and renders
 * nothing where the field is absent. What the number means is decided upstream in
 * `statedNumber`; what this file pins is that the screen never states a distance
 * nobody measured, and never substitutes one.
 */

describe('the hint states the distance only where the radar stated one', () => {
  it('renders the distance the radar stated', () => {
    expect(statedDistanceSuffix(120)).toBe('（120m）')
    expect(statedDistanceSuffix(853.6)).toBe('（854m）')
  })

  it('keeps a stated zero, which is a measurement and not the absence', () => {
    // A POI on the measured point is genuinely 0 m away. Reading that as 「no
    // distance」 would erase a real reading, exactly as inventing a 0 for an
    // absent field would.
    expect(statedDistanceSuffix(0)).toBe('（0m）')
  })

  it('renders no distance at all where the radar never stated one', () => {
    const absent = statedDistanceSuffix(undefined)
    expect(absent).toBe('')
    // The failure this replaces, named: the old expression printed 「（NaNm）」,
    // and a 「0m」 would be the same class of claim — a number nobody measured.
    expect(absent).not.toContain('NaN')
    expect(absent).not.toContain('0')
  })

  it('renders no distance for a value no radar could have measured', () => {
    // A non-finite value is the same absence: it is not a distance, and printing
    // it would put a number on screen that measures nothing.
    expect(statedDistanceSuffix(Number.NaN)).toBe('')
    expect(statedDistanceSuffix(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('the platform view reads the distance through the one rule', () => {
  const view = readFileSync(
    fileURLToPath(new URL('../index.vue', import.meta.url)),
    'utf8',
  )

  it('never rounds a distance the radar may not have stated', () => {
    // `Math.round(nearestPoi.distanceMeters)` is the expression that turned an
    // absent field into 「NaNm」 on the hint.
    expect(view, 'the view rounds a distance that may be absent')
      .not.toMatch(/Math\.round\(\s*nearestPoi\.distanceMeters/)
    expect(view, 'the view does not route the distance through the shared rule')
      .toContain('statedDistanceSuffix(')
  })

  it('renders the distance on both hint branches, and invents none elsewhere', () => {
    // Both branches that name a platform carry its stated distance; the 「no
    // platform in range」 branch has no distance to state at all. The pin is the
    // rendered copy, so a branch that keeps its own number expression is visible
    // here rather than only in the browser.
    expect(view.match(/statedDistanceSuffix\(/g)).toHaveLength(1)
    expect(view).toContain('`GPS 已对准 ${matched}${distance}`')
    expect(view).toContain('`最近站台 ${nearestPoi.name}${distance}，不在关注线路中`')
    expect(view).toContain('周边 800m 未检索到站台')
  })
})
