import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataSourceTypeSchema } from '@real-time-transport/shared'
import {
  AA_NORMAL_TEXT,
  PAGE_BASE,
  auditContrast,
  contrastOfHex,
  luminance,
  rgbaOf,
} from './chain-contrast'
import {
  deferred,
  httpStatus,
  mountChainPage,
  pickPurpose,
  pressRefresh,
  purposeRadios,
  refreshButton,
  refreshedLines,
  type Deferred,
  type Responder,
} from './chain-page-harness'
import { OPERATING, READ_AT, chainView, conclusion, leg, refusal, refreshAnswer } from './chain-fixtures'

/**
 * 链路页的接线，由**行为**守住。
 *
 * 本文件曾断言标识符出现在页面源码中——这种守卫在修好与损坏两种状态下都通过：`refreshTargets`
 * 存在并不能说明它推导出什么，且一个什么都不刷新的页面也会是绿的。故现在**挂载**页面（见
 * `chain-page-harness.ts`，经 Vue 的 runtime-core 渲染而不需 DOM），断言的是用户得到的东西：
 * 页面发出的请求、它印出的文字、以及两个答案相竞时谁胜。
 *
 * 仍有少数规则按源码断言，且其名称已说明：nav 与 router 条目（注册表数据而非行为）、两条本质上
 * 词法的设计守卫（字号阶梯、安全区归属）、以及源码无论渲染什么都必须持有的纯净规则（无厂商名、
 * 无已移除的契约字段）。其余的一切都在驱动页面。
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

const MODULES = {
  'types': read('../../../views/commute-chain/types.ts'),
  'margin': read('../../../views/commute-chain/margin.ts'),
  'refusal': read('../../../views/commute-chain/refusal.ts'),
  'empty-state': read('../../../views/commute-chain/empty-state.ts'),
  'provenance': read('../../../views/commute-chain/provenance.ts'),
  'card': read('../../../views/commute-chain/card.ts'),
}

const COMPONENTS = {
  'transfer-card': read('../../../views/commute-chain/components/transfer-card.vue'),
  'transfer-row': read('../../../views/commute-chain/components/transfer-row.vue'),
  'band-chip': read('../../../views/commute-chain/components/band-chip.vue'),
  'chain-empty-state': read('../../../views/commute-chain/components/chain-empty-state.vue'),
  'chain-load-state': read('../../../views/commute-chain/components/chain-load-state.vue'),
  'index': read('../../../views/commute-chain/components/index.ts'),
}

const page = read('../../../views/commute-chain/index.vue')
const router = read('../../../router/index.ts')
const nav = read('../../../components/header-nav/main.vue')

/** 构成本页的每个 .vue 文件——设计守卫所评判的表面。 */
const SFC = { 'index.vue': page, ...COMPONENTS }

/** 某个目的的一条链路答案，如端点所发送。 */
function chainsOf(chains: Array<ReturnType<typeof chainView>>, purpose = 'morning'): unknown {
  return { success: true, data: { purpose, chains } }
}

/** 设置行 `设置` 自己的响应，只含页面读取的字段。 */
function settings(coords: Record<string, number> = {}): unknown {
  return { success: true, data: coords }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the chain page is a first-level entry beside the home tab (a registry guard: nav and router are data)', () => {
  it('is in the top-level nav, under the name the product gives it', () => {
    expect(codeOf(nav)).toContain(`to: '/commute-chain'`)
    expect(codeOf(nav)).toContain(`label: '换乘链路'`)
  })

  it('has a route of its own, loading the view the plan names', () => {
    const code = codeOf(router)
    expect(code).toContain(`path: '/commute-chain'`)
    expect(code).toContain(`name: 'commute-chain'`)
    expect(code).toContain(`import('@/views/commute-chain/index.vue')`)
  })
})

