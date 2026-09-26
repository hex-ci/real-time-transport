import { createRenderer, nextTick, ssrContextKey, type Component } from 'vue'
import { describe, expect, it } from 'vitest'
import LineMiniCard from '../components/line-mini-card.vue'
import type { NearbyLocationState } from '../nearby-notice'

/**
 * 附近卡片在没有站台可报时实际渲染的内容。
 *
 * 值层面的用例在 `src/__tests__/nearby-notice.test.ts`；本文件守住文案单元测试看不到的一半——
 * 卡片为它被给到的状态**渲染**了该提示，使停止到达屏幕的 prop 名、绑定或分支在此而非浏览器里被抓到。
 *
 * 经 Vue 的 runtime-core 渲染为普通对象，与链路页的装置相同：本仓库没有 DOM 装置，本文件也不新增
 * ——无 jsdom、无 `@vue/test-utils`、无全局测试装置。
 */

/** 一个渲染节点，对 Vue 的宿主操作足够 DOM 化。 */
class HostElement {
  tag: string
  text: string
  props: Record<string, any> = {}
  children: HostElement[] = []
  parent: HostElement | null = null
  nodeType = 1

  constructor(tag: string, text = '') {
    this.tag = tag
    this.text = text
  }

  get nodeName(): string { return this.tag.toUpperCase() }
  closest(): null { return null }
  contains(): boolean { return false }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true }
  focus(): void {}
  blur(): void {}
  setAttribute(name: string, value: unknown): void { this.props[name] = value }
  getAttribute(name: string): unknown { return this.props[name] ?? null }
  hasAttribute(name: string): boolean { return name in this.props }
  removeAttribute(name: string): void { delete this.props[name] }
  get firstElementChild(): HostElement | null { return this.children[0] ?? null }
  get nextElementSibling(): HostElement | null {
    const parent = this.parent
    if (!parent) return null
    return parent.children[parent.children.indexOf(this) + 1] ?? null
  }
}

function walk(root: HostElement): HostElement[] {
  const out: HostElement[] = []
  const visit = (current: HostElement): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(root)
  return out
}

/** 卡片的可见文本，已归一化空白。 */
function textOf(root: HostElement): string {
  return walk(root)
    .map((node) => {
      // 被提升的静态子树以原始 HTML 到达：按它显示的文本读取。
      if (node.tag === '#static') return node.text.replace(/<[^>]*>/g, ' ')
      return node.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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

/** 在附近模式下渲染一张无行的卡片，交回它的可见文本。 */
async function renderNearbyCard(nearbyLocation: NearbyLocationState): Promise<string> {
  const renderer = createHostRenderer()
  const container = new HostElement('#root')
  const app = renderer.createApp(LineMiniCard as Component, {
    lineName: '1路',
    directionName: '开往终点站',
    stopName: null,
    stopDistanceMeters: null,
    legState: null,
    nearbyLocation,
    rows: [],
    mode: 'nearby',
    detailLoaded: true,
    isSubway: false,
    isPinned: false,
  })
  // Vitest 经 Vite 管线转换模块，故 SFC 的编译包装器会取 `useSSRContext()`：
  // 空上下文使它挂载在此。
  app.provide(ssrContextKey, { modules: new Set<string>() })
  app.mount(container)
  await nextTick()
  return textOf(container)
}

describe('the card renders the cause it was given, not a cause it guessed', () => {
  it('says to enable location only when there is no position at all', async () => {
    const text = await renderNearbyCard('absent')
    expect(text).toContain('开启定位后显示离你最近的站点车辆')
  })

  it('says a position is being acquired while one is on the way', async () => {
    const text = await renderNearbyCard('locating')
    expect(text).toContain('正在获取定位…')
    expect(text, 'the card told a waiting user to enable location').not.toContain('开启定位')
  })

  it('says this line has no platform nearby when a position exists', async () => {
    const text = await renderNearbyCard('fix')
    // 用户已授权定位且应用有定位：此处点名「开启定位」正是本缺陷的断言，
    // 而它由浏览器会用的同一个表达式渲染。
    expect(text).toContain('已定位，但附近没有该线路的站台')
    expect(text).not.toContain('开启定位')
  })

  it('says the browser cannot locate when it has no geolocation at all', async () => {
    const text = await renderNearbyCard('unsupported')
    // 此用户没有可开启的东西：能力是缺失而非被拒，故句子如此陈述并点名唯一能改变它的事。
    expect(text).toContain('当前浏览器不支持定位，请换用其他浏览器')
    expect(text, 'a browser with no geolocation was told to enable location')
      .not.toContain('开启定位')
  })

  it('drops the notice entirely once a platform resolves', async () => {
    const renderer = createHostRenderer()
    const container = new HostElement('#root')
    const app = renderer.createApp(LineMiniCard as Component, {
      lineName: '1路',
      directionName: '开往终点站',
      stopName: '乙站',
      stopDistanceMeters: null,
      legState: null,
      nearbyLocation: 'fix',
      rows: [
        { lineId: '010-1-0', direction: 0, stopOrder: 3, directionName: '开往终点站', arrivals: null },
      ],
      mode: 'nearby',
      detailLoaded: true,
      isSubway: false,
      isPinned: false,
    })
    app.provide(ssrContextKey, { modules: new Set<string>() })
    app.mount(container)
    await nextTick()

    const text = textOf(container)
    expect(text, 'a card with a platform still showed an empty state').not.toContain('已定位，但附近没有该线路的站台')
    expect(text).toContain('乙站')
  })
})
