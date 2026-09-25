import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataSourceTypeSchema } from '@real-time-transport/shared'
import { refreshStatusTextOf } from '@/stores/transit.store'
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
  type MountedChainPage,
  type Responder,
} from './chain-page-harness'
import { OPERATING, READ_AT, chainView, conclusion, leg, refusal, refreshAnswer } from './chain-fixtures'

/**
 * The chain page's wiring, held by BEHAVIOUR.
 *
 * This file used to assert that identifiers appear in the page's source, which is
 * a guard that passes in both the fixed and the broken state: `refreshTargets`
 * being present says nothing about what it derives, and a page that refreshed
 * nothing at all would still have been green. So the page is now MOUNTED — see
 * `chain-page-harness.ts`, which renders it through Vue's runtime-core without a
 * DOM — and what is asserted is what a user gets: the requests the page makes, the
 * words it prints, and which answer wins when two of them race.
 *
 * A handful of rules are still asserted against the source, and their names say so:
 * the nav and router entries (registry data, not behaviour), the two design guards
 * that are lexical by nature (font-size ladder, safe-area ownership), and the purity
 * rules the source must hold whatever it renders (no vendor name, no removed
 * contract field). Everything else below drives the page.
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

const MODULES = {
  'types': read('../types.ts'),
  'margin': read('../margin.ts'),
  'refusal': read('../refusal.ts'),
  'empty-state': read('../empty-state.ts'),
  'provenance': read('../provenance.ts'),
  'card': read('../card.ts'),
}

const COMPONENTS = {
  'transfer-card': read('../components/transfer-card.vue'),
  'transfer-row': read('../components/transfer-row.vue'),
  'band-chip': read('../components/band-chip.vue'),
  'chain-empty-state': read('../components/chain-empty-state.vue'),
  'chain-load-state': read('../components/chain-load-state.vue'),
  'index': read('../components/index.ts'),
}

const page = read('../index.vue')
const router = read('../../../router/index.ts')
const nav = read('../../../components/header-nav/main.vue')

/** Every .vue file the page is made of — the surface the design guards judge. */
const SFC = { 'index.vue': page, ...COMPONENTS }

/** A chain answer for one purpose, as the endpoint sends it. */
function chainsOf(chains: Array<ReturnType<typeof chainView>>, purpose = 'morning'): unknown {
  return { success: true, data: { purpose, chains } }
}

/** The setting row 设置's own response, with only the fields the page reads. */
function settings(coords: Record<string, number> = {}): unknown {
  return { success: true, data: coords }
}

/** The state line, as the page renders it. */
function statusLineOf(page: MountedChainPage): string {
  return page.textOf(page.node(item => item.props.id === 'refresh-status', 'state line'))
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

    // A SUBWAY id carries both directions while the answer does not say which way
    // its leg runs, so naming one would leave the leg's own direction un-refreshed
    // while the control still reported 已刷新.
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

    // A refusal carries no earlier leg's answer, so the refusing leg is the ONLY
    // line that chain is reading.
    expect(refreshedLines(page)).toEqual(['bus_027_1_0@027', 'bus_027_9_0@027'])
    page.unmount()
  })

  it('names nothing at all when it is showing no answer to re-read', async () => {
    const page = await mountChainPage({
      // A refusal with no leg at all: this chain names no line, so the page has
      // nothing to ask for and the control is not pressable.
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

    // A refusal carried nothing, so asking for the numbers again would only fetch
    // what is already on screen.
    expect(page.store.refreshOutcome).toBe('throttled')
    expect(page.server.seen(/commute-chains\/deductions/)).toHaveLength(before)
    page.unmount()
  })
})

