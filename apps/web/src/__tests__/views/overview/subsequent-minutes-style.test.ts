import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRenderer, nextTick, ssrContextKey, type Component } from 'vue'
import { describe, expect, it } from 'vitest'
import LineMiniCard from '../../../views/overview/components/line-mini-card.vue'
import type { CardRowWithArrivals } from '../../../views/overview/types'

/**
 * 后续车次的分钟数与主分钟的关系。
 *
 * 后续那几班同样是要等的车，故它们与主分钟**同色同字重**，只用字号分层 —— 而不是像先前那样
 * 用灰色（`text-slate-300` / 400 字重）把它压成注释。反过来，字号也不能无限大：它是量出来的，
 * 16px 在 375 上每行仍站得下与原来同样多的车，再大一档就少一辆（见下方那条排版约束）。
 *
 * 经 Vue 的 runtime-core 渲染为普通对象，与同目录其他卡片测试同一套装置：无 jsdom、
 * 无 `@vue/test-utils`。
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

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

function row(direction: 0 | 1, arrivals: CardRowWithArrivals['arrivals']): CardRowWithArrivals {
  return { lineId: 'bus_027_1', direction, stopOrder: 3, directionName: '开往终点站', arrivals }
}

function readFeed(minutes: number[]) {
  return {
    state: 'read' as const,
    value: {
      arrivals: minutes.map((m, i) => ({
        busId: `b${i}`, time: `20:${String(10 + i * 6).padStart(2, '0')}`,
        stopsAway: i + 1, distanceMeters: 700 + i * 900, etaSeconds: m * 60,
      })),
      operatingStatus: { state: 'operating' as const, firstDeparture: '05:30', lastDeparture: '23:00' },
      reference: null,
    },
  }
}

/** 渲染一张有多班后续车的通勤卡片，交回它的节点树。 */
async function renderCard(): Promise<HostElement> {
  const renderer = createHostRenderer()
  const container = new HostElement('#root')
  const app = renderer.createApp(LineMiniCard as Component, {
    lineName: '52',
    directionName: '开往终点站',
    detailHref: '/line/bus_027_1?direction=0&cityCode=027',
    stopName: '测试站',
    stopDistanceMeters: null,
    legState: null,
    nearbyLocation: 'fix',
    rows: [row(0, readFeed([2, 8, 15, 23]))],
    mode: 'morning',
    detailLoaded: true,
    isSubway: false,
    isPinned: false,
  })
  app.provide(ssrContextKey, { modules: new Set<string>() })
  app.mount(container)
  await nextTick()
  return container
}

/** 后续块里每一辆车的分钟数那一格。 */
function subsequentMinutes(root: HostElement): HostElement[] {
  const block = walk(root).find(node => node.tag === 'div' && textOf(node).startsWith('后续'))
  if (!block) return []
  return walk(block).filter(node => node.tag === 'span' && /^\d+分$/.test(node.text))
}

function textOf(root: HostElement): string {
  return walk(root)
    .map((node) => {
      if (node.tag === '#static') return node.text.replace(/<[^>]*>/g, ' ')
      return node.text
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('后续车次的分钟数与主分钟同一套颜色', () => {
  it('renders one minute cell per following bus', async () => {
    const minutes = subsequentMinutes(await renderCard())
    expect(minutes.map(node => node.text)).toEqual(['8分', '15分', '23分'])
  })

  it('paints them with the same accent token as the leading minute, not a grey', async () => {
    const root = await renderCard()
    const minutes = subsequentMinutes(root)
    expect(minutes.length).toBeGreaterThan(0)

    // 同一套强调色：公交是青（`text-cyan-400`），与首行那个大分钟数解析出的是同一个值 ——
    // `:class="accent.etaText"` 渲染后就是这个类名。先前这里是灰（`text-slate-300`）。
    for (const node of minutes) {
      const cls = String(node.props.class ?? '')
      expect(cls, 'a following minute lost the accent colour').toContain('text-cyan-400')
      expect(cls, 'a following minute fell back to a grey').not.toContain('text-slate-')
      // 与主分钟同字重：先前是 400，那等于没有重量。
      expect(cls).toContain('font-black')
    }

    // 而它与主分钟确实是同一个令牌：地铁卡片下两处都解析成琥珀。
    const renderer = createHostRenderer()
    const container = new HostElement('#root')
    const subway = renderer.createApp(LineMiniCard as Component, {
      lineName: '地铁 1 号线', directionName: '开往终点站', detailHref: '/line/subway_027_1?direction=0&cityCode=027',
      stopName: '测试站', stopDistanceMeters: null, legState: null, nearbyLocation: 'fix',
      rows: [row(0, readFeed([2, 8]))], mode: 'morning', detailLoaded: true, isSubway: true, isPinned: false,
    })
    subway.provide(ssrContextKey, { modules: new Set<string>() })
    subway.mount(container)
    await nextTick()
    const amber = subsequentMinutes(container)
    expect(amber.length).toBeGreaterThan(0)
    expect(String(amber[0]!.props.class)).toContain('text-amber-400')
  })

  it('keeps them a measured step below the leading minute, and no larger', async () => {
    const source = read('../../../views/overview/components/line-mini-card.vue')
    // 主分钟 24（text-2xl）；后续 16（text-base）。16 是量出来的边界：18 在 375 上每行少站一辆车
    // （实测 375 可用宽 293px：12px 与 16px 每行都站 3 辆，18px 起掉到 2 辆）。
    expect(source).toContain('font-mono text-2xl font-black')

    // 后续那一格：取 `statedArrivalMinutes(a)` 旁边的那一处类名来断言，避免误伤别的元素。
    const cell = source.match(/class="(font-mono [^"]*)"[^>]*>\{\{ statedArrivalMinutes\(a\) \}\}分/)
      ?? source.match(/class="(font-mono [^"]*)"[^>]*\{\{ statedArrivalMinutes\(a\) \}\}/)
    expect(cell, 'the following minute cell is gone').not.toBeNull()
    expect(cell![1]).toContain('text-base')
    expect(cell![1]).toContain('font-black')
    expect(cell![1], 'the following minutes grew past the measured boundary').not.toContain('text-lg')
    expect(cell![1], 'the following minutes grew past the measured boundary').not.toContain('text-xl')
  })
})
