import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
} from '../../views/settings/settings-harness'
import RefreshControl from '../../../components/refresh-control/main.vue'

/**
 * 本控件的两半（按钮与那一行读数）常分处页面上两处，故 `variant` 决定只渲染哪一半。
 *
 * 这里钉四件事：默认（`full`）的渲染是**一份**确定的树（下面那份快照；首页与线路页的桌面端用的就是它）、
 * `reading` 只出那一行字且不出按钮、`button` 只出按钮且描述指向另一半、以及按下仍然只发一次
 * `refresh` —— 拆两半不得把它变成两个可点入口。
 *
 * 本仓库没有 DOM 测试台，故经 `设置` 页那台无 DOM 宿主挂载（见 settings-harness.ts）。
 */

const FRESHNESS = '最后更新 14:03:21 · 实时'

/**
 * `full` 渲染出的那一棵树，按节点规范成文本（属性按名排序、函数值记为 `<fn>`）。
 *
 * 快照是逐字的，因为它要抓的正是「顺手改一下类名」这类漂移：这一次改动把状态行从控件里摘掉了，
 * 故这份树就是摘掉之后的形状。
 */
const FULL_GOLDEN: string[] = [
  'section aria-label="数据刷新" class="flex min-w-0 items-center gap-2 lg:gap-3"',
  'p class="min-w-0 flex-1 text-xs text-slate-400 lg:text-base" id="refresh-freshness" | 最后更新 14:03:21 · 实时',
  'button aria-busy=false aria-describedby="refresh-freshness" aria-label="刷新最新车况" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 transition active:scale-95" disabled=false onClick=<fn> type="button"',
  'svg aria-hidden="true" class="lucide lucide-refresh-cw h-4 w-4 shrink-0" fill="none" height=24 stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width=2 viewBox="0 0 24 24" width=24 xmlns="http://www.w3.org/2000/svg"',
  'path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"',
  'path d="M21 3v5h-5"',
  'path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"',
  'path d="M8 16H3v5"',
]

const PROPS = {
  refreshing: false,
  freshness: FRESHNESS,
  label: '刷新最新车况',
}

/** 空白与注释不进快照：它们是模板的排版，不是控件渲染出的东西。 */
function isStructural(node: HostElement): boolean {
  return !node.tag.startsWith('#')
}

