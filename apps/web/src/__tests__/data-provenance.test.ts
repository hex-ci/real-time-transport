import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DataProvenance } from '@real-time-transport/shared'
import { DataProvenanceSchema } from '@real-time-transport/shared'
import { provenanceLabelOf } from '../provenance-copy'

/**
 * F4 的标记，以文本形式。
 *
 * 措辞是纯逻辑，故在此测试而不靠浏览器（本应用无 DOM 测试台）。要点有二。其一，
 * 标记回答「这个数字是哪来的」，词汇表里的几个答案不能读起来一样。其二——本特性要堵的坑——
 * 来源未知的到站不得有任何标记，更不能带上好看的那个：「没有来源」与「实时」是两个不同的事实。
 */

describe('the mark names the kind of number, not the vendor behind it', () => {
  it('renders the vocabulary\'s three marks', () => {
    // 实时 / 排班推演 / 精确时刻表 是词汇表里全部的三档：本应用自算的那一档已删除，
    // 因为没有任何路径产出它。
    expect(provenanceLabelOf('live')).toBe('实时')
    expect(provenanceLabelOf('schedule_simulation')).toBe('排班推演')
    expect(provenanceLabelOf('exact_timetable')).toBe('精确时刻表')
  })

  it('has no wording for the kind the vocabulary dropped', () => {
    // 类型层由 shared 的 `Record<DataProvenance, true>` 钉子保证；这里是同一事实的运行时面：
    // 契约拒绝该值，变词函数对它什么都不说。
    expect(DataProvenanceSchema.safeParse('position_estimate').success).toBe(false)
    expect(provenanceLabelOf('position_estimate' as DataProvenance)).toBeNull()
  })

  it('shows nothing — never 实时 — when the provenance is not stated', () => {
    expect(provenanceLabelOf(null)).toBeNull()
    expect(provenanceLabelOf(undefined)).toBeNull()
    // 以规则形式陈述的守卫：任何未知都不得渲染成实时。
    for (const unknown of [null, undefined]) {
      expect(provenanceLabelOf(unknown)).not.toBe('实时')
    }
  })

  it('reads every kind differently, so no two can be confused', () => {
    const labels = (['live', 'schedule_simulation', 'exact_timetable'] as const)
      .map(p => provenanceLabelOf(p))
    expect(labels.every(l => typeof l === 'string' && l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('does not let the timetable engine\'s output read as live data', () => {
    // 地铁屏的行是生成出来的列车：这正是 F4 要防的那种混淆。
    expect(provenanceLabelOf('schedule_simulation')).not.toBe(provenanceLabelOf('live'))
  })
})

describe('the marks name no source and carry no marketing register', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  function templateOf(sfc: string): string {
    const start = sfc.indexOf('<template>')
    const end = sfc.lastIndexOf('</template>')
    return start >= 0 && end > start ? sfc.slice(start, end) : ''
  }

  /**
   * SFC `<script>` 块里的字符串字面量。
   *
   * 渲染内容不只在 template：script 返回或绑定的字面量同样到达屏幕——站台屏的行状态
   * 以字符串 '离线' 开始，`computed` 返回的标记词也是这种字面量。只扫 `<template>`
   * 会让这些都无人看守。
   */
  function scriptLiteralsOf(sfc: string): string {
    const literals: string[] = []
    for (const match of sfc.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      literals.push(literalsOf(match[1] ?? ''))
    }
    return literals.join('\n')
  }

  /**
   * 去掉说明性文字的文件，使关于**代码**的规则不被「恰好点出它所要解释之物」的注释触发。
   * `//` 仅在不跟在冒号后时才剥离，因此含 URL 的字符串字面量（`ws://`、`https://`）
   * 得以保留、仍可扫描。
   */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  /**
   * `.ts` copy 模块的字符串字面量——它的 `return` 就是用户读到的标记，故这些字面量
   * 正是这类文件的渲染内容。对 `.ts` 用 `templateOf` 会得到 `''`，两个 copy 模块因此
   * 曾什么都不扫。
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
   * 一个文件能放到用户屏幕上的内容。SFC 贡献 `<template>` 与 `<script>` 字符串字面量；
   * `.ts` copy 模块贡献其字符串字面量，那就是它返回的全部。两种情形都排除注释——
   * 说明某厂商名已被删除的文字不该被读成那个厂签名。
   */
  function renderedOf(name: string, source: string): string {
    if (name.endsWith('.ts')) return literalsOf(source)
    // 两半都剥离注释：渲染内容是到达屏幕的东西，HTML 注释不是。
    return `${codeOf(templateOf(source))}\n${scriptLiteralsOf(source)}`
  }

  const rendered = Object.fromEntries(
    Object.entries(files).map(([name, source]) => [name, renderedOf(name, source)]),
  )

  /**
   * 厂商与内部标识符 token。针对每个文件**渲染**的内容检查——SFC 的 template、
   * `.ts` copy 模块的字符串字面量——而非整个文件：`<script>` 注释可以正当地点名
   * 代码所集成的提供方。非字面量的代码（标识符、import）也不是渲染内容。
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
   * 传输机制。用户读的是连接**状态**，绝非其下的管道：「实时 WebSocket 已连接」、
   * 「LIVE WS」把机制本身放上了移动优先的屏幕。针对渲染字符串匹配，因此状态所读的
   * `wsConnected` 标识符不会被误当作渲染内容。
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
    // 「上游 / 秒级推演」描述的是管道；「官方」改由标记在唯一能坐实的形式（精确时刻表）里承载。
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
    // 站台屏每行对应一条线路/方向，故每行各陈其类——没有可供一个词描述的单一列表。
    expect(files['platform/components/departure-board.vue']).toContain('provenanceLabelOf')
    // 类型取自载荷声明的来源，就在产出该行的分支上——站台视图不自己算分钟，
    // 而拥有这些分支的行构造器才是应用来源之处。
    expect(files['platform/index.vue']).toContain('dataSource')
    expect(files['platform/departure-row.ts']).toContain('platformRowProvenanceOf(')
    expect(files['platform/departure-row.ts']).toContain('dataSource')
    // 写进模板的标记词会绕过 provenance-copy.ts（类型变词的唯一处）；实时尤其不得硬编码。
    const boardTemplate = rendered['platform/components/departure-board.vue']!
    for (const word of ['实时', '排班推演', '精确时刻表']) {
      expect(boardTemplate, `the board template states ${word} itself`).not.toContain(word)
    }
  })

  it('decides no mark from the route type or from a component\'s own position', () => {
    // 来源取自载荷，不由线路类型、也不由响应级 `isExact` 猜出；按代码断言，
    // 故解释删除过程的注释不会触发这些断言。
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
    // 站台屏按每行自身载荷声明的来源分类，因此同样不得从线路标识符嗅探线路类型。
    const platformCode = codeOf(files['platform/index.vue'])
    expect(platformCode, 'platform/index.vue still guesses the route type from the identifier')
      .not.toMatch(/lineId\s*\.\s*startsWith\(/)
    expect(platformCode, 'platform/index.vue still names a route-type prefix')
      .not.toMatch(/['"`]subway/)
    expect(platformCode, 'platform/index.vue still branches on a route-type field')
      .not.toMatch(/\b(?:lineType|routeType)\b/)
  })
})
