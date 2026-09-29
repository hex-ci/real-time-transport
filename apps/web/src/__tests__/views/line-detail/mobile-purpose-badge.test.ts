import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from '../../settings/__tests__/settings-harness'
import MobileLineHeader from '../components/mobile-line-header.vue'
import LineDetail from '../index.vue'

/**
 * 移动端头部上的通勤方向标识（🏠 上班方向 / 🏢 下班方向）。
 *
 * 本项目移动优先，而这一条标识一直只在桌面端：手机上只有「切换反向」，同一屏在两块屏幕上
 * 说的不是同一套话。这里钉三件事：
 *
 *  1. 屏幕上这个方向是上班/下班方向时，移动头部出现与桌面端逐字相同的那句话；
 *  2. 未声明方向（或这条线路不在关注里）时一个字都不显示，绝不退到「方向 0」；
 *  3. 两处说的是同一句话，且词只有一处作者（`@/purpose-badge`），不是两份各自措辞的副本。
 *
 * 页面挂载用真实的两处头部，故「同一个来源」是按行为查的：52 路那类收藏行里 payload 的方向号
 * 与收藏行自己的号相反，移动端若另算一份就会与桌面端各说一句话。
 * 报站板（Konva）与弹窗由桩件替掉 —— 本文件钉的是头部，它们各自有自己的测试台。
 */
vi.mock('../components', async () => {
  const vue = await import('vue')
  // 两处头部都是真的：这一条标识要按同一次渲染里两处各自说出的话来比。
  const MobileLineHeader = (await import('../components/mobile-line-header.vue')).default
  const DesktopActionBar = (await import('../components/desktop-action-bar.vue')).default
  const Empty = vue.defineComponent({ name: 'EmptyStub', render: () => null })
  return {
    MobileLineHeader,
    DesktopActionBar,
    RouteBoard: Empty,
    StationPopover: Empty,
    LineHero: Empty,
    LineLoadState: Empty,
  }
})

const UP = '010-52-0'
const DOWN = '010-52-1'

/**
 * 上游方向 1 的那条线。收藏行把它的号编成 0，也就是使用者的上班方向 —— 两套号在这一行上相反，
 * 故移动端若自己再算一次方向，就会与桌面端说不一致的话。
 */
const DETAIL_DOWN = {
  lineId: DOWN,
  direction: 1,
  directionName: '开往 潘道庙',
  otherDirectionLineId: UP,
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 'd1', name: '劲松', order: 7, interchanges: [] },
    { id: 'd2', name: '潘道庙', order: 8, interchanges: [] },
  ],
}

/** 上游方向 0 的那条线（收藏行编号里的方向 1）。 */
const DETAIL_UP = {
  lineId: UP,
  direction: 0,
  directionName: '开往 靛厂新村',
  otherDirectionLineId: DOWN,
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 'u1', name: '劲松', order: 12, interchanges: [] },
    { id: 'u2', name: '靛厂新村', order: 13, interchanges: [] },
  ],
}

/** 收藏行编号里的方向 0 是上班方向。 */
const MORNING_FAVOURITE = {
  id: 'fav-52',
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: '52',
  preferredDirection: 1,
  morningDirection: 0,
  displayOrder: 1,
}

/** 同一条线路，方向 0 是下班方向。 */
const EVENING_FAVOURITE = {
  ...MORNING_FAVOURITE,
  id: 'fav-52-evening',
  morningDirection: 1,
  eveningDirection: 0,
}

/** 标识本身的形状：只认这两句话，故「一个字都没显示」与「显示的是别的词」不会被混为一谈。 */
const BADGE = /(?:🏠 上班方向|🏢 下班方向)/g

function walk(root: HostElement): HostElement[] {
  return [root, ...root.children.flatMap(walk)]
}

/** 一棵子树里出现的每一处通勤方向标识，按文档顺序。 */
function badgesIn(root: HostElement): string[] {
  return walk(root)
    .flatMap(node => node.text.replace(/<[^>]*>/g, ' ').match(BADGE) ?? [])
}

/**
 * 一屏头部：移动端头部是页面上唯一带 `md:hidden` 的块，桌面操作栏是唯一带 `md:flex` 的
 * （弹窗没打开时不渲染）。两个都断言只有一处，使这条定位本身也受钉。
 */
function surface(host: MountedHost, marker: string): HostElement {
  const found = host.nodes(node => String(node.props.class ?? '').includes(marker))
  expect(found, `页面上带 ${marker} 的块`).toHaveLength(1)
  return found[0]!
}

/** 移动头部单独挂载：标识的判据与措辞只按 props 可查。 */
async function mountHeader(activePurpose: 'morning' | 'evening' | null): Promise<MountedHost> {
  const host = await mountComponent(MobileLineHeader, {
    props: {
      detail: DETAIL_DOWN,
      liveStatus: null,
      canSwitchDirection: true,
      activePurpose,
      accent: { lineName: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400', stops: '' },
    },
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

class WebSocketStub {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = WebSocketStub.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

/** 每条线路的详情按它自己的 lineId 作答（两个方向是两条上游线路）。 */
function detailOf(url: string): Record<string, unknown> {
  return url.includes(encodeURIComponent(DOWN)) ? DETAIL_DOWN : DETAIL_UP
}

function routes(favourites: Array<Record<string, unknown>>): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: favourites })],
    [/\/api\/transit\/lines\/[^/?]+\?/, request => ({ success: true, data: detailOf(request.url) })],
  ]
}

