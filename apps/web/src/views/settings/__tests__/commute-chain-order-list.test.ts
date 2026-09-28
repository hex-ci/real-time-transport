import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommuteChain } from '@real-time-transport/shared'
import ChainsPage from '../chains.vue'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'

/**
 * F10 链路列表的拖动排序，按用户看到的东西守住。
 *
 * 拖动唯一可以从**手柄**开始：整行可拖时，翻页的滑动与「编辑」的点按都会被读成一次拖拽的开始。
 * 手柄是移动端唯一的手指落点，故它是 44px 的触控目标，且有自己的可访问名字 —— 一个只有图标的
 * 无名按钮说不出它做什么。
 *
 * 列表本身渲染存储顺序（`displayOrder`），一条链路都不是从别处推导出来的：一次拖动改变的是它，
 * 一次新增落在这条列表的末尾。
 */

/** 文件还不存在时读为空串：本钉子先于实现立起，而缺席就是空。 */
function read(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  }
  catch {
    return ''
  }
}

/** 去掉说明性文字的文件，故被断言的是代码。 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 渲染这份列表的页面。拖动排序住在**列表页**（`/settings/chains`）上：编辑器搬到
 * `/settings/chains/new` 与 `/settings/chains/:chainId` 之后，列表与它的拖动留在这里
 * （见 `docs/PRD.md` §4.1「列表页与编辑页的分工」）。
 */
const LIST = read('../chains.vue')
const ORDER_LIST = read('../components/drag-order-list.vue')

function chain(id: string, displayOrder: number, name: string, createdAt = '2026-01-01T00:00:00.000Z'): CommuteChain {
  return {
    id,
    userId: 'default_user',
    name,
    purpose: 'morning',
    displayOrder,
    createdAt,
    legs: [{
      seq: 0,
      lineId: 'bus_027_1',
      lineName: '快线 1 路',
      cityCode: '027',
      boardStationName: '东大桥',
      boardStationOrder: 3,
      alightStationName: '建国门',
      alightStationOrder: 4,
      transferExtraMinutes: null,
      connectionMode: 'walk' as const,
    }],
  }
}

const CHAINS: CommuteChain[] = [
  chain('chain-1', 0, '早上上班'),
  chain('chain-2', 1, '下班回家'),
  chain('chain-3', 2, '接孩子'),
]

function routes(chains: CommuteChain[]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [] })],
    [/\/api\/transit\/settings/, () => ({
      success: true,
      data: { morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00', eveningEnd: '22:00' },
    })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: chains })],
    [/\/api\/transit\/commute-chains$/, request => ({
      // 新建：服务端按收到的那份内容作答，链路自己的 id 与服务端字段由它补上。
      success: true,
      data: { ...chain('chain-new', Number(request.body?.displayOrder ?? 0), String(request.body?.name ?? '新链路')), legs: [] },
    })],
    [/\/api\/transit\/commute-chains\/[^/]+$/, (request) => {
      const id = request.url.split('/').at(-1)!
      const known = chains.find(item => item.id === id) ?? chain(id, 0, '链路')
      return { success: true, data: { ...known, displayOrder: request.body?.displayOrder ?? known.displayOrder } }
    }],
  ]
}

