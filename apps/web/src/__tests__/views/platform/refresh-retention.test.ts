import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mountComponent,
  type HostElement,
  type MountedHost,
  type RecordedRequest,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import PlatformPage from '../index.vue'

/**
 * 站台页：刷新不清空已在屏上的行。
 *
 * 车主报告的原话是「站台大屏的刷新每次都清空列表刷新」。机制在页面与看板的接缝上：
 * 每一次重读（12 秒轮询、选站、GPS 对准）都从同一个 load 进入，它一进来就把 `loading`
 * 置真，而看板把整个表体挂在 `v-if="loading"` 上 —— 于是刷新期间行被整体卸载，页面塌成
 * 一行「正在加载车况数据...」，然后行再回来。这里的每条断言钉住修复后的形状：
 *
 * - 刷新进行中，行保持渲染，更新只以不打扰的方式示意（(a)、(d) 修复前为红）；
 * - 首载没有行可保留时，加载态照常出现（(b)，正向对照）；
 * - 刷新失败，行保持渲染，失败由行自己的既有措辞说出，且「最后更新」不被改写（(c)）；
 * - 「最后更新」永远是产生屏上行的那次响应自己的时刻（(d)）；
 * - 换站不是刷新：旧站的行随站而去，绝不留在新站名下（(e)，守卫）。
 *
 * 页面被挂载而不是被 grep，因为「哪一半状态在刷新时被渲染」正是这次改动本身。挂载走
 * 设置页的同一套无 DOM harness（本仓只有这一套，第二套会漂移）；站头换成可查探的惰性
 * 桩 —— 它驱动的原生 `<select>` 的 v-model 要写 `options.length`，这是 harness 有意不
 * 模拟的 DOM API。桩把 change/v-model 两个绑定摊到标记元素上，测试就能按真实顺序驱动
 * 一对：先 v-model 写入，再 change 事件。
 *
 * 默认站由 localeCompare 选出，测试不对它下注：需要「两条方向行都在屏」的场景，先显式
 * 切到两条规则都途经的「共用站」；那一次切换本身就是一次带行刷新，正好铺垫出前提，之后
 * 场景自己的那一次重读才是被断言的刷新。(b) 恰恰相反——它钉的就是首载，所以停在默认站上。
 *
 * 刻意不在测试里做的事：不伪造中间态、不引入时钟 —— 时刻断言用的期望值与页面同一种
 * 算法（本地时区的 HH:MM:SS），因此断言与时区无关。
 */

vi.mock('../components/platform-header.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'PlatformHeaderStub',
      props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
      setup(_props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
        // change / v-model 的 onXxx 绑定不声明为 emits，才落在 attrs 里、被摊到
        // 标记元素上，测试才有得驱动。真实 <select> 的顺序是先写值再发事件。
        return () => h('platform-header-stub', { ...attrs })
      },
    },
  }
})

/** live 响应所报的取得时刻。2023-11-14，断言中用本地时区。 */
const STAMP_A = 1_700_000_010_000
const STAMP_A2 = 1_700_000_030_000
const STAMP_B = 1_700_000_060_000

/** 一条两个方向的关注线路，如 store 所持有。 */
const FAVOURITE: Record<string, unknown> = {
  id: 'fav-1',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  lineName: '快线 1 路',
  preferredDirection: 0,
  reverseLineId: 'bus_027_2',
  displayOrder: 0,
}

/** 某线路的详情：方向 0 途经 共用站/甲站/乙站，方向 1 途经 共用站/丙站。 */
function detailBody(direction: 0 | 1): Record<string, unknown> {
  return {
    lineId: direction === 0 ? 'bus_027_1' : 'bus_027_2',
    lineName: '快线 1 路',
    direction,
    directionName: direction === 0 ? '开往甲乙方向' : '开往丙方向',
    firstBusTime: '05:00',
    lastBusTime: '23:30',
    cityCode: '027',
    type: 'bus',
    stops: direction === 0
      ? [
          { id: 's1', name: '共用站', order: 1, interchanges: [] },
          { id: 's2', name: '甲站', order: 2, interchanges: [] },
          { id: 's3', name: '乙站', order: 3, interchanges: [] },
        ]
      : [
          { id: 's1', name: '共用站', order: 1, interchanges: [] },
          { id: 's4', name: '丙站', order: 2, interchanges: [] },
        ],
  }
}

/** 一个定位的 live 答案：为所请求站定价的一辆车，盖有来源时刻。 */
function liveBody(lineId: string, stationOrder: number, stamp: number, travelSec: number) {
  return {
    success: true,
    data: {
      lineId,
      direction: 0,
      buses: [{
        id: `v_${lineId}`,
        order: 1,
        nextOrder: stationOrder,
        travelTimeSec: travelSec,
        congestion: 'low',
        updatedAt: stamp,
      }],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: stamp,
    },
  }
}

