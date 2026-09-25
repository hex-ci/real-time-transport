import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue'
import type { Renderer } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'

/**
 * A DOM-free mount of the 设置 page, so the 通勤链路 card's behaviour is tested by
 * driving the screen rather than by grepping its source.
 *
 * This repo has no DOM harness (no jsdom, no `@vue/test-utils`), and this file does
 * not add one: Vue's runtime-core is handed a host that keeps the tree as plain
 * objects instead of touching a document. That is enough for everything the card's
 * behaviour is read through here — the rendered tree, the events its controls
 * receive, and the requests it makes — with no new dependency and no global test
 * setup.
 *
 * WHAT THIS HOST ADDS OVER THE CHAIN PAGE'S. The controls on this page are richer
 * than a radio group: the station picker is a reka-ui combobox whose list lives in
 * a `Teleport`, and the text fields are `v-model`ed native inputs, which read
 * `el.value` and call `el.getRootNode()`. So the host knows how to resolve a
 * teleport target (`querySelector`), and a node here carries the few DOM-ish
 * accessors runtime-dom's own `vModelText` reaches for. `Document` and `ShadowRoot`
 * are stubbed as classes this node is not an instance of, which is what makes
 * `vModelText`'s focus guard a no-op rather than a crash.
 *
 * `fetch` is the seam. The page and the store it calls both go through it, so the
 * harness records every request (url, method, parsed body) and answers each route
 * from a responder the test supplies.
 */

/**
 * The document the host's nodes belong to, wired per mount so `defaultView` is the
 * window stub. `@floating-ui/vue` reads `element.ownerDocument.defaultView` before
 * it will look at anything else.
 */
let hostDocument: Record<string, any> | null = null

/**
 * One rendered node. DOM-ish on purpose: reka-ui reaches for `closest`, `focus` and
 * `instanceof Element`, and native controls are read through `value` and `tagName`.
 */
export class HostElement {
  tag: string
  text: string
  props: Record<string, any>
  children: HostElement[]
  parent: HostElement | null
  nodeType = 1
  private readonly live = new Map<string, any>()
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

  get tagName(): string {
    return this.tag.toUpperCase()
  }

  /** The `type` attribute a real control carries, read by `vModelText`'s dispatch. */
  get type(): string {
    return this.props.type === undefined ? '' : String(this.props.type)
  }

  /** The live value of a native control — what a `v-model` reads and writes. */
  get value(): string {
    const own = this.live.get('value')
    if (own !== undefined) return String(own)
    return this.props.value === undefined ? '' : String(this.props.value)
  }

  set value(next: unknown) {
    this.live.set('value', next)
    this.props.value = next
  }

  /**
   * The node's root. Deliberately NOT a `Document`, so `vModelText`'s guard about
   * the focused element is skipped: this host has no document and no focus.
   */
  getRootNode(): unknown {
    return this
  }

  /**
   * The parent, under the name DOM libraries walk. floating-ui's popper climbs
   * `parentNode` to find the overflow ancestors it must watch, so a tree with only
   * a `parent` link reads as a detached node and falls through to `window.document`.
   */
  get parentNode(): HostElement | null {
    return this.parent
  }

  get ownerDocument(): Record<string, any> | null {
    return hostDocument
  }

  /** Inline styles, with the two methods a popper writes CSS variables through. */
  style: Record<string, any> = {
    setProperty(name: string, value: unknown): void { (this as any)[name] = value },
    removeProperty(name: string): void { delete (this as any)[name] },
    getPropertyValue(name: string): string { return String((this as any)[name] ?? '') },
  }

  offsetParent: HostElement | null = null

  /** No layout here: a zero rect is what "unmeasured" means to a popper. */
  getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  scrollIntoView(): void {}

  /** Nothing this page renders sits inside a form, so there is no ancestor to walk. */
  closest(): null {
    return null
  }

  contains(): boolean {
    return false
  }

  /** No tree to search: the drag library asks on teardown, and nothing is draggable here. */
  querySelector(): null {
    return null
  }

