import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveBusSchema } from '@real-time-transport/shared'
import {
  mountComponent,
  type MountedHost,
  type RecordedRequest,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import PlatformPage from '../index.vue'

/**
 * 站台页**自己**的多线路聚合与排序（F5 界面层）。
 *
 * 页面按每一条（线路，方向，站序）规则各发一次定点 `live` 读数，再把这些答案拼成一块屏：
 * 行的内容、行的次序、每行的来源标记全在页面自己的代码里。接口层契约已由
 * `apps/server/src/__tests__/api/f5-platform-aggregation.test.ts` 钉住，本文件驱动的是消费它的那一页。
 *
 * 四条承重规则：一行的分钟只能来自它自己那条读数（多线路绝不共用一个答案）；行按到站耗时
 * 升序，秒级读数决定谁在前，无分钟的行排在所有有数字的行之后；每行的来源标记取自自己那条
 * 响应声明的来源；一块屏上可以同时存在不同类别的行，故类别逐行陈述。
 *
 * 挂载的是页面而不是把它的输出喂给报告板——被断言的那份聚合代码就是页面自己。本仓库只有一个
 * 无 DOM 挂载装置（`设置` 的），第二份副本会与之漂移。站点头部被换成惰性桩件：它驱动原生
 * `<select>`，而 runtime-dom 的 `v-model` 要写 `options.length`，是装置刻意不建模的 DOM API。
 */

vi.mock('../components/platform-header.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'PlatformHeaderStub',
      props: ['modelValue', 'stationOptions', 'landmarkHint', 'detecting'],
      setup(_props: Record<string, unknown>, { attrs }: { attrs: Record<string, unknown> }) {
        // change / v-model 的 onXxx 绑定不声明为 emits 才落在 attrs 里、被摊到标记元素上，
        // 测试才有得驱动；真实 `<select>` 的顺序是先写值再发事件。
        return () => h('platform-header-stub', { ...attrs })
      },
    },
  }
})

/** 所选站台，以及它落在每条线路上的那个站序。 */
const STATION = '西单路口东'

/** 屏上的一行：它自己的读数给出什么。 */
interface LineFixture {
  lineId: string
  lineName: string
  /** 该方向的终到站，行上的方向文本，也是屏上行序的读法。 */
  terminal: string
  /** 本站台在该方向上的站序；读数按它定价，站数按它数。 */
  stationOrder: number
  /** 该响应声明的来源；行的标记由它决定。 */
  dataSource: string
  /** 这条读数里的车：没有 `travelTimeSec` 即该行没有分钟。 */
  bus: Record<string, unknown>
}

/**
 * 五条已关注线路，全部途经本站台。
 *
 * 秒数是刻意选的：600 s 与 120 s 是**同一个站序**上的两条读数，故任何「把多线路的车并成一个
 * 池子」的聚合都会让 10 分钟出现在本该 2 分钟的那一行上；540 s 与 555 s 相差 15 秒却同落
 * 9 分钟，故次序由分钟决定而不由秒的细微差别决定；机场 5 路只有车没有分钟，它的位置就是
 * 「无分钟的行排在哪」的答案。
 */
const LINES: LineFixture[] = [
  {
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    terminal: '开往东单',
    stationOrder: 3,
    dataSource: 'chelaile',
    bus: { order: 1, nextOrder: 3, travelTimeSec: 600, congestion: 'low' },
  },
  {
    lineId: 'bus_027_2',
    lineName: '支线 2 路',
    terminal: '开往西直门',
    stationOrder: 3,
    dataSource: 'subway_schedule',
    bus: { order: 1, nextOrder: 3, travelTimeSec: 120, congestion: 'high' },
  },
  {
    lineId: 'bus_027_3',
    lineName: '环线 3 路',
    terminal: '开往四惠',
    stationOrder: 4,
    dataSource: 'chelaile',
    bus: { order: 1, nextOrder: 2, travelTimeSec: 540, congestion: 'low' },
  },
  {
    lineId: 'bus_027_4',
    lineName: '夜班 4 路',
    terminal: '开往北京站',
    stationOrder: 3,
    dataSource: 'chelaile',
    bus: { order: 1, nextOrder: 3, travelTimeSec: 555, congestion: 'low' },
  },
  {
    lineId: 'bus_027_5',
    lineName: '机场 5 路',
    terminal: '开往首都机场',
    stationOrder: 3,
    dataSource: 'chelaile',
    // 车在途、车头正开向本站台，只是这条读数没有行程时间——故本行没有分钟。
    bus: { order: 1, nextOrder: 3, congestion: 'high' },
  },
]

