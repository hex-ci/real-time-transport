/**
 * 链路页设计规则所依据的对比度审计。
 *
 * 逐色清单做不到的事：拿每个 `text-*` token 去对一个手挑的表面检查，看不见背景本身的改动（把卡片
 * 从 `slate-800` 提亮到 `slate-700`，那十个颜色照样通过），而它对照的表面是猜的，两个方向都会出错——
 * 被选中的单选药丸会叠出比假定值更亮的表面，而只出现在深色卡片上的颜色会被一个它从不出现的表面判不合格。
 *
 * 因此这里走 SFC 自己的模板：每个元素的背景（含渐变停靠点、alpha、`data-[state=checked]:bg-…` 这类
 * 状态变体）沿祖先合成到 App.vue 自己的根，元素声明的每个文字色都对着**该元素**实际涂绘的表面检查。
 * 被提亮的表面因此在此可见，且无法靠省略隐藏：被审计的表面是源码声明的，审计没有取值的颜色算失败而非跳过。
 *
 * 状态也必须对应：带变体前缀的类只在该状态涂绘，故把每个文字色与每个背景叉积会产生屏幕画不出的组合，
 * 既凭空造出违规、又把它背后真正的组合藏起来。文字色因此只与它自己状态可达的层合成：它共享的带前缀层，
 * 加上每个无前缀的祖先层（后者在每个状态都涂绘）。
 *
 * 取值取自 Tailwind 自己的调色板，alpha 合成即浏览器的：预乘意义下的 `over`，逐通道
 * `c = a·front + (1-a)·back`，从页面底色向外应用。
 */

/** Tailwind 调色板，覆盖本页所用到的家族。 */
const COLORS: Record<string, string> = {
  'white': '#ffffff',
  'black': '#000000',
  'slate-950': '#020617',
  'slate-900': '#0f172a',
  'slate-800': '#1e293b',
  'slate-700': '#334155',
  'slate-600': '#475569',
  'slate-500': '#64748b',
  'slate-400': '#94a3b8',
  'slate-300': '#cbd5e1',
  'slate-200': '#e2e8f0',
  'slate-100': '#f1f5f9',
  'slate-50': '#f8fafc',
  'cyan-950': '#083344',
  'cyan-900': '#164e63',
  'cyan-800': '#155e75',
  'cyan-700': '#0e7490',
  'cyan-600': '#0891b2',
  'cyan-500': '#06b6d4',
  'cyan-400': '#22d3ee',
  'cyan-300': '#67e8f9',
  'cyan-200': '#a5f3fc',
  'amber-500': '#f59e0b',
  'amber-400': '#fbbf24',
  'amber-300': '#fcd34d',
  'rose-500': '#f43f5e',
  'rose-400': '#fb7185',
  'rose-300': '#fda4af',
  'emerald-500': '#10b981',
  'emerald-400': '#34d399',
  'emerald-300': '#6ee7b7',
  'sky-700': '#0369a1',
  'sky-600': '#0284c7',
  'sky-500': '#0ea5e9',
  'sky-400': '#38bdf8',
  'sky-300': '#7dd3fc',
  'violet-700': '#6d28d9',
  'violet-600': '#7c3aed',
  'violet-500': '#8b5cf6',
  'violet-400': '#a78bfa',
  'violet-300': '#c4b5fd',
}

/** 页面自身的底色：App.vue 的根在每个路由上涂 `bg-slate-950`。 */
export const PAGE_BASE = '#020617'

/** WCAG 2.1 对本页不设余量的 12px 标签的下限。 */
export const AA_NORMAL_TEXT = 4.5

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export function rgbaOf(hex: string, alpha = 1): Rgba {
  const value = hex.replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    a: alpha,
  }
}

/** `front` 绘在 `back` 之上，即浏览器合成半透明层的方式。 */
export function over(front: Rgba, back: Rgba): Rgba {
  return {
    r: front.a * front.r + (1 - front.a) * back.r,
    g: front.a * front.g + (1 - front.a) * back.g,
    b: front.a * front.b + (1 - front.a) * back.b,
    a: front.a + (1 - front.a) * back.a,
  }
}

