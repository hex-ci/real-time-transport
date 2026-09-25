import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import ChainPage from '../index.vue'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'

/**
 * A DOM-free mount of the chain page, so the page's own wiring can be tested by
 * BEHAVIOUR rather than by grepping its source.
 *
 * This repo has no DOM harness (no jsdom, no `@vue/test-utils`), and this file does
 * not add one: Vue's runtime-core is handed a host that keeps the tree as plain
 * objects instead of touching a document. That is enough for everything the page's
 * behaviour is read through here — the rendered tree, the events its children emit,
 * and the requests it makes — with no new dependency and no global test setup.
 *
 * Two globals are provided because the page's radio group is reka-ui, which is
 * written against a real DOM: `Element` (its `forwardRef` tests `ref instanceof
 * Element`) and `localStorage` (the city store reads it while it is created). Both
 * are stubbed here; the test file unstubs them.
 *
 * `fetch` is the seam. The page and the store it calls both go through it, so the
 * harness records every request (url, method, parsed body) and answers each route
 * from a responder the test supplies. A responder may hand back a `deferred()` so a
 * test can hold one answer open and release answers out of order — the only way to
 * see a stale answer race a newer one.
 */

/**
 * One rendered node. It is DOM-ish on purpose: reka-ui's radio group reaches for
 * `closest`, `focus` and `instanceof Element` on what it renders.
 */
export class HostElement {
  tag: string
  text: string
  props: Record<string, any>
  children: HostElement[]
  parent: HostElement | null
  nodeType = 1
  private readonly listeners = new Map<string, Set<(event: any) => void>>()

  constructor(tag: string, text = '') {
    this.tag = tag
    this.text = text
    this.props = {}
    this.children = []
    this.parent = null
  }

  get nodeName(): string {
    return this.tag.toUpperCase()
  }

  /** Nothing this page renders sits inside a form, so there is no ancestor to walk. */
  closest(): null {
    return null
  }

  contains(): boolean {
    return false
  }

  addEventListener(name: string, handler: (event: any) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(handler)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name: string, handler: (event: any) => void): void {
    this.listeners.get(name)?.delete(handler)
  }

  /**
   * reka-ui's radio dispatches its own `CustomEvent` at the click's target and
   * listens for it there, so a click needs a target that can hold listeners.
   */
  dispatchEvent(event: { type: string }): boolean {
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event)
    return true
  }

  focus(): void {}
  blur(): void {}
  setAttribute(name: string, value: unknown): void { this.props[name] = value }
  getAttribute(name: string): unknown { return this.props[name] ?? null }
  hasAttribute(name: string): boolean { return name in this.props }
  removeAttribute(name: string): void { delete this.props[name] }

  get nextElementSibling(): HostElement | null {
    const parent = this.parent
    if (!parent) return null
    return parent.children[parent.children.indexOf(this) + 1] ?? null
  }

  get firstElementChild(): HostElement | null {
    return this.children[0] ?? null
  }
}

/** Every node of the tree, in document order. */
function walk(root: HostElement): HostElement[] {
  const out: HostElement[] = []
  const visit = (current: HostElement): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(root)
  return out
}

