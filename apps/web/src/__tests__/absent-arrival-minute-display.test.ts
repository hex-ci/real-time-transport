import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { statedArrivalMinutes } from '@real-time-transport/shared'
import type { ArrivalRow } from '@real-time-transport/shared'
import { ARRIVAL_MINUTE_UNAVAILABLE_TEXT } from '../arrival-copy'

/**
 * 列出到站的每个界面都必须渲染「无到站耗时」，绝不显示分钟数。
 *
 * 服务端对无法估价的车辆只下发顺序中的位置，不含 `etaSeconds`。三个界面列出到站：
 * 线路面板的后续进站计划、总览卡片的到站行、站台屏的预计到站列，它们共用
 * `@/arrival-copy` 里的同一个 token，不能各自造句。
 *
 * 这些组件只跑在浏览器（无 jsdom、无 @vue/test-utils），故按 SFC 源码断言。
 */

function sfc(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

function templateOf(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

const popover = sfc('../views/line-detail/components/station-popover.vue')
const card = sfc('../views/overview/components/line-mini-card.vue')
const board = sfc('../views/platform/components/departure-board.vue')
const linePage = sfc('../views/line-detail/index.vue')

describe('the unknown-arrival token is one token', () => {
  it('is the platform board\'s own wording, and contains no digit', () => {
    expect(ARRIVAL_MINUTE_UNAVAILABLE_TEXT).toBe('暂无到站耗时')
    // token 里出现数字会被读成旁边的分钟数。
    expect(ARRIVAL_MINUTE_UNAVAILABLE_TEXT).not.toMatch(/\d/)
  })

  it('is the constant every arrivals surface renders, the board included', () => {
    // 同一行同一状态在多个界面呈现，措辞必须唯一：只此一处常量，不逐文件重复字面量。
    expect(templateOf(board)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    expect(templateOf(popover)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    expect(templateOf(card)).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
  })
})

describe('no arrivals surface prices a minute for a row that states none', () => {
  it('the line panel renders the absence and guards its minute on the helper', () => {
    const template = templateOf(popover)
    // 分钟取自 helper，绝不对可能缺失的字段做原始算术。
    expect(template).toContain('statedArrivalMinutes(a)')
    expect(template, 'the panel still rounds etaSeconds itself, which is undefined for this row')
      .not.toContain('Math.round(a.etaSeconds / 60)')
    expect(template).toMatch(/ARRIVAL_MINUTE_UNAVAILABLE_TEXT/)
    // helper 为面板正在绘制的行作答。
    const absent: ArrivalRow = { stopsAway: 2, busId: 'b1' }
    expect(statedArrivalMinutes(absent)).toBeNull()
    const present: ArrivalRow = { time: '14:07', etaSeconds: 420 }
    expect(statedArrivalMinutes(present)).toBe(7)
  })

  it('the overview card renders the absence on its leading and subsequent rows', () => {
    const template = templateOf(card)
    expect(template, 'the card still rounds etaSeconds itself for a subsequent row')
      .not.toContain('Math.round(a.etaSeconds / 60)')
    expect(template).toContain('statedArrivalMinutes(a)')
    // 首行保留自己的「无分钟」分支，且必须排在 operating-state 兜底（声称无车在范围内）之前。
    const numbered = template.indexOf('minutesOf(primaryArrivals) !== null')
    const absence = template.indexOf('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
    const operating = template.indexOf('primaryOperatingText', numbered)
    expect(numbered, 'the card lost its numbered branch').toBeGreaterThan(-1)
    expect(absence, 'the card has no branch for a row that states no minute').toBeGreaterThan(numbered)
    expect(absence, 'the absence falls through to the operating fact, which claims no vehicle is in range')
      .toBeLessThan(operating)
  })

  it('reads the row the wire serves, so the token is what the screen shows', () => {
    // 服务端对无法估价的车辆下发的行：仍上报顺序中的位置，但没有分钟数。
    const row: ArrivalRow = { stopsAway: 3, distanceMeters: 1200, busId: 'b1' }
    expect(statedArrivalMinutes(row)).toBeNull()
    expect(JSON.stringify(row), 'a minute-shaped number is hiding in the row').not.toMatch(/\d{2}:\d{2}/)
  })
})

/**
 * 线路页面自己的头条：与列表行出于同一理由显示「无到站耗时」。
 */
describe('the line page states the absence instead of a bus minute of its own', () => {
  it('no longer prices a minute from the vehicle\'s position', () => {
    expect(linePage, 'the page still imports the deleted position estimate')
      .not.toContain('estimatePositionArrivalSeconds')
    expect(linePage, 'the page still computes a position/dwell minute inline')
      .not.toContain('remainingMeters / speed')
  })

  it('states the same absence token the arrivals list renders', () => {
    expect(linePage).toContain('ARRIVAL_MINUTE_UNAVAILABLE_TEXT')
  })
})
