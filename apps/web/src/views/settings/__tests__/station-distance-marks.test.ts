import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  choose,
  httpStatus,
  mountComponent,
  press,
  type,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import {
  NEAREST_STATION_MARK,
  STATIONS_WITHOUT_COORDS_SENTENCE,
  distanceText,
  legReferencesOf,
  stationDistances,
} from '../station-distance'
import type { ChainDraft } from '../chain-draft'
import type { ChainLineOption, StationReference } from '../types'
import ChainsPage from '../chains.vue'

/**
 * 链路录入的站点选择器：每个站到**参考点**的直线距离，最近的那一个带「最近」标记。
 *
 * 参考点由链路的目的与这一段的位置决定（第 1 段的上车站量起点的锚点、末段的下车站量另一头的
 * 锚点、中间段量相邻段已经选好的那一站），而这一屏有两件最容易被做错的事：
 *
 *  - **顺序**。选择器列出的先后就是线路自己的站序，而站序是「公交只能顺行」那一契约的凭据
 *    （下车站序必须大于上车站序）。按距离重排因此不是一种排序，而是一种误导：使用者会把上车站
 *    挑到某个下车站之后，保存时才被拒绝。本文件钉住「按站序渲染，距离只标注」，并使按距离排序
 *    的那次变异变红；
 *  - **数字的来历**。距离是直线（大圆）距离，不是步行或乘车路线的长度；参考点不可知时
 *    （锚点未存、相邻段的站还没选）一个数字都不标，并说出是哪一种不可知 —— 绝不猜一个点顶替。
 *
 * 坐标是合成的，但几何是真的：下面的读数是真实的 `haversineMeters` 在大圆上的结果，
 * 并由一条独立的界（0.005° 纬度 ≈ 557 米）复核，而不是把同一个公式再算一遍来自证。
 */

/** 家的位置、公司的位置：两者相隔几公里，故「离家」与「离公司」读起来是不同的答案。 */
const HOME = { lat: 39.9, lng: 116.4 }
const WORK = { lat: 39.88, lng: 116.45 }

/** 一段的站点，带它在上游的位置。 */
function stop(name: string, order: number, lat: number, lng: number): Record<string, unknown> {
  return { id: `${name}-${order}`, name, order, lat, lng, interchanges: [] }
}

const FAST_ID = 'bus_027_1'
const SLOW_ID = 'bus_027_2'

/**
 * 快线 1 路：离家最近的是**第 2 站**（团结湖），离家最远的是第 3 站——两个方向上的不对称都在，
 * 故「最近」标在哪一个上可被检查，而按距离排序与按站序排序会给出不同的列表。
 */
const FAST_STOPS = [
  stop('东大桥', 1, 39.94, 116.4),
  stop('团结湖', 2, 39.905, 116.4),
  stop('建国门', 3, 39.9, 116.5),
  stop('十里堡', 4, 39.87, 116.4),
]

/** 慢线 2 路：离公司最近的是第 2 站（双井），换乘段的参考答案。 */
const SLOW_STOPS = [
  stop('光明桥', 1, 39.9, 116.42),
  stop('双井', 2, 39.895, 116.44),
  stop('国贸', 3, 39.9, 116.46),
]

const STOP_LISTS: Record<string, Record<string, unknown>[]> = {
  [`${FAST_ID}#0`]: FAST_STOPS,
  [`${SLOW_ID}#0`]: SLOW_STOPS,
}

const DIRECTION_NAMES: Record<string, string> = {
  [`${FAST_ID}#0`]: '开往建国门',
  [`${SLOW_ID}#0`]: '开往国贸',
}

/**
 * 两条各只有一个方向的关注线路。一个方向就够：本文件量的是**站**到参考点的距离，
 * 方向只决定哪一份站表在屏上，多一个方向不会多一种事实。
 */
const FAVOURITES = [
  {
    id: 'fav-fast',
    userId: 'default_user',
    cityCode: '027',
    lineId: FAST_ID,
    lineName: '快线 1 路',
    preferredDirection: 0,
    reverseLineId: null,
    displayOrder: 0,
  },
  {
    id: 'fav-slow',
    userId: 'default_user',
    cityCode: '027',
    lineId: SLOW_ID,
    lineName: '慢线 2 路',
    preferredDirection: 0,
    reverseLineId: null,
    displayOrder: 1,
  },
]