describe('F11 has one entry here, and what it names comes from the answers on screen', () => {
  it('names every leg of a deduced chain, and both directions of a subway leg', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([
          chainView(conclusion([
            leg({ seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路', marginMinutes: 9 }),
            leg({ seq: 1, lineId: 'subway_027_88', lineName: '地铁 88 号线', marginMinutes: 2 }),
          ])),
        ])],
        [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })],
      ],
    })

    await pressRefresh(page)

    // 地铁 id 携带两个方向，而答案没说它的段跑哪个方向，故点名其中一个会让该段自己的方向未刷新，
    // 而控件仍报告「已刷新」。
    expect(refreshedLines(page)).toEqual([
      'bus_027_1_0@027',
      'subway_027_88_0@027',
      'subway_027_88_1@027',
    ])
    page.unmount()
  })

  it('names the refusing leg of a refused chain and nothing else', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([
          chainView(conclusion([leg({ seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' })]), { chainId: 'deduced-1' }),
          chainView(
            refusal('no-vehicle', { leg: { seq: 1, lineId: 'bus_027_9', lineName: '快线 9 路' }, updatedAt: READ_AT, operatingStatus: OPERATING }),
            { chainId: 'refused-1', name: '上班 · 拒绝的链路' },
          ),
        ])],
        [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })],
      ],
    })

    await pressRefresh(page)

    // 拒绝不携带前一段的答案，故发出拒绝的那段是该链路唯一在读取的线路。
    expect(refreshedLines(page)).toEqual(['bus_027_1_0@027', 'bus_027_9_0@027'])
    page.unmount()
  })

  it('names nothing at all when it is showing no answer to re-read', async () => {
    const page = await mountChainPage({
      // 完全没有段的拒绝：该链路不点名任何线路，故页面没有可请求的，控件也不可按。
      routes: [/commute-chains\/deductions/, () => chainsOf([chainView(refusal('no-legs'))])],
    })

    expect(refreshButton(page).props.disabled).toBe(true)
    await expect(pressRefresh(page)).rejects.toThrow(/disabled/)
    expect(page.server.seen(/api\/transit\/refresh$/)).toHaveLength(0)
    page.unmount()
  })

  it('asks through the store\'s one request, so the window a press spends is shared', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([chainView(conclusion([leg({ seq: 0 })]))])],
        [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })],
      ],
    })

    await pressRefresh(page)

    const reReads = page.server.requests.filter(request => request.url.startsWith('/api/transit/refresh'))
    expect(reReads).toHaveLength(1)
    expect(reReads[0]!.method).toBe('POST')
    expect(reReads[0]!.url).toBe('/api/transit/refresh')
    page.unmount()
  })

  it('re-reads the answers only when the press obtained a reading', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([chainView(conclusion([leg({ seq: 0 })]))])],
        [/api\/transit\/refresh$/, () => httpStatus(429, { success: false, data: refreshAnswer({ throttled: true }) })],
      ],
    })
    const before = page.server.seen(/commute-chains\/deductions/).length

    await pressRefresh(page)

    // 拒绝什么都没携带，故再次索要数字只会取回屏幕上已有的东西。
    expect(page.store.refreshOutcome).toBe('throttled')
    expect(page.server.seen(/commute-chains\/deductions/)).toHaveLength(before)
    page.unmount()
  })
})

/**
 * 一次按下的结局由全局提示承载（`__tests__/refresh-toast.test.ts` 评判它推了什么），故本页既不再
 * 印那个词，也不再有一条常驻的 live region —— 两处都留着会让一次拒绝同时被说两遍。
 *
 * 刷新读数那一行也不再印：它随这次改动从两档工具栏里撤掉了。store 仍记着它（线路页的抽屉与首页的
 * 卡片各有自己的一半），而本页一个字都不说它。
 */
describe('结局由全局提示说，页面上没有读数那一行', () => {
  const withChains: [RegExp, Responder] = [
    /commute-chains\/deductions/,
    () => chainsOf([chainView(conclusion([leg({ seq: 0 })]))]),
  ]

  it('按下之后 store 记下了这次结局，而页面上找不到那个词', async () => {
    const cases: Array<{ name: string, outcome: string, respond: Responder }> = [
      { name: 'ok', outcome: 'ok', respond: () => ({ success: true, data: refreshAnswer() }) },
      {
        name: 'throttled',
        outcome: 'throttled',
        respond: () => httpStatus(429, { success: false, data: refreshAnswer({ throttled: true, retryAfterSeconds: 13 }) }),
      },
      { name: 'unavailable', outcome: 'unavailable', respond: () => ({ success: false, data: null }) },
      { name: 'offline', outcome: 'offline', respond: () => { throw new Error('the connection is down') } },
    ]

    for (const scenario of cases) {
      const page = await mountChainPage({
        routes: [withChains, [/api\/transit\/refresh$/, scenario.respond]],
      })
      await pressRefresh(page)

      expect(page.store.refreshOutcome, scenario.name).toBe(scenario.outcome)
      // 页面不印结局：它是提示的，措辞只出在一个地方（store + 提示模块）。
      expect(page.text(), scenario.name).not.toContain('刷新太频繁')
      expect(page.text(), scenario.name).not.toContain('已刷新')
      expect(page.text(), scenario.name).not.toContain('连接已断开')
      expect(page.nodes(item => item.props.role === 'status'), scenario.name).toHaveLength(0)
      page.unmount()
    }
  })

  it('store 仍记下这次按下取到的读数，而本页一行字都不印它', async () => {
    const page = await mountChainPage({
      routes: [withChains, [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })]],
    })

    expect(page.store.refreshReading).toBeNull()
    await pressRefresh(page)

    // 读数确实被记下了：它是刷新那一处唯一的事实，别的表面（线路页抽屉）由它取字。
    expect(page.store.refreshReading).not.toBeNull()
    // ……而本页不再有那一行：两档工具栏里都没有这个 id，也没有它那句库存措辞。
    expect(page.nodes(item => typeof item.props.id === 'string' && item.props.id.endsWith('refresh-freshness')))
      .toHaveLength(0)
    expect(page.text()).not.toContain('尚未获取到数据')
    page.unmount()
  })
})

