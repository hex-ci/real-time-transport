import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  press,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import LinesPage from '../lines.vue'
import SchedulePage from '../schedule.vue'
import AnchorsPage from '../anchors.vue'
import ChainsPage from '../chains.vue'
import RemovalDialog from '../components/removal-dialog.vue'
import OverviewEmptyState from '@/views/overview/components/empty-state.vue'
import ChainEmptyState from '@/views/commute-chain/components/chain-empty-state.vue'
import { emptyStateOf } from '@/views/commute-chain/empty-state'

/**
 * The four sub-pages 设置 was split into, and the three in-app pointers that had to
 * follow the split.
 *
 * THREE CLAIMS, each held by what renders rather than by what the source says:
 *
 *  - every sub-page is a page of its own: a real `<h2>`, and an in-app 「返回设置」
 *    control. The back control is not the browser's back gesture, so it must exist for
 *    real; its accessible name must CONTAIN its visible words (WCAG 2.5.3 Label in Name)
 *    — a name that replaces 「返回设置」 with a shorter phrase is a control a voice-control
 *    user cannot call by reading it out. The precedent in this repo is
 *    `chain-leg-fields.vue`'s 「删除该段（第 1 段）」: visible words first, extras in
 *    parentheses, and `aria-label` never repeats a heading it already renders.
 *  - the four controls THIS PASS brought up to the house 44px: the collapsed 通勤时段 trigger,
 *    the row's 取消关注, and the two controls in the removal dialog. The claim is scoped to those
 *    four, because the same source still holds targets under 44px that this pass did not touch —
 *    the followed row's drag grip (36×32) and the station picker's own search field and option
 *    rows (36px / 38px). Each of them clears WCAG 2.5.8's 24×24 minimum (the grip's 36×32 is the
 *    measured size recorded for it); none of them is the house number. Reading 「the touch targets
 *    this screen was measured to have below 44px」 as an exhaustive set was wrong, and the audit's
 *    list was only ever the ones it fixed. The direction radio items (36px) were on that list and
 *    were raised to 44px by the pass that measured the board stop's own flow (see the 方向单选 test
 *    below).
 *  - the three in-app pointers now name the DOMAIN they are about instead of 设置 as a
 *    whole: the home screen's empty state is about followed lines, the two chain pointers
 *    are about anchors — except the one that only became honest now that a recording
 *    surface exists, which is about the chain page. 设置's own nav item still points at
 *    the index (`/settings`) and is untouched; that is the registry guard's business.
 *
 * The URL each page answers on is a fact about the route table, and the table is pinned
 * in `settings-index.test.ts` (a structural assertion). Nothing here can load a path.
 */

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

/** The reads these pages make, all answering with something. */
function routes(options: { favourites?: 'ok' | 'fail', settings?: 'ok' | 'fail' | 'unset' } = {}): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => (options.favourites === 'fail'
      ? { success: false, error: '读取失败' }
      : { success: true, data: [{ id: 'fav-1', userId: 'default_user', cityCode: '027', lineId: 'bus_027_1', lineName: '快线 1 路', preferredDirection: 0, displayOrder: 0 }] })],
    // The answer carries `settingsState`, as the endpoint does: a stored row and a read
    // that found no row are different answers, and the state says which one this is.
    [/\/api\/transit\/settings/, () => {
      if (options.settings === 'fail') return { success: false, error: '读取失败' }
      if (options.settings === 'unset') return { success: true, settingsState: 'unset', data: null }
      return {
        success: true,
        settingsState: 'stored',
        data: { morningStart: '06:30', morningEnd: '11:30', eveningStart: '17:00', eveningEnd: '22:00', homeLat: 39.9, homeLng: 116.4 },
      }
    }],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: { lineId: 'bus_027_1', direction: 0, directionName: '开往建国门', cityCode: '027', stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }] } })],
    [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
  ]
}

