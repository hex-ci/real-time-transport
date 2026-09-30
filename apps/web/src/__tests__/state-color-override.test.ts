import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 静态类与 `:class` 不得对同一个 CSS 属性都给颜色令牌。
 *
 * 两者特异性相同（都是一个类选择器），谁赢**只看编译后的 CSS 里谁排在后面** —— 读源代码看不出来。
 * 而 Tailwind 编译出的顺序是按颜色名排的（`cyan-*` 排在 `slate-*` 前面），于是「静态写灰、动态写
 * 青/玫红」这类写法**动态那面一律失效**：按钮看着像没反应，而代码里明明写了。
 *
 * 本应用没有 DOM 测试台，故这里按源码断言：一处都别写，而不是「写了但要保证动态在后面」。
 * 两态都给的那一面对（`:class="a ? 'text-cyan-400' : 'text-slate-300'"`）—— 静态里不放颜色令牌
 * 就不会撞上。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** 颜色族的类名，形如 `text-cyan-400` / `bg-slate-800/80` / `border-rose-500/30`。 */
const COLOR_TOKENS = /(?<![\w:-])(text|bg|border|ring|outline|fill|stroke)-([a-z]+)-\d{2,3}(?:\/\d+)?/g

/** 被上了色的 CSS 属性集合；同属性相撞才会失效，`text-sm` 这类字号不在内（它不匹配上面的正则）。 */
function paintedProperties(classList: string): Set<string> {
  const out = new Set<string>()
  for (const match of classList.matchAll(COLOR_TOKENS)) out.add(match[1]!)
  return out
}

/**
 * 找出「静态 class 之后、同一个标签闭合之前」跟着 `:class` 的标签对。
 *
 * `[^>]*?` 使匹配不越过标签边界，故不会把两个相邻标签的 class 配到一起。
 */
function conflictingTokens(source: string): string[] {
  const found: string[] = []
  const pattern = /class="([^"]*)"[^>]*?:class="([^"]*)"/gs
  for (const match of source.matchAll(pattern)) {
    const staticProps = paintedProperties(match[1]!)
    const dynamicProps = paintedProperties(match[2]!)
    const both = [...staticProps].filter(property => dynamicProps.has(property))
    if (both.length > 0) found.push(both.sort().join('+'))
  }
  return found
}

function sourceFiles(directory: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      Object.assign(out, sourceFiles(join(directory, entry.name), name))
      continue
    }
    if (entry.name.endsWith('.test.ts')) continue
    if (entry.name.endsWith('.vue')) out[name] = readFileSync(join(directory, entry.name), 'utf8')
  }
  return out
}

const FILES = sourceFiles(SRC)

describe('颜色令牌：静态与动态不同时给同一个属性', () => {
  it('非测试源码里一处这样的写法都没有', () => {
    const guilty = Object.entries(FILES)
      .map(([name, source]) => [name, conflictingTokens(source)] as const)
      .filter(([, tokens]) => tokens.length > 0)
      .map(([name, tokens]) => `${name} → ${tokens.join(', ')}`)
    expect(guilty).toEqual([])
  })

  it('扫的是源码本身而不是空集：那些有 `:class` 的控件仍在盘上', () => {
    for (const name of [
      'views/overview/components/line-mini-card.vue',
      'views/overview/index.vue',
      'components/header-nav/main.vue',
      'components/searchable-combobox/main.vue',
      'views/platform/components/departure-board.vue',
    ]) {
      expect(FILES[name], `${name} 没有被扫到`).toBeDefined()
      expect(FILES[name], `${name} 里连一个 :class 都没有，闸门等于没扫`).toContain(':class=')
    }
  })

  it('两态都给的那种写法是允许的', () => {
    // 反面样本：静态里不放颜色令牌，就不可能与动态那面撞上。
    const paired = '<button class="flex min-h-11 text-xs transition" :class="on ? \'bg-cyan-500/8 text-cyan-400\' : \'text-slate-300\'">'
    expect(conflictingTokens(paired)).toEqual([])
  })

  it('闸门能抓到「静态灰 + 动态青」这一种', () => {
    // 正面样本：这正是本轮修掉的那一类。
    const broken = '<button class="flex min-h-11 text-xs text-slate-300 transition" :class="on ? \'text-cyan-400\' : \'\'">'
    expect(conflictingTokens(broken)).toEqual(['text'])
  })

  it('字号与变体不算颜色冲突', () => {
    const fine = '<div class="text-xs lg:text-base hover:text-slate-100" :class="on ? \'text-cyan-300\' : \'text-slate-300\'">'
    expect(conflictingTokens(fine)).toEqual([])
  })
})