/** 一棵渲染树，规范成与上面快照同样的文本。 */
function serialize(node: HostElement): string[] {
  const props = Object.entries(node.props)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${typeof value === 'function' ? '<fn>' : JSON.stringify(value)}`)
  const head = [node.tag, ...props].join(' ')
  return [
    node.text === '' ? head : `${head} | ${node.text}`,
    ...node.children.filter(isStructural).flatMap(serialize),
  ]
}

function rootOf(host: MountedHost): HostElement {
  // 模板里的空白也是一个节点，故第一个**元素**才是根本身。
  const root = host.root.children.find(child => !child.tag.startsWith('#'))
  if (!root) throw new Error('the control rendered no root element')
  return root
}

function buttons(host: MountedHost): HostElement[] {
  return host.nodes(node => node.tag === 'button')
}

/** 一个节点到根之间的所有祖先，最近的在前。 */
function ancestorsOf(node: HostElement): HostElement[] {
  const out: HostElement[] = []
  for (let current = node.parent; current; current = current.parent) out.push(current)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('variant 默认与 full：读数与按钮同处一块', () => {
  it('默认渲染就是那份快照', async () => {
    const host = await mountComponent(RefreshControl, { props: PROPS })
    expect(serialize(rootOf(host))).toEqual(FULL_GOLDEN)
    host.unmount()
  })

  it('显式 variant="full" 与默认是同一棵树', async () => {
    const implicit = await mountComponent(RefreshControl, { props: PROPS })
    const explicit = await mountComponent(RefreshControl, { props: { ...PROPS, variant: 'full' } })
    expect(serialize(rootOf(explicit))).toEqual(serialize(rootOf(implicit)))
    implicit.unmount()
    explicit.unmount()
  })

  it('两半都在，且按钮描述的那一行就在这一块里', async () => {
    const host = await mountComponent(RefreshControl, { props: PROPS })
    const region = host.node(node => node.props['aria-label'] === '数据刷新', 'refresh region')
    expect(host.nodes(node => node.props['aria-label'] === '数据刷新')).toHaveLength(1)
    expect(region.children.filter(child => child.tag === 'button')).toHaveLength(1)

    const button = buttons(host)[0]!
    for (const id of String(button.props['aria-describedby']).split(' ')) {
      const described = host.nodes(node => node.props.id === id)
      expect(described, `${id} is described but not rendered`).toHaveLength(1)
      // 被描述的那一行就在这枚按钮所在的区域里，故它确实是这枚按钮的说明。
      expect(ancestorsOf(described[0]!).includes(region), `${id} sits outside the refresh region`).toBe(true)
    }
    host.unmount()
  })
})

describe('variant=reading：只有那一行读数', () => {
  it('渲染那一行字，但不渲染任何按钮、也不取区域名', async () => {
    const host = await mountComponent(RefreshControl, { props: { ...PROPS, variant: 'reading' } })

    expect(host.text().trim()).toBe(FRESHNESS)
    // 拆两半不得拆出第二个可点入口：这一半一个都没有。
    expect(buttons(host)).toHaveLength(0)
    // 没有可点之物的那一半不叫「数据刷新」：否则同一块会被念两遍。
    expect(host.nodes(node => node.props['aria-label'] === '数据刷新')).toHaveLength(0)
    host.unmount()
  })

  it('页面给的类落在这一行字自己身上（行尾那个位置就靠它）', async () => {
    const host = await mountComponent(RefreshControl, {
      props: { ...PROPS, variant: 'reading', class: 'ml-auto shrink-0' },
    })

    const line = host.node(node => node.props.id === 'refresh-freshness', 'the reading')
    expect(String(line.props.class)).toContain('ml-auto')
    // 根就是这一行字，故没有任何一层外壳替它接这些类。
    expect(rootOf(host)).toBe(line)
    host.unmount()
  })

  it('页面的 idPrefix 照样作用在它上面，且量得到', async () => {
    const host = await mountComponent(RefreshControl, {
      props: { ...PROPS, variant: 'reading', idPrefix: 'm-' },
    })
    expect(host.nodes(node => node.props.id === 'm-refresh-freshness')).toHaveLength(1)
    expect(host.nodes(node => node.props.id === 'refresh-freshness')).toHaveLength(0)
    host.unmount()
  })
})

describe('variant=button：只有那枚按钮', () => {
  it('只出按钮：44×44、名字来自页面、区域名仍是这一块', async () => {
    const host = await mountComponent(RefreshControl, { props: { ...PROPS, variant: 'button' } })

    expect(buttons(host)).toHaveLength(1)
    const button = buttons(host)[0]!
    expect(String(button.props.class)).toContain('h-11')
    expect(String(button.props.class)).toContain('w-11')
    expect(button.props['aria-label']).toBe('刷新最新车况')
    // 区域名属于**两半同处一块**的那个实例：只有一枚按钮的这一半不是一块区域，
    // 否则同一个名字会在同一页上出现两次（那一行读数也算一块）。
    expect(host.nodes(node => node.props['aria-label'] === '数据刷新')).toHaveLength(0)
    // 那一行读数不在这一半里：它由另一半渲染，故这里的 id 一个都不该出现。
    expect(host.nodes(node => node.props.id === 'refresh-freshness')).toHaveLength(0)
    host.unmount()
  })

  it('按钮描述的是另一半的 id：同一个前缀就是两半之间的约定', async () => {
    const host = await mountComponent(RefreshControl, {
      props: { ...PROPS, variant: 'button', idPrefix: 'm-' },
    })
    expect(buttons(host)[0]!.props['aria-describedby']).toBe('m-refresh-freshness')
    host.unmount()
  })

  it('按下仍然只发一次 refresh', async () => {
    let presses = 0
    const host = await mountComponent(RefreshControl, {
      props: { ...PROPS, variant: 'button', onRefresh: () => { presses += 1 } },
    })
    await press(host, buttons(host)[0]!)
    expect(presses).toBe(1)
    host.unmount()
  })
})