/** 链路录入时读不到的线路站点与读不到的链路，各是另一条规则的事，此处一律作答。 */
function lineResponder(request: { url: string }): unknown {
  const lineId = decodeURIComponent(request.url.split('/lines/')[1]!.split('?')[0]!)
  const direction = /direction=(\d)/.exec(request.url)?.[1] ?? '0'
  const stops = STOP_LISTS[`${lineId}#${direction}`]
  if (!stops) return { success: false }
  return {
    success: true,
    data: {
      lineId,
      direction: Number(direction),
      directionName: DIRECTION_NAMES[`${lineId}#${direction}`],
      cityCode: '027',
      stops,
    },
  }
}

/**
 * `/settings` 的应答，按它自己的四种事实：
 *
 *  - `stored`  —— 家与公司的坐标都在；
 *  - `unset`   —— 读取作答且没有记录：没人存过锚点。「未设置」是关于已存记录的断言，只有这个答案支持它；
 *  - `silent`  —— 应答里没有 `settingsState`：这一趟读取**没有作答**，故它与上面那种不是同一件事；
 *  - `fail`    —— 请求失败，同样是没作答。
 */
type SettingsAnswer = 'stored' | 'unset' | 'silent' | 'fail'

function settingsBody(state: SettingsAnswer): unknown {
  if (state === 'fail') return { success: false, error: '读取失败' }
  if (state === 'unset') return { success: true, settingsState: 'unset', data: null }
  const hours = { morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00', eveningEnd: '22:00' }
  if (state === 'silent') return { success: true, data: hours }
  return {
    success: true,
    settingsState: 'stored',
    data: { ...hours, homeLat: HOME.lat, homeLng: HOME.lng, workLat: WORK.lat, workLng: WORK.lng },
  }
}

function routes(options: { settings?: SettingsAnswer } = {}): Route[] {
  const settings = options.settings ?? 'stored'
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: FAVOURITES })],
    [/\/api\/transit\/settings/, () => settingsBody(settings)],
    [/\/api\/transit\/lines\//, lineResponder],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
    [/\/api\/transit\/commute-chains$/, () => httpStatus(400, { success: false, error: '本文件不保存链路' })],
  ]
}