/** 由测试自行兑现的 promise，使一轮答案可被挂起。 */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * 按 lineId 为 live 路由编排脚本：每轮消耗下一个脚本步骤（一个值，或一个要挂起的 deferred promise）；
 * 脚本用尽后什么都不答。
 */
function liveRounds(script: Record<string, Array<unknown>>): (request: RecordedRequest) => unknown {
  const round: Record<string, number> = {}
  return (request) => {
    const lineId = /\/lines\/([^/]+)\/live/.exec(request.url)?.[1] ?? ''
    const index = (round[lineId] = (round[lineId] ?? 0) + 1)
    const step = script[lineId]?.[index - 1]
    if (step === undefined) return { success: false }
    return step
  }
}

/** 共用站的固定读数：120 s 与 300 s，各由自身来源定价。 */
const READ_A_1 = liveBody('bus_027_1', 1, STAMP_A, 120)
const READ_A_2 = liveBody('bus_027_2', 1, STAMP_A, 300)

function routes(live: (request: RecordedRequest) => unknown): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/bus_027_1\?/, () => ({ success: true, data: detailBody(0) })],
    [/\/api\/transit\/lines\/bus_027_2\?/, () => ({ success: true, data: detailBody(1) })],
    [/\/api\/transit\/lines\/.+\/live/, live],
  ]
}

async function mountPlatform(live: (request: RecordedRequest) => unknown): Promise<MountedHost> {
  const host = await mountComponent(PlatformPage, { routes: routes(live) })
  await host.flush()
  return host
}

/** 像真实 select 那样驱动选站器：v-model 先写值，再发 change。 */
async function selectStation(host: MountedHost, name: string): Promise<void> {
  const stub = host.node(item => item.tag === 'platform-header-stub', 'station header stub')
  const write = stub.props['onUpdate:modelValue']
  const change = stub.props.onChange
  if (typeof write !== 'function' || typeof change !== 'function') {
    throw new Error('the header stub carries no v-model write or change handler')
  }
  ;(write as (value: string) => void)(name)
  ;(change as (event: unknown) => void)({ type: 'change', target: stub })
  await host.flush()
}

/**
 * 铺垫确定性的前提：共用站的两条方向行都在屏。该切换本身就是一次带行的刷新，故它返回时屏幕持有
 * 两条盖 STAMP_A 的行——每个场景的起点。
 */
async function showBothRowsAtSharedStation(host: MountedHost): Promise<void> {
  await selectStation(host, '共用站')
  expect(rowTerminals(host)).toHaveLength(2)
}

/** 终到站区间，每个渲染行一个——用户看到的行数。 */
function rowTerminals(host: MountedHost): string[] {
  return host
    .nodes((item: HostElement) => item.tag === 'span' && item.text.includes('开往'))
    .map(item => item.text.trim())
}

/** 屏幕上的分钟值——没有行携带数字时为空。 */
function minuteSpans(host: MountedHost): string[] {
  return host
    .nodes((item: HostElement) => item.tag === 'span' && /^\d+$/.test(item.text.trim()))
    .map(item => item.text.trim())
}