/** WCAG 2.1 相对亮度。 */
export function luminance(color: Rgba): number {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** 两个不透明颜色之间的 WCAG 2.1 对比度。 */
export function contrastRatio(left: Rgba, right: Rgba): number {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

export function hexOf(color: Rgba): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

/** `#rrggbb` 对 `#rrggbb`，两者都不透明。 */
export function contrastOfHex(foreground: string, background: string): number {
  return contrastRatio(rgbaOf(foreground), rgbaOf(background))
}

/** 元素文字可落在的一个表面，连同它是如何合成的。 */
export interface AuditedSurface {
  hex: string
  /** 涂绘它的类，最外层在前。 */
  layers: string[]
  /**
   * 该表面被涂绘的状态，即其各层的变体前缀（`hover`、`data-[state=checked]`，或没有）。
   * 文字色只能与它共享状态的表面配对。
   */
  variants: string[]
}

/** 审计检查过的每个「文字-表面」对。 */
export interface AuditedPair {
  /** 声明该文字色的文件。 */
  source: string
  /** 声明它的元素，形如 `<tag class="…">`。 */
  element: string
  /** 写下的完整 token，含变体前缀：`hover:text-slate-950`。 */
  textToken: string
  /** 该文字色生效的状态——配对规则的另一半。 */
  textVariants: string[]
  surface: AuditedSurface
  ratio: number
}

export interface ContrastAudit {
  violations: string[]
  pairs: AuditedPair[]
  /** 审计合成过的每个表面，按十六进制去重。 */
  surfaces: AuditedSurface[]
  /** 在 `<script>` 块而非模板中声明的文字色。 */
  scriptColors: string[]
}

/** 元素涂绘的一个背景层；不涂绘任何背景的元素为 `null`。 */
interface Layer {
  description: string
  /** token 上的变体前缀（`hover`、`data-[state=checked]`），或没有。 */
  variants: string[]
  color: Rgba
}

/** 元素声明的一个文字色，连同它生效的状态。 */
interface TextRule {
  /** 写下的 token，含前缀：`hover:text-slate-950`。 */
  token: string
  /** `text-` 之后的调色板名，即 `COLORS` 的键。 */
  name: string
  /**
   * token 自身的 alpha 分数（`text-sky-400/80`），不透明时为 null。半透明前景会先与它所在的表面
   * 合成再被测量：那个合成才是眼睛实际收到的颜色。
   */
  alpha: number | null
  variants: string[]
}

interface ParsedElement {
  tag: string
  classes: string[]
  /** 元素写下的 `:class` 表达式——脚本值所绑定的对象。 */
  bindings: string[]
  layers: Layer[]
  textRules: TextRule[]
  children: ParsedElement[]
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'path', 'circle'])

/** 类的工具部分，去掉所有 `variant:` 前缀。 */
function utilityOf(token: string): { variants: string[], utility: string } {
  const parts = token.split(':')
  return { variants: parts.slice(0, -1), utility: parts[parts.length - 1]! }
}

/** 携带颜色的背景 token；token 不涂绘背景时为 null。 */
function backgroundLayerOf(token: string): Layer | null {
  const { variants, utility } = utilityOf(token)
  const match = /^(?:bg|from|via|to)-(.+)$/.exec(utility)
  if (!match) return null
  const [name, alpha] = match[1]!.split('/')
  const hex = COLORS[name!]
  if (!hex) return null
  return {
    description: token,
    variants,
    color: rgbaOf(hex, alpha === undefined ? 1 : Number(alpha) / 100),
  }
}

/** 携带颜色的文字 token 规则；token 不是文字色时为 null。 */
function textRuleOf(token: string): TextRule | null {
  const { variants, utility } = utilityOf(token)
  const match = /^text-(white|black|[a-z]+-\d{2,3})(?:\/(\d+))?$/.exec(utility)
  if (!match) return null
  return {
    token,
    name: match[1]!,
    alpha: match[2] === undefined ? null : Number(match[2]) / 100,
    variants,
  }
}

/** 源码写下的每个 `:class` 表达式。 */
function bindingsOf(source: string): string[] {
  return [...source.matchAll(/:class="([^"]*)"/g)].map(match => match[1]!)
}

/** 源码写下的每个类：静态 `class` 属性与 `:class` 字面量。 */
function classesOf(source: string): string[] {
  const classes: string[] = []
  for (const attribute of source.matchAll(/\bclass="([^"]*)"/g)) {
    classes.push(...attribute[1]!.split(/\s+/).filter(Boolean))
  }
  for (const binding of bindingsOf(source)) {
    for (const literal of binding.matchAll(/'([^']*)'/g)) {
      classes.push(...literal[1]!.split(/\s+/).filter(Boolean))
    }
  }
  return classes
}

/**
 * 模板体，去掉 script 块。
 *
 * 取**最外层**的 `<template>…</template>`，通过找到它自己的闭合标签而非第一个：使用嵌套
 * `<template v-if>`/`<template v-else>` 的模板（这些屏幕上每个条件块都这么写）否则会在那个内层
 * `</template>` 处被截断，其下的一切都会静默逃过审计，而审计仍报告看似健康的对数。
 */
function templateBody(source: string): string {
  const withoutScripts = source.replace(/<script[\s\S]*?<\/script>/g, '')
  const open = withoutScripts.indexOf('<template')
  const close = withoutScripts.lastIndexOf('</template>')
  if (open === -1 || close === -1) return withoutScripts
  const nameEnd = withoutScripts.indexOf('>', open)
  if (nameEnd === -1 || nameEnd > close) return withoutScripts
  return withoutScripts.slice(nameEnd + 1, close)
}