  querySelectorAll(): HostElement[] {
    return []
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
   * Fire an event at this node, the way a browser delivers one: listeners registered
   * through `addEventListener` receive an event carrying the target, and the three
   * methods a dismissable layer or a `v-model` handler reaches for.
   */
  dispatchEvent(event: { type: string, target?: unknown, [key: string]: unknown }): boolean {
    let prevented = false
    const delivered = {
      ...event,
      target: event.target ?? this,
      currentTarget: this,
      preventDefault: () => { prevented = true },
      stopPropagation: () => {},
      get defaultPrevented() { return prevented },
    }
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(delivered)
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
      if (item.tag === '#static') return staticText(item.text)
      return item.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
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

/** Answer a route with a specific status — a 400 is how the contract refuses a write. */
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

/**
 * A window as far as this page reaches for one.
 *
 * Two things on this page need it and neither needs a renderer: the popper that
 * positions the station picker's popup (which watches scroll and resize ancestors,
 * so it wants `getComputedStyle`, observers and the document element), and
 * `@vueuse/core`'s `useMediaQuery`, which the settings page uses to place the
 * commute-hours card in the xl side rail. Both are answered with inert stubs —
 * nothing here measures, and nothing here listens.
 */
function createWindowStub(body: HostElement): Record<string, unknown> {
  const documentStub = {
    documentElement: new HostElement('html'),
    body,
    activeElement: null,
    createElement: (tag: string) => new HostElement(tag),
    createTextNode: (text: string) => new HostElement('#text', text),
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    // reka-ui's focus scope walks the document for tabbable nodes. Nothing here is
    // tabbable, so the walk ends immediately — the node filter must still exist,
    // because the walker's arguments are evaluated before the call.
    createTreeWalker: () => ({
      currentNode: null,
      nextNode: () => null,
      previousNode: () => null,
    }),
  }
  const observer = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return [] }
  }
  const ShadowRootStub = class ShadowRootStub {}
  return {
    document: documentStub,
    // floating-ui reaches for these through whichever window a node belongs to,
    // so the same classes are here as on the global. Nothing here is a real DOM:
    // they exist to answer `instanceof`, which is all that library asks of them.
    Node: HostElement,
    Element: HostElement,
    HTMLElement: HostElement,
    ShadowRoot: ShadowRootStub,
    Document: class DocumentStub {},
    // Mobile first: below the xl breakpoint, which is the base layout.
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
    getComputedStyle: () => ({
      overflow: 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
      position: 'static',
      getPropertyValue: () => '',
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    ResizeObserver: observer,
    IntersectionObserver: observer,
    MutationObserver: observer,
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: any) => clearTimeout(handle),
    visualViewport: undefined,
    devicePixelRatio: 1,
    innerWidth: 390,
    innerHeight: 844,
    location: { protocol: 'http:', host: 'localhost' },
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

export interface Host {
  root: HostElement
  /** Where a reka-ui portal mounts: the teleport target `querySelector` resolves. */
  body: HostElement
}

/** Vue's runtime-core, rendered into `HostElement`s instead of a document. */
function createHostRenderer(body: HostElement): Renderer<HostElement> {
  const renderer: Renderer<HostElement> = createRenderer<HostElement, HostElement>({
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
    // The teleport target. Everything else resolves to nothing, which is what a
    // missing selector means.
    querySelector: selector => (String(selector) === 'body' ? body : null),
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
  return renderer
}

/** One route: the requests it answers, and the answer it gives. */
export type Route = [RegExp, Responder]

/** A mount, with the two trees a component can render into. */
export interface MountedHost {
  root: HostElement
  body: HostElement
  server: MockServer
  store: ReturnType<typeof useTransitStore>
  city: ReturnType<typeof useCityStore>
  /** Everything the mount renders, portal included, whitespace-normalised. */
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
  /**
   * Props for the component under test, for the pages that are presentational and read
   * everything they show off a prop (`empty-state.vue`, `chain-empty-state.vue`).
   */
  props?: Record<string, unknown>
  /**
   * Components the app registers globally, so a template that renders one can be mounted
   * here: 设置's index and its four sub-pages render `RouterLink`, and what a test reads
   * from one is the DESTINATION it was given (`RouterLinkStub`).
   */
  components?: Record<string, Component>
}

/**
 * `RouterLink` as this host can render it: the `to` it is given, as the `href` a browser
 * would follow.
 *
 * There is no router behind this host and nothing here navigates — which is exactly the
 * half of 设置's pointers a test can hold. Whether a path is the RIGHT one is a claim
 * about the route table (asserted against `router/index.ts`), and whether the link is lit
 * is the controller's browser pass; what a link was pointed at is read here.
 */
export const RouterLinkStub: Component = {
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
}

/** A page with one route should not have to wrap it in a list. */
function routeList(routes: Route | Route[] | undefined): Route[] {
  if (!routes) return []
  return routes[0] instanceof RegExp ? [routes as Route] : routes as Route[]
}

/**
 * Mount any component the way the settings page is mounted.
 *
 * What the component renders into is a host tree and a teleport target, never a
 * document — so a portalled popup is reachable by the same `nodes()` lookup as
 * anything else, and `text()` reads both trees as what the user sees.
 */
export async function mountComponent(component: Component, options: MountOptions = {}): Promise<MountedHost> {
  const server = new MockServer()
  for (const [pattern, respond] of routeList(options.routes)) server.on(pattern, respond)
  const teleportTarget = new HostElement('body')
  const windowStub = createWindowStub(teleportTarget)
  // A node's own document, whose `defaultView` is that same window.
  ;(windowStub.document as Record<string, any>).defaultView = windowStub
  hostDocument = windowStub.document as Record<string, any>
  vi.stubGlobal('fetch', server.handle)
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('document', windowStub.document)
  // reka-ui tests `ref instanceof Element`, and runtime-dom's `vModelText` asks
  // whether a node's root is a Document or a ShadowRoot.
  vi.stubGlobal('Element', HostElement)
  vi.stubGlobal('Node', HostElement)
  vi.stubGlobal('HTMLElement', HostElement)
  // A class this host's nodes are NOT instances of: reka-ui only selects a text
  // input it recognises, and nothing here is one.
  vi.stubGlobal('HTMLInputElement', class HTMLInputElementStub {})
  vi.stubGlobal('Document', class DocumentStub {})
  vi.stubGlobal('ShadowRoot', class ShadowRootStub {})
  // Called bare by floating-ui, which asks whether an ancestor scrolls.
  // Called bare by @vueuse's interval/media helpers, which the page's own layout
  // watcher uses.
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (handle: any) => clearTimeout(handle))
  vi.stubGlobal('NodeFilter', {
    SHOW_ALL: 0xFFFFFFFF,
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    SHOW_COMMENT: 128,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  })
  vi.stubGlobal('getComputedStyle', () => ({
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible',
    display: 'block',
    position: 'static',
    getPropertyValue: () => '',
  }))
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

  const renderer = createHostRenderer(teleportTarget)
  const container = new HostElement('#root')
  const app = renderer.createApp(component, options.props ?? {})
  app.use(pinia)
  for (const [name, registered] of Object.entries(options.components ?? {})) {
    app.component(name, registered)
  }
  // Vitest transforms modules through Vite's pipeline, so an SFC's compiled wrapper
  // reaches for `useSSRContext()`. Handing it an empty context keeps the component
  // mounting in this host instead of into a server render it is not.
  app.provide(ssrContextKey, { modules: new Set<string>() })
  app.mount(container)

  const mounted: MountedHost = {
    root: container,
    body: teleportTarget,
    server,
    store: useTransitStore(),
    city: useCityStore(),
    text: () => `${textOf(container)} ${textOf(teleportTarget)}`,
    textOf: node => textOf(node),
    nodes: where => [...walk(container), ...walk(teleportTarget)].filter(where),
    node: (where, description) => {
      const found = [...walk(container), ...walk(teleportTarget)].find(where)
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

  await mounted.flush()
  return mounted
}

/**
 * Click a rendered element, with the event shape a real click carries: reka-ui reads
 * `target`, `preventDefault` and `defaultPrevented` off it.
 *
 * EVERY handler runs, not just the first: when a component binds `onClick` AND the screen
 * binding it binds one too (every reka-ui trigger on this page), Vue stores both in an
 * array, and calling the array directly is how a test turns into `onClick is not a
 * function` instead of a click.
 */
export function click(element: HostElement): void {
  let prevented = false
  const onClick = element.props.onClick
  const handlers = Array.isArray(onClick) ? onClick : [onClick]
  const event = {
    type: 'click',
    target: element,
    currentTarget: element,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
    stopPropagation: () => {},
  }
  for (const handler of handlers) handler?.(event)
}

/**
 * Submit the form a control sits in, the way a browser does when a submit control is
 * pressed.
 *
 * This host is not a browser, so nothing fires the form's own `submit` for it: a
 * template that binds its save to `@submit.prevent` would read as a dead button here
 * and the test would "pass" against a screen where pressing save does nothing at all.
 */
function submitForm(element: HostElement): void {
  let form: HostElement | null = element
  while (form && form.tag !== 'form') form = form.parent
  if (!form) return
  let prevented = false
  form.props.onSubmit?.({
    type: 'submit',
    target: form,
    currentTarget: form,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
    stopPropagation: () => {},
  })
}

/** Press a control the way a user does, then let the render settle. */
export async function press(host: MountedHost, element: HostElement): Promise<void> {
  click(element)
  if (String(element.props.type ?? '') === 'submit') submitForm(element)
  await host.flush()
}

/**
 * Type into a native text field: set the value, then let the field read it.
 *
 * Both ways a template can bind one are served — `v-model` registers its own
 * listener through the element (`addEventListener`), while a plain `@input`
 * arrives as the element's `onInput` prop — so a component written either way is
 * driven the same way by a test.
 */
export async function type(host: MountedHost, element: HostElement, text: string): Promise<void> {
  element.value = text
  element.props.onInput?.({ type: 'input', target: element })
  element.dispatchEvent({ type: 'input', target: element })
  await host.flush()
}

/** Choose an option of a native select, the way selecting one reports it. */
export async function choose(host: MountedHost, element: HostElement, value: string): Promise<void> {
  element.value = value
  element.props.onChange?.({ type: 'change', target: element })
  element.dispatchEvent({ type: 'change', target: element })
  await host.flush()
}
