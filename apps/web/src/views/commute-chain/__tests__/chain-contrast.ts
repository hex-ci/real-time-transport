/**
 * The contrast audit the chain page's design rule is held by.
 *
 * WHAT IT DOES THAT A COLOUR LIST CANNOT. An audit that checks every `text-*`
 * token against one hand-picked surface cannot see a BACKGROUND change at all:
 * lighten a card from `slate-800` to `slate-700` and the same ten colours keep
 * passing, because nothing in the audit ever looked at the background. And the
 * surface it checks against is a guess — the lightest surface any text "could"
 * sit on — which is wrong in both directions: a checked radio pill composites
 * `cyan-500/20` over `slate-800/80` over the page and is LIGHTER than the
 * `slate-800` the audit assumed, while a colour that only ever sits on a dark card
 * is failed for a surface it never appears on.
 *
 * So this walks the SFC's own template: every element's background — including
 * gradient stops, alpha, and state variants like `data-[state=checked]:bg-…` — is
 * composited over its ancestors' down to App.vue's own root, and every text colour
 * an element declares is checked against the surfaces THAT element actually paints.
 * A lightened surface is therefore visible here, and it cannot be hidden by
 * omission: an audited surface is one the source declares, and a colour the audit
 * has no value for is a failure rather than a skip.
 *
 * AND THE STATES HAVE TO MATCH. A class with a variant prefix paints only in that state, so
 * cross-producting every text colour with every background produces pairs no screen can
 * draw: `bg-slate-800 hover:bg-cyan-500` with `text-slate-200 hover:text-slate-950` is TWO
 * states (11.87:1 and 8.31:1), never the four a cross-product claims — and claiming the base
 * text sits on the hover surface (1.97:1) or the hover text on the base surface (1.38:1)
 * both invents a violation and hides the real pair behind it. A text colour is therefore
 * composited against the layers its own state reaches: the prefixed ones it shares, plus
 * every unprefixed ancestor layer, which paints in every state.
 *
 * The values are Tailwind's own palette (the same hexes the page's classes name),
 * and the alpha compositing is the browser's: `over` in premultiplied terms,
 * `c = a·front + (1-a)·back` per channel, applied from the page base outwards.
 */

/** Tailwind's palette, for the families this page paints with. */
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

/** The page's own base: App.vue's root paints `bg-slate-950` on every route. */
export const PAGE_BASE = '#020617'

/** WCAG 2.1's minimum for the 12px labels this page applies no slack to. */
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

/** `front` drawn over `back`, the way a browser composites a translucent layer. */
export function over(front: Rgba, back: Rgba): Rgba {
  return {
    r: front.a * front.r + (1 - front.a) * back.r,
    g: front.a * front.g + (1 - front.a) * back.g,
    b: front.a * front.b + (1 - front.a) * back.b,
    a: front.a + (1 - front.a) * back.a,
  }
}

