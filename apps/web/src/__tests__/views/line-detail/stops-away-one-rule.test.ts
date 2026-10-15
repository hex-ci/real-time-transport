import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stopsTagTextOf, stopsTextOf } from '../../../views/line-detail/stops-text'

/**
 * 「到目标站还有几站」只有一条规则（`packages/shared` 的 `stopsAwayOf`），说法也只有一份
 * （`views/line-detail/stops-text.ts`）。
 *
 * 这个数有两条路径：服务端组装的到站行，与前端在到站答案回来之前的回退分支。两处各写一份时，
 * 同一个距离会在两条路径上差一站 —— 使用者看到的是「同一个站一会儿 2 站一会儿 1 站」。
 * 面板在本仓库只跑在浏览器，故这里按**源码**钉住调用点，按模块钉住说法。
 */
const view = readFileSync(
  fileURLToPath(new URL('../../../views/line-detail/index.vue', import.meta.url)),
  'utf8',
)

const popover = readFileSync(
  fileURLToPath(new URL('../../../views/line-detail/components/station-popover.vue', import.meta.url)),
  'utf8',
)

const service = readFileSync(
  fileURLToPath(new URL('../../../../../../apps/server/src/services/transit.service.ts', import.meta.url)),
  'utf8',
)

describe('到目标站还有几站：一条规则，两条路径', () => {
  it('服务端与前端回退都调 stopsAwayOf', () => {
    expect(view).toContain('stopsAwayOf(')
    expect(service).toContain('stopsAwayOf(')
  })

  it('说法只此一份：0 站说「即将到站」，隔站才报数字', () => {
    expect(stopsTextOf(0)).toBe('即将到站')
    expect(stopsTextOf(1)).toBe('距本站 1 站')
    expect(stopsTextOf(2)).toBe('距本站 2 站')
    expect(stopsTextOf(undefined)).toBe('')
    // 列表里的紧凑说法同一个口径，只是没有「距本站」那三个字。
    expect(stopsTagTextOf(0)).toBe('即将到站')
    expect(stopsTagTextOf(2)).toBe('(2站)')
    expect(stopsTagTextOf(undefined)).toBeNull()
  })

  it('三处渲染都取自那个模块，页面里不再有第二份说法', () => {
    expect(view).toContain('stopsTextOf(')
    expect(popover).toContain('stopsTagTextOf(')
    expect(view).not.toContain('即将到站')
    expect(view).not.toContain('距本站')
    expect(popover).not.toContain('即将到站')
  })

  it('回退分支挑的是最近的那一辆（站序最大），不是最远的那辆', () => {
    // 曾按站序升序取第一辆 —— 那是离本站最远的一辆，服务端报「最近 2 站」而回退报「9 站」。
    const sortLine = view.slice(view.indexOf('const upcoming = allBuses'), view.indexOf('const bus = upcoming[0]!'))
    expect(sortLine).toMatch(/sort\(\(a, b\) => \(\(b\.nextOrder/)
  })
})
