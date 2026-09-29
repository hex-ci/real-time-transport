import { describe, expect, it } from 'vitest'
import {
  mountComponent,
  press,
  type,
  type HostElement,
  type MountedHost,
  type RecordedRequest,
  type Route,
} from '@/__tests__/views/settings/settings-harness'
import PlatformPage from '../../../views/platform/index.vue'

/**
 * 站台屏的站台选择器：屏上不再有原生 `<select>`，换的是共用的带搜索的下拉。
 *
 * 本文件钉住的是这一屏上的四件事，它们各自都能在别处悄悄退化：
 *
 *  - **没有原生 select**。一屏几十个站台靠滚动挑不出来——那正是这次要换掉的东西；
 *  - **搜索会缩列表**，且一个都不匹配时说得出空态；
 *  - **键盘**：只用键盘也能开、移动、选中、关上；
 *  - **换站是一次重读**：那次重读问的是刚选中的那个站台（请求里的 `order`），屏上的数字跟着它走——
 *    一次只清空不重读的「换站」，对使用者就是空屏。
 *
 * 站头这一次不换成桩：本文件要读的正是它渲染出来的控件。原生 `<select>` 在无 DOM 宿主里挂不起来
 * （`vModelSelect` 要写 `el.options.length`），换掉它之后这一屏才第一次可被真的挂载。
 */

/** 一条两个方向的关注线路。 */
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

/** 方向 0 途经 共用站/甲站/乙站，方向 1 途经 共用站/丙站。 */
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

/** 一个为所请求站序定价的读数：分钟就是站序，故屏上的数字能证明这次读的是哪一个站台。 */
function liveBody(lineId: string, stationOrder: number): unknown {
  return {
    success: true,
    data: {
      lineId,
      direction: 0,
      buses: [{
        id: `v_${lineId}`,
        order: 1,
        nextOrder: stationOrder,
        travelTimeSec: stationOrder * 60,
        congestion: 'low',
        updatedAt: 1_700_000_010_000,
      }],
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: 1_700_000_010_000,
    },
  }
}

function orderOf(url: string): number {
  return Number(/order=(\d+)/.exec(url)?.[1] ?? '0')
}

function routes(favourites: Record<string, unknown>[]): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: favourites })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\/bus_027_1\?/, () => ({ success: true, data: detailBody(0) })],
    [/\/api\/transit\/lines\/bus_027_2\?/, () => ({ success: true, data: detailBody(1) })],
    [/\/api\/transit\/lines\/([^/?]+)\/live/, (request: RecordedRequest) => {
      const lineId = decodeURIComponent(/\/lines\/([^/?]+)\/live/.exec(request.url)?.[1] ?? '')
      return liveBody(lineId, orderOf(request.url))
    }],
  ]
}

async function mountPlatform(favourites: Record<string, unknown>[] = [FAVOURITE]): Promise<MountedHost> {
  const host = await mountComponent(PlatformPage, { routes: routes(favourites) })
  await host.flush()
  return host
}

/** 站台选择器自己的触发器。 */
function triggerOf(host: MountedHost): HostElement {
  return host.node(
    (item: HostElement) => item.tag === 'button'
      && (item.props.role === 'combobox' || item.props['aria-haspopup'] === 'listbox'),
    '站台选择器',
  )
}

/** 面板顶上的搜索框；面板没开时它不在屏上。 */
function searchBoxOf(host: MountedHost): HostElement | null {
  return host.nodes((item: HostElement) => item.tag === 'input' && item.props.role === 'combobox')[0] ?? null
}

function optionsOf(host: MountedHost): HostElement[] {
  return host.nodes((item: HostElement) => item.props.role === 'option')
}

function optionOf(host: MountedHost, text: string): HostElement {
  return host.node(
    (item: HostElement) => item.props.role === 'option' && host.textOf(item) === text,
    `站台选项「${text}」`,
  )
}

/** 屏上的分钟值——没有行携带数字时为空。 */
function minuteSpans(host: MountedHost): string[] {
  return host
    .nodes((item: HostElement) => item.tag === 'span' && /^\d+$/.test(item.text.trim()))
    .map(item => item.text.trim())
}

/** 一次按键，按浏览器投递 keydown 的方式送给渲染出的节点。 */
function keydown(element: HostElement, key: string): boolean {
  let prevented = false
  const handler = element.props.onKeydown
  const handlers = Array.isArray(handler) ? handler : [handler]
  const event = {
    type: 'keydown',
    key,
    target: element,
    currentTarget: element,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
    stopPropagation: () => {},
  }
  for (const each of handlers) each?.(event)
  return prevented
}

const liveOf = (host: MountedHost): RecordedRequest[] => host.server.seen(/\/live/)

/** 每个站台在本线路方向 0 上的站序——live 请求里的 `order` 就是它。 */
const ORDER_OF: Record<string, number> = { 共用站: 1, 甲站: 2, 乙站: 3 }

/**
 * 换一个**与屏上不同的**站台。
 *
 * 首屏选中哪一个是这一页自己的枢纽排序（同分时按名称）之下的结果，本文件不对它下注；但也绝不能
 * 挑到那一个上：选同一个站台不产生任何变化，于是「换站触发了重读」会因为什么都没发生而白通过。
 */
