import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import OverviewPage from '../../../views/overview/index.vue'

/**
 * 首页上按下的东西：置顶说一句，而**切换**不说话。
 *
 * 置顶是这一页唯一的写操作（入口、标记与取消都在卡片上），故它成与败各说一句；而模式按钮
 * （自动/上班/下班/附近）、卡片本身（导航）与城市切换都是「按下去屏幕立刻换了样」的那一类，
 * 它们一个提示都不推 —— 提示要回答的是「我那一下到底做成了没有」，而这三样自己就是答案。
 *
 * 提示库被替换掉，故这里读的是推出去的那句话本身。
 */

const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string) => {
      pushed.push(message)
      return pushed.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

const LINE_NAME = '快线 1 路'
const FAV_ID = 'fav-1'
const LINE_ID = 'bus_027_1'

/** 一条关注线路，是否已置顶由测试给。 */
function favourite(isPinned = false): Record<string, unknown> {
  return {
    id: FAV_ID,
    userId: 'default_user',
    cityCode: '027',
    lineId: LINE_ID,
    reverseLineId: 'bus_027_2',
    lineName: LINE_NAME,
    preferredDirection: 0,
    morningDirection: 0,
    morningStopName: '东大桥',
    morningStopOrder: 1,
    displayOrder: 0,
    isPinned,
  }
}

const LINE_DETAIL = {
  lineId: LINE_ID,
  direction: 0,
  directionName: '开往建国门',
  cityCode: '027',
  type: 'bus',
  stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }],
}

const ARRIVALS = {
  arrivals: [],
  operatingStatus: { state: 'operating', firstDeparture: '05:16', lastDeparture: '23:06' },
  reference: null,
}

/** 页面加载时的读取，外加回显所给行的置顶 PATCH。 */
function routes(pinned = false, ...overrides: Route[]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [favourite(pinned)] })],
    [/\/api\/transit\/favorites\/fav-1$/, request => ({
      success: true,
      data: { ...favourite(pinned), ...(request.body as Record<string, unknown> ?? {}) },
    })],
    [/\/api\/transit\/cities/, () => ({
      success: true,
      data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }],
    })],
    [/\/api\/transit\/commute-profile/, () => ({
      success: true,
      data: { mode: 'work', description: '早通勤', windowState: 'stored' },
    })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/(?!search)[^/?]+\?/, () => ({ success: true, data: LINE_DETAIL })],
    [/\/arrivals\?/, () => ({ success: true, data: ARRIVALS })],
    ...overrides,
  ]
}

async function mountOverview(pinned = false, ...overrides: Route[]): Promise<MountedHost> {
  pushed.length = 0
  const host = await mountComponent(OverviewPage, {
    routes: routes(pinned, ...overrides),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 置顶那枚控件：它的可访问名就是它此刻会做的事。 */
function pinButton(host: MountedHost, pinned: boolean): HostElement {
  return host.node(
    node => node.tag === 'button' && node.props['aria-label'] === (pinned ? '取消置顶' : '置顶此线路'),
    `the ${pinned ? 'unpin' : 'pin'} control`,
  )
}

/** 卡片主体那枚链接：指向线路详情，与操作栏里那格「线路详情」是两处入口。 */
function cardBodyLink(host: MountedHost): HostElement {
  return host.node(
    (node: HostElement) => node.tag === 'a'
      && String(node.props.href ?? '').startsWith('/line/')
      && !host.textOf(node).includes('线路详情'),
    'the card body link',
  )
}

/** 某一档里那枚模式按钮。 */
function modeButton(host: MountedHost, label: string): HostElement {
  return host.node(
    node => node.tag === 'button' && host.textOf(node).trim() === label,
    `the ${label} mode button`,
  )
}

describe('置顶：成功由操作栏自己说，失败才说一句原因', () => {
  it('钉住一条线路：操作栏立刻变成「已置顶」，不再额外推 toast', async () => {
    const host = await mountOverview()

    await press(host, pinButton(host, false))

    expect(pushed).toEqual([])
    expect(pinButton(host, true).props['aria-pressed']).toBe(true)
    host.unmount()
  })

  it('取消钉住：操作栏立刻回到「置顶」，不再额外推 toast', async () => {
    const host = await mountOverview(true)

    await press(host, pinButton(host, true))

    expect(pushed).toEqual([])
    expect(pinButton(host, false).props['aria-pressed']).toBe(false)
    host.unmount()
  })

  it('置顶与取消置顶都不动视口：卡片走到新槽位就是全部', async () => {
    vi.useFakeTimers()
    const host = await mountOverview(false)
    const scrollTo = vi.fn()
    ;(window as any).scrollTo = scrollTo
    ;(window as any).scrollY = 500

    const pinned = press(host, pinButton(host, false))
    await vi.advanceTimersByTimeAsync(400)
    await pinned

    const unpinned = press(host, pinButton(host, true))
    await vi.advanceTimersByTimeAsync(400)
    await unpinned

    expect(scrollTo).not.toHaveBeenCalled()

    vi.useRealTimers()
    host.unmount()
  })

  it('写入结束后 CSS move 的 400ms 内仍锁住操作', async () => {
    vi.useFakeTimers()
    const host = await mountOverview(false)
    const control = pinButton(host, false)

    const first = press(host, control)
    await vi.advanceTimersByTimeAsync(0)
    await host.flush()
    const writesAfterFirst = pushed.length

    await press(host, control)
    expect(pushed).toHaveLength(writesAfterFirst)
    expect(host.server.seen(/\/api\/transit\/favorites\/fav-1$/)).toHaveLength(1)

    await vi.runAllTimersAsync()
    await first
    vi.useRealTimers()
    host.unmount()
  })

  it('被拒：卡片回到原来的「置顶」状态，仍不额外推 toast', async () => {
    const host = await mountOverview(false, [
      /\/api\/transit\/favorites\/fav-1$/,
      () => ({ success: false, error: '该线路不在关注列表中' }),
    ])

    await press(host, pinButton(host, false))

    expect(pushed).toEqual([])
    expect(pinButton(host, false).props['aria-pressed']).toBe(false)
    host.unmount()
  })
})

describe('屏幕上立刻看得见的动作一个字都不推', () => {
  it('换模式：四个按钮按下去都不推话', async () => {
    const host = await mountOverview()

    for (const label of ['上班', '下班', '附近', '自动']) {
      await press(host, modeButton(host, label))
    }

    expect(pushed).toEqual([])
    host.unmount()
  })

  it('点卡片主体：那是一次导航，不是一次写入', async () => {
    const host = await mountOverview()

    const link = cardBodyLink(host)

    // 它确实是一条通往详情的链接（故这一条不是空转），而一个提示都没有。主体是真正的链接而不是
    // 脚本跳转 —— 键盘可达与「在新标签页打开」都来自这一点。
    expect(link.props.href).toBe(`/line/${LINE_ID}?direction=0&cityCode=027`)
    expect(pushed).toEqual([])
    host.unmount()
  })

  it('换城市：那一行自己换了样，故不推话', async () => {
    const host = await mountOverview()

    host.city.setCity('010')

    // 城市确实换了（同一个 store，同一份状态），而提示一条都没有。
    expect(host.city.currentCode).toBe('010')
    expect(pushed).toEqual([])
    host.unmount()
  })
})