describe('the answers come from one purpose at a time', () => {
  it('reads the purpose it is showing, from the one endpoint', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([chainView(conclusion([leg({ seq: 0 })]))])],
    })

    const asked = () => page.server.seen(/\/api\/transit\/commute-chains/)
    expect(asked().map(request => request.url)).toEqual([
      '/api/transit/commute-chains/deductions?purpose=morning&userId=default_user',
    ])

    await pickPurpose(page, 'evening')

    expect(asked().map(request => request.url)).toEqual([
      '/api/transit/commute-chains/deductions?purpose=morning&userId=default_user',
      '/api/transit/commute-chains/deductions?purpose=evening&userId=default_user',
    ])
    page.unmount()
  })

  it('never shows one purpose\'s chains under another\'s purpose', async () => {
    const answers: Array<{ purpose: string, deferred: Deferred<unknown> }> = []
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, (request) => {
          const purpose = /purpose=(\w+)/.exec(request.url)?.[1] ?? 'morning'
          const answer = deferred<unknown>()
          answers.push({ purpose, deferred: answer })
          return answer.promise
        }],
      ],
    })

    await pickPurpose(page, 'evening')
    expect(answers.map(entry => entry.purpose)).toEqual(['morning', 'evening'])

    // 用户**离开**的目的在切换后作答：它不再是本页的答案。接受它会终结晚间答案仍在进行的读取——
    // 页面随后会对一个它尚未问完的目的说「这个时段还没有换乘链」。
    answers[0]!.deferred.resolve(chainsOf([chainView(conclusion([leg({ seq: 0 })]), { name: '早上的链路' })], 'morning'))
    await page.flush()
    expect(page.text()).not.toContain('早上的链路')
    expect(page.text(), 'the stale answer ended a read that is still open').toContain('正在读取换乘链')
    expect(page.text()).not.toContain('还没有换乘链')

    answers[1]!.deferred.resolve(chainsOf([chainView(conclusion([leg({ seq: 0 })]), { name: '晚上的链路' })], 'evening'))
    await page.flush()
    expect(page.text()).toContain('晚上的链路')
    page.unmount()
  })

  it('never lets a slower older answer overwrite a newer one', async () => {
    // 读取重叠：一次读取在途时切换目的，再在任一作答前切回。三次读取，而其中**第一次**是为现在
    // 屏幕上的目的——故若不排序，它的答案（最旧的）最后落地，替换用户已在看的那一个。F10 排除的
    // 正是这次跳变。（周期性重读与一次按下相竞是同一场竞赛，只是触发者从点击换成定时器。）
    const answers: Array<{ purpose: string, deferred: Deferred<unknown> }> = []
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, (request) => {
        const purpose = /purpose=(\w+)/.exec(request.url)?.[1] ?? 'morning'
        const answer = deferred<unknown>()
        answers.push({ purpose, deferred: answer })
        return answer.promise
      }],
    })

    await pickPurpose(page, 'evening')
    await pickPurpose(page, 'morning')
    expect(answers.map(entry => entry.purpose)).toEqual(['morning', 'evening', 'morning'])

    answers[2]!.deferred.resolve(chainsOf([chainView(conclusion([leg({ seq: 0 })]), { name: '新的一次读取' })], 'morning'))
    await page.flush()
    expect(page.text()).toContain('新的一次读取')

    answers[0]!.deferred.resolve(chainsOf([chainView(conclusion([leg({ seq: 0 })]), { name: '旧的一次读取' })], 'morning'))
    await page.flush()
    expect(page.text(), 'the older answer overwrote the newer one').toContain('新的一次读取')
    expect(page.text()).not.toContain('旧的一次读取')
    page.unmount()
  })
})