/** 挂载 通勤链路 页（`/settings/chains`）并打开录入表单。 */
async function mountEditor(options: { settings?: SettingsAnswer } = {}): Promise<MountedHost> {
  const host = await mountComponent(ChainsPage, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  await press(host, buttonWith(host, '新增链路'))
  return host
}

afterEach(async () => {
  // reka-ui 的焦点作用域在卸载时排定一个定时器，而该定时器会读 document。
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

// ---------- 驱动渲染出的选择器 ----------

function inside(root: HostElement, node: HostElement): boolean {
  let current: HostElement | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

function within(host: MountedHost, root: HostElement): HostElement[] {
  return host.nodes(item => inside(root, item))
}

function buttonWith(host: MountedHost, label: string): HostElement {
  const found = host.nodes(item => item.tag === 'button' && host.textOf(item).includes(label))[0]
  if (!found) throw new Error(`the page rendered no 「${label}」 control`)
  return found
}

function legBlock(host: MountedHost, index: number): HostElement {
  return host.node(item => String(item.props['data-chain-leg']) === String(index), `第 ${index + 1} 段`)
}

/** 某一段的两个站选择器，上车站在前。 */
function stationTriggers(host: MountedHost, index: number): HostElement[] {
  return within(host, legBlock(host, index)).filter(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))
}

function triggerOf(host: MountedHost, index: number, which: 'board' | 'alight'): HostElement {
  const triggers = stationTriggers(host, index)
  const trigger = which === 'board' ? triggers[0] : triggers[1]
  if (!trigger) throw new Error(`第 ${index + 1} 段 rendered no ${which} picker`)
  return trigger
}

async function chooseLine(host: MountedHost, index: number, label: string): Promise<void> {
  const select = within(host, legBlock(host, index)).find(item => item.tag === 'select')!
  const option = host.node(item => item.tag === 'option' && host.textOf(item) === label, `the option 「${label}」`)
  await choose(host, select, String(option.props.value))
}

/**
 * 某一段某个选择器列出的每个站，按屏幕上的先后：打开、读、再关上。
 *
 * 读的是渲染出来的东西，而不是规则模块的复述。数量先被断言非空：空列表会让任何循环白通过，
 * 而「一个距离都没标」与「一个站都没列出来」是两件完全不同的事。
 */
async function listedStations(
  host: MountedHost,
  index: number,
  which: 'board' | 'alight',
  expected: number,
): Promise<string[]> {
  const trigger = triggerOf(host, index, which)
  await press(host, trigger)
  const texts = host.nodes(item => item.props.role === 'option').map(item => host.textOf(item))
  await press(host, trigger)
  expect(texts, `第 ${index + 1} 段的${which === 'board' ? '上' : '下'}车站选择器列出的站`).toHaveLength(expected)
  return texts
}

/** 从选择器里挑一个站：按站名与站序匹配，因为它旁边可能还挂着一段距离。 */
async function pickStation(
  host: MountedHost,
  index: number,
  which: 'board' | 'alight',
  name: string,
  order: number,
): Promise<void> {
  await press(host, triggerOf(host, index, which))
  const option = host.node(
    item => item.props.role === 'option'
      && host.textOf(item).startsWith(`${name} `)
      && host.textOf(item).includes(`第${order}站`),
    `the stop 「${name} 第${order}站」`,
  )
  await press(host, option)
}

/** 编辑器自己的名称字段：表单里第一个文本输入框（站点选择器的搜索框只在面板打开时存在）。 */
function nameField(host: MountedHost): HostElement {
  const found = host.nodes(item => item.tag === 'input' && item.props.type === 'text')[0]
  if (!found) throw new Error('the editor rendered no name field')
  return found
}

/** 某一段这一整块说出来的话（含两个选择器下面各自的说明）。 */
function legText(host: MountedHost, index: number): string {
  return host.textOf(legBlock(host, index))
}

// ---------- 规则模块用的夹具 ----------

/** 一个「线路 + 方向」选项，站点与坐标一同给出。 */
function lineOption(lineId: string, stations: Array<[string, number, number, number]>): ChainLineOption {
  return {
    key: `${lineId}_0`,
    lineGroupKey: lineId,
    direction: 0,
    lineId,
    lineName: lineId,
    cityCode: '027',
    directionLabel: null,
    commuteRole: null,
    stations: stations.map(([name, order, lat, lng]) => stop(name, order, lat, lng)) as never,
    stops: 'ready',
  }
}

/** 三个已经选好上下车站的段，使「中间段的参考点是相邻段的站」可被单独断言。 */
function draftOfThreeLegs(): ChainDraft {
  return {
    name: '三段',
    purpose: 'morning',
    legs: [
      { lineKey: `${FAST_ID}_0`, boardStationName: '东大桥', boardStationOrder: 1, alightStationName: '建国门', alightStationOrder: 3, transferExtraMinutes: null, connectionMode: null },
      { lineKey: `${SLOW_ID}_0`, boardStationName: '光明桥', boardStationOrder: 1, alightStationName: '双井', alightStationOrder: 2, transferExtraMinutes: null, connectionMode: null },
      { lineKey: `${FAST_ID}_0`, boardStationName: '团结湖', boardStationOrder: 2, alightStationName: '十里堡', alightStationOrder: 4, transferExtraMinutes: null, connectionMode: null },
    ],
  }
}

const ANCHORS_READ = { state: 'read' as const, value: { homeLat: HOME.lat, homeLng: HOME.lng, workLat: WORK.lat, workLng: WORK.lng } }

describe('上车站与下车站各自的参考点：按链路的目的与段的位置定，而不是一个固定的点', () => {
  it('第 1 段的上车站量的是链路的起点锚点：上班按家，下班按公司（同一份站表，两个答案）', async () => {
    const host = await mountEditor()

    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    // 上班链路从家出发，故量的是家；第 2 站（团结湖）是这条线上离家最近的一个，
    // 而它的站序排在中间——最近的那一个与第一个不是同一个站。
    expect(await listedStations(host, 0, 'board', 4)).toEqual([
      '东大桥 离家直线 4.4 公里 第1站',
      '团结湖 离家直线 556 米 最近 第2站',
      '建国门 离家直线 8.5 公里 第3站',
      '十里堡 离家直线 3.3 公里 第4站',
    ])

    // 同一个屏幕上下班链路：目的换了，量到的参考点就换成了公司，最近的站也随之变成第 4 站。
    const evening = host.node(item => item.props.role === 'radio' && item.props.value === 'evening', 'the 下班 radio')
    await press(host, evening)

    expect(await listedStations(host, 0, 'board', 4)).toEqual([
      '东大桥 离公司直线 7.9 公里 第1站',
      '团结湖 离公司直线 5.1 公里 第2站',
      '建国门 离公司直线 4.8 公里 第3站',
      '十里堡 离公司直线 4.4 公里 最近 第4站',
    ])
    host.unmount()
  })

  it('末段的下车站量的是链路的**目的**锚点：上班链路的末段下车站量到公司', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await press(host, buttonWith(host, '添加乘车段'))
    await chooseLine(host, 1, '慢线 2 路 · 开往国贸')

    // 第 2 段是末段，而它的下车站是链路的终点那一头——上班链路的目的地是公司。
    // 慢线 2 路上离公司最近的是第 2 站（双井），不是第一个。
    expect(await listedStations(host, 1, 'alight', 3)).toEqual([
      '光明桥 离公司直线 3.4 公里 第1站',
      '双井 离公司直线 1.9 公里 最近 第2站',
      '国贸 离公司直线 2.4 公里 第3站',
    ])

    // 同一段的上车站量的是**上一段的下车站**，不是公司：相邻的两段在同一个站换乘，
    // 故「哪一站是我要的」问的是离那个换乘点有多远。
    expect(await listedStations(host, 1, 'board', 3)).toEqual([
      '光明桥 第1站',
      '双井 第2站',
      '国贸 第3站',
    ])
    expect(legText(host, 1)).toContain('第 1 段下车站还没选，算不出直线距离')
    host.unmount()
  })

  it('相邻段已经选好的那一站就是参考点：选上之后，上一段的下车站当场按它标注', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await press(host, buttonWith(host, '添加乘车段'))
    await chooseLine(host, 1, '慢线 2 路 · 开往国贸')

    // 相邻段还没选：一个距离都不标，并说出缺的是哪一段的哪一端。
    expect(await listedStations(host, 0, 'alight', 4)).toEqual([
      '东大桥 第1站',
      '团结湖 第2站',
      '建国门 第3站',
      '十里堡 第4站',
    ])
    expect(legText(host, 0)).toContain('第 2 段上车站还没选，算不出直线距离')

    // 第 2 段的上车站选在国贸之后，第 1 段的下车站改按国贸量：离国贸最近的是第 3 站（建国门）。
    await pickStation(host, 1, 'board', '国贸', 3)
    expect(await listedStations(host, 0, 'alight', 4)).toEqual([
      '东大桥 离第 2 段上车站直线 6.8 公里 第1站',
      '团结湖 离第 2 段上车站直线 5.1 公里 第2站',
      '建国门 离第 2 段上车站直线 3.4 公里 最近 第3站',
      '十里堡 离第 2 段上车站直线 6.1 公里 第4站',
    ])
    expect(legText(host, 0)).not.toContain('算不出直线距离')
    host.unmount()
  })
})

describe('参考点不可知时一个数字都不标，并如实说出是哪一种不可知', () => {
  it('锚点没存下来：不标数字，说「未设置家的位置」，绝不说成「未读到」（那是关于失败读取的话）', async () => {
    const host = await mountEditor({ settings: 'unset' })
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    expect(await listedStations(host, 0, 'board', 4)).toEqual([
      '东大桥 第1站',
      '团结湖 第2站',
      '建国门 第3站',
      '十里堡 第4站',
    ])
    const said = legText(host, 0)
    expect(said).toContain('未设置家的位置，算不出直线距离')
    expect(said).not.toContain('未读到家的位置')
    host.unmount()
  })

  it('锚点那一次读取没作答：同一个位置说的是「未读到家的位置」，与「未设置」不是同一件事', async () => {
    const host = await mountEditor({ settings: 'silent' })
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    expect(await listedStations(host, 0, 'board', 4)).toEqual([
      '东大桥 第1站',
      '团结湖 第2站',
      '建国门 第3站',
      '十里堡 第4站',
    ])
    const said = legText(host, 0)
    expect(said).toContain('未读到家的位置，算不出直线距离')
    expect(said).not.toContain('未设置家的位置')
    host.unmount()
  })

  it('本方向的站点一个坐标都没有：数字量不出来，那句话说的是站点这一边缺东西', async () => {
    const host = await mountComponent(ChainsPage, {
      routes: [
        ...routes(),
        [/\/api\/transit\/lines\//, () => ({ success: true, data: {
          lineId: FAST_ID,
          direction: 0,
          directionName: '开往建国门',
          cityCode: '027',
          // 站表在，坐标一个都没有：从任何一个站都量不出距离，而参考点本身是好的。
          stops: FAST_STOPS.map(({ name, order, id }) => ({ id, name, order, interchanges: [] })),
        } })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()
    await press(host, buttonWith(host, '新增链路'))
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    expect(await listedStations(host, 0, 'board', 4)).toEqual([
      '东大桥 第1站',
      '团结湖 第2站',
      '建国门 第3站',
      '十里堡 第4站',
    ])
    expect(legText(host, 0)).toContain(STATIONS_WITHOUT_COORDS_SENTENCE)
    host.unmount()
  })
})

describe('顺序一律不动：距离只是标注', () => {
  it('列出的先后就是线路自己的站序，标在哪一个站上都不改它（按距离排序会让上车站被挑到下车站之后）', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    const listed = await listedStations(host, 0, 'board', 4)
    // 站名与站序按线路自己的编号：东大桥 1、团结湖 2、建国门 3、十里堡 4。
    expect(listed.map(text => text.split(' ')[0])).toEqual(['东大桥', '团结湖', '建国门', '十里堡'])
    expect(listed.map(text => /第(\d)站$/.exec(text)?.[1])).toEqual(['1', '2', '3', '4'])

    // 距离读起来是散的（4.4 / 0.6 / 8.5 / 3.3 公里），故上面那份顺序不可能是按距离排出来的：
    // 按距离排的话第 1 个就是团结湖、第 2 个是十里堡。
    expect(listed[0]).toContain('4.4 公里')
    expect(listed[1]).toContain('556 米')
    expect(listed[2]).toContain('8.5 公里')
    expect(listed[3]).toContain('3.3 公里')
    host.unmount()
  })

  it('距离说的是直线：单位是米与公里，且不会被读成步行或路线长度', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    const listed = await listedStations(host, 0, 'board', 4)
    for (const text of listed) {
      expect(text).toMatch(/^[^ ]+ 离家直线 \d+(?:\.\d)? (?:米|公里)(?: 最近)? 第[1-4]站$/)
      for (const claim of ['步行', '路线', '车程']) expect(text).not.toContain(claim)
    }
    host.unmount()
  })
})

