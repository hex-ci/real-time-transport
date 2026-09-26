import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue'
import type { Renderer } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'

/**
 * `设置` 页的无 DOM 挂载，使通勤链路卡的行为可按驱动屏幕而非 grep 源码来测试。
 *
 * 本仓库没有 DOM 测试台（无 jsdom、无 `@vue/test-utils`），本文件也不新增：Vue 的 runtime-core
 * 被交给一个把树保存为普通对象的宿主，而非触碰 document。这已足够读取该卡行为所需的一切——渲染出的树、
 * 其控件收到的事件、以及它发出的请求——不新增依赖、不设全局测试装置。
 *
 * 本宿主比链路页的多了什么。本页的控件比一个单选组更丰富：选站器是 reka-ui 组合框，其列表位于 `Teleport` 中；
 * 文本字段是 `v-model` 的原生输入，会读 `el.value` 并调用 `el.getRootNode()`。故宿主知道如何解析
 * teleport 目标（`querySelector`），且此处的节点携带 runtime-dom 自己的 `vModelText` 所取用的少数
 * DOM 式访问器。`Document` 与 `ShadowRoot` 被打桩为本节点并非其实例的类，这使 `vModelText` 的焦点守卫
 * 成为空操作而非崩溃。
 *
 * `fetch` 是接缝。页面与它调用的 store 都经由它，故装置记录每个请求（url、method、解析后的 body）
 * 并按键由测试提供的 responder 作答。
 */

/**
 * 宿主节点所属的 document，按挂载接线，使 `defaultView` 是那个 window 桩。
 * `@floating-ui/vue` 会先读 `element.ownerDocument.defaultView` 才看别的。
 */
let hostDocument: Record<string, any> | null = null

/**
 * 一个渲染节点。刻意 DOM 化：reka-ui 会取 `closest`、`focus` 与 `instanceof Element`，
 * 而原生控件通过 `value` 与 `tagName` 读取。
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

  /** 真实控件携带的 `type` 属性，由 `vModelText` 的派发读取。 */
  get type(): string {
    return this.props.type === undefined ? '' : String(this.props.type)
  }

  /** 原生控件的活值——`v-model` 所读写的东西。 */
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
   * 节点的根。刻意**不是** `Document`，使 `vModelText` 关于焦点元素的守卫被跳过：
   * 本宿主没有 document、没有焦点。
   */
  getRootNode(): unknown {
    return this
  }

  /**
   * 父节点，用 DOM 库所遍历的那个名字。floating-ui 的 popper 会爬 `parentNode` 找它必须观察的
   * 溢出祖先，故只有 `parent` 链接的树会被读成脱离的节点并落到 `window.document`。
   */
  get parentNode(): HostElement | null {
    return this.parent
  }

  get ownerDocument(): Record<string, any> | null {
    return hostDocument
  }

  /** 内联样式，含 popper 写 CSS 变量所用的两个方法。 */
  style: Record<string, any> = {
    setProperty(name: string, value: unknown): void { (this as any)[name] = value },
    removeProperty(name: string): void { delete (this as any)[name] },
    getPropertyValue(name: string): string { return String((this as any)[name] ?? '') },
  }

  offsetParent: HostElement | null = null

  /** 此处无布局：零矩形就是 popper 眼中「未测量」的意思。 */
  getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  scrollIntoView(): void {}

  /** 本页渲染的任何内容都不在 form 内，故没有祖先可走。 */
  closest(): null {
    return null
  }

  contains(): boolean {
    return false
  }

  /** 没有树可搜：拖拽库在拆卸时询问，而此处没有可拖拽的东西。 */
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
   * 在此节点上触发一个事件，如浏览器投递事件那样：经 `addEventListener` 注册的监听器会收到携带
   * target 的事件，以及一个可关闭层或 `v-model` 处理器所取用的三个方法。
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

/** 树里的每个节点，按文档顺序。 */
function walk(root: HostElement): HostElement[] {
  const out: HostElement[] = []
  const visit = (current: HostElement): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(root)
  return out
}

/** 被提升的静态子树以原始 HTML 到达：按它显示的文本读取。 */
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

/** 页面（或它调用的 store）发出的一个请求。 */
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

/** 以特定状态应答一个路由——400 是契约拒绝一次写入的方式。 */
export function httpStatus(status: number, payload: unknown): HttpAnswer {
  return { status, payload, [HTTP_ANSWER]: true }
}

