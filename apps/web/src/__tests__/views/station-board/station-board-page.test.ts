import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import {
  click,
  memoryStorage,
  mountComponent,
  type MountedHost,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import StationBoardPage from '../../../views/station-board/index.vue'

/**
 * 电子站牌页（PRD F5）在界面上的那一份：**一个站台上的全部线路并排**。
 *
 * 挂载的是页面本身，因为要断言的一半是「页面把答复里的每一条线路都渲染出来」——
 * 它不认识关注列表，故夹具里那条谁都没关注的线路必须照样在屏上。
 * 站点选择器被换成惰性桩件：它是 reka 的 Combobox，真实键盘由 `tests/e2e` 的场景钉住，此处无关。
 */

vi.mock('@/components/searchable-combobox', () => ({
  SearchableCombobox: {
    name: 'SearchableComboboxStub',
    props: ['modelValue', 'label', 'options', 'selected', 'placeholder'],
    emits: ['select', 'update:modelValue'],
    // 惰性桩件（真键盘由 e2e 钉），但它把候选渲染成文本：这一页要断言的一半正是
    // 「下拉里标出了什么」—— 桩件渲染成空，那半就没人在看了。
    render(this: { label?: string, options?: unknown, selected?: unknown }) {
      const options = (this.options ?? []) as Array<{ primary: string, secondary: string | null }>
      const selected = this.selected as { primary: string, secondary: string | null } | null
      return h('div', { 'data-stub': 'combobox', 'data-label': this.label }, [
        h('span', { 'data-stub': 'selected' }, `${selected?.primary ?? ''} ${selected?.secondary ?? ''}`),
        ...options.map(option => h('span', { 'data-stub': 'option' }, `${option.primary} ${option.secondary ?? ''}`)),
      ])
    },
  },
}))

const CITY = '027'
/** 读取时刻：板子的「最后更新」与分钟都由它推出来。 */
const READ_AT = new Date('2026-10-12T08:30:00').getTime()

/** 一条双向关注线路。 */
function favourite(): Record<string, unknown> {
  return {
    id: 'fav-1',
    userId: 'default_user',
    cityCode: CITY,
    lineId: 'bus_027_1',
    reverseLineId: 'bus_027_2',
    lineName: '101路',
    preferredDirection: 0,
    displayOrder: 0,
  }
}

/** 线路详情：站表里的**站 id** 是这页拿去读站台的凭据，站序是钉过的站台的身份。 */
function lineDetail(stops: Array<{ id: string, name: string, order?: number, lat?: number, lng?: number }>): Record<string, unknown> {
  return {
    success: true,
    data: {
      lineId: 'bus_027_1',
      lineName: '101路',
      direction: 0,
      directionName: '开往 NN终点站',
      stops: stops.map((stop, index) => ({ ...stop, order: stop.order ?? index + 1 })),
    },
  }
}

/** 一次站台读取的答复：三个方向，其中一个只有发车间隔预报。 */
function boardAnswer(): Record<string, unknown> {
  return {
    success: true,
    data: {
      stationId: '010-00001',
      readAt: READ_AT,
      dataSource: 'chelaile',
      lines: [
        {
          lineId: 'bus_027_1',
          lineName: '101路',
          direction: 0,
          destination: 'NN终点站',
          firstBusTime: '05:00',
          lastBusTime: '22:00',
          isSubway: false,
          intervalForecast: null,
          arrivals: [
            { busId: 'b1', arriveAt: READ_AT + 300_000, remainSeconds: 300, distanceToStationMeters: 2408, congestion: 'high', tags: ['无障碍'] },
          ],
        },
        {
          // 这条线路谁都没关注：本页仍要把它列出来（上游按站台作答）。
          lineId: 'bus_027_9',
          lineName: '909路',
          direction: 0,
          destination: 'NN另一终点站',
          firstBusTime: '05:30',
          lastBusTime: '21:00',
          isSubway: false,
          intervalForecast: null,
          arrivals: [
            { busId: 'b9', arriveAt: READ_AT + 720_000, remainSeconds: 720, distanceToStationMeters: 5200, congestion: 'unknown', tags: [] },
          ],
        },
        {
          lineId: 'bus_027_7',
          lineName: '707路',
          direction: 1,
          destination: 'NN第三个终点站',
          firstBusTime: '06:00',
          lastBusTime: '20:00',
          isSubway: false,
          intervalForecast: '16:41~16:51',
          arrivals: [],
        },
      ],
    },
  }
}

interface Answers {
  board?: Record<string, unknown> | 'fail'
  favorites?: Record<string, unknown>[]
  /** 覆盖那条关注线路的站表（站 id + 站名 + 站序），用来造「钉过的站台」。 */
  stops?: Array<{ id: string, name: string, order?: number, lat?: number, lng?: number }>
  /** 附近站台那一次的答复；`'fail'` 表示读不到。 */
  nearby?: Record<string, unknown> | 'fail'
  /** 刷新答复挂住不答：由测试自己放行，用来量「重读还没有答案」那一刻的屏幕。 */
  holdRefresh?: { release?: () => void }
}

/**
 * 我附近的两个站：一个是关注线路站表里没有的，一个与它同名（合并成一行）。
 *
 * 坐标刻意不同（相隔约 200 米）：距离相同时排序会落到站名上，用例就说不清「默认选中的是最近
 * 那个」还是「名字排前面那个」。
 */
function nearbyAnswer(): Record<string, unknown> {
  return {
    success: true,
    data: [
      { stationId: '010-77777', name: 'NN附近站', lat: 39.8745, lng: 116.6715 },
      { stationId: '010-00001', name: 'NN站', lat: 39.8745, lng: 116.6740 },
    ],
  }
}

function routes(answers: Answers = {}): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: answers.favorites ?? [favourite()] })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: CITY, name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/lines\//, () => lineDetail(answers.stops ?? [{ id: '010-00001', name: 'NN站' }])],
    // 附近站台：坐标 + 城市 → 站 id（列表的第二个来源）。
    [/\/api\/transit\/stations\/nearby/, () => (answers.nearby === 'fail'
      ? { success: false, error: '读不到' }
      : answers.nearby ?? nearbyAnswer())],
    [/\/api\/transit\/stations\/.*\/board/, () => (answers.board === 'fail'
      ? { success: false, error: '读不到' }
      : answers.board ?? boardAnswer())],
    // 手动刷新走的是全站共用那一个端点：这一次点名的是站台，而不是几条线路。
    [/\/api\/transit\/refresh/, () => (answers.holdRefresh
      ? new Promise((resolve) => {
          answers.holdRefresh!.release = () => resolve({
            success: true,
            data: {
              dataClass: 'live',
              throttled: false,
              lastUpdatedAt: READ_AT,
              nextAllowedAt: READ_AT + 18_000,
              retryAfterSeconds: 18,
              lines: [],
            },
          })
        })
      : {
          success: true,
          data: {
            dataClass: 'live',
            throttled: false,
            lastUpdatedAt: READ_AT,
            nextAllowedAt: READ_AT + 18_000,
            retryAfterSeconds: 18,
            lines: [],
          },
        })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
  ]
}