describe('「最近」标的是这条线路上真正最近的那一个', () => {
  it('最近的那个带标记，且是整份站表里的最小值——包括一个比第一个更近的中间站', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    const listed = await listedStations(host, 0, 'board', 4)
    const marked = listed.filter(text => text.includes(NEAREST_STATION_MARK))
    expect(marked).toHaveLength(1)
    // 团结湖是第 2 站：它比第一个站离得更近，故「最近」不是「第一个」的另一个说法。
    expect(marked[0]).toBe('团结湖 离家直线 556 米 最近 第2站')
    expect(listed[0]).not.toContain(NEAREST_STATION_MARK)
    host.unmount()
  })

  it('按站名筛选过之后，「最近」仍说的是整条线路的最小值，而不是筛出来的那几个里的最小值', async () => {
    const host = await mountEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await press(host, triggerOf(host, 0, 'board'))

    // 只留下离家最远的那个站：它旁边不得出现「最近」——最小值是这条线路的事实，
    // 不是使用者敲进去的那几个字的。
    const search = host.nodes(item => item.tag === 'input' && item.props.role === 'combobox')[0]!
    await type(host, search, '建国门')
    const filtered = host.nodes(item => item.props.role === 'option').map(item => host.textOf(item))
    expect(filtered).toEqual(['建国门 离家直线 8.5 公里 第3站'])
    expect(filtered.join(' ')).not.toContain(NEAREST_STATION_MARK)
    host.unmount()
  })
})

