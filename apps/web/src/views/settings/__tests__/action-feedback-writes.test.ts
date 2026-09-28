import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  type,
  httpStatus,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'
import FavoriteEditorPage from '../favorite-editor.vue'
import AnchorDetailPage from '../anchor-detail.vue'
import CommuteHoursForm from '../components/commute-hours-form.vue'

/**
 * 设置页每一处写操作，成与败各说一句。
 *
 * 内联提示仍是那份**持久**的记录（一眼看得见它落在哪个控件旁），故它一个字都不改；而手机上它常常
 * 落在屏幕之外，故每一次按下另有一句跟着走。这一份逐个动作评判：关注线路的五个写操作（关注、取消关注、
 * 上车点、方向、顺序）、位置锚点那一个、通勤时段那一个，以及失败时那句话带上的原因。
 *
 * 「列表页 + 独立编辑页」把关注线路的五个写操作分在两页上：关注与顺序在列表页，取消关注、上车点、
 * 方向在编辑页（`/settings/lines/:favoriteId`）。故驱动方式随之分成 `mountLines`（列表页）与
 * `mountEditor`（编辑页）两个；编辑页的两处字段写入现在还要按一次「保存」（草稿语义）。
 *
 * 提示库被替换掉，故这里读的是推出去的那句话本身。
 */

const { pushed } = vi.hoisted(() => ({ pushed: [] as Array<{ message: string, options: Record<string, unknown> }> }))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string, options: Record<string, unknown> = {}) => {
      pushed.push({ message, options })
      return pushed.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

const FAV_ID = 'fav-300'
const UP = 'bus_027_300_0'
const DOWN = 'bus_027_300_1'
const LINE_NAME = '300内'

/** 一条公交双向线路的关注行。 */
const FAVOURITE: Record<string, unknown> = {
  id: FAV_ID,
  userId: 'default_user',
  cityCode: '027',
  lineId: UP,
  reverseLineId: DOWN,
  lineName: LINE_NAME,
  preferredDirection: 0,
  displayOrder: 0,
  morningDirection: 0,
}

/** 方向 0 的站表。 */
const DIR0 = {
  lineId: UP,
  direction: 0,
  directionName: '开往 和平东桥',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '和平东桥', order: 1, interchanges: [] },
    { id: 's2', name: '安贞桥东', order: 2, interchanges: [] },
  ],
}

/** 另一个方向。 */
const DIR1 = { ...DIR0, lineId: DOWN, direction: 1, directionName: '开往 安慧桥' }

/** 搜索结果里的一条线路：一条**还没被关注**的线路，故它那一行提供的是「关注」。 */
const SEARCH_LINE_NAME = '400路'
const SEARCH_GROUP = {
  groupKey: 'g1',
  lineName: SEARCH_LINE_NAME,
  cityCode: '027',
  up: { lineId: 'bus_027_400_0', direction: 0, directionName: '开往 四方桥' },
  down: { lineId: 'bus_027_400_1', direction: 1, directionName: '开往 桥头' },
}

const SETTINGS = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
  homeLat: null,
  homeLng: null,
  workLat: null,
  workLng: null,
}

function messages(): string[] {
  return pushed.map(item => item.message)
}