/** A hoisted static subtree arrives as raw HTML: read it as the text it shows. */
function staticText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function textOf(root: HostElement): string {
  return walk(root)
    .map((item) => {
      // A node holds either children or its own text, never both: `setElementText`
      // is how Vue renders an element whose whole content is one string.
      if (item.tag === '#static') return staticText(item.text)
      return item.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A promise a test resolves itself, so an answer can be released on demand. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** One request the page (or the store it calls) made. */
export interface RecordedRequest {
  url: string
  method: string
  body: any
}

export type Responder = (request: RecordedRequest) => unknown

export interface HttpAnswer {
  status: number
  payload: unknown
  [HTTP_ANSWER]: true
}

const HTTP_ANSWER: unique symbol = Symbol('http-answer')

/** Answer a route with a specific status — a 429 is how the window refuses a press. */
export function httpStatus(status: number, payload: unknown): HttpAnswer {
  return { status, payload, [HTTP_ANSWER]: true }
}

function isHttpAnswer(answer: unknown): answer is HttpAnswer {
  return typeof answer === 'object' && answer !== null && HTTP_ANSWER in answer
}

/** The fetch seam: routes, and every request it saw. */
export class MockServer {
  readonly requests: RecordedRequest[] = []
  private readonly routes: Array<{ pattern: RegExp, respond: Responder }> = []

  on(pattern: RegExp, respond: Responder): this {
    this.routes.push({ pattern, respond })
    return this
  }

  /** Every request whose url matches, in order. */
  seen(pattern: RegExp): RecordedRequest[] {
    return this.requests.filter(request => pattern.test(request.url))
  }

  handle = async (input: any, init?: any): Promise<unknown> => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const request: RecordedRequest = { url, method, body }
    this.requests.push(request)

    // The most recently registered match wins, so a test can override a default.
    const route = [...this.routes].reverse().find(item => item.pattern.test(url))
    const answer = route ? await route.respond(request) : { success: false }
    if (isHttpAnswer(answer)) {
      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => answer.payload,
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => answer,
    }
  }
}

/** Just enough `localStorage` for the city store, which reads it while it is created. */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key) },
    setItem: (key: string, value: string) => { entries.set(key, String(value)) },
  } as Storage
}

/** Vue's runtime-core, rendered into `HostElement`s instead of a document. */
function createHostRenderer() {
  return createRenderer<HostElement, HostElement>({
    createElement: tag => new HostElement(tag),
    createText: text => new HostElement('#text', text),
    createComment: () => new HostElement('#comment'),
    setText: (element, text) => { element.text = text },
    setElementText: (element, text) => {
      element.children = []
      element.text = text
    },
    patchProp: (element, key, _previous, next) => { element.props[key] = next },
    insert: (child, parent, anchor) => {
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index >= 0) parent.children.splice(index, 0, child)
      else parent.children.push(child)
    },
    remove: (child) => {
      const parent = child.parent
      if (!parent) return
      const index = parent.children.indexOf(child)
      if (index >= 0) parent.children.splice(index, 1)
      child.parent = null
    },
    parentNode: element => element.parent,
    nextSibling: (element) => {
      const parent = element.parent
      if (!parent) return null
      return parent.children[parent.children.indexOf(element) + 1] ?? null
    },
    querySelector: () => null,
    setScopeId: (element, id) => { element.props[id] = '' },
    cloneNode: element => new HostElement(element.tag, element.text),
    insertStaticContent: (content, parent, anchor) => {
      const staticNode = new HostElement('#static', content)
      staticNode.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index >= 0) parent.children.splice(index, 0, staticNode)
      else parent.children.push(staticNode)
      return [staticNode, staticNode]
    },
  })
}

export interface MountedChainPage {
  root: HostElement
  server: MockServer
  store: ReturnType<typeof useTransitStore>
  city: ReturnType<typeof useCityStore>
  /** The page's visible text, whitespace-normalised. */
  text(): string
  /** The visible text of one rendered node, the same way. */
  textOf(node: HostElement): string
  /** All rendered nodes matching a predicate, in document order. */
  nodes(where: (node: HostElement) => boolean): HostElement[]
  /** The first node matching, or a thrown error naming what was looked for. */
  node(where: (node: HostElement) => boolean, description: string): HostElement
  /** Let every pending promise and re-render settle. */
  flush(): Promise<void>
  unmount(): void
}

export interface MountOptions {
  /** Routes, tried in order (the last match wins). One route, or a list of them. */
  routes?: Route | Route[]
}

/** One route: the requests it answers, and the answer it gives. */
export type Route = [RegExp, Responder]

/** A page with one route should not have to wrap it in a list. */
function routeList(routes: Route | Route[] | undefined): Route[] {
  if (!routes) return []
  return routes[0] instanceof RegExp ? [routes as Route] : routes as Route[]
}

/**
 * Mount the chain page and answer its requests from `routes`.
 *
 * A route the test does not supply answers `{ success: false }`, which is what the
 * page's own failure paths must handle — so a missing route shows up as the state it
 * produces rather than as a crash.
 */
