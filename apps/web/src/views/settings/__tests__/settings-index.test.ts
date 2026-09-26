import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import SettingsIndex from '../index.vue'

/**
 * `设置` 的**索引页**，由**行为**守住。
 *
 * `设置` 变成索引加四个子页面（`/settings/lines`、`/schedule`、`/anchors`、`/chains`），本文件守住
 * 属于索引自己的那一半：四行，每行整行是链接，各行以事实陈述**本域**当前状态——而在该状态读不到时
 * 什么都不陈述。页面经 `settings-harness.ts` 挂载（Vue 的 runtime-core 渲染为普通对象，无 jsdom）
 * 并按浏览器驱动它的方式驱动，故被断言的是该行实际说了什么。
 *
 * 本文件存在的两个诚实性坑是 §4.1 自己的：**失败**的读取不得被改写成默认值（`GET /api/transit/settings`
 * 抛出时，折叠的通勤时段摘要曾保留 `06:30–11:30`），也不得被改写成空列表（`fetchFavorites` 曾对失败的
 * 读取答 `[]`，故「4 条」分不清「一条都没有」与「没读到」）。两者都在下方与失败读取一起钉住。
 *
 * 行的**链接**经 `RouterLinkStub` 断言：测试能持有的是页面选择的目标，而非路由随后是否点亮导航项
 * ——顶部导航的点亮状态是控制器的浏览器侧；使其成为可能的路由表规则（`/settings` 的子路由，绝不是平级）
 * 按结构断言。
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** 去掉说明性文字的文件，故被断言的是代码。 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 设置行默认交回的四个存储时刻。 */
const HOURS = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
}

/** 折叠摘要自己的措辞，逐字：`06:30–11:30 · 17:00–22:00`。 */
const HOURS_SUMMARY = '06:30–11:30 · 17:00–22:00'

/** 当前城市（027）的两条关注线路，使计数行有数可陈。 */
function favourites(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `fav-${index + 1}`,
    userId: 'default_user',
    cityCode: '027',
    lineId: `bus_027_${index + 1}`,
    lineName: `快线 ${index + 1} 路`,
    preferredDirection: 0,
    displayOrder: index,
  }))
}

/** 一条已存链路，使链路行有数可陈。 */
function chain(): Record<string, unknown> {
  return { id: 'chain-1', userId: 'default_user', name: '早上上班', purpose: 'morning', displayOrder: 0, legs: [] }
}

/** 端点在测试里的行为：作答、拒绝、交回空列表，或（仅设置）答根本没有任何行。 */
type Answer = 'ok' | 'fail' | 'empty'

/** 设置读取所答。`unset` 是从未保存过的用户得到的状态。 */
type SettingsAnswer = Answer | 'unset' | 'unchosen' | 'no-state'

interface IndexRoutes {
  favourites?: Answer
  settings?: SettingsAnswer
  chains?: Answer
  /** 设置行携带的坐标：默认只有「家」，除非被覆盖。 */
  anchors?: Record<string, unknown>
  /**
   * 读取所答的关注线路，用于测试需要 `favourites(count)` 之外的形状时——例如来自**不止一个城市**的线路，
   * 那是区分「屏幕所在城市的计数」与「所有存储行的计数」的形状。
   */
  favouriteLines?: Record<string, unknown>[]
}

/**
 * 索引发出的三次读取，测试想让哪一个失败就哪一个失败。
 *
 * `favourites`/`settings`/`chains` 就是本页的全部表面：发出第四次读取、或为躲避失败把其中之一读两次的行，
 * 会表现为此处没有路由应答的一个请求。
 *
 * 设置答案携带 `settingsState`，与端点完全一致：有时刻的行与发现**没有**行的读取是不同的答案，而状态说明
 * 这是哪一个。`no-state` 是畸形形状——没有该词的行——不得被读成用户的配置。
 */