describe('the facts an answer is made of reach the screen', () => {
  it('states a deduction: the binding transfer, the margin, the wait, the vehicle and the reading', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(conclusion([leg({
          seq: 0,
          lineId: 'bus_027_1',
          lineName: '快线 1 路',
          marginMinutes: 4,
          waitMinutes: 4,
          alightMinutes: 12,
          rideMinutes: 8,
        })])),
      ])],
    })

    const text = page.text()
    expect(text).toContain('最紧的是第 1 段 · 快线 1 路')
    expect(text).toContain('余量 4 分')
    expect(text).toContain('站台等待 4 分')
    expect(text).toContain('乘这一班')
    expect(text).toContain('充裕')
    expect(text).toContain('12 分钟后到下车站')
    expect(text).toContain('最后更新')
    page.unmount()
  })

  it('states a refusal as one sentence, its transfer and F3\'s service state — and no margin beside it', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(refusal('no-vehicle', {
          leg: { seq: 1, lineId: 'bus_027_1', lineName: '快线 1 路' },
          updatedAt: READ_AT,
          operatingStatus: { ...OPERATING, state: 'after_last' },
        })),
      ])],
    })

    const text = page.text()
    expect(text).toContain('暂时没有开往这一站的车')
    expect(text).toContain('第 2 段 · 快线 1 路')
    expect(text).toContain('已过末班')
    expect(text).toContain('最后更新')
    // 拒绝卡片不持有任何种类的答案——无余量、无分钟、无车辆。（页面自己的导语所说的是余量**是**什么，
    // 那是关于本特性的文案，不是归给本链路的数字。）
    const card = page.textOf(page.node(item => item.tag === 'article', 'chain card'))
    expect(card, 'a refusal is not a smaller answer').not.toContain('余量')
    expect(card).not.toContain('乘这一班')
    page.unmount()
  })

  it('keeps the reading\'s internal vehicle ids out of everything it renders', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(conclusion([leg({
          seq: 0,
          vehicleId: 'provider-vehicle-secret-1',
          referenceVehicleId: 'provider-vehicle-gone-2',
          marginMinutes: -2,
          waitMinutes: 6,
        })])),
        chainView(refusal('no-shared-vehicle', { leg: { seq: 0, lineId: 'subway_027_88', lineName: '地铁 88 号线' } }), { chainId: 'refused-1' }),
      ])],
    })

    const text = page.text()
    for (const id of ['provider-vehicle-secret-1', 'provider-vehicle-gone-2', 'provider-vehicle']) {
      expect(text, `the page rendered ${id}`).not.toContain(id)
    }
    // 不印余量，也不印在正在上的车辆旁。
    expect(text).toContain('改乘下一班')
    expect(text).not.toContain('余量 -')
    page.unmount()
  })

  it('adds nothing up: the chain ends at its last leg\'s alight station', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(conclusion([
          leg({ seq: 0, alightMinutes: 12, rideMinutes: 8, marginMinutes: 9 }),
          leg({ seq: 1, lineName: '地铁 88 号线', alightMinutes: 20, rideMinutes: 10, marginMinutes: 2 }),
        ])),
      ])],
    })

    const text = page.text()
    expect(text).toContain('12 分钟后到下车站')
    expect(text).toContain('20 分钟后到下车站')
    // 12 + 20 = 32 是尾部合计会印的总数，它不出现于任何地方。
    expect(text).not.toContain('32')
    page.unmount()
  })

  it('carries the anchor\'s own affordance, and only where the action is that one', async () => {
    // 下班链路从公司出发，故要修的是公司那一行 —— 起点由目的推出，页面没有第二个来源可读。
    const unset = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(refusal('anchor-unset'), { purpose: 'evening' }),
      ])],
    })
    expect(unset.text()).toContain('未设置「公司」位置')
    // `设置` 是一个索引加四个页面，故该可供性点名拥有该成因的页面（位置锚点）而非索引：
    // 用户距要修复的那一行只差一次点击。
    expect(unset.nodes(item => item.tag === 'a').map(item => item.props.href)).toEqual(['/settings/anchors'])
    unset.unmount()

    const generic = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(refusal('connection-unpriced', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' } })),
      ])],
    })
    expect(generic.nodes(item => item.tag === 'a')).toHaveLength(0)
    generic.unmount()
  })
})