describe('the state line is the store\'s, and it is announced without the seconds', () => {
  const withChains: [RegExp, Responder] = [
    /commute-chains\/deductions/,
    () => chainsOf([chainView(conclusion([leg({ seq: 0 })]))]),
  ]

  it('prints every outcome in the store\'s own words, and never a second vocabulary', async () => {
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
      const expected = refreshStatusTextOf({
        inFlight: false,
        outcome: page.store.refreshOutcome,
        waitSeconds: page.store.refreshWaitSecondsLeft,
        // One line, and the endpoint's cap covers it.
        wanted: 1,
        covered: 1,
        // The chains this page reads have answered by the time a press is possible.
        targetsRead: true,
      })
      expect(expected, scenario.name).not.toBeNull()
      expect(statusLineOf(page), scenario.name).toBe(`${expected!.announcement}${expected!.detail}`)
      page.unmount()
    }
  })

  it('announces the state from a live region and renders the seconds outside it', async () => {
    const page = await mountChainPage({
      routes: [
        withChains,
        [/api\/transit\/refresh$/, () => httpStatus(429, {
          success: false,
          data: refreshAnswer({ throttled: true, retryAfterSeconds: 13 }),
        })],
      ],
    })
    await pressRefresh(page)

    const region = page.node(item => item.props.role === 'status', 'live region')
    // A live region whose text changed every second would announce the refusal
    // thirteen times, so the countdown is rendered beside the state, not inside it.
    expect(page.textOf(region)).toBe('刷新太频繁')
    expect(page.textOf(region)).not.toMatch(/\d/)
    expect(statusLineOf(page)).toContain('13 秒后可刷新')
    page.unmount()
  })

  it('says nothing about a list it has not read, and names the list once it has', async () => {
    const first = deferred<unknown>()
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => first.promise],
    })

    // The store's 「暂无正在读取车况的线路」 is true of a list that HAS been read
    // and named no line to ask for. While the chains are still arriving this page
    // has not learned what it is showing, so it hands `targetsRead: false` over and
    // the control states nothing.
    expect(statusLineOf(page)).toBe('')

    first.resolve(chainsOf([]))
    await page.flush()

    expect(statusLineOf(page)).toBe('暂无正在读取车况的线路')
    page.unmount()
  })

  it('states the reading the last press obtained, in the store\'s freshness line', async () => {
    const page = await mountChainPage({
      routes: [withChains, [/api\/transit\/refresh$/, () => ({ success: true, data: refreshAnswer() })]],
    })

    expect(page.text()).toContain('尚未获取到数据')
    await pressRefresh(page)

    expect(page.text()).not.toContain('尚未获取到数据')
    expect(page.text()).toContain('最后更新')
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

    // The purpose the user LEFT answers after the switch: it is not this page's
    // answer any more. Accepting it would end the read the evening answer is still
    // in — and the page would then say 「这个时段还没有换乘链」 about a purpose it had
    // not finished asking about.
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
    // Reads overlap: a purpose switch while a read is in flight, then a switch back
    // before either has answered. Three reads, and the FIRST of them is for the
    // purpose now on screen — so left unsequenced its answer (the oldest) lands last
    // and replaces the one the user is already looking at. That jump is what F10
    // rules out. (The periodic re-read racing a press is the same race with a timer
    // as its trigger instead of a tap.)
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
    // The refusal card holds no answer of any kind — no margin, no minute, no
    // vehicle. (The page's own standfirst says what a margin IS; that is copy
    // about the feature, not a number attributed to this chain.)
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
    // The withheld margin is not printed beside the vehicle being boarded, either.
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
    // 12 + 20 = 32 is the total a tail sum would print, and it appears nowhere.
    expect(text).not.toContain('32')
    page.unmount()
  })

  it('carries the anchor\'s own affordance, and only where the action is that one', async () => {
    const unset = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([
        chainView(refusal('anchor-unset'), { originAnchor: 'work' }),
      ])],
    })
    expect(unset.text()).toContain('未设置「公司」位置')
    // 设置 is an index plus four pages, so the affordance names the page that owns the cause
    // (位置锚点), not the index: the user is one tap from the row they have to repair.
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
        // 设置's row holds 公司 only: the morning chain starts from 家, which is unset.
        [/api\/transit\/settings/, () => settings({ workLat: 31, workLng: 121 })],
      ],
    })

    expect(page.text()).toContain('还没有换乘链')
    expect(page.text()).toContain('未设置「家」位置')
    // The anchor cause's own screen, straight to the row rather than through 设置's index.
    expect(page.nodes(item => item.tag === 'a').map(item => item.props.href)).toEqual(['/settings/anchors'])
    expect(page.server.seen(/api\/transit\/settings/)).toHaveLength(1)
    page.unmount()
  })

  it('reads the anchor the purpose actually starts from', async () => {
    const page = await mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([])],
        // 设置's row holds 家 only: the evening chain starts from 公司, which is unset.
        [/api\/transit\/settings/, () => settings({ homeLat: 39.9, homeLng: 116.4 })],
      ],
    })

    await pickPurpose(page, 'evening')

    expect(page.text()).toContain('未设置「公司」位置')
    expect(page.text()).not.toContain('家」')
    page.unmount()
  })

  it('claims nothing about an anchor state nobody could read, and offers the screen that claims nothing either', async () => {
    // An unread row is neither saved nor missing, so no anchor sentence and no anchor link.
    // The recording page is not a claim about that row — a chain is recorded there whatever
    // the anchor holds — so it is the one affordance this state keeps.
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
    const radios = purposeRadios(page)
    expect(radios).toHaveLength(2)
    expect(radios.filter(radio => radio.props['aria-checked'] === true)).toHaveLength(1)

    await pickPurpose(page, 'evening')

    // Clicking one is what switches the purpose, and the group says so.
    const after = purposeRadios(page)
    expect(after.filter(radio => radio.props['aria-checked'] === true).map(radio => radio.props.value)).toEqual(['evening'])
    page.unmount()
  })

  it('gives the purpose radios the repo\'s 44px mobile touch target (min-h-11), as 设置\'s own controls do', async () => {
    // The repo's mobile convention for touch targets is 44px (`settings/index.vue`
    // cites Apple HIG); WCAG 2.2 SC 2.5.8's 24px minimum is met either way.
    const page = await mountChainPage({
      routes: [/commute-chains\/deductions/, () => chainsOf([])],
    })

    for (const radio of purposeRadios(page)) {
      expect(String(radio.props.class), 'a purpose radio is smaller than the house touch target').toContain('min-h-11')
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
        // Colours and alignments are not sizes; only a size token is judged.
        if (!/^(?:xs|sm|base|lg|xl|md|[0-9])/.test(token)) continue
        expect(allowed.has(token), `${name} uses text-${token}`).toBe(true)
      }
    }
  })

  it('leaves the iOS safe-area insets where App.vue applies them (a structural rule)', () => {
    // `<main>` adds the top and bottom insets to the page gutter for every route.
    // A viewport-fixed element would escape that gutter and would have to carry an
    // inset of its own, so this page has none.
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
    // 「没有目的地、没有尾段接驳、没有总到达时间」 — a field that came back would be a
    // number nobody measured, and it would not show up in any rendered assertion.
    for (const [name, source] of Object.entries({ ...MODULES, ...SFC, index: page })) {
      expect(codeOf(source), name).not.toContain('tailConnectionSeconds')
      expect(codeOf(source), name).not.toContain('arriveInMinutes')
    }
  })

  it('text is readable on the surface it actually sits on, composited from the source', () => {
    const audit = auditContrast(SFC)
    expect(audit.pairs.length).toBeGreaterThan(0)
    expect(audit.violations).toEqual([])

    // The surface this audit exists for: a CHECKED radio pill composites
    // `cyan-500/20` over `slate-800/80` over the page, and it is LIGHTER than the
    // `slate-800` card it sits on — so an audit that checks every colour against
    // one hand-picked surface is checking a surface some text never uses, and the
    // pill's own background is invisible to it.
    const pill = audit.surfaces.find(surface =>
      surface.layers.some(layer => layer.startsWith('data-[state=checked]:bg-')))
    expect(pill, 'the checked pill is a surface this page paints and the audit must composite it').toBeDefined()
    const card = audit.surfaces.find(surface => surface.layers.at(-1) === 'from-slate-900')
    expect(card, 'the header card surface is not audited').toBeDefined()
    expect(luminance(rgbaOf(pill!.hex))).toBeGreaterThan(luminance(rgbaOf(card!.hex)))

    // And the failure this rebuild must now catch: `bg-slate-700` under 12px
    // `text-slate-400` is below AA — a lightened BACKGROUND, which an audit that
    // only ever looks at `text-*` tokens cannot see at all.
    expect(contrastOfHex('#94a3b8', '#334155')).toBeLessThan(AA_NORMAL_TEXT)

    // The colour the page must not drift into: slate-500 fails at 12px even on the
    // darkest surface this page paints, so no surface rescues it.
    expect(contrastOfHex('#64748b', PAGE_BASE)).toBeLessThan(AA_NORMAL_TEXT)
  })
})

