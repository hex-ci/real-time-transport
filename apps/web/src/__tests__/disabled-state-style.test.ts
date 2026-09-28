import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 按不动的控件只有一处样子。
 *
 * 那一处写在 `assets/main.css` 的 base 层里：变淡与「按不动」的光标一起给，`button:disabled` 与
 * `[aria-disabled='true']` 各一份。控件自己再写一份就会盖过它 —— 而此前那批已经漂成两种（0.5 与 0.6
 * 各半，一半还漏了光标）。故本文件钉两头：全局那一处仍在且只有这一条，非测试源码里一处本地禁用令牌都
 * 没有。
 *
 * 本应用没有 DOM 测试台，故这里按源码断言：生效与否由 Tailwind 的层序决定，除非拿浏览器量计算样式，
 * 没有别的仪器能证明它。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** 本地写的禁用令牌；只这两个前缀，其余 `disabled:` 变体不在此列。 */
const LOCAL_DISABLED_TOKENS = /disabled:(?:opacity-|cursor-)/

/**
 * 本目录下每个源码文件，含子目录；`__tests__` 与 `*.test.ts` 不在内 —— 测试逐字引用渲染出的 class，
 * 它不属于这条约束的对象。
 */
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
    if (/\.(?:ts|vue|css)$/.test(entry.name)) {
      out[name] = readFileSync(join(directory, entry.name), 'utf8')
    }
  }
  return out
}

const FILES = sourceFiles(SRC)
const CSS = FILES['assets/main.css'] ?? ''

/** `@layer <name> { … }` 那一块，按花括号配平取出；没有该层时空串。 */
function layerBlock(css: string, name: string): string {
  const marker = `@layer ${name} {`
  const open = css.indexOf(marker)
  if (open === -1) return ''
  const start = open + marker.length
  let depth = 1
  for (let index = start; index < css.length; index++) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index)
    }
  }
  return ''
}

describe('禁用态：全局一处定义，本地零处', () => {
  it('base 层里那一条把变淡与光标一起说全，两种按不下的入口都算', () => {
    const base = layerBlock(CSS, 'base')
    expect(base, 'main.css 里没有 @layer base 块').not.toBe('')
    expect(base).toContain('button:disabled')
    expect(base).toMatch(/\[aria-disabled='true'\]/)
    expect(base).toContain('cursor: not-allowed')
    expect(base).toMatch(/opacity:\s*[\d.]+/)
  })

  it('全站只有这一条：main.css 里没有第二处禁用态', () => {
    expect(CSS.match(/button:disabled/g)).toHaveLength(1)
    expect(CSS.match(/aria-disabled/g)).toHaveLength(1)
  })

  it('base 层排在 utilities 之前，故工具类仍压得住它', () => {
    expect(CSS.indexOf('@layer base')).toBeGreaterThan(-1)
    expect(CSS.indexOf('@layer utilities')).toBeGreaterThan(-1)
    expect(CSS.indexOf('@layer base')).toBeLessThan(CSS.indexOf('@layer utilities'))
  })

  it('每个控件都不再自己写变淡或光标：非测试源码里一处都没有', () => {
    const guilty = Object.entries(FILES)
      .filter(([, source]) => LOCAL_DISABLED_TOKENS.test(source))
      .map(([name]) => name)
    expect(guilty).toEqual([])
  })

  it('扫的是源码本身而不是空集：那几个曾经的犯规者仍在盘上', () => {
    for (const name of [
      'assets/main.css',
      'components/refresh-control/main.vue',
      'views/line-detail/components/station-popover.vue',
      'views/settings/lines.vue',
      'views/settings/anchor-detail.vue',
      'views/settings/components/chain-form.vue',
      'views/platform/components/departure-board.vue',
    ]) {
      expect(FILES[name], `${name} 没有被扫到`).toBeDefined()
    }
  })
})