/** WCAG 2.1 relative luminance. */
export function luminance(color: Rgba): number {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** WCAG 2.1 contrast ratio between two opaque colours. */
export function contrastRatio(left: Rgba, right: Rgba): number {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

export function hexOf(color: Rgba): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

/** `#rrggbb` on `#rrggbb`, both opaque. */
export function contrastOfHex(foreground: string, background: string): number {
  return contrastRatio(rgbaOf(foreground), rgbaOf(background))
}

/** One surface an element's text can sit on, with how it was composited. */
export interface AuditedSurface {
  hex: string
  /** The classes that painted it, outermost first. */
  layers: string[]
  /**
   * The states this surface is painted in, as the variant prefixes of its layers
   * (`hover`, `data-[state=checked]`, or nothing at all). A text colour may only be paired
   * with a surface whose states it shares: a `hover:` colour has no business being checked
   * against a surface that is not painted while hovering.
   */
  variants: string[]
}

/** Every text-on-surface pair the audit checked. */
export interface AuditedPair {
  /** The file the text colour was declared in. */
  source: string
  /** The element that declared it, as `<tag class="…">`. */
  element: string
  /** The whole token as written, variant prefix included: `hover:text-slate-950`. */
  textToken: string
  /** The states the text colour applies in — the other half of the pairing rule. */
  textVariants: string[]
  surface: AuditedSurface
  ratio: number
}

export interface ContrastAudit {
  violations: string[]
  pairs: AuditedPair[]
  /** Every surface the audit composited, deduplicated by hex. */
  surfaces: AuditedSurface[]
  /** Text colours declared in a `<script>` block rather than in the template. */
  scriptColors: string[]
}

/** A background layer an element paints: `null` for an element that paints none. */
interface Layer {
  description: string
  /** The variant prefixes on the token (`hover`, `data-[state=checked]`), or none. */
  variants: string[]
  color: Rgba
}

/** A text colour an element declares, with the states it applies in. */
interface TextRule {
  /** The token as written, prefix included: `hover:text-slate-950`. */
  token: string
  /** The palette name after `text-`, which is what `COLORS` is keyed by. */
  name: string
  /**
   * The token's own alpha as a fraction (「text-sky-400/80」), or null when it is opaque.
   * A translucent foreground is composited over the surface before it is measured: that
   * composite is the colour the eye actually receives.
   */
  alpha: number | null
  variants: string[]
}

interface ParsedElement {
  tag: string
  classes: string[]
  /** The element's `:class` expressions, as written — what a script value binds to. */
  bindings: string[]
  layers: Layer[]
  textRules: TextRule[]
  children: ParsedElement[]
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'path', 'circle'])

/** The utility part of a class, with any `variant:` prefixes dropped. */
function utilityOf(token: string): { variants: string[], utility: string } {
  const parts = token.split(':')
  return { variants: parts.slice(0, -1), utility: parts[parts.length - 1]! }
}

/** A colour-bearing background token, or null when the token paints no background. */
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

/** A colour-bearing text token as a rule, or null when the token is not a text colour. */
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

/** Every `:class` expression the source states, as written. */
function bindingsOf(source: string): string[] {
  return [...source.matchAll(/:class="([^"]*)"/g)].map(match => match[1]!)
}

/** Every class the source states: static `class` attributes and `:class` literals. */
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
 * The template body, with the script blocks removed.
 *
 * The OUTERMOST `<template>…</template>` block, matched by finding its own closing tag rather
 * than the first one: a template that uses a nested `<template v-if>`/`<template v-else>` —
 * which is how every conditional block on these screens is written — would otherwise be cut
 * off at that inner `</template>`, and everything below it would silently escape the audit
 * while the audit still reported a healthy number of pairs. That is the same
 * invisible-omission failure the audit exists to prevent, one level up.
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

/** The class names a `:class` binding refers to but does not state as a literal. */
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
 * The template as a tree.
 *
 * A small scanner rather than a real HTML parser: the templates here are Vue's own
 * and well formed, and what the audit needs from the structure is only which
 * classes an element carries and who its ancestors are.
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

/** Every element of the tree, with its ancestor chain, outermost first. */
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
 * The background layers of an element that paint while the given states hold.
 *
 * An element's own layers are ALTERNATIVES, not a stack: with `bg-slate-800
 * hover:bg-cyan-500` a hover paints cyan-500 alone, so pairing hover text with the base
 * slate-800 would check a pair the screen never draws. A layer whose states the text's own
 * states do not imply cannot paint under that text at all and is dropped; among those that
 * can, the most specific wins, which is the layer a browser would actually render.
 */
function layersActiveIn(element: ParsedElement, textVariants: string[]): Layer[] {
  const applicable = element.layers.filter(layer =>
    layer.variants.every(variant => textVariants.includes(variant)))
  if (applicable.length === 0) return []
  const most = Math.max(...applicable.map(layer => layer.variants.length))
  return applicable.filter(layer => layer.variants.length === most)
}

/**
 * Every surface a chain of elements can paint FOR A TEXT COLOUR IN `textVariants`.
 *
 * The state matters: the same element paints different backgrounds in different states, and
 * a text colour only ever meets the ones its own state reaches. A `hover:` colour is
 * therefore composited over the `hover:` layers (plus every unprefixed ancestor layer, which
 * paints in every state), and never over a base layer its own hover would have overridden.
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

/** How an element is named in a violation message. */
function describeElement(element: ParsedElement): string {
  return `<${element.tag} class="${element.classes.join(' ')}">`
}

/**
 * Check every text colour these SFCs declare against the surfaces the element
 * declaring it actually paints.
 *
 * A colour in the `<script>` block rather than the template is audited against the
 * lightest surface among the elements whose `:class` binding refers to the script —
 * its own element's surface, which is the one it is rendered on.
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
      // A translucent foreground is first composited over the surface it sits on: the
      // composite, not the palette colour, is what the reader's eye receives.
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
          // The surfaces of THIS colour's own state: a rule that only applies while hovered
          // is read against what is painted while hovered, and against nothing else.
          for (const surface of surfacesFor(chain, rule.variants)) {
            check(name, element, surface, rule, hex)
          }
        }
      }
    }

    // The script's own tone helper: its colours are rendered on the element that
    // binds it, so they are audited against that element's surfaces — not against
    // the lightest surface in the file, which would fail a colour for a surface it
    // never appears on. A value a script hands to a `:class` binding carries no state of
    // its own, so it is read against the surfaces painted in the element's base state.
    const declared = [...script.matchAll(/'(text-(?:white|black|[a-z]+-\d{2,3}))'/g)]
      .map(match => match[1]!.replace('text-', ''))
    scriptColors.push(...declared)
    if (declared.length > 0) {
      // Which element binds a script value: the `:class` binding that names an
      // identifier the script declares (a computed tone, a helper's result).
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