function isHttpAnswer(answer: unknown): answer is HttpAnswer {
  return typeof answer === 'object' && answer !== null && HTTP_ANSWER in answer
}

/** fetch 接缝：路由，以及它见过的每个请求。 */
export class MockServer {
  readonly requests: RecordedRequest[] = []
  private readonly routes: Array<{ pattern: RegExp, respond: Responder }> = []

  on(pattern: RegExp, respond: Responder): this {
    this.routes.push({ pattern, respond })
    return this
  }

  /** url 匹配的每个请求，按顺序。 */
  seen(pattern: RegExp): RecordedRequest[] {
    return this.requests.filter(request => pattern.test(request.url))
  }

  handle = async (input: any, init?: any): Promise<unknown> => {
    const url = String(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const request: RecordedRequest = { url, method, body }
    this.requests.push(request)

    // 最近注册的匹配胜出，故测试可覆盖默认值。
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
 * 就本页所需而言的一个 window。
 *
 * 本页有两处需要它，且都不需要渲染器：定位选站器弹层的 popper（它观察滚动与尺寸变化的祖先，
 * 故需要 `getComputedStyle`、观察器与 document 元素），以及 `@vueuse/core` 的 `useMediaQuery`
 * ——设置页用它把通勤时段卡放在 xl 侧栏。两者都以惰性桩件应答——此处不测量，也不监听。
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
    // reka-ui 的焦点作用域会走 document 找可 tab 的节点。此处没有可 tab 的，故遍历立即结束
    // ——节点过滤器仍必须存在，因为遍历器的参数在调用前就被求值。
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
    // floating-ui 通过节点所属的那个 window 取用这些，故与全局上的是同一批类。
    // 此处没有真正的 DOM：它们存在只是为了应答 `instanceof`，那也是该库对它们的全部请求。
    Node: HostElement,
    Element: HostElement,
    HTMLElement: HostElement,
    ShadowRoot: ShadowRootStub,
    Document: class DocumentStub {},
    // 移动优先：xl 断点之下，即基础布局。
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

/** 恰好够 city store 用的 `localStorage`，它在创建时读取。 */
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
  /** reka-ui portal 挂载之处：`querySelector` 解析的 teleport 目标。 */
  body: HostElement
}

/** Vue 的 runtime-core，渲染进 `HostElement` 而非 document。 */
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
    // teleport 目标。其余一切解析为空，这也是选择器缺失的含义。
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

/** 一个路由：它应答的请求，以及它给出的答案。 */
export type Route = [RegExp, Responder]

/** 一次挂载，含组件可渲染进的两棵树。 */
export interface MountedHost {
  root: HostElement
  body: HostElement
  server: MockServer
  store: ReturnType<typeof useTransitStore>
  city: ReturnType<typeof useCityStore>
  /** 挂载所渲染的一切，含 portal，已归一化空白。 */
  text(): string
  /** 某个渲染节点的可见文本，方式相同。 */
  textOf(node: HostElement): string
  /** 所有匹配谓词的渲染节点，按文档顺序。 */
  nodes(where: (node: HostElement) => boolean): HostElement[]
  /** 首个匹配的节点，或一个点名所寻之物的错误。 */
  node(where: (node: HostElement) => boolean, description: string): HostElement
  /** 让所有挂起的 promise 与重渲染落定。 */
  flush(): Promise<void>
  unmount(): void
}

export interface MountOptions {
  /** 路由，按顺序尝试（最后一个匹配胜出）。一个路由，或它们的一个列表。 */
  routes?: Route | Route[]
  /**
   * 被测组件的 props，供那些纯展示、一切皆取自 prop 的页面使用（`empty-state.vue`、`chain-empty-state.vue`）。
   */
  props?: Record<string, unknown>
  /**
   * 应用全局注册的组件，使渲染它们的模板能在此挂载：`设置` 的索引与四个子页面渲染 `RouterLink`，
   * 而测试从它读到的，是它被给到的**目标**（`RouterLinkStub`）。
   */
  components?: Record<string, Component>
}

/**
 * `RouterLink` 在本宿主可渲染的样子：它被给到的 `to`，即浏览器会跟随的 `href`。
 *
 * 本宿主背后没有路由，此处什么都不导航——而这正是 `设置` 指针中测试能持有的一半。某个路径是否**正确**
 * 是对路由表的断言（对 `router/index.ts` 断言），链接是否点亮是控制器的浏览器侧；此处读取的是一个链接被指向了哪里。
 */
export const RouterLinkStub: Component = {
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
}

/** 只有一个路由的页面不该被迫把它包成列表。 */
function routeList(routes: Route | Route[] | undefined): Route[] {
  if (!routes) return []
  return routes[0] instanceof RegExp ? [routes as Route] : routes as Route[]
}

/**
 * 按设置页被挂载的方式挂载任意组件。
 *
 * 组件渲染进的是一个宿主树与一个 teleport 目标，绝不是 document——故 portal 出的弹层与别的东西一样
 * 可被同一个 `nodes()` 查到，且 `text()` 把两棵树都读作用户所见。
 */
export async function mountComponent(component: Component, options: MountOptions = {}): Promise<MountedHost> {
  const server = new MockServer()
  for (const [pattern, respond] of routeList(options.routes)) server.on(pattern, respond)
  const teleportTarget = new HostElement('body')
  const windowStub = createWindowStub(teleportTarget)
  // 节点自己的 document，其 `defaultView` 即同一个 window。
  ;(windowStub.document as Record<string, any>).defaultView = windowStub
  hostDocument = windowStub.document as Record<string, any>
  vi.stubGlobal('fetch', server.handle)
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('document', windowStub.document)
  // reka-ui 测试 `ref instanceof Element`，而 runtime-dom 的 `vModelText` 会问
  // 一个节点的根是不是 Document 或 ShadowRoot。
  vi.stubGlobal('Element', HostElement)
  vi.stubGlobal('Node', HostElement)
  vi.stubGlobal('HTMLElement', HostElement)
  // 本宿主节点**不是**其实例的类：reka-ui 只选择它所识别的文本输入，而此处没有一个是。
  vi.stubGlobal('HTMLInputElement', class HTMLInputElementStub {})
  vi.stubGlobal('Document', class DocumentStub {})
  vi.stubGlobal('ShadowRoot', class ShadowRootStub {})
  // 由 floating-ui 裸调用，它问某个祖先是否滚动。
  // 由 @vueuse 的 interval/media helper 裸调用，页面自己的布局观察器用它们。
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
  // reka-ui 的单选会在被点击元素上派发其中一个。
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
  // Vitest 经 Vite 管线转换模块，故 SFC 的编译包装器会取 `useSSRContext()`。
  // 给它一个空上下文，使组件挂载于本宿主而非一个它并不属于的服务端渲染。
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
 * 点击一个渲染元素，带真实点击所携带的事件形状：reka-ui 会从它读取 `target`、`preventDefault`
 * 与 `defaultPrevented`。
 *
 * **每个**处理器都会运行，不只是第一个：当组件绑定 `onClick` **且**绑定它的屏幕也绑定时（本页每个
 * reka-ui 触发器都是），Vue 把两者存进一个数组，直接调用该数组会让测试变成 `onClick is not a function` 而非一次点击。
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
 * 按浏览器在按下提交控件时的方式提交某控件所在的表单。
 *
 * 本宿主不是浏览器，故没有东西为它触发表单自己的 `submit`：把保存绑到 `@submit.prevent` 的模板在此
 * 会读成一个死按钮，测试会对一个「按下保存什么也不发生」的屏幕「通过」。
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

/** 像用户那样按一个控件，然后让渲染落定。 */
export async function press(host: MountedHost, element: HostElement): Promise<void> {
  click(element)
  if (String(element.props.type ?? '') === 'submit') submitForm(element)
  await host.flush()
}

/**
 * 向原生文本字段输入：设置该值，然后让字段读取它。
 *
 * 模板可以绑定它的两种方式都被服务——`v-model` 经元素注册自己的监听器（`addEventListener`），
 * 而纯 `@input` 作为元素的 `onInput` prop 到达——故以任一方式写的组件都被测试同样地驱动。
 */
export async function type(host: MountedHost, element: HostElement, text: string): Promise<void> {
  element.value = text
  element.props.onInput?.({ type: 'input', target: element })
  element.dispatchEvent({ type: 'input', target: element })
  await host.flush()
}

/** 选择原生 select 的一个选项，如选中一个所上报的那样。 */
export async function choose(host: MountedHost, element: HostElement, value: string): Promise<void> {
  element.value = value
  element.props.onChange?.({ type: 'change', target: element })
  element.dispatchEvent({ type: 'change', target: element })
  await host.flush()
}
