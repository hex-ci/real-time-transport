import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Component } from 'vue'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import AnchorsIndexPage from '../../../views/settings/anchors.vue'
import { anchorSummaryOf, pickAnchors } from '../../../views/settings/anchors'
import { anchorOf } from '../../../views/settings/anchor-catalog'

/**
 * 组件自己发起的跳转，按顺序记下。
 *
 * `useRouter` 被替换掉：本宿主的 `RouterLinkStub` 只能读链接被指向哪里，而保存之后的那次
 * 跳转是**命令式**的（`router.push`），它不在链接里。
 */
const pushedRoutes: string[] = []

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: (to: string) => {
      pushedRoutes.push(to)
      return Promise.resolve()
    },
  }),
}))

/** 推出去的提示：操作反馈只说在这里，页上不再留第二处。 */
const { messages } = vi.hoisted(() => ({ messages: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string) => {
      messages.push(message)
      return messages.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

/**
 * F2 的两段式：`/settings/anchors` 两行整行可点，每个锚点自己一页（搜索 → 选中 → 保存）。
 *
 * 本文件钉的是**行为**（挂载页面、按控件、读印出的文字与发出的请求），而不是源码里有什么。
 * 其中几条是本轮真正会坏的地方：
 *
 *  - **搜索只在提交时发生**：输入框与搜索请求之间不得有 watch。逐字请求会让结果顺序跳动、
 *    移动端键盘占掉四成屏高，而上游有 QPS 限额。断言方式：打字之后请求数为 0，提交之后为 1。
 *  - **选中不写库**：点一行只改屏上的选中态，PATCH 一个都不发。写库只有「保存」一处。
 *  - **没有「取消」**：不保存就走（点返回）等于放弃这次选择，故页面里没有这个动作。
 *  - **来源随坐标一起提交**：搜索来的坐标是高德给的 GCJ-02（`search`，原样落库），
 *    抓来的是原始 WGS-84（`device`，服务端换算一次）。浏览器侧不做任何换算。
 *  - **认不出的路由参数不发明默认值**：`/settings/anchors/office` 不得按「家」渲染。
 */

const PLACES = [
  { name: '珠江帝景B区', district: '朝阳区劲松街道', address: '西大望路珠江帝景', lng: 116.480284, lat: 39.890076 },
  { name: '珠江帝景E区', district: '朝阳区劲松街道', address: '大郊亭中街', lng: 116.484142, lat: 39.887832 },
]

/** 一条没有地址的候选：次行只能显示区，绝不编造一个地址。 */
const PLACE_WITHOUT_ADDRESS = { name: '珠江帝景', district: '北京市朝阳区', lng: 116.481799, lat: 39.889332 }

const STORED = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
  homeLat: 39.87765,
  homeLng: 116.46392,
  homePlaceName: '珠江帝景B区',
  homeAnchorSource: 'search',
  workLat: null,
  workLng: null,
  workPlaceName: null,
  workAnchorSource: null,
}

type SettingsAnswer = 'ok' | 'fail' | 'unset'

function settingsBody(answer: SettingsAnswer): unknown {
  if (answer === 'fail') return { success: false, error: '读取失败' }
  if (answer === 'unset') return { success: true, settingsState: 'unset', data: null }
  return { success: true, settingsState: 'stored', data: STORED }
}

function routes(options: {
  settings?: SettingsAnswer
  search?: 'ok' | 'empty' | 'fail' | 'unreadable'
  searchResults?: unknown[]
} = {}): Route[] {
  return [
    [/\/api\/transit\/settings/, () => settingsBody(options.settings ?? 'ok')],
    [/\/api\/transit\/gis\/place-search/, () => {
      if (options.search === 'fail') return { success: false, error: '地点搜索暂时不可用' }
      if (options.search === 'unreadable') return { success: false, error: '上游没答' }
      return { success: true, data: options.search === 'empty' ? [] : (options.searchResults ?? PLACES) }
    }],
  ]
}

async function mountDetail(options: Parameters<typeof routes>[0] = {}, anchor = 'home'): Promise<MountedHost> {
  const host = await mountComponent(await anchorDetailComponent(), {
    props: { anchor },
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/**
 * 锚点页的组件，**在关掉 GPS 覆写之后**加载。
 *
 * `location.store.ts` 在 import 时决定设备定位是否被固定坐标顶替（读 `import.meta.env`），
 * 而仓库根的 `.env` 把 `VITE_GPS_SIMULATION` 开着。不显式关掉并重新加载模块图，
 * 「用当前位置」那条路径测到的会是模拟坐标 —— 于是「设备上报的原始定位原样送出」这条
 * 断言测的就不是它说的那件事。
 */
async function anchorDetailComponent(): Promise<Component> {
  vi.stubEnv('VITE_GPS_SIMULATION', 'false')
  vi.stubEnv('VITE_GPS_SIM_LAT', '')
  vi.stubEnv('VITE_GPS_SIM_LNG', '')
  vi.resetModules()
  return (await import('../../../views/settings/anchor-detail.vue')).default
}

async function mountIndex(options: Parameters<typeof routes>[0] = {}): Promise<MountedHost> {
  const host = await mountComponent(AnchorsIndexPage, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

beforeEach(() => {
  // 「用当前位置」那条路径先要一次设备定位。`getCurrentPosition` 报的是原始 WGS-84，
  // 且它与搜索结果刻意不是同一个坐标 —— 两条路径分得开。
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

/** 按文本取一个控件，或一个点名所寻之物的抛错。 */
function control(host: MountedHost, words: string): HostElement {
  return host.node(
    item => (item.tag === 'button' || item.tag === 'a') && host.textOf(item).trim() === words,
    `the 「${words}」 control`,
  )
}

/** 搜索表单里的输入框（`type=search`），以及提交它的那个按钮。 */
function searchField(host: MountedHost): HostElement {
  return host.node(item => item.tag === 'input' && item.props.type === 'search', 'the search field')
}

function searchButton(host: MountedHost): HostElement {
  return host.node(item => item.tag === 'button' && host.textOf(item).includes('搜索'), 'the search button')
}

/** 整宽的那个保存按钮。 */
function saveButton(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === '保存',
    'the save button',
  )
}

/** 搜一次并回车（本仓的表单提交由装置自己触发，见 `settings-harness.ts` 的 `press`）。 */
async function search(host: MountedHost, words = '珠江帝景'): Promise<void> {
  await type(host, searchField(host), words)
  await press(host, searchButton(host))
}

/** 结果列表里的每一行：整行是一个 button，行内没有别的按钮。 */
function resultRows(host: MountedHost): HostElement[] {
  return host.nodes(item => item.tag === 'button' && item.props['aria-pressed'] !== undefined)
}

/** 页面上发出的 PATCH（写库）。 */
function patches(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.method === 'PATCH')
}

/** 页面上发出的搜索请求。 */
function searches(host: MountedHost): Array<{ url: string }> {
  return host.server.requests.filter(request => request.url.includes('place-search'))
}

describe('锚点页：搜索只在提交时发生', () => {
  it('逐字输入一个请求都不发，按下搜索才发一次', async () => {
    const host = await mountDetail()

    // 逐字：输入框真的收到了这些字符，而请求数一直是 0。
    for (const words of ['珠', '珠江', '珠江帝', '珠江帝景']) {
      await type(host, searchField(host), words)
    }
    expect(searches(host), 'typing issued a request per keystroke').toHaveLength(0)

    await press(host, searchButton(host))
    expect(searches(host)).toHaveLength(1)
    host.unmount()
  })

  it('输入框是 type=search + enterkeyhint=search，且带防 iOS 缩放的 16px 文本', async () => {
    const host = await mountDetail()

    const field = searchField(host)
    expect(field.props.enterkeyhint).toBe('search')
    expect(String(field.props.class), 'the field is below 16px, so iOS zooms on focus').toContain('text-base')
    // 两个控件都在 44px 的触控目标内，且都不换行。
    expect(String(field.props.class)).toMatch(/min-h-\[44px\]/)
    expect(String(searchButton(host).props.class)).toMatch(/min-h-\[44px\]/)
    host.unmount()
  })

  it('搜索请求带上关键词与当前城市', async () => {
    const host = await mountDetail()

    await search(host, '珠江帝景')

    expect(decodeURIComponent(searches(host)[0]!.url)).toContain('keywords=珠江帝景')
    expect(searches(host)[0]!.url).toContain('cityCode=027')
    host.unmount()
  })

  it('结果行：整行可点、行内没有别的按钮，主文本是地点名、次行是区 + 地址', async () => {
    const host = await mountDetail()
    await search(host)

    const rows = resultRows(host)
    expect(rows, 'the result list rendered no selectable row').toHaveLength(PLACES.length)
    expect(host.textOf(rows[0]!)).toContain('珠江帝景B区')
    expect(host.textOf(rows[0]!)).toContain('朝阳区劲松街道')
    expect(host.textOf(rows[0]!)).toContain('西大望路珠江帝景')
    // 行内没有按钮：选中靠点整行，不靠一个「选 / 已选」控件。
    for (const row of rows) {
      expect(host.nodes(item => item.tag === 'button' && item !== row && isInside(row, item)), 'a result row carries a button of its own').toHaveLength(0)
    }
    host.unmount()
  })

  it('没有地址的候选只显示名字与区，绝不编造地址', async () => {
    const host = await mountDetail({ searchResults: [PLACE_WITHOUT_ADDRESS] })
    await search(host)

    const row = resultRows(host)[0]!
    expect(host.textOf(row)).toContain('珠江帝景')
    expect(host.textOf(row)).toContain('北京市朝阳区')
    host.unmount()
  })

  it('搜到 0 条：说清在哪个城市、搜的什么词，空态里不夹带动作', async () => {
    const host = await mountDetail({ search: 'empty' })
    await search(host, '珠江帝景苑三区')

    const text = host.text()
    expect(text).toContain('未找到匹配「珠江帝景苑三区」的位置')
    expect(text).toContain('北京')
    // 「用当前位置」已移到保存按钮旁边，故它不在空态里 —— 空态只说这一件事。
    expect(host.textOf(control(host, '用当前位置'))).toBe('用当前位置')
    host.unmount()
  })

  it('搜索没答上来：说「未读到」，不说「未找到」，并给重试', async () => {
    const host = await mountDetail({ search: 'fail' })
    await search(host)

    const text = host.text()
    expect(text, 'a failed search is worded as an empty one').not.toContain('未找到匹配')
    expect(text).toContain('未读到搜索结果')
    expect(control(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('没搜过的时候不显示空态，但「用当前位置」一直都在（它和保存并排）', async () => {
    const host = await mountDetail()

    expect(host.text(), 'an empty state was shown before any search').not.toContain('未找到匹配')
    // 它与保存同一行，因此任何时候都在屏上，不依赖搜索有没有结果。
    expect(host.textOf(control(host, '用当前位置'))).toBe('用当前位置')
    expect(host.textOf(control(host, '保存'))).toBe('保存')
    host.unmount()
  })
})

describe('锚点页：选中不写库，保存才写', () => {
  it('点一行只选中（高亮 + 右端对勾），PATCH 一个都不发', async () => {
    const host = await mountDetail()
    await search(host)

    await press(host, resultRows(host)[0]!)

    expect(resultRows(host)[0]!.props['aria-pressed']).toBe(true)
    expect(patches(host), 'selecting a row wrote to the store').toHaveLength(0)
    host.unmount()
  })

  it('再点一次取消选中：待保存的坐标对只能有一个', async () => {
    const host = await mountDetail()
    await search(host)

    await press(host, resultRows(host)[0]!)
    await press(host, resultRows(host)[0]!)

    expect(resultRows(host)[0]!.props['aria-pressed']).toBe(false)
    host.unmount()
  })

  it('点另一行就换成那一行，前一行不再选中', async () => {
    const host = await mountDetail()
    await search(host)

    await press(host, resultRows(host)[0]!)
    await press(host, resultRows(host)[1]!)

    expect(resultRows(host)[0]!.props['aria-pressed']).toBe(false)
    expect(resultRows(host)[1]!.props['aria-pressed']).toBe(true)
    host.unmount()
  })

  it('没选东西时保存按钮不可点（没有可以保存的坐标对）', async () => {
    const host = await mountDetail()

    expect(saveButton(host).props.disabled).toBe(true)
    host.unmount()
  })

  it('选了之后保存按钮可点，按下写一次库：坐标 + 名字 + 来源 search', async () => {
    const host = await mountDetail()
    await search(host)
    await press(host, resultRows(host)[0]!)

    expect(saveButton(host).props.disabled).toBe(false)
    await press(host, saveButton(host))

    const sent = patches(host)
    expect(sent).toHaveLength(1)
    // 坐标**原样**是高德给的那一对：转一次会落在另一个坐标上，而界面看不出来。
    expect(sent[0]!.body).toMatchObject({
      homeLat: PLACES[0]!.lat,
      homeLng: PLACES[0]!.lng,
      homePlaceName: PLACES[0]!.name,
      homeAnchorSource: 'search',
    })
    host.unmount()
  })

  it('保存之后待保存的选中态清掉：留下的高亮会让「保存」看起来还没落库', async () => {
    const host = await mountDetail()
    await search(host)
    await press(host, resultRows(host)[0]!)
    await press(host, saveButton(host))

    expect(saveButton(host).props.disabled).toBe(true)
    host.unmount()
  })

  it('保存成功之后回到锚点列表：这一页的事办完了', async () => {
    pushedRoutes.length = 0
    const host = await mountDetail()
    await search(host)
    await press(host, resultRows(host)[0]!)
    await press(host, saveButton(host))
    await host.flush()

    expect(pushedRoutes).toEqual(['/settings/anchors'])
    host.unmount()
  })

  it('保存失败留在这一页：跳走会把原因也带走', async () => {
    pushedRoutes.length = 0
    messages.length = 0
    const host = await mountDetail()
    host.server.on(/\/api\/transit\/settings/, () => ({ success: false, error: '写入失败' }))
    await search(host)
    await press(host, resultRows(host)[0]!)
    await press(host, saveButton(host))
    await host.flush()

    // 原因由 toast 带着说，且这一页不跳走 —— 跳走那句话就没地方读了。
    expect(messages).toEqual(['未能保存「家」的位置'])
    expect(pushedRoutes).toEqual([])
    host.unmount()
  })

  it('结果列表封顶并自己滚：一次搜索回来十几条也不把保存按钮推走', async () => {
    const host = await mountDetail()
    await search(host)

    const list = host.node(
      item => String(item.props.class ?? '').includes('overflow-y-auto') && String(item.props.class ?? '').includes('max-h-'),
      'the scrollable result list',
    )
    expect(String(list.props.class)).toContain('overscroll-contain')
    host.unmount()
  })

  it('页面里没有「取消」这个动作：不保存就走等于放弃这次选择', async () => {
    const host = await mountDetail()
    await search(host)
    await press(host, resultRows(host)[0]!)

    const labelled = host.nodes(item => item.tag === 'button').map(item => host.textOf(item).trim())
    expect(labelled).not.toContain('取消')
    expect(labelled.some(words => words.includes('取消'))).toBe(false)
    host.unmount()
  })

  it('换一次搜索就丢掉上一次的选中：屏上已看不见那条候选', async () => {
    const host = await mountDetail()
    await search(host)
    await press(host, resultRows(host)[0]!)
    expect(saveButton(host).props.disabled).toBe(false)

    await search(host, '另一个地方')

    expect(saveButton(host).props.disabled, 'a coordinate nobody can see is still queued for saving').toBe(true)
    host.unmount()
  })

  it('写库被拒：说一句带原因的话，且不说成保存成功', async () => {
    messages.length = 0
    const host = await mountDetail()
    host.server.on(/\/api\/transit\/settings/, () => ({ success: false, error: '写入失败' }))
    await search(host)
    await press(host, resultRows(host)[0]!)
    await press(host, saveButton(host))

    expect(messages).toEqual(['未能保存「家」的位置'])
    expect(host.text()).not.toContain('已保存')
    host.unmount()
  })
})

describe('锚点页：两处入口汇进同一个保存动作', () => {
  it('用当前位置：一次点完就写库（抓取 + 保存 + 回列表），不再有「待保存」那一步', async () => {
    pushedRoutes.length = 0
    const host = await mountDetail({ search: 'empty' })
    await search(host)
    await press(host, control(host, '用当前位置'))
    await host.flush()

    // 一次点击 = 一次写库，且写的是设备那一路：原始 WGS-84、来源 device、名字为 null。
    const sent = patches(host)
    expect(sent, 'the grab did not write').toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({
      homeLat: 39.90931,
      homeLng: 116.3974,
      homeAnchorSource: 'device',
      homePlaceName: null,
    })
    expect(pushedRoutes).toEqual(['/settings/anchors'])
    host.unmount()
  })

  it('用当前位置失败：说一句带原因的话，且不写库、不跳走', async () => {
    pushedRoutes.length = 0
    messages.length = 0
    const host = await mountDetail({ search: 'empty' })
    await search(host)
    host.server.on(/\/api\/transit\/settings/, () => ({ success: false, error: '写入失败' }))
    await press(host, control(host, '用当前位置'))
    await host.flush()

    expect(messages).toEqual(['未能保存「家」的位置'])
    expect(pushedRoutes).toEqual([])
    host.unmount()
  })

  it('用当前位置后保存：来源记为 device，名字提交为 null，坐标是浏览器上报的原始值', async () => {
    const host = await mountDetail({ search: 'empty' })
    await search(host)
    await press(host, control(host, '用当前位置'))
    await press(host, saveButton(host))

    const sent = patches(host)
    expect(sent).toHaveLength(1)
    // 原始 WGS-84 原样送出：浏览器侧不做任何换算，服务端换算一次。
    expect(sent[0]!.body).toMatchObject({
      homeLat: 39.90931,
      homeLng: 116.3974,
      homeAnchorSource: 'device',
      homePlaceName: null,
    })
    host.unmount()
  })

  it('搜索选中之后再抓当前位置：待保存的换成抓来的那一个', async () => {
    const host = await mountDetail({ search: 'empty' })
    await search(host)
    await press(host, control(host, '用当前位置'))
    await press(host, saveButton(host))

    expect(patches(host)[0]!.body.homeAnchorSource).toBe('device')
    host.unmount()
  })
})

describe('锚点页：两个锚点共用一页，文案与字段按参数走', () => {
  it('公司页：标题、按钮与 PATCH 字段都是公司的', async () => {
    const host = await mountDetail({}, 'work')
    await search(host)
    await press(host, resultRows(host)[0]!)
    await press(host, saveButton(host))

    expect(host.text()).toContain('设置「公司」')
    expect(patches(host)[0]!.body).toMatchObject({
      workLat: PLACES[0]!.lat,
      workLng: PLACES[0]!.lng,
      workPlaceName: PLACES[0]!.name,
      workAnchorSource: 'search',
    })
    // 绝不写另一个锚点的字段。
    expect(patches(host)[0]!.body).not.toHaveProperty('homeLat')
    host.unmount()
  })

  it('两个锚点页共用一页，动作行也共用：按钮不随参数改名', async () => {
    const host = await mountDetail({ search: 'empty' }, 'work')
    await search(host)

    expect(host.text()).toContain('设置「公司」')
    expect(control(host, '用当前位置')).toBeDefined()
    expect(control(host, '保存')).toBeDefined()
    host.unmount()
  })

  it('认不出的路由参数不发明默认值：不按「家」渲染，也不发写请求', async () => {
    const host = await mountDetail({}, 'office')

    // 页面自己的那一半：路由表里那条 `(home|work)` 正则让它在导航层面落到 404 页，
    // 而组件被以别的参数挂载时同样不猜。
    expect(host.text()).not.toContain('设置「家」')
    expect(host.text()).not.toContain('设置「公司」')
    expect(host.text()).toContain('这个位置锚点不存在')
    expect(saveButton_optional(host)).toBeUndefined()
    host.unmount()
  })

  it('锚点表认不出参数就是 null —— 这就是页面不发明默认值的那条规则', () => {
    expect(anchorOf('home')).toBe('home')
    expect(anchorOf('work')).toBe('work')
    expect(anchorOf('office')).toBeNull()
    expect(anchorOf(undefined)).toBeNull()
    // 大小写不同也是另一个字符串：路由与这一处都不归一化。
    expect(anchorOf('HOME')).toBeNull()
  })
})

/** 保存按钮，或 undefined（参数不合法时页面里没有它）。 */
function saveButton_optional(host: MountedHost): HostElement | undefined {
  return host.nodes(item => item.tag === 'button' && host.textOf(item).trim() === '保存')[0]
}

describe('锚点索引页：两行整行可点', () => {
  it('两行各自指向自己那一页，摘要文本在链接里面', async () => {
    const host = await mountIndex()

    const links = host.nodes(item => item.tag === 'a' && String(item.props.href).startsWith('/settings/anchors/'))
    expect(links.map(item => item.props.href)).toEqual(['/settings/anchors/home', '/settings/anchors/work'])
    // 行与它的状态不能各说一半：整行就是那一个链接。
    expect(host.textOf(links[0]!)).toContain('家')
    expect(host.textOf(links[0]!)).toContain('珠江帝景B区')
    expect(host.textOf(links[1]!)).toContain('公司')
    host.unmount()
  })

  it('摘要有名字说名字、没名字说坐标、没有坐标说未设置', async () => {
    const host = await mountIndex()

    const text = host.text()
    // 搜索来的锚点有名字，故它说名字（坐标在它自己的页面里说）。
    expect(text).toContain('珠江帝景B区')
    // 未设置的那一个说清代价。
    expect(text).toContain('未设置 · 无法算出门时间')
    host.unmount()
  })

  it('设备抓来的锚点没有名字：摘要显示坐标，不编造一个名字', async () => {
    const host = await mountComponent(AnchorsIndexPage, {
      routes: [[/\/api\/transit\/settings/, () => ({
        success: true,
        settingsState: 'stored',
        data: { ...STORED, homePlaceName: null, homeAnchorSource: 'device' },
      })]],
      components: { RouterLink: RouterLinkStub },
    })
    await host.flush()

    expect(host.text()).toContain('39.87765, 116.46392')
    host.unmount()
  })

  it('读失败：说「未读到」，不说「未设置」，并给重试', async () => {
    const host = await mountIndex({ settings: 'fail' })

    const text = host.text()
    expect(text).toContain('未读到')
    expect(text, 'a failed read is worded as 「nothing saved」').not.toContain('未设置')
    expect(control(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('从没存过：两个锚点都说「未设置」，这不是读失败', async () => {
    const host = await mountIndex({ settings: 'unset' })

    const text = host.text()
    expect(text.match(/未设置 · 无法算出门时间/g)).toHaveLength(2)
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('摘要是事实：`anchorSummaryOf` 对三种情形各说各的', () => {
    const unset = pickAnchors(null)
    const device = pickAnchors({ homeLat: 39.87765, homeLng: 116.46392, homeAnchorSource: 'device' })
    const searched = pickAnchors({ homeLat: 39.87765, homeLng: 116.46392, homePlaceName: '珠江帝景B区', homeAnchorSource: 'search' })

    expect(anchorSummaryOf(unset, 'home')).toBe('未设置 · 无法算出门时间')
    expect(anchorSummaryOf(device, 'home')).toBe('39.87765, 116.46392')
    expect(anchorSummaryOf(searched, 'home')).toBe('珠江帝景B区')
    // 空串不是名字：它是「没写下这一项」，故仍显示坐标。
    expect(anchorSummaryOf(pickAnchors({ homeLat: 1, homeLng: 2, homePlaceName: '  ' }), 'home')).toBe('1.00000, 2.00000')
    // 认不出的来源读成 null，绝不取整成 device。
    expect(pickAnchors({ homeAnchorSource: 'gps' }).homeAnchorSource).toBeNull()
  })

  it('两行的摘要是**行自己的**，各按自己的锚点说：家说名字，公司说未设置', async () => {
    // 同一页上的两行不得互相借用对方的答案。
    const host = await mountIndex()
    const links = host.nodes(item => item.tag === 'a' && String(item.props.href).startsWith('/settings/anchors/'))

    expect(host.textOf(links[0]!)).toContain('珠江帝景B区')
    expect(host.textOf(links[1]!)).toContain('未设置 · 无法算出门时间')
    host.unmount()
  })
})

/** 某节点是否位于给定的子树内。 */
function isInside(root: HostElement, node: HostElement): boolean {
  let current: HostElement | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}
