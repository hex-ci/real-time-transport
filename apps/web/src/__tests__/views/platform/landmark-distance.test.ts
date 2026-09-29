import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { statedDistanceSuffix } from '../landmark-distance'

/**
 * 雷达的距离，在渲染它的唯一表面上：站台屏 GPS 按钮下的地标提示。
 *
 * 该值来自 `NearbyStationResult.distanceMeters`，线上把它设为可选，因为高德对未测量的 POI 会省掉该字段。
 * 该缺失**不是**距离零——「0m」声称用户正站在站台上——也不是本屏可以捏造的数字：视图自己的
 * `Math.round(...)` 为它印出「NaNm」。故雷达陈述了距离时提示渲染它（陈述的 0 也包括，那确实是测量），
 * 字段缺失时什么都不渲染。数字的含义在上游 `statedNumber` 中决定；本文件钉的是该屏绝不陈述没人测量过的
 * 距离，也绝不用别的替代。
 */

describe('the hint states the distance only where the radar stated one', () => {
  it('renders the distance the radar stated', () => {
    expect(statedDistanceSuffix(120)).toBe('（120m）')
    expect(statedDistanceSuffix(853.6)).toBe('（854m）')
  })

  it('keeps a stated zero, which is a measurement and not the absence', () => {
    // 位于被测点上的 POI 真的是 0 m。把它读成「无距离」会抹掉一个真实读数，
    // 正如为缺失字段捏造 0 一样。
    expect(statedDistanceSuffix(0)).toBe('（0m）')
  })

  it('renders no distance at all where the radar never stated one', () => {
    const absent = statedDistanceSuffix(undefined)
    expect(absent).toBe('')
    // 本实现所替代的失败，点名于此：旧表达式印出「（NaNm）」，而「0m」会是同一类断言——一个没人测量过的数字。
    expect(absent).not.toContain('NaN')
    expect(absent).not.toContain('0')
  })

  it('renders no distance for a value no radar could have measured', () => {
    // 非有限值与缺失同义：它不是距离，印出它会把一个不测量任何东西的数字放上屏幕。
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
    // `Math.round(nearestPoi.distanceMeters)` 正是把缺失字段变成提示上「NaNm」的表达式。
    expect(view, 'the view rounds a distance that may be absent')
      .not.toMatch(/Math\.round\(\s*nearestPoi\.distanceMeters/)
    expect(view, 'the view does not route the distance through the shared rule')
      .toContain('statedDistanceSuffix(')
  })

  it('renders the distance on both hint branches, and invents none elsewhere', () => {
    // 两个点名站台的分支都携带其陈述的距离；「范围内无站台」分支根本没有距离可陈述。
    // 此处钉的是渲染文案，故保留自己数字表达式的分支在此可见而非只在浏览器里。
    expect(view.match(/statedDistanceSuffix\(/g)).toHaveLength(1)
    expect(view).toContain('`GPS 已对准 ${matched}${distance}`')
    expect(view).toContain('`最近站台 ${nearestPoi.name}${distance}，不在关注线路中`')
    expect(view).toContain('周边 800m 未检索到站台')
  })
})