export async function mountChainPage(options: MountOptions = {}): Promise<MountedChainPage> {
  const server = new MockServer()
  for (const [pattern, respond] of routeList(options.routes)) server.on(pattern, respond)
  vi.stubGlobal('fetch', server.handle)
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('Element', HostElement)
  // reka-ui's radio dispatches one of these at the clicked element.
  vi.stubGlobal('CustomEvent', class {
    type: string
    detail: unknown
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type
      this.detail = init?.detail
    }
  })

  const pinia: Pinia = createPinia()
  setActivePinia(pinia)

  const renderer = createHostRenderer()
  const container = new HostElement('#root')
  const app = renderer.createApp(ChainPage as Component)
  app.use(pinia)
  // Vitest transforms modules through Vite's pipeline, so an SFC's compiled wrapper
  // reaches for `useSSRContext()`. Handing it an empty context keeps the component
  // mounting in this host instead of into a server render it is not.
  app.provide(ssrContextKey, { modules: new Set<string>() })
  app.component('RouterLink', {
    props: { to: { type: String, required: true } },
    render() {
      return h('a', { href: (this as any).to }, (this as any).$slots.default?.())
    },
  })
  app.mount(container)

  const page: MountedChainPage = {
    root: container,
    server,
    store: useTransitStore(),
    city: useCityStore(),
    text: () => textOf(container),
    textOf: node => textOf(node),
    nodes: where => walk(container).filter(where),
    node: (where, description) => {
      const found = walk(container).find(where)
      if (!found) throw new Error(`the page rendered no ${description}`)
      return found
    },
    flush: async () => {
      for (let index = 0; index < 8; index += 1) {
        await nextTick()
        await Promise.resolve()
      }
    },
    unmount: () => app.unmount(),
  }

  await page.flush()
  return page
}

/**
 * The refresh control: the page's one F11 entry.
 *
 * Found by the section it lives in rather than by a class, so the selector cannot
 * be satisfied by some other 44px control the page grows (the purpose radios are
 * buttons with a touch-target height of their own).
 */
export function refreshButton(page: MountedChainPage): HostElement {
  const section = page.node(item => item.props['aria-label'] === '数据刷新', 'refresh section')
  const button = walk(section).find(item => item.tag === 'button')
  if (!button) throw new Error('the refresh section holds no button')
  return button
}

/**
 * Click a rendered element, with the event shape a real click carries: reka-ui's
 * radio reads `target`, `preventDefault` and `defaultPrevented` off it.
 */
export function click(element: HostElement): void {
  let prevented = false
  element.props.onClick?.({
    type: 'click',
    target: element,
    currentTarget: element,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
    stopPropagation: () => {},
  })
}

/** Press the refresh control, the way a user does — a disabled control is not clickable. */
export async function pressRefresh(page: MountedChainPage): Promise<void> {
  const button = refreshButton(page)
  if (button.props.disabled) {
    throw new Error('the page\'s refresh control is disabled: it names no line to re-read')
  }
  click(button)
  await page.flush()
}

/** Every line the last refresh request named, flattened for comparison. */
export function refreshedLines(page: MountedChainPage): string[] {
  const posted = page.server.seen(/\/api\/transit\/refresh$/).at(-1)
  if (!posted) throw new Error('the page made no refresh request')
  return (posted.body?.lines ?? []).map((line: any) => `${line.lineId}_${line.direction}@${line.cityCode}`)
}

/** The purpose radios, in the order the page renders them. */
export function purposeRadios(page: MountedChainPage): HostElement[] {
  return page.nodes(item => item.props.role === 'radio')
}

/** Pick a purpose by clicking its radio, the way a user does. */
export async function pickPurpose(page: MountedChainPage, purpose: string): Promise<void> {
  const radio = purposeRadios(page).find(item => item.props.value === purpose)
  if (!radio) throw new Error(`the page rendered no ${purpose} radio`)
  click(radio)
  await page.flush()
}