/** 每条线路的秒数，行上该以哪个分钟出现。 */
const MINUTE_OF: Record<string, number> = { bus_027_1: 10, bus_027_2: 2, bus_027_3: 9, bus_027_4: 9 }

/** 一条关注线路，如 store 所持有。 */
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

/**
 * 该方向的停靠列表：本站台落在它自己的站序上，其余站名唯一。
 * 站名唯一使「哪一行问的是哪一个站序」可按站序断言，而不必猜名字。
 */
function stopsOf(line: LineFixture): Array<Record<string, unknown>> {
  const stops: Array<Record<string, unknown>> = []
  for (let order = 1; order <= line.stationOrder; order += 1) {
    stops.push({
      id: `${line.lineId}_s${order}`,
      name: order === line.stationOrder ? STATION : `${line.lineName} · 第 ${order} 站`,
      order,
      interchanges: [],
    })
  }
  stops.push({ id: `${line.lineId}_s_end`, name: `${line.lineName} · 终点`, order: line.stationOrder + 1, interchanges: [] })
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

/** 一次定点读数的答案：车辆由契约校验，故夹具本身不能携带非法读数。 */
function liveBody(line: LineFixture): Record<string, unknown> {
  return {
    success: true,
    data: {
      lineId: line.lineId,
      direction: 0,
      buses: [LiveBusSchema.parse({ id: `v_${line.lineId}`, updatedAt: 0, ...line.bus })],
      dataSource: line.dataSource,
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
    // 线路详情与定点读数各由自己的 lineId 作答，故一块屏的五条线路互不供数。
    [/\/api\/transit\/lines\/([^/?]+)\?/, request => ({ success: true, data: detailOf(lineOf(request)) })],
    [/\/api\/transit\/lines\/([^/]+)\/live/, request => liveBody(lineOf(request))],
  ]
}

/** 挂载页面并显式停在共用站台上——不对 localeCompare 选出的默认站下注。 */
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
      // 方向文本所在的那一格 → 它所在的那一行（两格组成一行）。
      const row = terminal.parent?.parent
      if (!row) throw new Error('a rendered terminal is not inside a row')
      return host.textOf(row)
    })
}

/** 行序，读作线路名。 */
function boardOrder(host: MountedHost): string[] {
  return boardRows(host).map((text) => {
    const line = LINES.find(item => text.startsWith(item.lineName))
    if (!line) throw new Error(`a rendered row belongs to no fixture line: ${text}`)
    return line.lineName
  })
}