describe('the empty state names the cause the user can act on, read from 设置\'s own row', () => {
  it('sends them to 设置 when the purpose\'s own anchor was never saved', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([])],
        // `设置` 的行只持有「公司」：上班链路从「家」起步，而它未设置。
        [/api\/transit\/settings/, () => settings({ workLat: 31, workLng: 121 })],
      ],
    })

    expect(page.text()).toContain('还没有换乘链')
    expect(page.text()).toContain('未设置「家」位置')
    // 锚点成因自己的屏幕，直达该行而不经 `设置` 的索引。
    expect(page.nodes(item => item.tag === 'a').map(item => item.props.href)).toEqual(['/settings/anchors'])
    expect(page.server.seen(/api\/transit\/settings/)).toHaveLength(1)
    page.unmount()
  })

  it('reads the anchor the purpose actually starts from', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([])],
        // `设置` 的行只持有「家」：晚间链路从「公司」起步，而它未设置。
        [/api\/transit\/settings/, () => settings({ homeLat: 39.9, homeLng: 116.4 })],
      ],
    })

    await pickPurpose(page, 'evening')

    expect(page.text()).toContain('未设置「公司」位置')
    expect(page.text()).not.toContain('家」')
    page.unmount()
  })

  it('claims nothing about an anchor state nobody could read, and offers the screen that claims nothing either', async () => {
    // 未读的行既非已保存也非缺失，故没有锚点句、没有锚点链接。录制页不是对那行的断言——
    // 无论锚点持有什么，链路都记录在那里——故它是本状态保留的唯一可供性。
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([])],
        [/api\/transit\/settings/, () => { throw new Error('the settings row could not be read') }],
      ],
    })

    expect(page.text()).not.toContain('未设置')
    expect(page.nodes(item => item.tag === 'a').map(item => item.props.href)).toEqual(['/settings/chains'])
    page.unmount()
  })
})