describe('规则模块本身', () => {
  const lines = [lineOption(FAST_ID, [['东大桥', 1, 39.94, 116.4], ['团结湖', 2, 39.905, 116.4], ['建国门', 3, 39.9, 116.5], ['十里堡', 4, 39.87, 116.4]]),
    lineOption(SLOW_ID, [['光明桥', 1, 39.9, 116.42], ['双井', 2, 39.895, 116.44], ['国贸', 3, 39.9, 116.46]])]

  it('三个段各自的参考点：第 1 段上车站按起点锚点、末段下车站按目的锚点、中间段按相邻段的站', () => {
    const draft = draftOfThreeLegs()
    const [first, middle, last] = legReferencesOf(draft, lines, ANCHORS_READ)

    expect(first!.board).toEqual({ state: 'known', from: '家', lat: HOME.lat, lng: HOME.lng })
    // 第 1 段与第 2 段在东大桥换乘，故它的下车站量的是第 2 段的上车站。
    expect(first!.alight).toEqual({ state: 'known', from: '第 2 段上车站', lat: 39.9, lng: 116.42 })
    // 中间段的两端各量到相邻段的站：上一段的下车站（建国门 第3站）与下一段的上车站（团结湖 第2站）。
    expect(middle!.board).toEqual({ state: 'known', from: '第 1 段下车站', lat: 39.9, lng: 116.5 })
    expect(middle!.alight).toEqual({ state: 'known', from: '第 3 段上车站', lat: 39.905, lng: 116.4 })
    // 末段的下车站量的是链路的另一端：上班链路的目的是公司。
    expect(last!.alight).toEqual({ state: 'known', from: '公司', lat: WORK.lat, lng: WORK.lng })
    expect(last!.board).toEqual({ state: 'known', from: '第 2 段下车站', lat: 39.895, lng: 116.44 })
  })

  it('相邻段的站还没选：那一个参考点不可知，句子点名是第几段的哪一端', () => {
    const draft = draftOfThreeLegs()
    draft.legs[1]!.alightStationName = null
    draft.legs[1]!.alightStationOrder = null

    expect(legReferencesOf(draft, lines, ANCHORS_READ)[2]!.board).toEqual({
      state: 'unknown',
      sentence: '第 2 段下车站还没选，算不出直线距离',
    })
  })

  it('锚点那一边的三种事实各说各的：没读到、确实没设置、以及读到（带上坐标）', () => {
    const draft = draftOfThreeLegs()
    const purposeOf = (purpose: ChainDraft['purpose']): ChainDraft => ({ ...draft, purpose })

    expect(legReferencesOf(draft, lines, { state: 'unreadable' })[0]!.board)
      .toEqual({ state: 'unknown', sentence: '未读到家的位置，算不出直线距离' })
    expect(legReferencesOf(draft, lines, { state: 'reading' })[0]!.board)
      .toEqual({ state: 'unknown', sentence: '正在读取家的位置…' })
    expect(legReferencesOf(draft, lines, { state: 'read', value: { homeLat: null, homeLng: null, workLat: WORK.lat, workLng: WORK.lng } })[0]!.board)
      .toEqual({ state: 'unknown', sentence: '未设置家的位置，算不出直线距离' })
    // 下班链路从公司出发：同一份锚点读数，起点那一端读的是公司。
    expect(legReferencesOf(purposeOf('evening'), lines, ANCHORS_READ)[0]!.board)
      .toEqual({ state: 'known', from: '公司', lat: WORK.lat, lng: WORK.lng })
  })

  it('量的只有坐标齐全的站：没有坐标的站不在标注里（绝不印一个 NaN），参考点未知则一个都不标', () => {
    const reference: StationReference = { state: 'known', from: '家', lat: HOME.lat, lng: HOME.lng }
    const stations = [
      stop('东大桥', 1, 39.94, 116.4),
      // 未落点的站：本基准面上没有这个点，从它量出的数字会把一个不存在的站算成最近的。
      { id: '无坐标', name: '无名', order: 2, interchanges: [] },
      // 任一轴为 0 同样是「没有坐标」，而不是一个真实的赤道附近的位置。
      stop('零度', 3, 0, 116.4),
    ] as never

    const marked = stationDistances(stations, reference)
    expect([...marked.keys()]).toEqual(['1_东大桥'])
    expect(stationDistances(stations, { state: 'unknown', sentence: '未设置家的位置，算不出直线距离' }).size).toBe(0)
  })

  it('距离的写法：一公里以下用米、一公里以上用公里，取整后跨过一千米也不印「1000 米」', () => {
    expect(distanceText(556)).toBe('556 米')
    expect(distanceText(999.4)).toBe('999 米')
    expect(distanceText(999.6)).toBe('1.0 公里')
    expect(distanceText(8530.5)).toBe('8.5 公里')
  })

  it('读数是真实几何的结果，而不是同一个公式的自证：0.005° 纬度按 111.32 公里/度算出来就是 556 米上下', () => {
    // 团结湖与家只差 0.005° 纬度（经度相同），故大圆距离就是这一小段子午线：
    // 111.32 公里/度 × 0.005° ≈ 556.6 米，独立的界与模块给出的那个数字一致（差 < 1 米）。
    const marked = stationDistances(
      FAST_STOPS as never,
      { state: 'known', from: '家', lat: HOME.lat, lng: HOME.lng },
    )
    const stated = Number(/离家直线 (\d+) 米/.exec(marked.get('2_团结湖')!.text)![1])
    const bound = 111_320 * 0.005
    expect(stated).toBe(556)
    expect(Math.abs(bound - stated)).toBeLessThan(1)
  })
})