function otherStation(host: MountedHost): string {
  const current = host.textOf(triggerOf(host))
  // 优先取只有一条方向经过的站（甲站/乙站）：共用站两条方向都停，屏上会是两行，行数不必在这里下注。
  const other = ['甲站', '乙站'].find(name => name !== current)
    ?? ['共用站'].find(name => name !== current)
  if (!other) throw new Error(`屏上认不出当前站台，读到的是「${current}」`)
  return other
}

describe('屏上的站台选择器是共用的带搜索的下拉，不是原生 select', () => {
  it('原生 select 一个都不剩，换上来的是带搜索框的控件', async () => {
    const host = await mountPlatform()

    expect(host.nodes((item: HostElement) => item.tag === 'select'), '屏上还有原生 select')
      .toEqual([])
    const trigger = triggerOf(host)
    expect(trigger.props['aria-haspopup']).toBe('listbox')
    // 面板开着才有搜索框：关着时它连同面板一起不在屏上。
    expect(searchBoxOf(host)).toBeNull()
    await press(host, trigger)
    expect(searchBoxOf(host), '控件没有搜索框').not.toBeNull()
    host.unmount()
  })

  it('搜一半站名就缩到那一个，一个都不匹配时说得出空态', async () => {
    const host = await mountPlatform()
    await press(host, triggerOf(host))
    // 选项的先后是这一页自己的枢纽排序（按经过的线路条数），不是本控件的事。
    expect(optionsOf(host).map(item => host.textOf(item)).sort())
      .toEqual(['共用站', '甲站', '乙站'].sort())

    await type(host, searchBoxOf(host)!, '乙')
    expect(optionsOf(host).map(item => host.textOf(item))).toEqual(['乙站'])

    await type(host, searchBoxOf(host)!, '不存在的站台')
    expect(optionsOf(host)).toEqual([])
    expect(host.text()).toContain('未找到匹配站台')
    host.unmount()
  })
})

describe('键盘也能用：开 / 移动 / 选中 / 关上', () => {
  it('下键开面板、上下移动高亮、Escape 关上', async () => {
    const host = await mountPlatform()
    expect(searchBoxOf(host)).toBeNull()

    keydown(triggerOf(host), 'ArrowDown')
    await host.flush()
    expect(optionsOf(host)).toHaveLength(3)

    keydown(triggerOf(host), 'ArrowUp')
    await host.flush()
    expect(optionsOf(host)).toHaveLength(3)

    keydown(triggerOf(host), 'Escape')
    await host.flush()
    expect(searchBoxOf(host)).toBeNull()
    host.unmount()
  })

  it('回车选中高亮的那一个，并像点一下那样重读车况', async () => {
    const host = await mountPlatform()
    const target = otherStation(host)
    await press(host, triggerOf(host))

    const before = liveOf(host).length
    // 敲进站名后只剩它一个候选，高亮落回第一个候选上，回车拿走的就是它。
    await type(host, searchBoxOf(host)!, target)
    keydown(searchBoxOf(host)!, 'Enter')
    await host.flush()

    expect(optionsOf(host), '回车后面板没关').toEqual([])
    expect(host.textOf(triggerOf(host))).toContain(target)
    expect(liveOf(host).length, '回车没有触发重读').toBeGreaterThan(before)
    expect(orderOf(liveOf(host).at(-1)!.url)).toBe(ORDER_OF[target])
    host.unmount()
  })
})

describe('可访问名由调用方给，且就是控件可见的那些字', () => {
  it('名不随值变：换一个站台，名字还是同一个', async () => {
    const host = await mountPlatform()
    const named = triggerOf(host).props['aria-label']
    expect(named).toBe('选择站台')
    const before = host.textOf(triggerOf(host))

    const target = otherStation(host)
    await press(host, triggerOf(host))
    await press(host, optionOf(host, target))

    // 值真的换了（否则下面那条「名字没变」是在一个什么都没发生的屏幕上通过）。
    expect(host.textOf(triggerOf(host))).not.toBe(before)
    expect(host.textOf(triggerOf(host))).toContain(target)
    expect(triggerOf(host).props['aria-label'], '可访问名跟着值变成了站名').toBe(named)
    host.unmount()
  })

  it('还没选中任何站台时，控件可见的就是这个名字', async () => {
    // 关注线路读不到时一个站台选项都没有：选择器停在「什么都没选」上，故它可见的文字
    // 就是调用方给它的那个名字。
    const host = await mountPlatform([])
    const trigger = triggerOf(host)

    expect(host.textOf(trigger)).toBe('选择站台')
    expect(trigger.props['aria-label']).toBe('选择站台')
    host.unmount()
  })
})

describe('换站是一次重读：那次读的是刚选中的站台', () => {
  it('换一个站台后，live 请求带着那个站台的站序，屏上的分钟跟着它变', async () => {
    const host = await mountPlatform()
    expect(minuteSpans(host), '首载没有行').not.toEqual([])

    const target = otherStation(host)
    const before = liveOf(host).length
    await press(host, triggerOf(host))
    await press(host, optionOf(host, target))
    await host.flush()

    const after = liveOf(host)
    expect(after.length, '换站没有触发重读').toBeGreaterThan(before)
    expect(orderOf(after.at(-1)!.url), '那次重读问的还是上一个站台').toBe(ORDER_OF[target])
    // 读数按所请求的站序定价（分钟即站序），故屏上的数字是这次重读的证据。
    expect(minuteSpans(host)).toEqual([String(ORDER_OF[target])])
    host.unmount()
  })
})