/** 本页发出的读取，外加回显所给行的 PATCH —— 各写操作自己的成败由测试在末尾追加覆盖项。 */
function routes(): Route[] {
  return [
    [/\/api\/transit\/favorites$/, request => (request.method === 'POST'
      ? { success: true, data: { ...FAVOURITE, id: 'fav-new' } }
      : { success: true, data: [FAVOURITE] })],
    [/\/api\/transit\/lines\/search/, () => ({ success: true, data: [SEARCH_GROUP] })],
    // 详情读取：`search` 是另一个端点，故把它排除在外（最近的匹配胜出，而它也会被下面这条匹配到）。
    [/\/api\/transit\/lines\/(?!search)[^/?]+\?/, request => ({
      success: true,
      data: request.url.includes(DOWN) ? DIR1 : DIR0,
    })],
    [/\/api\/transit\/favorites\/fav-300$/, request => ({
      success: true,
      data: { ...FAVOURITE, ...(request.body as Record<string, unknown> ?? {}) },
    })],
    [/\/api\/transit\/settings/, () => ({ success: true, settingsState: 'stored', data: SETTINGS })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

async function mountLines(...overrides: Route[]): Promise<MountedHost> {
  const host = await mountComponent(LinesPage, {
    routes: [...routes(), ...overrides],
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 挂**编辑页**：取消关注、上车点与方向这三处写入住在这里。 */
async function mountEditor(...overrides: Route[]): Promise<MountedHost> {
  const host = await mountComponent(FavoriteEditorPage, {
    props: { favoriteId: FAV_ID },
    routes: [...routes(), ...overrides],
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 地点搜索的一条候选：名字与地址都是这条路径上真实存在的东西。 */
const PLACE_NAME = '珠江帝景B区'
const PLACE_SEARCH_RESULTS = [
  { name: PLACE_NAME, district: '朝阳区劲松街道', address: '西大望路珠江帝景', lng: 116.480284, lat: 39.890076 },
  { name: '珠江帝景E区', district: '朝阳区劲松街道', address: '大郊亭中街', lng: 116.484142, lat: 39.887832 },
]

async function mountAnchorPage(...overrides: Route[]): Promise<MountedHost> {
  const host = await mountComponent(AnchorDetailPage, {
    props: { anchor: 'home' },
    routes: [
      [/\/api\/transit\/gis\/place-search/, () => ({ success: true, data: PLACE_SEARCH_RESULTS })],
      ...routes(),
      ...overrides,
    ],
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 整宽的那个保存按钮：它的文字带着这个锚点的名字。 */
function saveButton(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === '保存',
    'the save button',
  )
}

async function mountHours(...overrides: Route[]): Promise<MountedHost> {
  const host = await mountComponent(CommuteHoursForm, { routes: [...routes(), ...overrides] })
  await host.flush()
  return host
}

afterEach(async () => {
  // reka-ui 的焦点作用域在卸载时排定一个定时器，而该定时器会读 document。
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

beforeEach(() => {
  pushed.length = 0
  // 锚点那一个写操作先要一次设备定位；其余用例不碰它。
  vi.stubGlobal('navigator', {
    geolocation: {
      getCurrentPosition: (success: (position: unknown) => void) => success({
        coords: { latitude: 39.90931, longitude: 116.3974, accuracy: 12 },
        timestamp: Date.now(),
      }),
      watchPosition: () => 1,
      clearWatch: () => {},
    },
  })
})

// ---------- 驱动关注线路页 ----------

/** 编辑页底部的保存控件 —— 草稿落库的唯一时刻。 */
function editorSaveButton(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === '保存',
    'the save button',
  )
}

/** 按保存，让编辑页的草稿落库。 */
async function save(host: MountedHost): Promise<void> {
  await press(host, editorSaveButton(host))
}

/**
 * 编辑页上的上车点选择器，按模板顺序：上班在前，下班在后。
 *
 * 编辑页上没有展开态，也没有别的组合框；列表行那个链接是 `<a>`，故这里不会点中它。
 */
function pickerTriggers(host: MountedHost): HostElement[] {
  return host.nodes(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'))
}

/** 经选择器自己的弹层选一个站。 */
async function pickStop(host: MountedHost, which: number, name: string, order: number): Promise<void> {
  const trigger = pickerTriggers(host)[which]
  if (!trigger) throw new Error(`the opened row rendered no picker at index ${which}`)
  await press(host, trigger)
  await press(host, host.node(
    item => item.props.role === 'option'
      && host.textOf(item).includes(name)
      && host.textOf(item).includes(`第${order}站`),
    `the stop option 「${name} 第${order}站」`,
  ))
}

/** 展开行里的方向单选，按模板顺序：上班两个、下班两个。 */
function directionRadios(host: MountedHost): HostElement[] {
  return host.nodes(item => item.props.role === 'radio')
}

/**
 * 拖拽库挂在容器元素自己身上的那个实例。
 *
 * 它按一个每次加载都不同的键挂上去，故这里按前缀找键 —— 库自己的键名就是 `Sortable…`。
 */
function sortableOf(host: MountedHost): { options: { onEnd: (event: unknown) => void } } {
  const key = (node: HostElement): string | undefined =>
    Object.keys(node).find(name => /^sortable/i.test(name))
  const node = host.node(item => key(item) !== undefined, 'the sortable container')
  return (node as unknown as Record<string, { options: { onEnd: (event: unknown) => void } }>)[key(node)!]!
}

/** 一次拖放：被拖走的行占据它落在其上的行的格子。 */
async function drag(host: MountedHost, from: number, to: number): Promise<void> {
  sortableOf(host).options.onEnd({ oldIndex: from, newIndex: to })
  await host.flush()
}

describe('关注线路：五个写操作各说一句（两个在列表页，三个在编辑页）', () => {
  it('上车点：按保存成功说一句已保存上车点', async () => {
    const host = await mountEditor()

    await pickStop(host, 0, '和平东桥', 1)
    await save(host)

    // 一次保存 = 一次动作 = 一句回话（写整屏的细节不逐条播报）。
    expect(messages()).toEqual(['已保存关注设置'])
    host.unmount()
  })

  it('上车点：被拒时说一句，并带上服务端给的原因', async () => {
    // 只拒**带上车点列**的那一次写入：保存现在写整屏，方向那一半要照常通过，
    // 否则第一次请求就被拒、后面的写入根本没机会发。
    const host = await mountEditor([
      /\/api\/transit\/favorites\/fav-300$/,
      (request) => {
        const body = (request.body ?? {}) as Record<string, unknown>
        const carriesStop = 'morningStopOrder' in body || 'eveningStopOrder' in body
        return carriesStop
          ? httpStatus(400, { success: false, error: '该站不在本方向停靠' })
          : { success: true, data: { ...FAVOURITE, ...body } }
      },
    ])

    await pickStop(host, 0, '和平东桥', 1)
    await save(host)

    expect(messages()).toEqual(['保存失败 · 该站不在本方向停靠'])
    // 内联那一份仍在，它才是持久的那份记录。
    expect(host.text()).toContain('该站不在本方向停靠')
    host.unmount()
  })

  it('方向：按保存改成功说一句已保存方向', async () => {
    const host = await mountEditor()

    const radios = directionRadios(host)
    expect(radios.length, 'this row offers no direction to choose').toBeGreaterThan(0)
    // 第一个是上班方向 0，它已是选中项；按第二个即换成方向 1。
    await press(host, radios[1]!)
    await save(host)

    expect(messages()).toEqual(['已保存关注设置'])
    host.unmount()
  })

  it('方向：被拒时说一句保存失败', async () => {
    const host = await mountEditor([
      /\/api\/transit\/favorites\/fav-300$/,
      () => httpStatus(500, { success: false, error: '暂时无法写入' }),
    ])

    await press(host, directionRadios(host)[1]!)
    await save(host)

    expect(messages()).toEqual(['保存失败 · 暂时无法写入'])
    host.unmount()
  })

  it('顺序：落一次拖放说一句顺序已更新', async () => {
    // 两条关注行，故真的有一次移动可写。
    const second = { ...FAVOURITE, id: 'fav-301', lineId: 'bus_027_301_0', reverseLineId: undefined, lineName: '52路', displayOrder: 1 }
    const host = await mountComponent(LinesPage, {
      routes: [
        ...routes().filter(([pattern]) => !String(pattern).includes('favorites')),
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE, second] })],
        [/\/api\/transit\/favorites\/[^/]+$/, request => ({
          success: true,
          data: { ...FAVOURITE, id: request.url.split('/').at(-1), ...(request.body as Record<string, unknown> ?? {}) },
        })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    await drag(host, 0, 1)

    expect(messages()).toEqual(['顺序已更新'])
    host.unmount()
  })

  it('顺序：被拒时说一句顺序保存失败', async () => {
    const second = { ...FAVOURITE, id: 'fav-301', lineId: 'bus_027_301_0', reverseLineId: undefined, lineName: '52路', displayOrder: 1 }
    const host = await mountComponent(LinesPage, {
      routes: [
        ...routes().filter(([pattern]) => !String(pattern).includes('favorites')),
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [FAVOURITE, second] })],
        [/\/api\/transit\/favorites\/[^/]+$/, () => httpStatus(500, { success: false, error: '该关注不存在' })],
      ],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    await drag(host, 0, 1)

    expect(messages()).toEqual(['顺序保存失败 · 该关注不存在'])
    host.unmount()
  })

  it('关注：说一句已关注，带上这条线路的名字', async () => {
    const host = await mountLines()

    await type(host, host.node(item => item.tag === 'input' && item.props.type === 'search', 'the search field'), SEARCH_LINE_NAME)
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '搜索', 'the search button'))
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '关注', 'the follow button'))

    expect(messages()).toEqual([`已关注 ${SEARCH_LINE_NAME}`])
    host.unmount()
  })

  it('关注：被拒时说一句关注失败', async () => {
    const host = await mountLines([
      /\/api\/transit\/favorites$/,
      request => (request.method === 'POST'
        ? httpStatus(500, { success: false, error: '关注上线了' })
        : { success: true, data: [] }),
    ])

    await type(host, host.node(item => item.tag === 'input' && item.props.type === 'search', 'the search field'), SEARCH_LINE_NAME)
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '搜索', 'the search button'))
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '关注', 'the follow button'))

    expect(messages()).toEqual([`关注失败 ${SEARCH_LINE_NAME} · 关注上线了`])
    host.unmount()
  })

  it('取消关注：说一句已取消关注，带上这条线路的名字', async () => {
    const host = await mountEditor([
      /\/api\/transit\/favorites\/fav-300$/,
      request => (request.method === 'DELETE'
        ? { success: true }
        : { success: true, data: { ...FAVOURITE, ...(request.body as Record<string, unknown> ?? {}) } }),
    ])

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes('取消关注'), 'the unfollow button'))
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '确认取消关注', 'the confirm button'))

    expect(messages()).toEqual([`已取消关注 ${LINE_NAME}`])
    host.unmount()
  })

  it('取消关注：被拒时说一句取消关注失败', async () => {
    const host = await mountEditor([
      /\/api\/transit\/favorites\/fav-300$/,
      () => httpStatus(500, { success: false, error: '该关注不存在' }),
    ])

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes('取消关注'), 'the unfollow button'))
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '确认取消关注', 'the confirm button'))

    expect(messages()).toEqual([`取消关注失败 ${LINE_NAME} · 该关注不存在`])
    host.unmount()
  })
})