/** Mount any of the split's pages, with `RouterLink` reaching the host. */
async function mountPage(
  component: Parameters<typeof mountComponent>[0],
  props: Record<string, unknown> = {},
  options: Parameters<typeof routes>[0] = {},
): Promise<MountedHost> {
  const host = await mountComponent(component, {
    routes: routes(options),
    props,
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** A control's accessible name: the `aria-label` when it has one, else its own text. */
function accessibleName(host: MountedHost, node: HostElement): string {
  const label = node.props['aria-label']
  return label === undefined ? host.textOf(node) : String(label)
}

/** The sub-page's 「返回设置」 control, or a thrown error naming what was missing. */
function backControl(host: MountedHost): HostElement {
  const found = host.nodes(item => item.tag === 'a' && host.textOf(item).includes('返回设置'))[0]
  if (!found) throw new Error('the page rendered no 「返回设置」 control')
  return found
}

/** A control whose text is exactly the given words, or a thrown error. */
function controlWith(host: MountedHost, words: string): HostElement {
  const found = host.nodes(item => (item.tag === 'a' || item.tag === 'button') && host.textOf(item).trim() === words)[0]
  if (!found) throw new Error(`the page rendered no 「${words}」 control`)
  return found
}

/**
 * The 通勤时段 card's collapsed trigger, whose two lines are the card's title AND its summary.
 *
 * Located as a `button` carrying the title: the trigger is what the card collapses to, so its
 * text IS the collapsed summary the user reads — the same element the 44px rule is measured on.
 */
function collapsedHoursTrigger(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).includes('通勤时段'),
    'the collapsed 通勤时段 trigger',
  )
}

/**
 * The house touch-target rule, as the classes state it.
 */
const HOUSE_TOUCH_TARGET = /min-h-\[44px\]|min-h-11|h-11/

/**
 * A followed route whose own detail carries BOTH directions.
 *
 * `reverseLineId` is what makes a bus route two-way (`favoriteIsBidirectional`), and a
 * single-direction route renders its direction as text instead of a picker — so this
 * fixture is the only shape in which the direction radios exist to be measured.
 */
const TWO_WAY_FAVOURITE = {
  id: 'fav-2',
  userId: 'default_user',
  cityCode: '027',
  lineId: 'bus_027_1',
  reverseLineId: 'bus_027_1_rev',
  lineName: '快线 1 路',
  preferredDirection: 0,
  displayOrder: 0,
}

/** A detail carrying stops, so the expanded row offers a board stop to pick. */
const TWO_WAY_DETAIL = {
  lineId: 'bus_027_1',
  direction: 0,
  directionName: '开往建国门',
  cityCode: '027',
  type: 'bus',
  stops: [
    { id: 's1', name: '东大桥', order: 1, interchanges: [] },
    { id: 's2', name: '建国门', order: 2, interchanges: [] },
  ],
}

/**
 * The direction radios of the expanded row.
 *
 * A filtering helper, so the caller owes the non-empty line first: a list that matched
 * nothing makes the loop below pass for free — the way two 40px controls once satisfied
 * this rule (see `commute-chain-editor.test.ts`).
 */
function directionRadios(host: MountedHost): HostElement[] {
  return host.nodes(item => item.props.role === 'radio')
}

const PAGES = [
  { name: 'lines', component: LinesPage, heading: '关注线路' },
  { name: 'schedule', component: SchedulePage, heading: '通勤时段' },
  { name: 'anchors', component: AnchorsPage, heading: '位置锚点' },
  { name: 'chains', component: ChainsPage, heading: '通勤链路' },
]

describe('四个子页面各自成页：真正的 h2、应用内的「返回设置」', () => {
  for (const page of PAGES) {
    it(`${page.name} 页有自己的 h2，并带一个指向 /settings 的「返回设置」`, async () => {
      const host = await mountPage(page.component)

      const heading = host.node(item => item.tag === 'h2', `${page.name}'s own heading`)
      expect(host.textOf(heading)).toContain(page.heading)

      const back = backControl(host)
      expect(back.props.href).toBe('/settings')
      // 名字里包含可见文案：可见的是「返回设置」，能念出来的也必须是「返回设置」。
      expect(accessibleName(host, back)).toContain('返回设置')
      expect(accessibleName(host, back)).toContain(host.textOf(back).trim())
      // 可见文案只写一次：不在 aria-label 里重复一遍标题。
      expect(back.props['aria-label']).toBeUndefined()
      expect(String(back.props.class), `${page.name}'s back control is smaller than 44px`).toMatch(HOUSE_TOUCH_TARGET)
      host.unmount()
    })
  }

  it('每一页渲染的是它自己那一域的内容，不是把四个域又堆在一起', async () => {
    const lines = await mountPage(LinesPage)
    expect(lines.text()).toContain('搜索')
    expect(lines.text()).not.toContain('新增链路')
    lines.unmount()

    const schedule = await mountPage(SchedulePage)
    expect(schedule.text()).toContain('通勤时段')
    expect(schedule.text()).not.toContain('搜索')
    schedule.unmount()

    const anchors = await mountPage(AnchorsPage)
    expect(anchors.text()).toContain('用当前位置设置「家」和「公司」')
    expect(anchors.text()).not.toContain('新增链路')
    anchors.unmount()

    const chains = await mountPage(ChainsPage)
    expect(chains.text()).toContain('新增链路')
    expect(chains.text()).not.toContain('用当前位置设置')
    chains.unmount()
  })
})

describe('44px 房规：这次量出来低于它的四个控件都补上了', () => {
  it('折叠态的通勤时段按钮：它现在也是 44px', async () => {
    const host = await mountPage(SchedulePage)

    const trigger = collapsedHoursTrigger(host)
    expect(String(trigger.props.class), 'the collapsed trigger is smaller than the house touch target')
      .toMatch(HOUSE_TOUCH_TARGET)
    host.unmount()
  })

  it('取消关注：展开一行之后的那个控件，以及对话框里的两个', async () => {
    const host = await mountPage(LinesPage)

    // The row has to be opened first: the panel is not rendered while it is collapsed.
    await press(host, host.node(item => item.tag === 'button' && host.textOf(item).includes('快线 1 路'), 'the followed-line row'))
    const unfollow = controlWith(host, '取消关注')
    expect(String(unfollow.props.class), '取消关注 is smaller than the house touch target').toMatch(HOUSE_TOUCH_TARGET)
    host.unmount()

    // The dialog's two controls, mounted in the state the flow above puts them in.
    const dialog = await mountPage(RemovalDialog, { open: true, lineName: '快线 1 路', removing: false, error: null })
    for (const words of ['保留', '确认取消关注']) {
      const control = controlWith(dialog, words)
      expect(String(control.props.class), `${words} is smaller than the house touch target`).toMatch(HOUSE_TOUCH_TARGET)
    }
    dialog.unmount()
  })

  it('展开一行后的方向单选也是 44px（这一处此前是 36px）', async () => {
    // The direction pills were the one control this screen still measured under the
    // house number: `min-h-[36px]`, which clears WCAG 2.5.8's 24×24 and is not 44.
    // A two-way route is the only shape that renders them (a single-direction route
    // shows its direction as text), so the fixture is a followed route carrying a
    // `reverseLineId`.
    const host = await mountComponent(LinesPage, {
      routes: [
        [/\/api\/transit\/favorites$/, () => ({ success: true, data: [TWO_WAY_FAVOURITE] })],
        [/\/api\/transit\/lines\//, () => ({ success: true, data: TWO_WAY_DETAIL })],
        [/\/api\/transit\/settings/, () => ({ success: true, data: {} })],
        [/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [] })],
      ],
    })
    await host.flush()

    // The row has to be opened first: the panel is not rendered while it is collapsed.
    await press(host, host.node(
      item => item.tag === 'button' && host.textOf(item).includes('快线 1 路'),
      'the followed-line row',
    ))

    const radios = directionRadios(host)
    // NON-EMPTY FIRST, because this list came from a filtering helper: an empty one
    // would make the loop below pass while measuring nothing. Two purposes × two
    // directions is the four pills the row shows.
    expect(radios.length, 'the expanded row rendered no direction radio to measure').toBe(4)
    for (const radio of radios) {
      expect(String(radio.props.class), `a direction radio is smaller than the house touch target: ${String(radio.props.class)}`)
        .toMatch(HOUSE_TOUCH_TARGET)
    }
    host.unmount()
  })
})