async function mountBoard(answers: Answers = {}, storage?: Storage): Promise<MountedHost> {
  const host = await mountComponent(StationBoardPage, { routes: routes(answers), storage })
  await host.flush()
  return host
}

/** 本页记住「上次看的那个站台」的那把钥匙：用例自己布下记录，装置把存储挂到 host 上。 */
const REMEMBERED_KEY = 'rt-transit-station-board-station'

/** 布下一个城市已经记着的站台。 */
function remembered(storage: Storage, stationId: string, cityCode = CITY): Storage {
  storage.setItem(REMEMBERED_KEY, JSON.stringify({ [cityCode]: stationId }))
  return storage
}

/** 触发器上选中的那一条的文字。 */
function selectedText(host: MountedHost): string {
  const selected = host.nodes(item => item.props['data-stub'] === 'selected')[0]
  return host.textOf(selected!).trim()
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('记住上次看的那个站台', () => {
  it('上次看的是列表里的站：重新进入还是它，读的也是它的站牌', async () => {
    // 「NN附近站」来自附近站台那一份，且按距离排不在第一个 —— 正是会被忘掉的那种。
    const host = await mountBoard({}, remembered(memoryStorage(), '010-77777'))

    expect(selectedText(host)).toContain('NN附近站')
    expect(host.server.seen(/\/api\/transit\/stations\/010-77777\/board/).length).toBeGreaterThan(0)
    host.unmount()
  })

  it('上次看的那一站已经不在列表里：退回第一个，但记忆留着', async () => {
    // 站台早已不在附近、那条关注线路也被取关：拿回它会让屏上出现一个下拉里点不到的站台。
    const host = await mountBoard({}, remembered(memoryStorage(), '010-99999'))

    expect(selectedText(host)).toContain('NN站')
    // 记忆没被抹掉：下次它重新回到列表里，还是它。
    expect(host.storage.getItem(REMEMBERED_KEY)).toContain('010-99999')
    host.unmount()
  })

  it('按「定位最近站台」= 回到自动并解除固定，而不是把最近的那个固定下来', async () => {
    const host = await mountBoard({}, remembered(memoryStorage(), '010-77777'))
    expect(selectedText(host)).toContain('NN附近站')

    click(host.node(item => item.tag === 'button' && item.props['aria-label'] === '定位最近站台', '定位按钮'))
    await host.flush()
    await host.flush()

    // 回到列表第一个（离我最近的那个）……
    expect(selectedText(host)).toContain('NN站')
    // ……并且解除固定：刷新时回到自动，而不是又回到刚才那一站。
    expect(JSON.parse(host.storage.getItem(REMEMBERED_KEY) ?? '{}')).toEqual({})
    host.unmount()
  })

  it('固定的那一站**恰好**就是最近的那个：按定位同样解除固定', async () => {
    // 这一条钉的是顺序：解除固定不能因为「选中的还是同一站」而被跳过。
    const host = await mountBoard({}, remembered(memoryStorage(), '010-00001'))
    expect(selectedText(host)).toContain('NN站')

    click(host.node(item => item.tag === 'button' && item.props['aria-label'] === '定位最近站台', '定位按钮'))
    await host.flush()
    await host.flush()

    expect(selectedText(host)).toContain('NN站')
    expect(JSON.parse(host.storage.getItem(REMEMBERED_KEY) ?? '{}')).toEqual({})
    host.unmount()
  })

  it('没记过时选第一个，且**不把自动选中的那个当成「上次看的」**', async () => {
    // 自动选中的第一个不是用户的选择：记下它，就等于把「离我最近」偷偷变成了一种固定。
    const host = await mountBoard()

    expect(selectedText(host)).toContain('NN站')
    expect(host.storage.getItem(REMEMBERED_KEY)).toBeNull()
    host.unmount()
  })
})

describe('我钉过的站台：在列表里（不受名额截断），但默认选中最近的那个站', () => {
  it('上班上车点在 20 公里外：它照样在列表里，而一进来读的是脚边那个站', async () => {
    const host = await mountBoard({
      // 自带一份坐标明确的附近答复：离我最近的是 010-77777（约 80 米）。
      nearby: {
        success: true,
        data: [
          { stationId: '010-77777', name: 'NN附近站', lat: 39.8745, lng: 116.6765 },
          { stationId: '010-00001', name: 'NN站', lat: 39.8745, lng: 116.6740 },
        ],
      },
      stops: [
        { id: '010-00001', name: 'NN站' },
        // 钉过的那个在 20 公里外：整张表按距离排，它落在末尾。
        { id: '010-00009', name: 'NN上车点', order: 9, lat: 39.9, lng: 116.7 },
      ],
      favorites: [{
        ...favourite(),
        morningStopName: 'NN上车点',
        morningStopOrder: 9,
        morningDirection: 0,
      }],
    })

    const options = host.nodes(item => item.props['data-stub'] === 'option').map(node => host.textOf(node).trim())
    // 它在列表里，且带自己的身份。
    expect(options.some(text => text.includes('NN上车点') && text.includes('上班'))).toBe(true)
    expect(options[0], '整张表按距离排，钉过的站不该被顶到最前').not.toContain('NN上车点')
    // 默认选中最近的那个站：这一页要答的是「我这个站上的车还有多久」。
    expect(host.server.seen(/\/api\/transit\/stations\/010-77777\/board/).length).toBeGreaterThan(0)
    expect(host.server.seen(/\/api\/transit\/stations\/010-00009\/board/).length).toBe(0)
    host.unmount()
  })

  it('钉过的站名在本方向对不上（站序变了或不在本方向停靠）：不出现，也不谎报', async () => {
    const host = await mountBoard({
      stops: [{ id: '010-00001', name: 'NN站' }],
      favorites: [{
        ...favourite(),
        morningStopName: 'NN上车点',
        morningStopOrder: 9,
        morningDirection: 0,
      }],
    })

    // 看候选行本身：整页文本里「上班」可能来自别处，那一句就证不到这一条。
    const options = host.nodes(item => item.props['data-stub'] === 'option').map(node => host.textOf(node).trim())
    expect(options.some(text => text.includes('上班'))).toBe(false)
    host.unmount()
  })
})

describe('一屏站台：站台上的线路全部并排', () => {
  it('答复里的每一条线路都渲染出来，含谁都没关注的那条', async () => {
    const host = await mountBoard()

    expect(host.text(), '站台上的线路被关注列表截住了').toContain('909路')
    expect(host.text()).toContain('101路')
    expect(host.text()).toContain('707路')
    expect(host.text()).toContain('开往 NN另一终点站')
    host.unmount()
  })

  it('「到站时刻」与「发车间隔预报」同屏但不同形：各说各的，各只出现一次', async () => {
    const host = await mountBoard()
    const text = host.text()

    expect(text).toContain('5 分钟')
    expect(text).toContain('预报 16:41~16:51')
    // 有车的行不带预报措辞，只有预报的行不带分钟。
    expect(text.match(/预报 16:41~16:51/g)).toHaveLength(1)
    expect(text.match(/分钟/g)?.length).toBe(2)
    host.unmount()
  })

  it('排序就是「哪趟先来」：101（5 分钟）在 909（12 分钟）之前，只有预报的排在有车的后面', async () => {
    const host = await mountBoard()
    const text = host.text()

    expect(text.indexOf('5 分钟')).toBeLessThan(text.indexOf('12 分钟'))
    expect(text.indexOf('12 分钟')).toBeLessThan(text.indexOf('预报 16:41~16:51'))
    host.unmount()
  })

  it('最后更新取自这次读数自己的时刻，且首末班与这趟车距本站多远照上游带上', async () => {
    const host = await mountBoard()
    const text = host.text()

    expect(text).toContain('最后更新 08:30:00')
    expect(text).toContain('首末班 06:00–20:00')
    expect(text).toContain('距本站 2.4 公里')
    expect(text).toContain('距本站 5.2 公里')
    host.unmount()
  })

  it('线路自己的静态事实不在这屏上：没有「距终点」「下一站」这类不随车走的说法', async () => {
    const host = await mountBoard()
    const text = host.text()

    // 它们与「这趟车现在怎样」无关，出现在这屏上会被读成车辆状态。
    expect(text).not.toContain('距终点')
    expect(text).not.toContain('下一站')
    host.unmount()
  })

  it('读不到本站台数据时说读不到，不说「本站台上没有可报的线路」', async () => {
    const host = await mountBoard({ board: 'fail' })
    const text = host.text()

    expect(text).toContain('未读到本站台的到站数据')
    expect(text).not.toContain('本站台上没有可报的线路')
    host.unmount()
  })

  it('答复里一条线路都没有时说「本站台上没有可报的线路」——那是关于这个站台的事实', async () => {
    const host = await mountBoard({
      board: { success: true, data: { stationId: '010-00001', readAt: READ_AT, dataSource: 'chelaile', lines: [] } },
    })
    const text = host.text()

    expect(text).toContain('本站台上没有可报的线路')
    expect(text).not.toContain('未读到本站台的到站数据')
    host.unmount()
  })
})

describe('站台列表的两个来源', () => {
  /** 下拉里每一行的文字（桩件把候选渲染成文本）。 */
  function optionLabels(host: MountedHost): string[] {
    return host.nodes(item => item.props['data-stub'] === 'option').map(node => host.textOf(node).trim())
  }

  it('问了附近的站台，并把它与关注线路的站表合成一张列表（同名只占一行）', async () => {
    const host = await mountBoard()

    expect(host.server.seen(/\/api\/transit\/stations\/nearby/).length).toBeGreaterThan(0)

    // 「NN附近站」只在附近那份里；「NN站」两处都有 —— 合并之后它在下拉里只占一行。
    const labels = optionLabels(host)
    expect(labels.filter(label => label.startsWith('NN站 ')), '同名的站在下拉里出现了不止一次').toHaveLength(1)
    expect(labels.some(label => label.startsWith('NN附近站 '))).toBe(true)
    // 两条都在附近那份里，故都带「附近」；关注线路的站表里没有「NN附近站」。
    expect(labels.filter(label => label.includes('附近'))).toHaveLength(2)
    host.unmount()
  })

  it('附近站台读不到时退回关注线路的站表：不报错，也不编一个「附近」出来', async () => {
    const host = await mountBoard({ nearby: 'fail' })

    const labels = optionLabels(host)
    expect(labels).toHaveLength(1)
    expect(labels[0]).toContain('NN站')
    // 只有关注线路的站表里有它，故不标 —— 标记只标例外。
    expect(labels[0], '只有关注线路经过的站不该带标记').not.toContain('附近')
    expect(host.text(), '附近读不到却冒出一个「附近」').not.toContain('附近')
    expect(host.text()).not.toContain('读不到本站台的到站数据')
    host.unmount()
  })

  it('下拉里的行与触发器上选中的那个用同一套次级文字', async () => {
    const host = await mountBoard()

    const stubText = (kind: string) => host.nodes(item => item.props['data-stub'] === kind)
    const selected = stubText('selected')[0]
    const options = stubText('option')
    expect(selected, '桩件没有渲染出选中的那一条').toBeDefined()
    expect(options.length).toBeGreaterThan(0)

    // 选中的那一条在下拉里必须逐字相同 —— 同一个站在两处长得不一样，读的人会以为它们是两回事。
    const labels = options.map(option => host.textOf(option).trim())
    expect(labels).toContain(host.textOf(selected!).trim())
    host.unmount()
  })
})

describe('刷新期间：屏上的行与它们的年龄都留着', () => {
  it('重读还没有答案时不清空屏：行与「最后更新」都在，且时刻仍是产生这些行的那一次读取', async () => {
    const holdRefresh: { release?: () => void } = {}
    const host = await mountBoard({ holdRefresh })
    const before = host.text()
    expect(before).toContain('还有 5 分钟')
    expect(before).toContain('最后更新 08:30:00')

    const refreshControl = host.node(
      item => item.tag === 'button' && item.props['aria-label'] === '刷新本站台到站',
      '刷新控件',
    )
    click(refreshControl)
    await host.flush()

    // 请求还挂着：屏幕上不能出现一批没有年龄的读数，也不能先空掉再重挂。
    const during = host.text()
    expect(during, '重读中把行清空了').toContain('还有 5 分钟')
    expect(during, '重读中把抬头行藏了起来').toContain('最后更新 08:30:00')

    holdRefresh.release?.()
    await host.flush()
    await host.flush()
    expect(host.text()).toContain('还有 5 分钟')
    host.unmount()
  })
})

describe('手动刷新：这一次点名的是这个站台', () => {
  it('按下刷新 → 请求体里是站台（不是线路），并按新读数重读一次板子', async () => {
    const host = await mountBoard()
    const page = host
    const before = host.server.seen(/\/api\/transit\/stations\/.*\/board/).length

    const refreshControl = page.node(
      item => item.tag === 'button' && item.props['aria-label'] === '刷新本站台到站',
      '刷新控件',
    )
    click(refreshControl)
    await page.flush()
    // 一次刷新之后紧跟一次回读：让 store 那一步的 promise 也落地。
    await page.flush()

    const posted = host.server.seen(/\/api\/transit\/refresh/)
    expect(posted, '按下刷新没有发出请求').toHaveLength(1)
    expect(posted[0]?.body, '刷新点名的不该是线路').toMatchObject({
      station: { stationId: '010-00001', cityCode: CITY },
    })
    expect(posted[0]?.body.lines, '站台刷新不该点名线路').toBeUndefined()
    expect(host.server.seen(/\/api\/transit\/stations\/.*\/board/).length).toBeGreaterThan(before)
    host.unmount()
  })
})
