import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * F4's mark, as text.
 *
 * The wording is pure logic, so it is tested here rather than left to a browser
 * pass (this app has no DOM test harness). Two things matter. First, the mark
 * answers 「这个数字是哪来的」 and the four answers must not read alike. Second —
 * the trap this feature exists to close — an arrival whose provenance is unknown
 * gets NO mark, never the flattering one: 「没有来源」 and 「实时」 are different
 * facts, and the difference is invisible to the user otherwise.
 */

describe('the mark names the kind of number, not the vendor behind it', () => {
  it('renders the plan\'s three marks, plus the one the live bus path needs', () => {
    // 实时 / 排班推演 / 精确时刻表 are the sanctioned three from the PRD. A bus
    // minute this app computes from a real position and a real speed is neither a
    // value upstream sent (so not 实时) nor derived from a schedule (so not
    // 排班推演); labelling it either way would be a false claim about the number.
    expect(provenanceLabelOf('live')).toBe('实时')
    expect(provenanceLabelOf('schedule_simulation')).toBe('排班推演')
    expect(provenanceLabelOf('exact_timetable')).toBe('精确时刻表')
    expect(provenanceLabelOf('position_estimate')).toBe('位置推算')
  })

  it('shows nothing — never 实时 — when the provenance is not stated', () => {
    expect(provenanceLabelOf(null)).toBeNull()
    expect(provenanceLabelOf(undefined)).toBeNull()
    // The guard, stated as a rule: nothing unknown may render as 实时.
    for (const unknown of [null, undefined]) {
      expect(provenanceLabelOf(unknown)).not.toBe('实时')
    }
  })

  it('reads every kind differently, so no two can be confused', () => {
    const labels = (['live', 'position_estimate', 'schedule_simulation', 'exact_timetable'] as const)
      .map(p => provenanceLabelOf(p))
    expect(labels.every(l => typeof l === 'string' && l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('does not let the timetable engine\'s output read as live data', () => {
    // The subway board's rows are generated trains: this is the one confusion F4
    // is written to prevent.
    expect(provenanceLabelOf('schedule_simulation')).not.toBe(provenanceLabelOf('live'))
  })
})

describe('the marks name no source and carry no marketing register', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** Everything between the SFC's own <template> tags: what reaches the screen. */
  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  /**
   * The string literals of an SFC's <script> blocks.
   *
   * Rendered copy is not only in the template: a literal a script returns or binds
   * reaches the screen too — the platform board's row status begins as the string
   * '离线', and a badge word returned from a `computed` is exactly such a literal.
   * Scanning only `<template>` left all of those unguarded.
   */
  function scriptLiteralsOf(sfc: string): string {
    const literals: string[] = []
    for (const match of sfc.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      literals.push(literalsOf(match[1] ?? ''))
    }
    return literals.join('\n')
  }

  /**
   * The file with its explanatory prose removed, so a rule about CODE is not
   * tripped by a comment that names the very thing it explains was removed.
   * `//` is only stripped when it does not follow a colon, so a string literal
   * holding a URL (`ws://`, `https://`) survives and stays scannable.
   */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  /**
   * The string literals of a `.ts` copy module — its `return`s are the marks the
   * user reads, so those literals ARE the rendered content of such a file. A
   * `templateOf` on a `.ts` file answers `''`, which is why this guard used to
   * scan nothing at all for the two copy modules and stayed green with a vendor
   * name sitting in a rendered string.
   */
  function literalsOf(source: string): string {
    const literals: string[] = []
    for (const match of codeOf(source).matchAll(/(['"`])(?:\\.|(?!\1)[^\\\r\n])*\1/g)) {
      literals.push(match[0])
    }
    return literals.join('\n')
  }

  const files = {
    'provenance-copy.ts': read('../provenance-copy.ts'),
    'operating-copy.ts': read('../operating-copy.ts'),
    'stores/transit.store.ts': read('../stores/transit.store.ts'),
    'overview/index.vue': read('../views/overview/index.vue'),
    'overview/components/line-mini-card.vue': read('../views/overview/components/line-mini-card.vue'),
    'line-detail/index.vue': read('../views/line-detail/index.vue'),
    'line-detail/components/line-hero.vue': read('../views/line-detail/components/line-hero.vue'),
    'line-detail/components/station-popover.vue': read('../views/line-detail/components/station-popover.vue'),
    'line-detail/components/line-load-state.vue': read('../views/line-detail/components/line-load-state.vue'),
    'platform/index.vue': read('../views/platform/index.vue'),
    'platform/departure-row.ts': read('../views/platform/departure-row.ts'),
    'platform/components/departure-board.vue': read('../views/platform/components/departure-board.vue'),
    'platform/components/platform-header.vue': read('../views/platform/components/platform-header.vue'),
    'components/header-nav/main.vue': read('../components/header-nav/main.vue'),
  }

  /**
   * What a file can put on the user's screen. An SFC contributes its `<template>`
   * and its `<script>` string literals; a `.ts` copy module contributes its string
   * literals, which are the whole of what it returns. Comments are excluded in both
   * cases — the prose explaining that a vendor name was removed must not be read as
   * that vendor name.
   */
  function renderedOf(name: string, source: string): string {
    if (name.endsWith('.ts')) return literalsOf(source)
    // Comments are stripped from both halves: rendered copy is what reaches the
    // screen, and an HTML comment does not.
    return `${codeOf(templateOf(source))}\n${scriptLiteralsOf(source)}`
  }

  const rendered = Object.fromEntries(
    Object.entries(files).map(([name, source]) => [name, renderedOf(name, source)]),
  )

  /**
   * Vendor and internal-identifier tokens. Checked against what each file renders
   * — an SFC's template, a `.ts` copy module's string literals — rather than the
   * whole file: a `<script>` comment may legitimately name the provider the code
   * integrates. Non-literal code (identifiers, imports) is not rendered either.
   */
  const FORBIDDEN_TOKENS = ['车来了', '高德', '极数本源', 'chelaile', 'apizero', 'subway_schedule', '接口']

  it('renders no vendor name and no internal identifier', () => {
    for (const [name, source] of Object.entries(rendered)) {
      for (const token of FORBIDDEN_TOKENS) {
        expect(source.toLowerCase(), `${name} leaks ${token}`).not.toContain(token.toLowerCase())
      }
    }
  })

  /**
   * Transport mechanisms. The user reads a connection STATE, never the plumbing
   * behind it: 「实时 WebSocket 已连接」 and 「LIVE WS」 put the mechanism itself on a
   * mobile-first screen, where the only fact worth stating is whether the live feed
   * is connected. Matched against the rendered strings, so the `wsConnected`
   * identifier the state is read from is not mistaken for rendered copy.
   */
  const TRANSPORT_MECHANISMS = [/websocket/i, /wss?:\/\//i, /\bWS\b/]

  it('names no transport mechanism in what it renders', () => {
    for (const [name, source] of Object.entries(rendered)) {
      for (const pattern of TRANSPORT_MECHANISMS) {
        expect(source, `${name} names a transport mechanism (${pattern})`).not.toMatch(pattern)
      }
    }
  })

  it('drops the copy that described an internal mechanism or a source', () => {
    // 上游 / 秒级推演 described the plumbing; 「官方」 was a claim the marks now
    // carry in the only form this data can substantiate (精确时刻表).
    for (const [name, source] of Object.entries(files)) {
      for (const retired of ['上游', '秒级', '官方排班推演', '官方时刻', '推演排班']) {
        expect(source, `${name} still says ${retired}`).not.toContain(retired)
      }
    }
  })

  it('carries the provenance marks where the numbers are', () => {
    expect(files['line-detail/components/line-hero.vue']).toContain('provenanceLabelOf')
    expect(files['line-detail/components/station-popover.vue']).toContain('provenanceLabelOf')
    expect(files['overview/components/line-mini-card.vue']).toContain('provenanceLabelOf')
  })

  it('marks each platform row from its own provenance, and words no mark itself', () => {
    // The board is a row per line/direction, so every row states its own kind —
    // there is no single list for one word to describe.
    expect(files['platform/components/departure-board.vue']).toContain('provenanceLabelOf')
    // The kind is read off the source the payload declared, at the branch that
    // produced the row — the platform view computes no minute of its own, and the
    // row builder (which now owns those branches) is where the source is applied.
    expect(files['platform/index.vue']).toContain('dataSource')
    expect(files['platform/departure-row.ts']).toContain('platformRowProvenanceOf(')
    expect(files['platform/departure-row.ts']).toContain('dataSource')
    // A mark word written into a template would bypass provenance-copy.ts, the one
    // place a kind becomes words; 实时 in particular must never be hard-coded.
    const boardTemplate = rendered['platform/components/departure-board.vue']!
    for (const word of ['实时', '位置推算', '排班推演', '精确时刻表']) {
      expect(boardTemplate, `the board template states ${word} itself`).not.toContain(word)
    }
  })

  it('decides no mark from the route type or from a component\'s own position', () => {
    // Provenance comes from the payload. The hero used to guess it from the route
    // type, which is right only until the aggregator fails over to a source that
    // answers with a different kind of reading; the lists used to guess it from the
    // response-level `isExact`, which cannot separate "upstream sent the minute"
    // from "this app computed it". Read as code, so the comments that explain the
    // removal do not trip these assertions.
    expect(codeOf(files['line-detail/components/line-hero.vue']), 'hero still guesses from the route type')
      .not.toContain('detail.type')
    for (const name of [
      'line-detail/components/station-popover.vue',
      'overview/components/line-mini-card.vue',
      'line-detail/index.vue',
      'platform/index.vue',
    ] as const) {
      expect(codeOf(files[name]), `${name} still branches on isExact`).not.toContain('.isExact')
    }
    // The platform board classifies each row from the source its own payload
    // declared, so it may not read the route type off the line identifier either.
    // A guess of the hero's old shape — `rule.lineId.startsWith('subway')` — reads
    // right only while the route type and the answering source agree, and this
    // board has no second opinion to fall back on. The prefixes are forbidden both
    // as a sniffed literal and as a comparison on the identifier itself.
    const platformCode = codeOf(files['platform/index.vue'])
    expect(platformCode, 'platform/index.vue still guesses the route type from the identifier')
      .not.toMatch(/lineId\s*\.\s*startsWith\(/)
    expect(platformCode, 'platform/index.vue still names a route-type prefix')
      .not.toMatch(/['"`]subway/)
    expect(platformCode, 'platform/index.vue still branches on a route-type field')
      .not.toMatch(/\b(?:lineType|routeType)\b/)
  })
})