describe('the house design rules', () => {
  it('renders a real radio group for the purpose, not a hand-rolled picker', async () => {
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([])],
    })

    const group = page.node(item => item.props.role === 'radiogroup', 'purpose radio group')
    expect(group.props['aria-label']).toBe('通勤目的')
    // 页签在本页出现两处：宽屏那块卡片一处、窄屏那条收展面板一处，各自一组两项。
    const radios = purposeRadios(page)
    expect(radios).toHaveLength(4)
    expect(new Set(radios.filter(radio => radio.props['aria-checked'] === true).map(radio => radio.props.value)))
      .toEqual(new Set(['morning']))

    await pickPurpose(page, 'evening')

    // 点击其一即切换目的，两处都如此陈述：一个页面不能同时选中两个目的。
    const after = purposeRadios(page).filter(radio => radio.props['aria-checked'] === true)
    expect(new Set(after.map(radio => radio.props.value))).toEqual(new Set(['evening']))
    page.unmount()
  })

  it('gives the purpose tabs the container/item rhythm of the house controls (44 in a 44)', async () => {
    // 本仓库的控件是 44 那一档（`settings/index.vue` 引 Apple HIG 的 44）；WCAG 2.2 SC 2.5.8 的
    // 24px 下限无论如何都满足。项与容器同高，故容器不带内边距：带了就会在选中项外面留出一圈，
    // 而那一圈属于容器、项永远填不满它。
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([])],
    })

    for (const group of page.nodes(item => item.props.role === 'radiogroup')) {
      const classes = String(group.props.class)
      expect(classes, 'a purpose container is not h-11').toContain('h-11')
      expect(classes, 'a purpose container keeps an inner ring the tabs cannot fill').toContain('p-0')
      // 项与容器同高时，被裁掉的只能是选中项自己那一圈圆角。
      expect(classes, 'a purpose container does not clip its tabs').toContain('overflow-hidden')
    }
    for (const radio of purposeRadios(page)) {
      expect(String(radio.props.class), 'a purpose tab is not the 44 its container is')
        .toMatch(/(?:^|\s)(?:min-)?h-11(?:\s|$)/)
    }
    expect(String(refreshButton(page).props.class)).toContain('h-11')
    page.unmount()
  })

  it('uses only the even font sizes (a lexical rule: the ladder is in the class names)', () => {
    const allowed = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'])
    for (const [name, source] of Object.entries(SFC)) {
      const code = codeOf(source)
      expect(code, `${name} uses an arbitrary font size`).not.toContain('text-[')
      for (const match of code.matchAll(/(?:^|[\s"'`])text-([a-z0-9]+)/g)) {
        const token = match[1]!
        // 颜色与对齐不是尺寸；只评判尺寸 token。
        if (!/^(?:xs|sm|base|lg|xl|md|[0-9])/.test(token)) continue
        expect(allowed.has(token), `${name} uses text-${token}`).toBe(true)
      }
    }
  })

  it('leaves the iOS safe-area insets where App.vue applies them (a structural rule)', () => {
    // `<main>` 为每个路由把上下内边距加到页面留白上。视口固定元素会逃出该留白，
    // 必须自带上内边距，故本页没有。
    for (const [name, source] of Object.entries(SFC)) {
      expect(codeOf(source), `${name} pins something to the viewport`)
        .not.toMatch(/(?:^|[\s"'`])(?:fixed|sticky)(?:[\s"'`]|$)/m)
    }
  })

  it('names no data source in its source, and none in anything it renders (a purity rule about the source)', async () => {
    for (const [name, source] of Object.entries({ ...MODULES, ...SFC, index: page })) {
      for (const dataSource of DataSourceTypeSchema.options) {
        expect(codeOf(source), `${name} names ${dataSource}`).not.toContain(dataSource)
      }
    }

    const rendered = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(conclusion([leg({ seq: 0 })])),
        chainView(refusal('no-vehicle', { leg: { seq: 0, lineId: 'bus_027_1', lineName: '快线 1 路' }, updatedAt: READ_AT, operatingStatus: OPERATING }), { chainId: 'refused-1' }),
      ])],
    })
    for (const dataSource of DataSourceTypeSchema.options) {
      expect(rendered.text(), `the page rendered ${dataSource}`).not.toContain(dataSource)
    }
    rendered.unmount()
  })

  it('keeps the contract\'s removed fields out of the source (a source-level rule)', () => {
    // 「没有目的地、没有尾段接驳、没有总到达时间」——回来的字段会是一个没人测量过的数字，
    // 且不会出现在任何渲染断言里。
    for (const [name, source] of Object.entries({ ...MODULES, ...SFC, index: page })) {
      expect(codeOf(source), name).not.toContain('tailConnectionSeconds')
      expect(codeOf(source), name).not.toContain('arriveInMinutes')
    }
  })

  it('text is readable on the surface it actually sits on, composited from the source', () => {
    const audit = auditContrast(SFC)
    expect(audit.pairs.length).toBeGreaterThan(0)
    expect(audit.violations).toEqual([])

    // 本审计存在所针对的表面：被选中的单选药丸把 `cyan-500/20` 叠在 `slate-800/80` 上再叠到页面，
    // 比它所在的 `slate-800` 卡片更亮——故拿每个颜色对一个手挑表面检查的审计，检查的是某些文本
    // 从不使用的表面，而药丸自己的背景对它不可见。
    const pill = audit.surfaces.find(surface =>
      surface.layers.some(layer => layer.startsWith('data-[state=checked]:bg-')))
    expect(pill, 'the checked pill is a surface this page paints and the audit must composite it').toBeDefined()
    // 页头那张卡片的渐变层：工具栏这一版里没有哪一行字直接坐在卡片上（读数由共用控件渲染，
    // 模块不在本页的 SFC 集合里），故它现在是作为**祖先层**被合成的 —— 该渐变改了，这些表面都会变。
    const card = audit.surfaces.find(surface => surface.layers.includes('from-slate-900'))
    expect(card, 'the header card surface is not audited').toBeDefined()
    expect(luminance(rgbaOf(pill!.hex))).toBeGreaterThan(luminance(rgbaOf(card!.hex)))

    // 以及本次重建现在必须抓住的失败：12px `text-slate-400` 下的 `bg-slate-700` 低于 AA——
    // 一个被提亮的**背景**，只盯 `text-*` token 的审计完全看不见。
    expect(contrastOfHex('#94a3b8', '#334155')).toBeLessThan(AA_NORMAL_TEXT)

    // 页面不得漂移成的颜色：slate-500 即使在本页涂绘的最暗表面上，12px 也不合格，故没有表面能救它。
    expect(contrastOfHex('#64748b', PAGE_BASE)).toBeLessThan(AA_NORMAL_TEXT)
  })
})