/** `:class` 绑定引用但未以字面量写出的类名。 */
export function boundIdentifiers(template: string): string[] {
  const identifiers: string[] = []
  for (const binding of template.matchAll(/:class="([^"]*)"/g)) {
    for (const word of binding[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!binding[1]!.includes(`'${word[0]}'`)) identifiers.push(word[0])
    }
  }
  return [...new Set(identifiers)]
}

/**
 * 模板的树形表示。
 *
 * 一个小扫描器而非真正的 HTML 解析器：这里的模板是 Vue 自己的、格式良好，审计从结构上只需知道
 * 元素携带哪些类、以及它的祖先是哪些。
 */
function parseTemplate(template: string): ParsedElement[] {
  const roots: ParsedElement[] = []
  const stack: ParsedElement[] = []
  const tagPattern = /<(\/?)([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

  const elementOf = (tag: string, attributes: string): ParsedElement => {
    const classes = classesOf(attributes)
    return {
      tag,
      classes,
      bindings: bindingsOf(attributes),
      layers: classes.map(backgroundLayerOf).filter((layer): layer is Layer => layer !== null),
      textRules: classes.map(textRuleOf).filter((rule): rule is TextRule => rule !== null),
      children: [],
    }
  }

  for (const match of template.matchAll(tagPattern)) {
    if (match[1] === '/') {
      stack.pop()
      continue
    }
    const element = elementOf(match[2]!, match[3] ?? '')
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else roots.push(element)
    if (match[4] !== '/' && !VOID_TAGS.has(element.tag.toLowerCase())) stack.push(element)
  }
  return roots
}

/** 树里的每个元素及其祖先链，最外层在前。 */
function walk(root: ParsedElement): Array<{ element: ParsedElement, chain: ParsedElement[] }> {
  const out: Array<{ element: ParsedElement, chain: ParsedElement[] }> = []
  const visit = (element: ParsedElement, chain: ParsedElement[]): void => {
    const here = [...chain, element]
    out.push({ element, chain: here })
    for (const child of element.children) visit(child, here)
  }
  for (const element of [root]) visit(element, [])
  return out
}

/**
 * 在给定状态成立时涂绘的元素背景层。
 *
 * 元素自己的层是**备选**而非堆叠：`bg-slate-800 hover:bg-cyan-500` 在 hover 时只涂 cyan-500，
 * 故把 hover 文字与基础 slate-800 配对会检查屏幕从不画出的组合。文字自己的状态不蕴含的层无法在它
 * 之下涂绘、被丢弃；在能涂绘的层中，最具体的胜出，即浏览器实际渲染的那层。
 */
function layersActiveIn(element: ParsedElement, textVariants: string[]): Layer[] {
  const applicable = element.layers.filter(layer =>
    layer.variants.every(variant => textVariants.includes(variant)))
  if (applicable.length === 0) return []
  const most = Math.max(...applicable.map(layer => layer.variants.length))
  return applicable.filter(layer => layer.variants.length === most)
}

/**
 * 元素链能为处于 `textVariants` 的文字色涂绘的每个表面。
 *
 * 状态要紧：同一元素在不同状态涂绘不同背景，而文字色只遇到它自己状态可达的那些。故 `hover:` 颜色与
 * `hover:` 层（加上每个无前缀的祖先层，后者在每个状态都涂绘）合成，绝不与其 hover 本会覆盖的基础层合成。
 */
function surfacesFor(chain: ParsedElement[], textVariants: string[]): AuditedSurface[] {
  let states: AuditedSurface[] = [{ hex: PAGE_BASE, layers: ['(App.vue) bg-slate-950'], variants: [] }]

  for (const element of chain) {
    const layers = layersActiveIn(element, textVariants)
    if (layers.length === 0) continue
    const next: AuditedSurface[] = []
    for (const state of states) {
      for (const layer of layers) {
        const composited = over(layer.color, rgbaOf(state.hex))
        const surface: AuditedSurface = {
          hex: hexOf(composited),
          layers: [...state.layers, layer.description],
          variants: [...new Set([...state.variants, ...layer.variants])],
        }
        if (!next.some(item => item.hex === surface.hex && item.layers.length === surface.layers.length)) {
          next.push(surface)
        }
      }
    }
    states = next
  }
  return states
}

/** 违规信息里如何称呼一个元素。 */
function describeElement(element: ParsedElement): string {
  return `<${element.tag} class="${element.classes.join(' ')}">`
}

/**
 * 把这些 SFC 声明的每个文字色，对着声明它的元素实际涂绘的**它自己的**表面检查。
 *
 * 在 `<script>` 块而非模板中的颜色，对 `:class` 绑定引用该脚本的元素之表面审计——即它被渲染于其上的那个元素。
 */
export function auditContrast(
  sources: Record<string, string>,
  options: { base?: string, minimum?: number } = {},
): ContrastAudit {
  const minimum = options.minimum ?? AA_NORMAL_TEXT
  const violations: string[] = []
  const pairs: AuditedPair[] = []
  const surfaces: AuditedSurface[] = []
  const scriptColors: string[] = []

  for (const [name, source] of Object.entries(sources)) {
    const template = templateBody(source)
    const script = source.replace(/<template[\s\S]*<\/template>/g, '')
    const roots = parseTemplate(template)
    const byHex = new Map<string, AuditedSurface>()

    const check = (
      sourceName: string,
      element: ParsedElement,
      surface: AuditedSurface,
      rule: TextRule,
      paletteHex: string,
    ): void => {
      // 半透明前景先与它所在的表面合成：读者眼睛收到的是合成结果，不是调色板颜色。
      const painted = rule.alpha === null
        ? paletteHex
        : hexOf(over(rgbaOf(paletteHex, rule.alpha), rgbaOf(surface.hex)))
      const ratio = contrastRatio(rgbaOf(painted), rgbaOf(surface.hex))
      pairs.push({
        source: sourceName,
        element: describeElement(element),
        textToken: rule.token,
        textVariants: rule.variants,
        surface,
        ratio,
      })
      if (!byHex.has(surface.hex)) byHex.set(surface.hex, surface)
      if (ratio < minimum) {
        violations.push(
          `${sourceName}: ${rule.token} (${painted}) on ${surface.hex} `
          + `[${surface.layers.join(' over ')}] is ${ratio.toFixed(2)}:1, below ${minimum}:1, `
          + `on ${describeElement(element)}`,
        )
      }
    }

    for (const root of roots) {
      for (const { element, chain } of walk(root)) {
        for (const token of element.classes) {
          if (/^(?:bg|text|from|via|to)-\[/.test(utilityOf(token).utility)) {
            violations.push(`${name}: ${token} is an arbitrary colour value, not a palette token`)
          }
        }
        if (element.textRules.length === 0) continue
        for (const rule of element.textRules) {
          const hex = COLORS[rule.name]
          if (!hex) {
            violations.push(`${name}: ${rule.token} is not in the audited palette`)
            continue
          }
          // 本颜色自己状态的表面：只在 hover 时适用的规则，只对 hover 时涂绘的内容读取，别的一概不对。
          for (const surface of surfacesFor(chain, rule.variants)) {
            check(name, element, surface, rule, hex)
          }
        }
      }
    }

    // script 自己的色调 helper：它的颜色渲染在绑定它的元素上，故对该元素的表面审计——而非文件里最亮的
    // 表面，那会为一个从不出现的表面判它不合格。script 交给 `:class` 绑定的值不带自己的状态，
    // 故按元素基础状态下涂绘的表面读取。
    const declared = [...script.matchAll(/'(text-(?:white|black|[a-z]+-\d{2,3}))'/g)]
      .map(match => match[1]!.replace('text-', ''))
    scriptColors.push(...declared)
    if (declared.length > 0) {
      // 哪个元素绑定某脚本值：那个命名了脚本所声明标识符的 `:class` 绑定（一个 computed 色调、一个 helper 的结果）。
      const declaredNames = [...script.matchAll(/(?:function|const)\s+([A-Za-z_$][\w$]*)/g)]
        .map(match => match[1]!)
      const boundHelpers = boundIdentifiers(template).filter(word => declaredNames.includes(word))
      const surfacesIn = (path: Array<{ element: ParsedElement, chain: ParsedElement[] }>): Array<{ element: ParsedElement, surface: AuditedSurface }> =>
        path.flatMap(({ element, chain }) => surfacesFor(chain, []).map(surface => ({ element, surface })))
      const bound = surfacesIn(roots
        .flatMap(root => walk(root))
        .filter(({ element }) => element.bindings.some(binding =>
          boundHelpers.some(helper => new RegExp(`\\b${helper}\\b`).test(binding)))))
      const lightest = (bound.length > 0 ? bound : surfacesIn(roots.flatMap(root => walk(root))))
        .sort((left, right) => luminance(rgbaOf(right.surface.hex)) - luminance(rgbaOf(left.surface.hex)))[0]

      for (const colorName of declared) {
        const hex = COLORS[colorName]
        if (!hex) {
          violations.push(`${name}: text-${colorName} is not in the audited palette`)
          continue
        }
        if (!lightest) continue
        check(name, lightest.element, lightest.surface, { token: `text-${colorName}`, name: colorName, alpha: null, variants: [] }, hex)
      }
    }

    for (const surface of byHex.values()) surfaces.push(surface)
  }

  return { violations, pairs, surfaces, scriptColors }
}