function routes(options: IndexRoutes = {}): Route[] {
  const answered = <T>(answer: Answer | undefined, value: T, fallback: T): unknown =>
    answer === 'fail' ? { success: false, error: '读取失败' } : { success: true, data: answer === 'empty' ? fallback : value }

  return [
    [/\/api\/transit\/favorites$/, () => answered(options.favourites, options.favouriteLines ?? favourites(2), [])],
    [/\/api\/transit\/settings/, () => {
      if (options.settings === 'fail') return { success: false, error: '读取失败' }
      if (options.settings === 'unset') return { success: true, settingsState: 'unset', data: null }
      if (options.settings === 'no-state') return { success: true, data: { ...HOURS } }
      // 该行存在（可能携带锚点）且其四个时刻**从未**选择过：线上四个都是 null
      // （`settingsState: 'stored'`，不是 'unset'）。
      if (options.settings === 'unchosen') {
        return {
          success: true,
          settingsState: 'stored',
          data: {
            morningStart: null,
            morningEnd: null,
            eveningStart: null,
            eveningEnd: null,
            ...(options.anchors ?? { homeLat: 39.9, homeLng: 116.4 }),
          },
        }
      }
      return {
        success: true,
        settingsState: 'stored',
        data: { ...HOURS, ...(options.anchors ?? { homeLat: 39.9, homeLng: 116.4 }) },
      }
    }],
    [/\/api\/transit\/commute-chains\?/, () => answered(options.chains, [chain()], [])],
  ]
}

