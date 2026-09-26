import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { vi } from 'vitest'
import ChainPage from '../index.vue'
import { useTransitStore } from '@/stores/transit.store'
import { useCityStore } from '@/stores/city.store'

/**
 * 链路页的无 DOM 挂载，使页面自身的接线可按**行为**而非 grep 源码来测试。
 *
 * 本仓库没有 DOM 测试台（无 jsdom、无 `@vue/test-utils`），本文件也不新增：Vue 的 runtime-core
 * 被交给一个把树保存为普通对象的宿主，而非触碰 document。这已足够读取本页行为所需的一切——
 * 渲染出的树、子组件发出的事件、以及它发出的请求——不新增依赖、不设全局测试装置。
 *
 * 提供两个全局是因为页面的单选组是 reka-ui（面向真实 DOM 编写）：`Element`（其 `forwardRef`
 * 检测 `ref instanceof Element`）与 `localStorage`（city store 在创建时读取它）。两者在此打桩；
 * 测试文件负责取消打桩。
 *
 * `fetch` 是接缝。页面与它调用的 store 都经由它，故本装置记录每个请求（url、method、解析后的 body）
 * 并按键由测试提供的 responder 作答。responder 可交回一个 `deferred()`，使测试能挂起一个答案、
 * 按乱序释放——这是看到旧答案与更新的答案相竞的唯一方式。
 */

/**
 * 一个渲染节点。它刻意 DOM 化：reka-ui 的单选组会对其渲染物取 `closest`、`focus`
 * 与 `instanceof Element`。
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

  /** 本页渲染的任何内容都不在 form 内，故没有祖先可走。 */
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
   * reka-ui 的单选在点击目标上派发自己的 `CustomEvent` 并就地监听，
   * 故一次点击需要一个能持有监听器的目标。
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
      // 节点要么持有子节点、要么持有自己的文本，不会两者兼有：
      // `setElementText` 就是 Vue 渲染整体内容为单个字符串的元素的方式。
      if (item.tag === '#static') return staticText(item.text)
      return item.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 由测试自行兑现的 promise，使一个答案可按需释放。 */
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

/** 以特定状态应答一个路由——窗口拒绝一次按下用的是 429。 */
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

/** Vue 的 runtime-core，渲染进 `HostElement` 而非 document。 */
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
  /** 页面的可见文本，已归一化空白。 */
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
}

/** 一个路由：它应答的请求，以及它给出的答案。 */
export type Route = [RegExp, Responder]

/** 只有一个路由的页面不该被迫把它包成列表。 */
function routeList(routes: Route | Route[] | undefined): Route[] {
  if (!routes) return []
  return routes[0] instanceof RegExp ? [routes as Route] : routes as Route[]
}

/**
 * 挂载链路页并由 `routes` 应答其请求。
 *
 * 测试未提供的路由答 `{ success: false }`，这正是页面自己的失败路径必须处理的——故缺失的路由
 * 表现为它产生的状态，而不是一次崩溃。
 */
export async function mountChainPage(options: MountOptions = {}): Promise<MountedChainPage> {
  const server = new MockServer()
  for (const [pattern, respond] of routeList(options.routes)) server.on(pattern, respond)
  vi.stubGlobal('fetch', server.handle)
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('Element', HostElement)
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

  const renderer = createHostRenderer()
  const container = new HostElement('#root')
  const app = renderer.createApp(ChainPage as Component)
  app.use(pinia)
  // Vitest 经 Vite 管线转换模块，故 SFC 的编译包装器会取 `useSSRContext()`。给它一个空上下文，
  // 使组件挂载于本宿主而非一个它并不属于的服务端渲染。
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
 * 刷新控件：本页唯一的 F11 入口。
 *
 * 按它所在的 section 而非某个 class 定位，使该选择器不会被页面日后长出的其他 44px 控件满足
 * （目的单选本身也是各自带触摸目标高度的按钮）。
 */
export function refreshButton(page: MountedChainPage): HostElement {
  const section = page.node(item => item.props['aria-label'] === '数据刷新', 'refresh section')
  const button = walk(section).find(item => item.tag === 'button')
  if (!button) throw new Error('the refresh section holds no button')
  return button
}

/**
 * 点击一个渲染元素，带真实点击所携带的事件形状：reka-ui 的单选会从它读取 `target`、
 * `preventDefault` 与 `defaultPrevented`。
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

/** 像用户那样按下刷新控件——被禁用的控件不可点击。 */
export async function pressRefresh(page: MountedChainPage): Promise<void> {
  const button = refreshButton(page)
  if (button.props.disabled) {
    throw new Error('the page\'s refresh control is disabled: it names no line to re-read')
  }
  click(button)
  await page.flush()
}

/** 上次刷新请求点名的每条线路，拍平以便比较。 */
export function refreshedLines(page: MountedChainPage): string[] {
  const posted = page.server.seen(/\/api\/transit\/refresh$/).at(-1)
  if (!posted) throw new Error('the page made no refresh request')
  return (posted.body?.lines ?? []).map((line: any) => `${line.lineId}_${line.direction}@${line.cityCode}`)
}

/** 目的单选，按页面渲染它们的顺序。 */
export function purposeRadios(page: MountedChainPage): HostElement[] {
  return page.nodes(item => item.props.role === 'radio')
}

/** 像用户那样点击单选来选一个目的。 */
export async function pickPurpose(page: MountedChainPage, purpose: string): Promise<void> {
  const radio = purposeRadios(page).find(item => item.props.value === purpose)
  if (!radio) throw new Error(`the page rendered no ${purpose} radio`)
  click(radio)
  await page.flush()
}