async function mountPage(
  id: string,
  direction: string,
  favourites: Array<Record<string, unknown>>,
): Promise<MountedHost> {
  vi.stubGlobal('WebSocket', WebSocketStub)
  class ObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return [] }
  }
  vi.stubGlobal('ResizeObserver', ObserverStub)
  vi.stubGlobal('MutationObserver', ObserverStub)
  vi.stubGlobal('IntersectionObserver', ObserverStub)
  const host = await mountComponent(LineDetail, {
    props: { id, direction, cityCode: '027' },
    routes: routes(favourites),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('移动端头部：通勤方向标识与桌面端是同一句话', () => {
  it('这个方向是上班方向：移动头部出现与桌面端逐字相同的那句话', async () => {
    const host = await mountHeader('morning')

    expect(badgesIn(host.root)).toEqual(['🏠 上班方向'])
    host.unmount()
  })

  it('这个方向是下班方向：同一个位置说下班那一句', async () => {
    const host = await mountHeader('evening')

    expect(badgesIn(host.root)).toEqual(['🏢 下班方向'])
    host.unmount()
  })

  it('标识与头部原有的三个入口同行，一个不少', async () => {
    const host = await mountHeader('morning')

    expect(badgesIn(host.root), '移动头部上借长度断言的那句话').toHaveLength(1)
    expect(host.nodes(node => node.props['aria-label'] === '返回总览')).toHaveLength(1)
    expect(host.nodes(node => node.props['aria-label'] === '切换反向')).toHaveLength(1)
    expect(host.nodes(node => node.props.title === '在途车辆与线路详情')).toHaveLength(1)
    // 标识是陈述，不是控件：加一个可点区域就得按房规给它 44px 的触控目标。
    expect(host.nodes(node => node.tag === 'button' && node.text.includes('上班方向'))).toHaveLength(0)
    host.unmount()
  })
})

describe('未声明方向时，移动头部一个字都不显示', () => {
  it('activePurpose 为 null：不显示任何标识，也不退到「方向 0」', async () => {
    const host = await mountHeader(null)
    const text = host.text()

    expect(badgesIn(host.root)).toEqual([])
    expect(text).not.toContain('上班')
    expect(text).not.toContain('下班')
    expect(text).not.toContain('🏠')
    expect(text).not.toContain('🏢')
    // 「方向 0」这类回退：头部上只有这一句陈述会用到「方向」二字。
    expect(text).not.toContain('方向')
    host.unmount()
  })

  it('控制：不属于关注线路的那一屏（页面上两处头部都不显示）', async () => {
    const host = await mountPage(UP, '0', [])

    expect(badgesIn(surface(host, 'md:hidden'))).toEqual([])
    expect(badgesIn(surface(host, 'md:flex'))).toEqual([])
    expect(host.text(), 'a direction nobody declared showed a badge').not.toContain('上班方向')
    host.unmount()
  })
})

describe('两处头部说的是同一句话，且只有一个词表', () => {
  it('同一次渲染：两处都说出上班方向那一句（payload 的号与收藏行的号相反也一样）', async () => {
    const host = await mountPage(DOWN, '1', [MORNING_FAVOURITE])

    expect(badgesIn(surface(host, 'md:hidden'))).toEqual(['🏠 上班方向'])
    expect(badgesIn(surface(host, 'md:flex'))).toEqual(['🏠 上班方向'])
    host.unmount()
  })

  it('同一次渲染：下班方向同理', async () => {
    const host = await mountPage(DOWN, '1', [EVENING_FAVOURITE])

    expect(badgesIn(surface(host, 'md:hidden'))).toEqual(['🏢 下班方向'])
    expect(badgesIn(surface(host, 'md:flex'))).toEqual(['🏢 下班方向'])
    host.unmount()
  })

  it('这句话只有一处作者：两处头部都用同一个词表，谁也不带自己的副本', () => {
    const source = (relative: string): string => {
      try {
        return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      }
      catch {
        return ''
      }
    }
    const bar = source('../components/desktop-action-bar.vue')
    const header = source('../components/mobile-line-header.vue')

    for (const [name, file] of [['桌面端', bar], ['移动端', header]] as const) {
      expect(file, `${name}头部没有用那个共享词表`).toContain('purposeBadgeOf(')
      expect(file, `${name}头部自己写了一份这句话`).not.toContain('上班方向')
      expect(file, `${name}头部自己写了一份这句话`).not.toContain('下班方向')
      expect(file, `${name}头部自己定了一套色调`).not.toContain('bg-emerald-500/10')
      expect(file, `${name}头部自己定了一套色调`).not.toContain('bg-violet-500/10')
    }

    const table = source('../../../purpose-badge.ts')
    expect(table).toContain('🏠 上班方向')
    expect(table).toContain('🏢 下班方向')
  })
})
