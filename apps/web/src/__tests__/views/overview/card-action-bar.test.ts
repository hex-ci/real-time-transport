import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RouterLinkStub,
  mountComponent,
  type MountedHost,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import LineMiniCard from '../../../views/overview/components/line-mini-card.vue'
import type { CardRowWithArrivals } from '../../../views/overview/types'

/**
 * 卡片的两块区域：主体是通往线路详情的链接，动作在底部操作栏里。
 *
 * 这一组钉住三件事，都是「动作该住在哪里」的直接后果：
 *   1. 卡片主体是真正的链接（可聚焦、可被辅助技术读成「通往线路详情」），不是挂了 click 的 div；
 *   2. 置顶与切换方向住在操作栏里，各自 ≥44px，互不误触；
 *   3. 卡片里那一行反方向只报告到站情况，不再自己承担动作 —— 原先它与主体是嵌套的两个可点区域。
 */

const LINE_NAME = '52'
const DETAIL_HREF = '/line/bus_027_1?direction=0&cityCode=027'

vi.mock('vue-sonner', () => ({
  toast: Object.assign(() => {}, { dismiss: () => {}, custom: () => {} }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

function row(direction: 0 | 1, directionName: string): CardRowWithArrivals {
  return {
    lineId: direction === 0 ? 'bus_027_1' : 'bus_027_2',
    direction,
    stopOrder: 4,
    directionName,
    arrivals: {
      state: 'read',
      value: {
        arrivals: [{ busId: 'b1', time: '16:18', stopsAway: 5, distanceMeters: 2300, etaSeconds: 540 }],
        operatingStatus: { state: 'operating', firstDeparture: '05:16', lastDeparture: '23:06' },
        reference: null,
      },
    },
  }
}

async function mountCard(options: {
  rows?: CardRowWithArrivals[]
  isPinned?: boolean
  isSubway?: boolean
} = {}): Promise<MountedHost> {
  const routes: Route[] = []
  return mountComponent(LineMiniCard, {
    routes,
    components: { RouterLink: RouterLinkStub },
    props: {
      lineName: LINE_NAME,
      directionName: '开往 潘道庙',
      detailHref: DETAIL_HREF,
      stopName: '西小马',
      stopDistanceMeters: null,
      legState: null,
      nearbyLocation: { state: 'located' },
      rows: options.rows ?? [row(0, '开往 潘道庙'), row(1, '开往 通州北苑路口南')],
      mode: 'morning',
      detailLoaded: true,
      isSubway: options.isSubway ?? false,
      isPinned: options.isPinned ?? false,
      primaryDirection: null,
    },
  })
}

describe('卡片主体是通往线路详情的链接', () => {
  it('主体是 <a>，指向详情，且不是脚本跳转', async () => {
    const host = await mountCard()

    const links = host.nodes((n: any) => n.tag === 'a' && String(n.props.href ?? '').startsWith('/line/'))
    // 两处入口：主体 + 操作栏那一格。
    expect(links.length).toBe(2)
    for (const link of links) expect(link.props.href).toBe(DETAIL_HREF)

    host.unmount()
  })

  it('主体链接带着可访问名，念得出它是哪条线路的详情', async () => {
    const host = await mountCard()

    const body = host.node(
      (n: any) => n.tag === 'a'
        && String(n.props.href ?? '').startsWith('/line/')
        && !host.textOf(n).includes('线路详情'),
      'the card body link',
    )
    expect(body.props['aria-label']).toBe(`查看${LINE_NAME}线路详情`)

    host.unmount()
  })

  it('到站分钟区在主体链接里面 —— 点结论的地方就是进详情的地方', async () => {
    const host = await mountCard()

    const body = host.node(
      (n: any) => n.tag === 'a'
        && String(n.props.href ?? '').startsWith('/line/')
        && !host.textOf(n).includes('线路详情'),
      'the card body link',
    )
    expect(host.textOf(body)).toContain('分钟后到站')

    host.unmount()
  })
})

describe('操作栏是卡片的动作归属地', () => {
  it('置顶与切换方向各占一格，都是 button，且都带可访问名', async () => {
    const host = await mountCard()

    const pin = host.node(
      (n: any) => n.tag === 'button' && n.props['aria-label'] === '置顶此线路',
      'the pin control',
    )
    expect(pin.props['aria-pressed']).toBe(false)

    const switchControl = host.node(
      (n: any) => n.tag === 'button' && String(n.props['aria-label'] ?? '').startsWith('切换到'),
      'the switch-direction control',
    )
    expect(switchControl.props['aria-label']).toBe('切换到开往 通州北苑路口南方向')

    host.unmount()
  })

  it('置顶按下的状态由那一格自己表示', async () => {
    const host = await mountCard({ isPinned: true })

    const pin = host.node(
      (n: any) => n.tag === 'button' && n.props['aria-label'] === '取消置顶',
      'the unpin control',
    )
    expect(pin.props['aria-pressed']).toBe(true)

    host.unmount()
  })

  it('每格至少 44px 高 —— 三个动作互不误触', async () => {
    const host = await mountCard()

    const bar = host.node(
      (n: any) => n.tag === 'div' && String(n.props.class ?? '').includes('items-stretch'),
      'the action bar',
    )
    const cells = host.nodes((n: any) => n.parent === bar && (n.tag === 'button' || n.tag === 'a'))
    expect(cells.length).toBe(3)
    for (const cell of cells) {
      expect(String(cell.props.class)).toContain('min-h-11')
      expect(String(cell.props.class)).toContain('flex-1')
    }

    host.unmount()
  })

  it('单向线路（只有一行）不摆切换方向那一格 —— 它说不出要切到哪儿', async () => {
    const host = await mountCard({ rows: [row(0, '开往 潘道庙')] })

    expect(host.nodes((n: any) => n.tag === 'button' && String(n.props['aria-label'] ?? '').startsWith('切换到'))).toEqual([])

    host.unmount()
  })
})

describe('卡片主体里除了它自己那枚链接，没有别的可点控件', () => {
  it('反方向那一行、置顶、切换方向都不在主体里面 —— 主体里只有「通往详情」这一件事', async () => {
    const host = await mountCard()

    const body = host.node(
      (n: any) => n.tag === 'a'
        && String(n.props.href ?? '').startsWith('/line/')
        && !host.textOf(n).includes('线路详情'),
      'the card body link',
    )

    // 主体里的可点控件只有它自己：原先反方向那一行是一个嵌套的 button，手指差几像素就是
    // 另一个动作；置顶与切换方向现在住在操作栏里。
    const interactive = host.nodes((n: any) =>
      n !== body && (n.tag === 'button' || n.tag === 'a'))
      .filter((n: any) => host.textOf(body).includes(host.textOf(n).slice(0, 12)) && host.textOf(n).length > 0)
      .filter((n: any) => host.textOf(body).includes(host.textOf(n)))

    expect(interactive).toEqual([])

    host.unmount()
  })

  it('反方向那一行仍然报告另一个方向的到站情况', async () => {
    const host = await mountCard()

    const body = host.node(
      (n: any) => n.tag === 'a'
        && String(n.props.href ?? '').startsWith('/line/')
        && !host.textOf(n).includes('线路详情'),
      'the card body link',
    )
    const text = host.textOf(body)
    expect(text).toContain('开往 通州北苑路口南')
    expect(text).toContain('9分')

    host.unmount()
  })
})

describe('操作栏始终贴着卡片底边', () => {
  it('卡片是纵向 flex，主体吃掉富余高度 —— 内容不足的卡片不会把操作栏留在半空', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/line-mini-card.vue', import.meta.url)),
      'utf-8',
    )
    // 网格默认 `align-items: stretch` 把同一行卡片拉成等高；没有这一对 flex 时，富余高度全落在
    // 操作栏下面（实测过 86~125px 的空当）。
    expect(source).toContain('flex flex-col')
    expect(source).toMatch(/class="flex flex-1 flex-col p-4/)
  })

  it('空状态与加载态的深色面板吃掉余下高度、文字垂直居中', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/line-mini-card.vue', import.meta.url)),
      'utf-8',
    )
    // 面板不 `grow` 时，富余空间落在面板外面 —— 卡片深浅两块的比例与内容满的卡片对不上
    // （实测深色占比会掉到 40% 上下，而满卡片是 63%）。
    const panels = source.match(/class="[^"]*bg-slate-950\/80[^"]*"/g) ?? []
    const emptyPanels = panels.filter((c: string) => !c.includes('space-y-2.5'))
    expect(emptyPanels.length).toBe(3)
    for (const cls of emptyPanels) {
      expect(cls).toContain('grow')
      expect(cls).toContain('items-center')
      expect(cls).toContain('justify-center')
    }
  })
})

describe('置顶横幅不再占卡片顶边', () => {
  it('源码里没有那条横幅 —— 那个位置留给「前方 N 辆」', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../views/overview/components/line-mini-card.vue', import.meta.url)),
      'utf-8',
    )
    // 横幅是一条带「置顶」字样的顶边条；置顶的状态现在只由操作栏那一格表示。
    expect(source).not.toMatch(/<div\s+v-if="isPinned"\s+class="[^"]*px-4 py-1\.5/)
    expect(source).toContain('已置顶')
  })
})