/** 在锚点页上搜一次并选中第一条结果 —— 两处入口（搜索 / 当前位置）汇进同一个保存动作。 */
async function searchAndSelect(host: MountedHost): Promise<void> {
  await type(host, host.node(item => item.tag === 'input' && item.props.type === 'search', 'the search field'), '珠江帝景')
  await press(host, host.node(item => item.tag === 'button' && host.textOf(item).trim() === '搜索', 'the search button'))
  await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes(PLACE_NAME), 'the result row'))
}

describe('位置锚点：保存各说一句', () => {
  it('成功：说一句已保存「家」的位置', async () => {
    const host = await mountAnchorPage()

    await searchAndSelect(host)
    await press(host, saveButton(host))

    expect(messages()).toEqual(['已保存「家」的位置'])
    host.unmount()
  })

  it('被拒：说一句未能保存，且指向定位权限', async () => {
    const host = await mountAnchorPage([
      /\/api\/transit\/settings/,
      request => (request.method === 'PATCH'
        ? httpStatus(500, { success: false, error: '写入失败' })
        : { success: true, settingsState: 'stored', data: SETTINGS }),
    ])

    await searchAndSelect(host)
    await press(host, saveButton(host))

    expect(messages()).toEqual(['未能保存「家」的位置，请检查定位权限后重试'])
    host.unmount()
  })
})

describe('通勤时段：保存各说一句', () => {
  it('成功：说一句已保存通勤时段', async () => {
    const host = await mountHours()

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes('保存时段'), 'the save button'))

    expect(messages()).toEqual(['已保存通勤时段'])
    host.unmount()
  })

  it('被拒：说一句通勤时段保存失败', async () => {
    const host = await mountHours([
      /\/api\/transit\/settings/,
      () => httpStatus(500, { success: false, error: '写入失败' }),
    ])

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes('保存时段'), 'the save button'))

    expect(messages()).toEqual(['通勤时段保存失败'])
    expect(host.text()).toContain('写入失败')
    host.unmount()
  })
})
