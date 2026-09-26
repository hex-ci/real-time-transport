import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AT_PLATFORM_ETA_TEXT } from '../at-platform'

/**
 * 显示侧的 F-A 与 F-C。
 *
 * F-A：上游对停在站的车辆说 `travelTime 0`，服务端现在把它路由到 at-platform 行
 * （`isAtStation`、`time: '正在进站'`、`etaSeconds: 0`）。面板必须陈述事实且**不**给分钟——
 * 「车辆正在本站」是对车所在位置的观测，旁边印一个分钟就是本应用的算术装扮成来源的读数。
 * 面板在本仓库只跑在浏览器（无 jsdom、无 @vue/test-utils），故措辞按模块断言、渲染按 SFC 源码断言。
 *
 * F-C：精确时刻表对当日末班（半程）的说明随到站答案传递，并渲染在那些末班所在处。
 */

const popover = readFileSync(
  fileURLToPath(new URL('../components/station-popover.vue', import.meta.url)),
  'utf8',
)

const view = readFileSync(fileURLToPath(new URL('../index.vue', import.meta.url)), 'utf8')

function templateOf(sfc: string): string {
  const start = sfc.indexOf('<template>')
  const end = sfc.lastIndexOf('</template>')
  return start >= 0 && end > start ? sfc.slice(start, end) : ''
}

describe('F-A: the at-platform state is a statement, not a number', () => {
  it('words the state with no minute in it', () => {
    expect(AT_PLATFORM_ETA_TEXT).toBe('车辆正在本站 (即将发车)')
    // 无数字：这句话旁的数字会是本应用对一辆来源已报告在场的车辆的估价。
    expect(AT_PLATFORM_ETA_TEXT).not.toMatch(/\d/)
  })

  it('is the ONE wording, chosen by the module rather than typed into the view', () => {
    // 同一句话曾站在本视图的三个分支里；能在三处漂移的措辞就是一个事实变成三种读数的路径。
    expect(view).not.toContain('车辆正在本站')
    expect(view).toContain('AT_PLATFORM_ETA_TEXT')
  })

  it('answers a row that is at the platform BEFORE any minute arithmetic', () => {
    const branch = view.indexOf('if (next.isAtStation)')
    // 分钟现在来自 `statedArrivalMinutes`，它对未陈述分钟的行答 `null`——
    // 这使得缺失成为一种状态。钉在此处使 at-platform 的顺序继续对真实表达式断言。
    const minuteMath = view.indexOf('statedArrivalMinutes(next)')
    expect(branch, 'the arrivals branch no longer checks isAtStation').toBeGreaterThan(-1)
    expect(minuteMath, 'the arrivals minute is no longer computed there').toBeGreaterThan(-1)
    expect(branch, 'the minute is computed before the at-platform state is answered').toBeLessThan(minuteMath)
    expect(view.slice(branch, minuteMath)).toContain('AT_PLATFORM_ETA_TEXT')
  })

  it('renders no per-row minute for a row the server marked at the platform', () => {
    const template = templateOf(popover)
    // 分钟现在来自 `statedArrivalMinutes`，它对未陈述分钟的行答 `null`——故守卫在**答案**上而非
    // 裸字段上，没有分钟的行渲染缺失而非 `undefined分`。
    const minuteSpan = /<span[^>]*>\s*\{\{\s*statedArrivalMinutes\(a\)\s*\}\}分\s*<\/span>/
    const match = minuteSpan.exec(template)
    expect(match, 'the panel no longer renders a per-row minute at all').not.toBeNull()
    expect(match![0], 'the row minute is not guarded by isAtStation').toContain('v-if="!a.isAtStation"')
    // 整个分支由「该行是否陈述了分钟」守卫，其中的 at-platform 观测先于任何数字。
    const guard = template.indexOf('statedArrivalMinutes(a) !== null')
    expect(guard, 'the panel no longer distinguishes a row with no minute').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(template.indexOf('{{ a.time }}'))
  })
})

describe('F-C: the table\'s own caveat is rendered with the departures', () => {
  it('renders the note the answer carries', () => {
    const template = templateOf(popover)
    expect(template).toContain('{{ arrivals.note }}')
  })

  it('renders it OUTSIDE the departures list, so an empty list still states it', () => {
    // 末班走后列表是空的——而那正是该说明要紧的时段（末班车可能不走完全程）。
    // 故该说明元素是列表自己的兄弟而非其子。
    const template = templateOf(popover)
    const listOpen = template.indexOf('v-if="arrivals && arrivals.arrivals.length > 0"')
    expect(listOpen, 'the departures list is no longer guarded by its own v-if').toBeGreaterThan(-1)
    const listEnd = endOfElement(template, listOpen)
    const note = template.indexOf('{{ arrivals.note }}')
    expect(listEnd).toBeGreaterThan(listOpen)
    expect(note, 'the note is inside the list block, so it vanishes when nothing is left to list')
      .toBeGreaterThan(listEnd)
  })

  it('guards the note on the note alone, not on the list having rows', () => {
    const template = templateOf(popover)
    const noteTag = /<p\b[^>]*data-arrivals-note[^>]*>/.exec(template)
    expect(noteTag, 'the note is no longer rendered as its own element').not.toBeNull()
    expect(noteTag![0]).toContain('v-if="arrivals?.note"')
    expect(noteTag![0]).not.toContain('arrivals.arrivals.length')
  })

  it('words nothing itself: the sentence is the table\'s', () => {
    // 该说明是上游自己的提示文本；在此写前缀会让本应用成为一个它只是携带的断言的作者。
    const template = templateOf(popover)
    expect(template).not.toContain('末班说明')
    expect(template).not.toContain('半程')
  })

  it('receives the note through the feed type the view passes down', () => {
    expect(view).toContain('note?: string | null')
    expect(popover).toContain('note?: string | null')
  })
})

/** 从 `from` 处打开的元素之后的下一个索引（其配对的 </div>），或 -1。 */
function endOfElement(template: string, from: number): number {
  const openTagEnd = template.indexOf('>', from)
  if (openTagEnd < 0) return -1
  let depth = 1
  const tag = /<div\b|<\/div>/g
  tag.lastIndex = openTagEnd
  let m: RegExpExecArray | null
  while ((m = tag.exec(template)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) return m.index + '</div>'.length
  }
  return -1
}