/** 某条线路那一行的全部可见文本，或一个点名缺失之物的抛错。 */
function rowTextOf(host: MountedHost, lineName: string): string {
  const text = boardRows(host).find(row => row.startsWith(lineName))
  if (text === undefined) throw new Error(`the board rendered no row for ${lineName}`)
  return text
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('站台屏：一行只陈述自己那条读数', () => {
  it('分钟与站数都来自本行的读数，绝不跨线借用', async () => {
    const host = await mountBoard()

    // 每条线路的秒数落在自己那一行上：600 s → 10 分钟，120 s → 2 分钟（同站序上的另一条读数），
    // 540 s 与 555 s → 都是 9 分钟。
    expect(rowTextOf(host, '快线 1 路')).toContain('10 分钟')
    expect(rowTextOf(host, '支线 2 路')).toContain('2 分钟')
    expect(rowTextOf(host, '环线 3 路')).toContain('9 分钟')
    expect(rowTextOf(host, '夜班 4 路')).toContain('9 分钟')

    // 站数同理：数的是本行那辆车头到本站台的距离（环线尚 2 站，快线只剩 1 站）。
    expect(rowTextOf(host, '环线 3 路')).toContain('距 2 站')
    expect(rowTextOf(host, '快线 1 路')).toContain('距 1 站')

    // 跨线借用的形状：别的线路的分钟出现在这一行上。逐行逐线地查，故任何一次借用在屏上都留痕。
    for (const line of LINES) {
      const own = MINUTE_OF[line.lineId]
      for (const other of LINES) {
        const borrowed = MINUTE_OF[other.lineId]
        if (borrowed === undefined || borrowed === own) continue
        expect(rowTextOf(host, line.lineName), `${line.lineName} borrowed ${other.lineName}`)
          .not.toContain(`${borrowed} 分钟`)
      }
    }

    host.unmount()
  })

  it('每行问的是自己那条线路在本站台的站序，故读数按本站台定价', async () => {
    const host = await mountBoard()

    const asked = new Map<string, Set<string>>()
    for (const request of host.server.seen(/\/live/)) {
      const line = lineOf(request)
      const order = new URL(request.url, 'http://localhost').searchParams.get('order') ?? ''
      asked.set(line.lineId, (asked.get(line.lineId) ?? new Set()).add(order))
    }

    for (const line of LINES) {
      expect([...asked.get(line.lineId) ?? []], `${line.lineName} was not asked about its own stop`)
        .toEqual([String(line.stationOrder)])
    }
    host.unmount()
  })
})

describe('站台屏：按到站耗时排序', () => {
  it('升序，秒级读数决定谁在前，而不是关注顺序或线路名', async () => {
    const host = await mountBoard()

    expect(boardOrder(host)).toEqual(['支线 2 路', '环线 3 路', '夜班 4 路', '快线 1 路', '机场 5 路'])
    // 与关注顺序不同，故排序确实发生过（关注顺序即夹具顺序）。
    expect(boardOrder(host)).not.toEqual(LINES.map(line => line.lineName))
    host.unmount()
  })

  it('排序按到站耗时，不按站数：更远的站数不妨碍更早到达', async () => {
    const host = await mountBoard()

    // 环线尚 2 站而快线只剩 1 站，但 540 s < 600 s，故环线在前。
    const text = rowTextOf(host, '环线 3 路')
    expect(text).toContain('距 2 站')
    expect(text).toContain('9 分钟')
    const order = boardOrder(host)
    expect(order.indexOf('环线 3 路')).toBeLessThan(order.indexOf('快线 1 路'))
    host.unmount()
  })

  it('无分钟的行排在所有有数字的行之后，且不冒充数字', async () => {
    const host = await mountBoard()
    const order = boardOrder(host)

    expect(order[order.length - 1]).toBe('机场 5 路')
    // 其余每一行都带数字，故最后一行不是碰巧落在末尾。
    for (const lineName of order.slice(0, -1)) {
      expect(rowTextOf(host, lineName)).toMatch(/\d+ 分钟/)
    }

    const missing = rowTextOf(host, '机场 5 路')
    expect(missing).not.toMatch(/\d+ 分钟/)
    expect(missing).toContain('暂无到站耗时')
    // 没有数字就没有标记——标记是给数字的，故本行不借「实时」。
    expect(missing).not.toContain('实时')
    expect(missing).not.toContain('排班推演')
    host.unmount()
  })

  it('同落到一分钟的两行相邻：15 秒之差不足以分先后', async () => {
    const host = await mountBoard()
    const order = boardOrder(host)

    // 540 s 与 555 s 都是 9 分钟，比较器同值；两条读数按关注顺序被请求，行仍相邻。
    expect(order.indexOf('夜班 4 路') - order.indexOf('环线 3 路')).toBe(1)
    expect(rowTextOf(host, '环线 3 路')).toContain('9 分钟')
    expect(rowTextOf(host, '夜班 4 路')).toContain('9 分钟')
    host.unmount()
  })
})

describe('站台屏：标记逐行取自本行的响应', () => {
  it('实时读数与排班推演在同一块屏上各标自己的那一行', async () => {
    const host = await mountBoard()

    // 支线那条响应声明 subway_schedule，快线与环线声明 chelaile：标记不跟着屏走，跟着行走。
    expect(rowTextOf(host, '支线 2 路')).toContain('排班推演')
    expect(rowTextOf(host, '支线 2 路')).not.toContain('实时')
    expect(rowTextOf(host, '快线 1 路')).toContain('实时')
    expect(rowTextOf(host, '快线 1 路')).not.toContain('排班推演')
    expect(rowTextOf(host, '环线 3 路')).toContain('实时')
    expect(rowTextOf(host, '环线 3 路')).not.toContain('排班推演')
    host.unmount()
  })
})