/**
 * The 通勤时段 sub-page's OWN collapsed summary, held here rather than only through the index
 * row.
 *
 * The two share one wording function (`index-summary.ts`'s `hoursText`) by design, so the same
 * stored hours cannot read two ways — but the READ is the page's own: this page fetches
 * `/api/transit/settings` itself and decides the three states itself. Nothing else holds that:
 * a `catch` here that restored `06:30–11:30` would make this page state the default wearing the
 * user's own configuration's clothes, and the index row's tests would stay green, because they
 * mount a different file.
 */
describe('通勤时段子页的折叠摘要自己说三态', () => {
  /** The collapsed summary's own wording, character for character. */
  const HOURS_SUMMARY = '06:30–11:30 · 17:00–22:00'

  it('读到：摘要就是那四个已保存的时刻', async () => {
    const host = await mountPage(SchedulePage)

    expect(host.textOf(collapsedHoursTrigger(host))).toContain(HOURS_SUMMARY)
    host.unmount()
  })

  it('读失败：摘要说「未读到」，不给默认的 06:30–11:30', async () => {
    const host = await mountPage(SchedulePage, {}, { settings: 'fail' })

    const summary = host.textOf(collapsedHoursTrigger(host))
    expect(summary).toContain('未读到')
    expect(summary, 'the default hours look like the user’s own configuration').not.toContain('06:30')
    expect(summary).not.toContain('17:00')
    host.unmount()
  })

  it('没存过：摘要说「未设置」，也不是那个默认时段', async () => {
    // The fourth state, on THIS page: the read answered and found no row. It used to be
    // answered with the built-in window, which this summary printed as the user's own
    // hours — one step further from the truth than a failure, because nothing failed.
    const host = await mountPage(SchedulePage, {}, { settings: 'unset' })

    const summary = host.textOf(collapsedHoursTrigger(host))
    expect(summary).toContain('未设置')
    expect(summary, 'the built-in window is printed for a user who never saved one').not.toContain('06:30')
    expect(summary).not.toContain('17:00')
    expect(summary).not.toContain('未读到')
    host.unmount()
  })
})