async function mountChainList(chains: CommuteChain[] = CHAINS): Promise<MountedHost> {
  const host = await mountComponent(ChainsPage, {
    routes: routes(chains),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // reka-ui 的焦点作用域在卸载时排定一个定时器，而该定时器会读 document。
  // 让它在装置的桩件仍就位时触发。
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 每一行链路的手柄：唯一能开始一次拖拽的地方。 */
function handles(host: MountedHost): HostElement[] {
  return host.nodes(node => 'data-drag-handle' in node.props)
}

/** 列表里每行印出的名字，按渲染顺序 —— 行的名字是它印出的第一段文字。 */
function renderedNames(host: MountedHost): string[] {
  return host.nodes(node => node.tag === 'li').map(node => host.textOf(node).split(' ')[0]!)
}

describe('F10 链路列表由拖动排序', () => {
  it('每一行各有一个手柄，且手柄只落在它自己的行上', async () => {
    const host = await mountChainList()

    expect(handles(host)).toHaveLength(CHAINS.length)
    host.unmount()
  })

  it('手柄的触控目标不小于 44px，且是两个方向都够大的手指落点', async () => {
    const host = await mountChainList()

    // 必须先有手柄，下面每一条才有东西可量 —— 空循环会「通过」一个不存在的控件。
    const found = handles(host)
    expect(found, 'the rows render a drag handle, or this check has nothing to measure').toHaveLength(CHAINS.length)
    for (const handle of found) {
      // 手柄不再是按钮：它是**行内**的一个手指落点，点它不做任何事（`@click.stop` 只是不让
      // 那次按压冒泡成一次导航），而真正的导航由整行那个链接承担 —— 与关注线路列表同一套做法。
      expect(handle.tag).toBe('span')
      const classes = String(handle.props.class ?? '')
      // 移动端只有手指：手柄是唯一的手指落点，故两个方向都要够大。
      expect(classes, `the drag handle is smaller than the house touch target: ${classes}`)
        .toMatch(/min-h-\[44px\]|min-h-11|h-11/)
      expect(classes, `the drag handle is narrower than a finger: ${classes}`)
        .toMatch(/min-w-\[44px\]|min-w-11|w-11/)
      // 手指从手柄上开始的手势属于拖拽，不是页面的滚动。
      expect(classes).toContain('touch-none')
    }
    host.unmount()
  })

  it('手柄对读屏器是隐形的（拖动是纯指针手势），而行链接自己带着可访问名字', async () => {
    // 手柄从可访问树里被移出：它做的是拖拽，而那是屏幕阅读器用户没有的手势；
    // 把一个做不了的控件念出来只会多一个够不着的东西。这一行的名字由整行那个链接承担。
    const host = await mountChainList()

    const found = handles(host)
    expect(found, 'the rows render a drag handle, or this check has nothing to name').toHaveLength(CHAINS.length)
    for (const handle of found) {
      expect(String(handle.props['aria-hidden'])).toBe('true')
      // 指针用户仍要认得出它：`title` 说的是它做的事（「拖动调整顺序」），不是只有图标。
      expect(String(handle.props.title)).toContain('拖动')
      expect(String(handle.props.title)).toContain('顺序')
    }

    // 行链接：每一行的 `li` 里那一个。页面上另有「新增链路」那个链接，故按行取而不是按全页取。
    const rowLinks = host.nodes(item => item.tag === 'a' && item.parent?.tag === 'li')
    expect(rowLinks.length, 'the rows render no link to open').toBe(CHAINS.length)
    const names = rowLinks.map(link => host.textOf(link).trim())
    expect(names.filter(name => name === ''), 'a row link has no accessible name').toEqual([])
    host.unmount()
  })

  it('列表仍是带边框的一份 ul，行仍是它的 li', async () => {
    const host = await mountChainList()

    // 交给共用组件的不只是行：容器自己的标签与边框也必须照旧 —— 少了 `tag`，这层框与分隔线
    // 会挂在一摞 div 上，列表的语义也就没了。
    const list = host.node(node => node.tag === 'ul', 'the chain list')
    const classes = String(list.props.class ?? '')
    expect(classes).toContain('divide-y')
    expect(classes).toContain('border-slate-800')
    expect(host.nodes(node => node.tag === 'li')).toHaveLength(CHAINS.length)
    host.unmount()
  })

  it('手柄由与关注线路列表共用的那一份拖动实现提供', async () => {
    // 一份实现：卡片经同一个组件渲染它的行，而不是自己再接一遍拖拽库。
    expect(codeOf(LIST)).toContain('import { BackToSettings, DragOrderList } from \'./components\'')
    expect(codeOf(LIST)).toContain('<DragOrderList')
    expect(codeOf(LIST)).toContain('@move="onReorder"')
    // 关注线路列表引用的是同一个文件，不是第二份复制品。
    expect(codeOf(read('../lines.vue'))).toContain('import { BackToSettings, DragOrderList } from \'./components\'')
    expect(codeOf(read('../lines.vue'))).toContain('<DragOrderList')
    expect(codeOf(read('../lines.vue'))).toContain('@move="onReorder"')
    expect(codeOf(ORDER_LIST)).toContain('handle="[data-drag-handle]"')
    expect(codeOf(ORDER_LIST)).toContain('VueDraggable')
  })

  it('列表渲染存储顺序：拖动之后的行序就是拖动后的顺序', async () => {
    const host = await mountChainList()
    expect(renderedNames(host)).toEqual(['早上上班', '下班回家', '接孩子'])

    // 一次拖动（库报告的是被拖走的行与它占据其格子的行），随后列表按新顺序渲染。
    await host.store.moveCommuteChain('chain-3', 'chain-1')
    await host.flush()

    expect(renderedNames(host)).toEqual(['接孩子', '早上上班', '下班回家'])
    host.unmount()
  })

  it('新增的链路落在列表末尾', async () => {
    const host = await mountChainList()
    expect(renderedNames(host).at(-1)).toBe('接孩子')

    await host.store.saveCommuteChain(null, {
      name: '新链路',
      purpose: 'morning',
      legs: [{
        lineId: 'bus_027_1',
        lineName: '快线 1 路',
        cityCode: '027',
        boardStationName: '东大桥',
        boardStationOrder: 3,
        alightStationName: '建国门',
        alightStationOrder: 4,
        transferExtraMinutes: null,
        connectionMode: null,
      }],
    })
    await host.flush()

    expect(renderedNames(host)).toEqual(['早上上班', '下班回家', '接孩子', '新链路'])
    host.unmount()
  })

  it('被拒绝的顺序写入绝不沉默', async () => {
    // 拖放由共用的容器发出、由卡片接住：那次写入的接线在卡片上，且经提示那一处接缝出去 ——
    // 写入被拒时列表已弹回存储顺序，一声不响会像那次拖拽从未发生。
    const list = codeOf(LIST)
    expect(list).toContain(`runWithFeedback('chain-reorder'`)
    expect(list).toContain('() => transitStore.moveCommuteChain(movedId, anchorId)')
    expect(list).toContain('orderError.value = err instanceof Error ? err.message')
    expect(list).toContain('v-if="orderError"')

    // 而被拒的写入确实把顺序弹回存储里的那个（store 自己那一侧）。
    const host = await mountChainList()
    host.server.on(/\/api\/transit\/commute-chains\?/, () => ({ success: false, error: '换乘链不存在' }))
    host.server.on(/\/api\/transit\/commute-chains\/[^/]+$/, () => ({ success: false, error: '换乘链不存在' }))

    await expect(host.store.moveCommuteChain('chain-3', 'chain-1')).rejects.toThrow('换乘链不存在')
    await host.flush()

    expect(renderedNames(host)).toEqual(['早上上班', '下班回家', '接孩子'])
    host.unmount()
  })
})
