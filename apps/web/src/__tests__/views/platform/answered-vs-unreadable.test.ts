import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveBusSchema, operatingDaySecondsOf, operatingStatusOf } from '@real-time-transport/shared'
import { operatingTextOf } from '@/operating-copy'
import {
  mountComponent,
  type MountedHost,
  type RecordedRequest,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import PlatformPage from '../../../views/platform/index.vue'

/**
 * 站台页的 F3/F4 界面层：一块屏上，「答了但没车」「读不到」「有车但没有分钟」是三种说法，
 * 谁都不许冒充谁。
 *
 * 接口层已经钉住这三种结局在**响应**上形状不同（`api/f5-platform-aggregation.test.ts`、
 * `api/x-read-state-not-empty.test.ts`），本文件驱动的是把它们放上同一块屏的那一页：多线路并发读，
 * 一条线路读失败不该让别的行改口，也不该升级成整块屏的失败；一条线路答了而没有车，陈述的是
 * 这条线路自己的运营事实，而不是「读不到」。
 *
 * 挂载的是页面，因为「哪一行拿到哪一种结局」正是页面自己按行配对的结果；报告板的措辞已在
 * `departure-minute.test.ts` / `failure-row.test.ts` 中钉过。站点头部换成惰性桩件：它驱动原生
 * `<select>`，而 runtime-dom 的 `v-model` 要写 `options.length`，是本装置刻意不建模的 DOM API。
 */

vi.mock('../../../views/platform/components/platform-header.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'PlatformHeaderStub',
      props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
      setup(_props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
        return () => h('platform-header-stub', { ...attrs })
      },
    },
  }
})

const STATION = '西单路口东'

const STATION_ORDER = 3

/** 本站台上的一条已关注线路，以及它那次定点读数给出哪一种结局。 */
interface LineFixture {
  lineId: string
  lineName: string
  terminal: string
  /** 这条读数的结局：`unreadable` 即请求死在线上，该行没有任何答案。 */
  outcome: 'answered' | 'unreadable'
  /** 作答了的话这条读数里的车，未给即空列表——「答了但没车」。 */
  bus?: Record<string, unknown>
}

/**
 * 四条线路，同一站序：一条有分钟、一条读不到、一条答了但没车、一条有车但没有分钟。
 * 站序相同使「谁的结局落在谁的行上」只由该行得到的那一条答案决定。
 */
const LINES: LineFixture[] = [
  {
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    terminal: '开往东单',
    outcome: 'answered',
    bus: { order: 1, nextOrder: STATION_ORDER, travelTimeSec: 300, congestion: 'low' },
  },
  {
    lineId: 'bus_027_2',
    lineName: '支线 2 路',
    terminal: '开往西直门',
    outcome: 'unreadable',
  },
  {
    lineId: 'bus_027_3',
    lineName: '环线 3 路',
    terminal: '开往四惠',
    outcome: 'answered',
  },
  {
    lineId: 'bus_027_5',
    lineName: '机场 5 路',
    terminal: '开往首都机场',
    outcome: 'answered',
    // 车在途、车头正开向本站台，只是这条读数没有行程时间——故本行没有分钟。
    bus: { order: 1, nextOrder: STATION_ORDER, congestion: 'high' },
  },
]

/** 读不到的那一行，与答了但没车的那一行。 */
const UNREADABLE_LINE = '支线 2 路'
const ANSWERED_EMPTY_LINE = '环线 3 路'

/**
 * 页面为「答了但没车」的那一行推得的运营事实。
 *
 * 页面在每次轮询时按线路自己的首末班与北京运营日重建规则，故期望值以**同一**模型推出，
 * 而不是钉死某一句——测试跑到哪个钟点都不该改变这条断言。
 */
const OPERATING_TEXT = operatingTextOf(operatingStatusOf({
  firstDeparture: '05:00',
  lastDeparture: '23:30',
  nowSecOfDay: operatingDaySecondsOf(),
}))

/** 运营状态的五种说法，任一都不属于「读不到」的那一行。 */
const OPERATING_WORDS = /运营中|未到首班|已过末班|运营时间未知|暂无来车/

function favouriteOf(line: LineFixture): Record<string, unknown> {
  return {
    id: `fav_${line.lineId}`,
    userId: 'default_user',
    cityCode: '027',
    lineId: line.lineId,
    lineName: line.lineName,
    preferredDirection: 0,
    displayOrder: LINES.indexOf(line),
  }
}

function stopsOf(line: LineFixture): Array<Record<string, unknown>> {
  const stops: Array<Record<string, unknown>> = []
  for (let order = 1; order <= STATION_ORDER + 1; order += 1) {
    stops.push({
      id: `${line.lineId}_s${order}`,
      name: order === STATION_ORDER ? STATION : `${line.lineName} · 第 ${order} 站`,
      order,
      interchanges: [],
    })
  }
  return stops
}

function detailOf(line: LineFixture): Record<string, unknown> {
  return {
    lineId: line.lineId,
    lineName: line.lineName,
    direction: 0,
    directionName: line.terminal,
    firstBusTime: '05:00',
    lastBusTime: '23:30',
    cityCode: '027',
    type: 'bus',
    stops: stopsOf(line),
  }
}

function lineOf(request: RecordedRequest): LineFixture {
  const lineId = /\/lines\/([^/?]+)/.exec(request.url)?.[1] ?? ''
  const line = LINES.find(item => item.lineId === lineId)
  if (!line) throw new Error(`no fixture line for ${request.url}`)
  return line
}