describe('设置拆分后，应用内的指向各自落在那一域的那一页', () => {
  it('首页空态：去搜索并关注线路 → /settings/lines', async () => {
    const host = await mountPage(OverviewEmptyState, { cityName: '北京市' })

    const link = controlWith(host, '去搜索并关注线路')
    expect(link.props.href).toBe('/settings/lines')
    host.unmount()
  })

  it('链路空态的锚点原因 → /settings/anchors，文案不变', async () => {
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: false }),
    })

    expect(host.text()).toContain('未设置「家」位置')
    expect(controlWith(host, '去设置起点位置').props.href).toBe('/settings/anchors')
    host.unmount()
  })

  it('链路空态的「还没有录入」原因 → /settings/chains：录入界面存在了，这条指向才诚实', async () => {
    // This entry did not exist while the build had no recording surface (the empty state
    // promised no affordance then, and rightly so). `/settings/chains` is where a chain is
    // recorded, so the cause the user can act on now has a screen — and the anchor cause
    // above keeps its own screen rather than being replaced by this one.
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: true }),
    })

    expect(controlWith(host, '去设置里录入链路').props.href).toBe('/settings/chains')
    host.unmount()
  })

  it('链路空态的锚点读不到：仍然给录入入口，且一个字都不说锚点', async () => {
    // An unread anchor row is claimed neither way, and the recording surface is not a
    // claim about it: the link goes to the chain page, never to the anchor row.
    const host = await mountPage(ChainEmptyState, {
      view: emptyStateOf({ purpose: 'morning', anchorSaved: null }),
    })

    expect(host.text()).not.toContain('未设置')
    expect(controlWith(host, '去设置里录入链路').props.href).toBe('/settings/chains')
    host.unmount()
  })
})

/**
 * 设置's index row learned this rule first (see `settings-index.test.ts`), and the pages
 * it points at owe it the same: a followed-lines read that FAILED leaves an empty array
 * behind, and rendering that array as 「暂无关注线路」 tells the user they follow nothing
 * when the truth is 「没读到」. The words differ because the facts differ — one names an
 * empty set, the other names a read nobody completed — and only the second has a retry
 * that can change the answer.
 */
describe('关注线路读不到时，说「未读到」，不说「没有」', () => {
  it('关注线路页：读失败时说未读到并给重试，不给「暂无关注线路」，也不报 0 条', async () => {
    const host = await mountPage(LinesPage, {}, { favourites: 'fail' })

    const text = host.text()
    expect(text, 'an unreadable list must not be worded as an empty one').not.toContain('暂无关注线路')
    expect(text, 'a count taken from an unreadable list is a number nobody obtained').not.toContain('(0)')
    expect(text).toContain('未读到关注线路')
    expect(controlWith(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('关注线路页：按重试，读到了就把列表显示出来，读失败的那句话消失', async () => {
    const host = await mountPage(LinesPage, {}, { favourites: 'fail' })
    expect(host.text()).toContain('未读到关注线路')

    host.server.on(/\/api\/transit\/favorites$/, () => ({
      success: true,
      data: [{ id: 'fav-1', userId: 'default_user', cityCode: '027', lineId: 'bus_027_1', lineName: '快线 1 路', preferredDirection: 0, displayOrder: 0 }],
    }))
    await press(host, controlWith(host, '重试'))

    expect(host.text()).toContain('快线 1 路')
    expect(host.text()).not.toContain('未读到关注线路')
    host.unmount()
  })

  it('通勤链路页的录入：读失败时说未读到，不给「还没有关注线路」这句关于存储行的话', async () => {
    // The chain editor's premise is the followed set, so a read that failed leaves it with
    // no line to offer — which is NOT the same fact as 「还没有关注线路」.
    const host = await mountPage(ChainsPage, {}, { favourites: 'fail' })
    await press(host, controlWith(host, '新增链路'))

    expect(host.text()).not.toContain('还没有关注线路')
    expect(host.text()).toContain('未读到关注线路')
    host.unmount()
  })
})
