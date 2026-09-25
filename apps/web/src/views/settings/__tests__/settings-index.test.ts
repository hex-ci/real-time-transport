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
 * 设置's INDEX, held by BEHAVIOUR.
 *
 * 设置 became an index plus four sub-pages (`/settings/lines`, `/schedule`, `/anchors`,
 * `/chains`), and this file holds the half that is the index's own: four rows, each a
 * whole-row link, each stating that DOMAIN's current state as a fact — and stating
 * NOTHING when that state could not be read. The page is mounted through
 * `settings-harness.ts` (Vue's runtime-core into plain objects, no jsdom) and driven the
 * way a browser drives it, so what is asserted is what the row actually says.
 *
 * The two honesty traps this file exists for are §4.1's own: a read that FAILED must not
 * be re-worded as a default (the collapsed 通勤时段 summary used to keep `06:30–11:30`
 * when `GET /api/transit/settings` threw) and must not be re-worded as an empty list
 * (`fetchFavorites` used to answer a failed read with `[]`, so 「4 条」 could not tell
 * 「一条都没有」 from 「没读到」). Both are pinned below with the read that fails.
 *
 * A row's LINK is asserted through `RouterLinkStub`: what a test can hold is the
 * destination the page chose, not whether the router then lights the nav item — the lit
 * state of the top nav is the controller's browser pass, and the route-table rule that
 * makes it possible (children of `/settings`, never siblings) is asserted structurally.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** The file with its explanatory prose removed, so code is what is asserted. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The four stored times the settings row hands back by default. */
const HOURS = {
  morningStart: '06:30',
  morningEnd: '11:30',
  eveningStart: '17:00',
  eveningEnd: '22:00',
}

/** The collapsed summary's own wording, character for character: `06:30–11:30 · 17:00–22:00`. */
const HOURS_SUMMARY = '06:30–11:30 · 17:00–22:00'

/** Two followed lines of the active city (027), so the count row has a count to state. */
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

/** One stored chain, so the chain row has a count to state. */
function chain(): Record<string, unknown> {
  return { id: 'chain-1', userId: 'default_user', name: '早上上班', originAnchor: 'home', purpose: 'morning', displayOrder: 0, legs: [] }
}

/** What an endpoint does in a test: answer, refuse, hand back an empty list, or (settings
 * only) answer that no row is stored at all. */
type Answer = 'ok' | 'fail' | 'empty'

/** What the settings read answers. `unset` is the state a never-saved user gets. */
type SettingsAnswer = Answer | 'unset' | 'unchosen' | 'no-state'

interface IndexRoutes {
  favourites?: Answer
  settings?: SettingsAnswer
  chains?: Answer
  /** The coordinates the settings row carries: 家 only, unless overridden. */
  anchors?: Record<string, unknown>
  /**
   * The followed lines the read answers with, when a test needs a shape of its own than the
   * one `favourites(count)` builds — e.g. lines from MORE THAN ONE city, which is the shape
   * that tells a count over the city on screen from a count over every stored row.
   */
  favouriteLines?: Record<string, unknown>[]
}

/**
 * The three reads the index makes, with whichever of them a test wants to fail.
 *
 * `favourites`/`settings`/`chains` are the whole surface of this page: a row that made a
 * fourth read, or read one of these twice to dodge a failure, would show up as a request
 * no route here answers.
 *
 * The settings answer carries `settingsState`, exactly as the endpoint does: a row with
 * times and a read that found NO row are different answers, and the state is what says
 * which one this is. `no-state` is the malformed shape — a row without the word — which
 * must not be read as the user's configuration.
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
      // The row exists (it may carry anchors) and its four times were NEVER chosen: every
      // one of them is null on the wire (`settingsState: 'stored'`, not 'unset').
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

/** Mount the index with its routes and let every read answer. */
async function mountIndex(options: IndexRoutes = {}): Promise<MountedHost> {
  const host = await mountComponent(SettingsIndex, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // Let any scheduled timer fire while the harness's stubs are still in place.
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** Every row of the index, as the link it is: where it goes and what it says. */
function rows(host: MountedHost): Array<{ href: string, text: string }> {
  return host.nodes(item => item.tag === 'a').map(item => ({
    href: String(item.props.href),
    text: host.textOf(item),
  }))
}

/** One row by destination, or a thrown error naming what was looked for. */
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
    // The whole visible text of a row is inside its link: nothing about a row is stated
    // beside it, where a screen reader reading links alone would never reach it.
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
    // The row describes the 关注线路 page, which manages the city on screen — so the fixture
    // carries lines of TWO cities, and the two plausible definitions of the count disagree:
    // the city on screen (027, two lines) versus every stored row (three). A fixture of one
    // city cannot tell them apart, which is how this could be counted the wrong way with a
    // green suite.
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

    // A filter over nothing passes for free: four rows, or this rule judged no row.
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
    // 未设置 is the OTHER fact, and it needs its own word: the endpoint answered — the
    // read did not fail — and it found no row. It used to answer the built-in window
    // here, which this row printed as the user's own hours.
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
    // No row means no stored anchor — a fact about the row, not a guess about it. The
    // hours beside it are 「未设置」 for the same reason, and neither borrows the other's
    // state.
    const host = await mountIndex({ settings: 'unset' })

    const text = row(host, '/settings/anchors').text
    expect(text).toContain('家 未设置')
    expect(text).toContain('公司 未设置')
    expect(text).not.toContain('未读到')
    host.unmount()
  })

  it('答了却没有状态：不当作读到的行，这一行说「未读到」', async () => {
    // A row that arrives without `settingsState` is an answer this page cannot read: the
    // state is the fact, and inferring it from a shape would let a body with the built-in
    // hours decide it — the exact substitution being removed. Stated as unreadable rather
    // than as 未设置, because nobody verified the row is absent.
    const host = await mountIndex({ settings: 'no-state' })

    const text = row(host, '/settings/schedule').text
    expect(text).toContain('未读到')
    expect(text).not.toContain('06:30')
    expect(text).not.toContain('未设置')
    host.unmount()
  })

  it('锚点读失败：这一行说「未读到」，不说「未设置」', async () => {
    // 未设置 is a claim about the stored row; nobody read it.
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
    // This is a STRUCTURAL assertion on registry data, and it is here because it is the
    // one fact no rendered assertion in this repo can hold: vue-router's default active
    // matching follows matched route RECORDS, so a link to `/settings` stays lit on
    // `/settings/lines` only while the parent record is still matched — i.e. only while
    // the four pages are CHILDREN. As four flat routes the top nav's 设置 item would go
    // dark on every sub-page, and the visual lit state is the controller's browser pass.
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

/** Whether a node sits inside the given subtree. */
function isInside(root: HostElement, node: HostElement): boolean {
  let current: HostElement | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}