/** 读者自己时区下的「HH:MM:SS」——与新鲜度行印出的形状相同。 */
function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('站台页：刷新不清空已在屏上的行', () => {
  it('(a) 刷新进行中：已在屏上的行保持渲染，加载态不出现', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gate1.promise],
      bus_027_2: [READ_A_2, gate2.promise],
    }))
    await showBothRowsAtSharedStation(host)

    // 同站重读：行为受测的那次刷新。
    await selectStation(host, '共用站')
    await host.flush()

    // 在途：**同一**两行仍在屏幕上，含分钟，且报告板说更新正在进行，而非把列表换掉。
    expect(rowTerminals(host), 'the rows must survive the in-flight refresh')
      .toHaveLength(2)
    expect(minuteSpans(host)).toEqual(expect.arrayContaining(['2', '5']))
    expect(host.text()).toContain('开往丙方向')
    expect(host.text()).not.toContain('正在加载车况数据')
    expect(host.text()).toContain('正在刷新…')

    gate1.resolve(liveBody('bus_027_1', 1, STAMP_A2, 240))
    gate2.resolve(liveBody('bus_027_2', 1, STAMP_A2, 600))
    await host.flush()

    // 新的读取落到被保留的行里。
    expect(minuteSpans(host)).toEqual(expect.arrayContaining(['4', '10']))
    expect(host.text()).not.toContain('正在刷新…')
    host.unmount()
  })

  it('(b) 首载还没有行：加载态照常渲染（正向对照）', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      // 默认站是 localeCompare 选出的那一个；方向 1 可能从不被请求。两个门无论如何都被兑现——
      // 未被应答的门不持有任何被 await 的东西。
      bus_027_1: [gate1.promise],
      bus_027_2: [gate2.promise],
    }))

    // 还什么都不可显示：加载体是诚实的形态。
    expect(host.text()).toContain('正在加载车况数据...')
    expect(rowTerminals(host)).toEqual([])
    expect(minuteSpans(host)).toEqual([])

    // 方向 0 的默认站是其 order-3 站（乙站）；方向 1 的共用站答案只有在默认是共用站时才会被消耗。
    gate1.resolve(liveBody('bus_027_1', 3, STAMP_A, 120))
    gate2.resolve(READ_A_2)
    await host.flush()

    expect(minuteSpans(host)).toContain('2')
    expect(rowTerminals(host).length).toBeGreaterThan(0)
    expect(host.text()).not.toContain('正在加载车况数据...')
    host.unmount()
  })

  it('(c) 刷新失败：行保持渲染，由行说出失败，时刻不被改写', async () => {
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1],
      bus_027_2: [READ_A_2, READ_A_2],
    }))
    await showBothRowsAtSharedStation(host)
    const stampText = `最后更新 ${clockOf(STAMP_A)}`

    // 刷新永不到达答案：每个 live 请求都死在线上。
    host.server.on(/\/api\/transit\/lines\/.+\/live/, () => {
      throw new Error('upstream down')
    })
    await selectStation(host, '共用站')
    await host.flush()

    // 行留下，且各自以报告板自己的措辞陈述失败。
    expect(rowTerminals(host), 'a failed refresh must not trade the rows away')
      .toHaveLength(2)
    expect(host.text()).toContain('无法获取')
    expect(host.text()).toContain('数据暂不可用')
    // 报告板以刷新家族自己的措辞陈述刷新失败——绝不留给行去推断。
    expect(host.text()).toContain('刷新失败')
    expect(host.text()).not.toContain('正在加载车况数据')
    // 屏幕上的时刻仍在描述行所来自的那次读取。
    expect(host.text()).toContain(stampText)
    host.unmount()
  })

  it('(d) 刷新进行中：「最后更新」仍是产生屏上行的那次读取的时刻', async () => {
    const gate1 = deferred<unknown>()
    const gate2 = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gate1.promise],
      bus_027_2: [READ_A_2, READ_A_2, gate2.promise],
    }))
    await showBothRowsAtSharedStation(host)
    const stampText = `最后更新 ${clockOf(STAMP_A)}`

    await selectStation(host, '共用站')
    await host.flush()

    // 在途时该时刻不被触碰——绝不在请求时盖章——且忙碌词在它旁边，而不是取代它。
    expect(host.text()).toContain(stampText)
    expect(host.text()).toContain('正在刷新…')
    expect(host.text()).not.toContain(clockOf(STAMP_A2))

    gate1.resolve(liveBody('bus_027_1', 1, STAMP_A2, 240))
    gate2.resolve(liveBody('bus_027_2', 1, STAMP_A2, 600))
    await host.flush()

    // 只有产出**新**行的那次读取会移动该行。
    expect(host.text()).toContain(`最后更新 ${clockOf(STAMP_A2)}`)
    expect(host.text()).not.toContain(stampText)
    expect(host.text()).not.toContain('正在刷新…')
    host.unmount()
  })

  it('(e) 换站不是刷新：旧站的行随站而去', async () => {
    const gateB = deferred<unknown>()
    const host = await mountPlatform(liveRounds({
      bus_027_1: [READ_A_1, READ_A_1, gateB.promise],
      bus_027_2: [READ_A_2, READ_A_2],
    }))
    await showBothRowsAtSharedStation(host)

    // 甲站只由一个方向服务，其答案被挂起。
    await selectStation(host, '甲站')
    await host.flush()

    // 在途时报告板不持有两个站中的任何一个：前一个站的行随站而去，旧盖章也随之而去。
    expect(host.text()).toContain('正在加载车况数据...')
    expect(rowTerminals(host)).toEqual([])
    expect(minuteSpans(host)).toEqual([])
    expect(host.text()).not.toContain('最后更新')

    gateB.resolve(liveBody('bus_027_1', 2, STAMP_B, 300))
    await host.flush()

    // 新站的单行，带它自己的读取时刻。
    expect(rowTerminals(host)).toEqual(['开往甲乙方向'])
    expect(minuteSpans(host)).toContain('5')
    expect(host.text()).toContain(`最后更新 ${clockOf(STAMP_B)}`)
    expect(host.text()).not.toContain('正在加载车况数据...')
    host.unmount()
  })
})
