import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  httpStatus,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'

/**
 * 关注线路页的上车点面板：一个方向的站点读取有三种事实，各说各的。
 *
 * 这一页的读取由 `line-stops.ts` 拥有（设置的车链页共用它），所以状态也在那里判，而不是这一页
 * 从「站表长不长」反推。被判错的那一次是这样的：上游答了这条线路 —— 有线路名、没有站表，是
 * `holdsLineRecord` 认得出的真实 payload —— 于是方向「答了，而且答的是没有站」；面板却把它当成
 * 「还在加载」，永远停在「正在加载站点…」上。
 *
 * 三句话分别是：
 *  - 读在路上：`正在加载站点…`（关于读取，不是关于这个方向）；
 *  - 读了、答的是空表：`该方向暂无站点数据，无法设置上车点`（与首页卡片对同一件事的说法
 *    「本方向暂无站点数据…」共用「暂无站点数据」这个事实子句，各自只说自己的后果）；
 *  - 没答上来：`未读到该方向的站点数据，暂时无法设置上车点`（未读到是这套应用对「读取没回答」
 *    的说法；这时也不能说这个方向没有数据 —— 那是关于上游数据的主张）。
 *
 * 正对照一并钉住：真的答了站表的方向，选择器里的站点照旧列出来。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

/** 两个方向都选过方向的关注线路：上班坐 `bus_027_1`（收藏行方向 0），下班坐它反向那条。 */
const FAVOURITE = {
  id: 'fav-1',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  reverseLineId: 'bus_027_1_rev',
  lineName: '快线 1 路',
  preferredDirection: 0,
  morningDirection: 0,
  eveningDirection: 1,
  displayOrder: 0,
}

/** 答了站表的那一条（下班方向），正对照用。 */
const STOPS_DETAIL = {
  lineId: 'bus_027_1_rev',
  direction: 1,
  directionName: '开往建国门',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '东大桥', order: 1, interchanges: [] },
    { id: 's2', name: '建国门', order: 2, interchanges: [] },
  ],
}

/** 答了、但一条站也没有的那一条（上班方向）。 */
const EMPTY_DETAIL = { ...STOPS_DETAIL, lineId: 'bus_027_1', direction: 0, stops: [] }

/**
 * 四种应答。`never` 由测试自己控制：永不应答的方向是真实状态，必须可达。
 */
interface Answer { kind: 'empty' | 'stops' | 'fail' | 'never' }

function routeFor(answer: Answer): (request: { url: string }) => unknown {
  return (request) => {
    if (answer.kind === 'never') return new Promise(() => {})
    if (answer.kind === 'fail') return httpStatus(404, { success: false, error: 'Line not found' })
    return { success: true, data: request.url.includes('direction=1') ? STOPS_DETAIL : EMPTY_DETAIL }
  }
}

function routes(answer: Answer = { kind: 'empty' }): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/lines\/[^/?]+\?/, routeFor(answer)],
    [/\/api\/transit\/settings/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

async function mountLines(answer: Answer = { kind: 'empty' }): Promise<MountedHost> {
  const host = await mountComponent(LinesPage, {
    routes: routes(answer),
    components: { RouterLink: { template: '<a><slot /></a>' } },
  })
  await host.flush()
  // 展开那一行：面板只在展开时渲染。
  await press(host, host.node(
    item => item.tag === 'button' && host.textOf(item).includes('快线 1 路'),
    'the followed-line row',
  ))
  return host
}

/** 一个方向的站点选择器的触发器：面板里那个还没定站时写着「未设置」的组合框按钮。 */
function pickers(host: MountedHost): HostElement[] {
  return host.nodes(item => item.tag === 'button' && host.textOf(item).trim() === '未设置')
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('上车点面板：一个方向的站点读取，三种事实三句话', () => {
  it('答了空表：说该方向暂无站点数据，不再说「正在加载站点…」', async () => {
    const host = await mountLines({ kind: 'empty' })

    const text = host.text()
    expect(text).toContain('该方向暂无站点数据，无法设置上车点')
    expect(text, 'an answered empty list still reads as a read that is on its way').not.toContain('正在加载站点')
    expect(text, 'a read that answered must not be worded as one that did not').not.toContain('未读到该方向的站点数据')
    host.unmount()
  })

  it('正对照：答了站表的方向照旧列出站点（同一屏上另一句话不会把这一条吃掉）', async () => {
    const host = await mountLines({ kind: 'empty' })

    // 下班方向答了站表：它的选择器在，打开就是那两站。
    const found = pickers(host)
    expect(found, 'the answered direction rendered no picker').toHaveLength(1)
    await press(host, found[0]!)

    expect(host.nodes(item => item.props.role === 'option').map(item => host.textOf(item)))
      .toEqual(['东大桥 第1站', '建国门 第2站'])
    host.unmount()
  })

  it('读还在路上：说正在加载站点…，不说这个方向没有数据，也不说没读到', async () => {
    const host = await mountLines({ kind: 'never' })

    const text = host.text()
    expect(text).toContain('正在加载站点…')
    expect(text, 'a read that has not answered must not claim the direction has no data')
      .not.toContain('暂无站点数据')
    expect(text).not.toContain('未读到该方向的站点数据')
    host.unmount()
  })

  it('读取没答上来：说未读到，不给「暂无站点数据」，也不留「正在加载站点…」', async () => {
    const host = await mountLines({ kind: 'fail' })

    const text = host.text()
    expect(text).toContain('未读到该方向的站点数据，暂时无法设置上车点')
    expect(text, 'a failed read was worded as a fact about the direction’s data').not.toContain('暂无站点数据')
    expect(text, 'a failed read was worded as one still on its way').not.toContain('正在加载站点')
    host.unmount()
  })
})