/** 定点读数的答案；读不到的那条线路上游根本没答上，故这条请求死在这里。 */
function liveBody(line: LineFixture): Record<string, unknown> {
  if (line.outcome === 'unreadable') throw new Error('upstream down')
  return {
    success: true,
    data: {
      lineId: line.lineId,
      direction: 0,
      buses: line.bus
        ? [LiveBusSchema.parse({ id: `v_${line.lineId}`, updatedAt: 0, ...line.bus })]
        : [],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: 1_700_000_000_000,
    },
  }
}

function routes(): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: LINES.map(favouriteOf) })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/([^/?]+)\?/, request => ({ success: true, data: detailOf(lineOf(request)) })],
    [/\/api\/transit\/lines\/([^/]+)\/live/, request => liveBody(lineOf(request))],
  ]
}

async function mountBoard(): Promise<MountedHost> {
  const host = await mountComponent(PlatformPage, { routes: routes() })
  await host.flush()
  const stub = host.node(item => item.tag === 'platform-header-stub', 'station header stub')
  const write = stub.props['onUpdate:modelValue']
  const change = stub.props.onChange
  if (typeof write !== 'function' || typeof change !== 'function') {
    throw new Error('the header stub carries no v-model write or change handler')
  }
  ;(write as (value: string) => void)(STATION)
  ;(change as (event: unknown) => void)({ type: 'change', target: stub })
  await host.flush()
  return host
}

/** 屏上的每一行，按用户读到的顺序；每个值是该行的全部可见文本。 */
function boardRows(host: MountedHost): string[] {
  return host
    .nodes(item => item.tag === 'span' && item.text.trim().startsWith('开往'))
    .map((terminal) => {
      const row = terminal.parent?.parent
      if (!row) throw new Error('a rendered terminal is not inside a row')
      return host.textOf(row)
    })
}

function rowTextOf(host: MountedHost, lineName: string): string {
  const text = boardRows(host).find(row => row.startsWith(lineName))
  if (text === undefined) throw new Error(`the board rendered no row for ${lineName}`)
  return text
}

afterEach(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  vi.unstubAllGlobals()
})

describe('站台屏：一块屏上三种结局各有各的说法', () => {
  it('答了但没车的一行陈述线路自己的运营事实，不说失败也不说缺分钟', async () => {
    const host = await mountBoard()
    const text = rowTextOf(host, ANSWERED_EMPTY_LINE)

    expect(text).toContain(OPERATING_TEXT)
    // 请求已作答，故这一行没有任何失败可言。
    expect(text).not.toContain('无法获取')
    expect(text).not.toContain('数据暂不可用')
    // 运营事实不是「有车但没有分钟」，两者不共用措辞。
    expect(text).not.toContain('暂无到站耗时')
    host.unmount()
  })

  it('读不到的一行只陈述失败，不冒充运营事实', async () => {
    const host = await mountBoard()
    const text = rowTextOf(host, UNREADABLE_LINE)

    expect(text).toContain('无法获取')
    expect(text).toContain('数据暂不可用')
    // 车辆与运营日都未知，故这一行不许陈任何一句运营事实。
    expect(text, 'an unreadable row stated an operating fact').not.toMatch(OPERATING_WORDS)
    expect(text).not.toContain('暂无到站耗时')
    host.unmount()
  })

  it('有车但没有分钟的一行陈述缺分钟，既不冒充失败也不冒充运营事实', async () => {
    const host = await mountBoard()
    const text = rowTextOf(host, '机场 5 路')

    expect(text).toContain('暂无到站耗时')
    expect(text).not.toContain('无法获取')
    expect(text).not.toMatch(OPERATING_WORDS)
    host.unmount()
  })

  it('三种说法在屏上互不相同，且各自只出现一次', async () => {
    const host = await mountBoard()
    const board = host.text()

    const answeredEmpty = rowTextOf(host, ANSWERED_EMPTY_LINE)
    const unreadable = rowTextOf(host, UNREADABLE_LINE)
    const missingMinute = rowTextOf(host, '机场 5 路')
    expect(answeredEmpty).not.toBe(unreadable)
    expect(unreadable).not.toBe(missingMinute)

    // 一句事实只由持有它的那一行说出，故没有一个词被第二行复述。
    expect(board.match(/数据暂不可用/g)?.length, 'the failure is stated more than once').toBe(1)
    expect(board.match(/暂无到站耗时/g)?.length, 'the missing minute is stated more than once').toBe(1)
    expect(board.match(new RegExp(OPERATING_TEXT, 'g'))?.length, 'the operating fact is stated more than once').toBe(1)
    host.unmount()
  })

  it('只有一行读不到时，失败留在那一行，不升级成整块屏的刷新失败', async () => {
    const host = await mountBoard()

    // 屏上别的行都有答案，故这不是一次端到端失败的刷新。
    expect(rowTextOf(host, '快线 1 路')).toContain('5 分钟')
    expect(host.text()).not.toContain('刷新失败')
    expect(host.text()).not.toContain('正在加载车况数据')
    // 失败的那一行仍与其余三行同在屏上。
    expect(boardRows(host)).toHaveLength(LINES.length)
    host.unmount()
  })

  it('答了但没车与读不到的行都排在有分钟的行之后', async () => {
    const host = await mountBoard()

    // 三行都没有数字可排：它们的相对次序不作断言，只断言它们都在有数字的行之后。
    expect(rowTextOf(host, '快线 1 路')).toContain('5 分钟')
    expect(boardRows(host)[0]).toContain('5 分钟')
    expect(boardRows(host).slice(1)).toHaveLength(3)
    for (const text of boardRows(host).slice(1)) {
      expect(text).not.toMatch(/\d+ 分钟/)
    }
    host.unmount()
  })
})
