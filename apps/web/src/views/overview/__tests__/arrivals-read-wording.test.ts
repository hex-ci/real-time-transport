import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  httpStatus,
  mountComponent,
  type MountedHost,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import LineMiniCard from '../components/line-mini-card.vue'
import OverviewPage from '../index.vue'

/**
 * 首页卡片上「前方有几辆车」这句话：只有读了才数车。
 *
 * 角标原来说的是 `aheadCount > 0 ? 前方 N 辆 : 前方暂无来车`，而 `aheadCount` 只是「手上几行
 * 读数里的到站条数」之和 —— 于是一次**失败**的到站读取（`overview/index.vue` 把它写成 `null`）
 * 与「读了、确实没有车」长得一模一样，屏幕上就成了「没有车要来」：一句关于世界、却没有任何人
 * 得到过的话。
 *
 * 现在每一行的读数带着它自己那次读取的状态（`@/read-state` 的三态），卡片据此说三句不同的话：
 *  - 读了、确实没有车：`前方暂无来车`（关于世界，有人读过才说得出口）；
 *  - 读取没答上来：`前方来车未读到`；
 *  - 还在读：`正在读取来车…`。
 * 正文里那句「没有分钟可说」的话同理：`未读到本站来车，无法显示到站时间` / `正在读取到站数据…` /
 * 运营状态本身。
 *
 * 首页那一侧也钉住：按页面挂载，让到站端点失败，看卡片真的说的哪一句 —— 页面的映射与卡片的
 * 措辞是同一条链上的两端。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

const STATUS = { state: 'operating', firstDeparture: '05:16', lastDeparture: '23:06' } as const

function row(arrivals: unknown) {
  return { lineId: 'bus_027_1', direction: 0, stopOrder: 1, directionName: '开往建国门', arrivals }
}

/** 一辆车都没有的读数：上游答了，`operatingStatus` 是它自己的答案。 */
const EMPTY_FEED = { arrivals: [], operatingStatus: STATUS, reference: null }

/** 两辆车的读数。 */
const TWO_FEED = {
  arrivals: [
    { time: '14:05', etaSeconds: 300, busId: 'v1', provenance: 'live' },
    { time: '14:07', etaSeconds: 420, busId: 'v2', provenance: 'live' },
  ],
  operatingStatus: STATUS,
  reference: null,
}

async function mountCard(arrivals: unknown, rows = [row(arrivals)]): Promise<MountedHost> {
  const host = await mountComponent(LineMiniCard, {
    props: {
      lineName: '快线 1 路',
      directionName: '开往建国门',
      stopName: '东大桥',
      stopDistanceMeters: null,
      legState: null,
      nearbyLocation: 'fix',
      rows,
      mode: 'morning',
      detailLoaded: true,
      isSubway: false,
      isPinned: false,
    },
  })
  await host.flush()
  return host
}

/** 首页：一条单向关注线路，早上那站已设好，到站端点失败。 */
function routes(): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({
      success: true,
      data: [{
        id: 'fav-1',
        userId: 'default_user',
        cityCode: '027',
        lineId: 'bus_027_1',
        lineName: '快线 1 路',
        preferredDirection: 0,
        morningDirection: 0,
        morningStopName: '东大桥',
        morningStopOrder: 1,
        displayOrder: 0,
      }],
    })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/commute-profile/, () => ({ success: true, data: { mode: 'work', description: '早通勤', windowState: 'stored' } })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/[^/?]+\?/, () => ({
      success: true,
      data: {
        lineId: 'bus_027_1',
        direction: 0,
        directionName: '开往建国门',
        cityCode: '027',
        type: 'bus',
        stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }],
      },
    })],
    // 到站读取失败（最后注册的最先匹配：这个 URL 也落得上一条）。
    [/\/arrivals\?/, () => httpStatus(500, { success: false, error: 'upstream down' })],
  ]
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('首页卡片：读失败不等于「没有车要来」', () => {
  it('到站读取没答上来：说未读到，不说「前方暂无来车」', async () => {
    const host = await mountCard({ state: 'unreadable' })

    const text = host.text()
    expect(text).toContain('前方来车未读到')
    expect(text, 'a failed read was displayed as a fact about vehicles').not.toContain('前方暂无来车')
    expect(text).toContain('未读到本站来车，无法显示到站时间')
    host.unmount()
  })

  it('读数还在路上：说正在读取来车…，不说「前方暂无来车」', async () => {
    const host = await mountCard({ state: 'reading' })

    const text = host.text()
    expect(text).toContain('正在读取来车…')
    expect(text).toContain('正在读取到站数据…')
    expect(text, 'a read still on its way was displayed as a fact about vehicles').not.toContain('前方暂无来车')
    host.unmount()
  })

  it('正对照：读了、确实一辆车都没有，「前方暂无来车」还是那句话', async () => {
    const host = await mountCard({ state: 'read', value: EMPTY_FEED })

    const text = host.text()
    expect(text).toContain('前方暂无来车')
    expect(text).toContain('运营中 · 暂无来车')
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('正对照：读了、有两辆在途，「前方 2 辆」照旧', async () => {
    const host = await mountCard({ state: 'read', value: TWO_FEED })

    const text = host.text()
    expect(text).toContain('前方 2 辆')
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('正对照：一行都没有的卡片不摆这个角标（它的主语是本站前方的车）', async () => {
    const host = await mountCard(null, [])

    const text = host.text()
    expect(text).not.toContain('前方暂无来车')
    expect(text).not.toContain('前方来车未读到')
    host.unmount()
  })
})

describe('首页：到站端点失败时，卡片说的是「未读到」', () => {
  it('按页面挂载，失败了就要读到那句话，而不是「前方暂无来车」', async () => {
    const host = await mountComponent(OverviewPage, {
      routes: routes(),
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    const text = host.text()
    expect(text, 'the page did not render the followed line’s card').toContain('快线 1 路')
    expect(text).toContain('前方来车未读到')
    expect(text, 'a failed arrivals read reached the screen as 「no vehicles are coming」').not.toContain('前方暂无来车')
    host.unmount()
  })
})