/**
 * The default-purpose chip, held on the three facts it can state.
 *
 * It used to say 「默认按通勤时段选定：上班」 whenever the profile was not reporting the
 * evening leg — which includes a user who has never saved any commute hours, and a
 * profile nobody has read. Both credit a stored window that does not exist (or was
 * never looked at), and the payload carries which fact it is (`windowState`), so the
 * three are stated separately here rather than inferred from the mode.
 */
describe('默认用途芯片说的是它读到的事实', () => {
  /** The chip's text, found by the id the page gives it. */
  function chipText(page: MountedChainPage): string {
    return page.textOf(page.node(item => item.props.id === 'purpose-default', 'the default-purpose chip'))
  }

  /** The page with a profile route answering whatever the case needs. */
  async function mountedWithProfile(profile: unknown | (() => never)): Promise<MountedChainPage> {
    return mountChainPage({
      routes: [
        [/commute-chains\/deductions/, () => chainsOf([])],
        [/commute-profile/, () => {
          if (typeof profile === 'function') return profile()
          return profile
        }],
      ],
    })
  }

  it('没有存过的通勤时段：说「未设置」，不把它算成「按通勤时段选定」', async () => {
    const page = await mountedWithProfile({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unset' },
    })

    const text = chipText(page)
    expect(text).toContain('未设置')
    expect(text, 'the chip credits a commute window nobody configured').not.toContain('按通勤时段选定')
    // The default is still a real default, and it is stated as one.
    expect(text).toContain('上班')
    page.unmount()
  })

  it('行在、时段没选过：同样说「未设置」，不把它算成「按通勤时段选定」', async () => {
    // T2 的第三种事实：行在（锚点可能已存），四个时刻是 NULL，服务端报
    // `windowState: 'unchosen'`。没有任何窗口可跟随，所以它和「没有这一行」一样不许
    // credit 一个窗口 —— 一个只认 'unset' 的芯片会把这一团印成「默认：上班」，听起来
    // 就像有一个按窗口选定的默认。
    const page = await mountedWithProfile({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unchosen' },
    })

    const text = chipText(page)
    expect(text).toContain('未设置')
    expect(text, 'the chip credits a commute window whose hours were never chosen').not.toContain('按通勤时段选定')
    expect(text).toContain('上班')
    page.unmount()
  })

  it('读到的通勤时段：仍然按窗口选定，和今天的说法一致', async () => {
    const page = await mountedWithProfile({
      success: true,
      data: { mode: 'home', description: '晚通勤时段', windowState: 'stored' },
    })

    const text = chipText(page)
    expect(text).toContain('按通勤时段选定')
    expect(text).toContain('下班')
    page.unmount()
  })

  it('没读到的通勤时段：不声称窗口选定了它', async () => {
    // The third fact. A profile that never answered is neither stored nor unset, and a
    // chip that credits the window here is making a claim about a row nobody read.
    const page = await mountedWithProfile({ success: false, error: '读取失败' })

    const text = chipText(page)
    expect(text).toContain('上班')
    expect(text, 'the chip credits a window nobody read').not.toContain('按通勤时段选定')
    expect(text).not.toContain('未设置')
    page.unmount()
  })
})