/** 挂载索引及其路由，让每次读取都作答。 */
async function mountIndex(options: IndexRoutes = {}): Promise<MountedHost> {
  const host = await mountComponent(SettingsIndex, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // 让任何已排定的定时器在装置的桩件仍就位时触发。
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** 索引的每一行，作为它所是的链接：去哪、说什么。 */
function rows(host: MountedHost): Array<{ href: string, text: string }> {
  return host.nodes(item => item.tag === 'a').map(item => ({
    href: String(item.props.href),
    text: host.textOf(item),
  }))
}

/** 按目标取一行，或一个点名所寻之物的抛错。 */
function row(host: MountedHost, href: string): { href: string, text: string } {
  const found = rows(host).find(item => item.href === href)
  if (!found) throw new Error(`the index rendered no row pointing at ${href}`)
  return found
}

describe('设置索引是一张四行的清单，每行是一个整行的链接', () => {
  it('四行按域的顺序指向四个子页面，摘要文本在链接里面', async () => {
    const host = await mountIndex()

    // 整行是一个链接：不是脚本跳转，所以「在新标签页打开」、键盘与语义都是浏览器原生的。
    expect(rows(host).map(item => item.href)).toEqual([
      '/settings/lines',
      '/settings/schedule',
      '/settings/anchors',
      '/settings/chains',
    ])
    // 该行的状态写在链接内部 —— 行与它的摘要不能各说一半。
    expect(row(host, '/settings/lines').text).toContain('关注线路')
    expect(row(host, '/settings/lines').text).toContain('已关注 2 条')
    expect(row(host, '/settings/schedule').text).toContain('通勤时段')
    expect(row(host, '/settings/anchors').text).toContain('位置锚点')
    expect(row(host, '/settings/chains').text).toContain('通勤链路')
    host.unmount()
  })

  it('索引是一个列表：四个 li，每行一个链接，摘要不在链接之外', async () => {
    const host = await mountIndex()

    expect(host.node(item => item.tag === 'ul', 'the index list').tag).toBe('ul')
    const items = host.nodes(item => item.tag === 'li')
    expect(items).toHaveLength(4)
    for (const item of items) {
      const links = host.nodes(node => node.tag === 'a' && isInside(item, node))
      expect(links, 'each row is one link').toHaveLength(1)
    }
    // 行的全部可见文本都在其链接内：行的一切都不在它旁边陈述，
    // 否则只读链接的屏幕阅读器永远到不了。
    for (const item of items) {
      const inside = host.textOf(host.nodes(node => node.tag === 'a' && isInside(item, node))[0]!)
      expect(host.textOf(item)).toBe(inside)
    }
    host.unmount()
  })

  it('索引自己有真正的 h2（四个子页面各有自己的 h2，那条在 settings-pages.test.ts 里）', async () => {
    const host = await mountIndex()

    const heading = host.node(item => item.tag === 'h2', 'the index heading')
    expect(host.textOf(heading)).toContain('设置')
    host.unmount()
  })
})

describe('每行的摘要只陈述该域现在的事实', () => {
  it('关注线路给条数，通勤链路给条数', async () => {
    const host = await mountIndex()

    expect(row(host, '/settings/lines').text).toContain('已关注 2 条')
    expect(row(host, '/settings/chains').text).toContain('已录入 1 条')
    host.unmount()
  })

  it('条数是「当前城市」的条数：另一个城市的关注线路不算进这一行', async () => {
    // 该行描述的是 关注线路 页，它管理屏幕所在的城市——故夹具携带**两个**城市的线路，而两种看似合理的
    // 计数定义会分歧：屏幕所在城市（027，两条）对全部存储行（三条）。单城市的夹具分不清它们，
    // 这正是可能以绿的套件算错的方式。
    const host = await mountIndex({
      favouriteLines: [
        { id: 'fav-1', userId: 'default_user', cityCode: '027', lineId: 'bus_027_1', lineName: '快线 1 路', preferredDirection: 0, displayOrder: 0 },
        { id: 'fav-2', userId: 'default_user', cityCode: '027', lineId: 'bus_027_2', lineName: '快线 2 路', preferredDirection: 0, displayOrder: 1 },
        { id: 'fav-3', userId: 'default_user', cityCode: '034', lineId: 'bus_034_1', lineName: '沪线 1 路', preferredDirection: 0, displayOrder: 0 },
      ],
    })

    const text = row(host, '/settings/lines').text
    expect(text).toContain('已关注 2 条')
    expect(text, 'the row counts a city the user is not looking at').not.toContain('已关注 3 条')
    host.unmount()
  })

  it('通勤时段给已保存的时刻，写法与折叠态一致', async () => {
    const host = await mountIndex()

    expect(row(host, '/settings/schedule').text).toContain(HOURS_SUMMARY)
    host.unmount()
  })

  it('位置锚点给出每个锚点自己已设置 / 未设置', async () => {
    const host = await mountIndex({ anchors: { homeLat: 39.9, homeLng: 116.4, workLat: null, workLng: null } })

    const text = row(host, '/settings/anchors').text
    expect(text).toContain('家 已设置')
    expect(text).toContain('公司 未设置')
    host.unmount()
  })

  it('摘要里没有动作词：怎么去由链接承担，摘要只说事实', async () => {
    const host = await mountIndex()

    // 对空集的筛选会白通过：四行，或本规则没有评判任何行。
    expect(rows(host)).toHaveLength(4)
    for (const item of rows(host)) {
      for (const action of ['去配置', '去设置', '点击', '请设置']) {
        expect(item.text, `${item.href} words its state as an action`).not.toContain(action)
      }
    }
    host.unmount()
  })

  it('三种状态各有话说：读中、未读到、读到 —— 没有一种渲染成 undefined', async () => {
    const host = await mountIndex()

    expect(rows(host), 'the index renders its four rows, or this rule judged no row').toHaveLength(4)
    expect(host.text()).not.toContain('undefined')
    host.unmount()
  })
})

describe('读不到就是读不到：不给默认值，也不给 0', () => {
  it('关注线路读失败：这一行说「未读到」，不留一个看起来像 0 条的条数', async () => {
    const host = await mountIndex({ favourites: 'fail' })

    const text = row(host, '/settings/lines').text
    expect(text).toContain('未读到')
    expect(text, 'an unreadable list must not be reported as a count').not.toContain('条')
    host.unmount()
  })

  it('时段读失败：这一行说「未读到」，不给默认的 06:30–11:30', async () => {
    const host = await mountIndex({ settings: 'fail' })

    const text = row(host, '/settings/schedule').text
    expect(text).toContain('未读到')
    expect(text, 'the default hours look like the user’s own configuration').not.toContain('06:30')
    host.unmount()
  })

  it('时段没存过：这一行说「未设置」，同样不印 06:30–11:30', async () => {
    // 「未设置」是另一个事实，需要自己的词：端点作答了——读取没有失败——而它没找到行。
    // 它曾在此答内置窗口，本行把它印成用户自己的时刻。
    const host = await mountIndex({ settings: 'unset' })

    const text = row(host, '/settings/schedule').text
    expect(text).toContain('未设置')
    expect(text, 'the built-in window is printed for a user who never saved one').not.toContain('06:30')
    expect(text).not.toContain('17:00')
    expect(text, 'nothing failed, so 未读到 would be a claim about a read that answered').not.toContain('未读到')
    host.unmount()
  })

  it('行在、但四个时刻从没选过：这一行说「未设置」，同样不印 06:30–11:30', async () => {
    // 第三种事实，也是 T2 修的那一种：行在（锚点可能已存），四个时刻是 NULL。它不是
    // 「未读到」——读成功了；也不是那组内置时刻——没有任何人选择过它。端点用
    // `settingsState: 'stored'` 加四个 null 说这件事，这一行必须说「未设置」。
    const host = await mountIndex({ settings: 'unchosen' })

    const text = row(host, '/settings/schedule').text
    expect(text).toContain('未设置')
    expect(text, 'the built-in window is printed for a user who never chose one').not.toContain('06:30')
    expect(text).not.toContain('17:00')
    expect(text, 'nothing failed, so 未读到 would be a claim about a read that answered').not.toContain('未读到')
    host.unmount()
  })

  it('行在、时刻没选过：锚点那一行照旧报它自己的事实，不跟着说「未设置时段」', async () => {
    // 时段这一域和锚点这一域各自读同一行的不同列：时段没选过不等于锚点没存过。
    const host = await mountIndex({ settings: 'unchosen' })

    const text = row(host, '/settings/anchors').text
    expect(text).toContain('家 已设置')
    expect(text).toContain('公司 未设置')
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('时段没存过：锚点那一行仍按每个锚点自己说，不跟着说「未读到」', async () => {
    // 没有行意味着没有已存锚点——这是关于该行的事实，不是对它的猜测。其旁的时段出于同一理由为
    // 「未设置」，两者不互相借用状态。
    const host = await mountIndex({ settings: 'unset' })

    const text = row(host, '/settings/anchors').text
    expect(text).toContain('家 未设置')
    expect(text).toContain('公司 未设置')
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('答了却没有状态：不当作读到的行，这一行说「未读到」', async () => {
    // 到达时没有 `settingsState` 的行是本页读不了的答案：状态就是事实，从形状推断它会让带内置时刻的
    // body 决定它——正是正在被移除的那种替代。陈述为不可读而非「未设置」，因为没人核实过该行缺席。
    const host = await mountIndex({ settings: 'no-state' })

    const text = row(host, '/settings/schedule').text
    expect(text).toContain('未读到')
    expect(text).not.toContain('06:30')
    expect(text).not.toContain('未设置')
    host.unmount()
  })

  it('锚点读失败：这一行说「未读到」，不说「未设置」', async () => {
    // 「未设置」是关于存储行的断言；没人读过它。
    const host = await mountIndex({ settings: 'fail' })

    const text = row(host, '/settings/anchors').text
    expect(text).toContain('未读到')
    expect(text).not.toContain('未设置')
    host.unmount()
  })

  it('链路读失败：这一行说「未读到」，不给 0 条', async () => {
    const host = await mountIndex({ chains: 'fail' })

    const text = row(host, '/settings/chains').text
    expect(text).toContain('未读到')
    expect(text).not.toContain('条')
    host.unmount()
  })

  it('读到的一条都没有，就是 0 条：空与读不到是两件事', async () => {
    const host = await mountIndex({ favourites: 'empty', chains: 'empty' })

    expect(row(host, '/settings/lines').text).toContain('已关注 0 条')
    expect(row(host, '/settings/chains').text).toContain('已录入 0 条')
    host.unmount()
  })
})

describe('四个子页面是 /settings 的子路由（一条结构断言：导航项的亮灯靠它）', () => {
  it('children 挂在 /settings 上，四个域各是子路由的一条，而不是四条平级路径', () => {
    // 这是对注册表数据的**结构**断言，它在此因为它是本仓库任何渲染断言都守不住的那个事实：
    // vue-router 的默认激活匹配跟随已匹配的路由**记录**，故指向 `/settings` 的链接只有在父记录仍被匹配时
    // ——即四个页面是**子路由**时——才在 `/settings/lines` 上保持点亮。作为四条平级路由时，顶部导航的
    // 设置 项会在每个子页面上变暗，而视觉点亮状态是控制器的浏览器侧。
    const router = codeOf(read('../../../router/index.ts'))

    expect(router).toContain(`path: '/settings'`)
    expect(router).toContain('children: [')
    for (const path of [`path: ''`, `path: 'lines'`, `path: 'schedule'`, `path: 'anchors'`, `path: 'chains'`]) {
      expect(router, `${path} is missing from the children of /settings`).toContain(path)
    }
    expect(router, 'a flat /settings/… path is a sibling record, and the nav item would go dark')
      .not.toMatch(/path: '\/settings\//)
    for (const page of ['index', 'lines', 'schedule', 'anchors', 'chains']) {
      expect(router, `${page}.vue is not reachable from the route table`).toContain(`@/views/settings/${page}.vue`)
    }
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
