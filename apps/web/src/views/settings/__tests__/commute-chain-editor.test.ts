import { readFileSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAST_LEG_REASON,
  emptyChainDraft,
  emptyLegDraft,
  lineOptionLabel,
  refuseChainDraft,
} from '../chain-draft'
import type { ChainLineOption } from '../types'
import { auditContrast } from '@/views/commute-chain/__tests__/chain-contrast'
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
import ChainsPage from '../chains.vue'

/**
 * F10's chain editor, held by BEHAVIOUR.
 *
 * 设置's 通勤链路 page is MOUNTED (see `settings-harness.ts`: Vue's runtime-core rendered into
 * plain objects, no jsdom) and driven the way a user drives it — press the control,
 * pick from the pickers, read the words and the request that comes out. What is
 * asserted is therefore what the user gets, including the rule that is easy to get
 * wrong: a bus route's stored line id has already fixed its direction, so a lesser
 * alight order is a leg entered backwards, while a subway line id carries BOTH
 * directions and the very same descending pair is a real ride.
 *
 * The contrast audit at the end is the chain page's own (`chain-contrast.ts`), pointed at
 * EVERY SFC of this screen (`SETTINGS_SFC`) rather than at this card's files alone: 12px
 * text must be readable on the surface it actually sits on — in the state it actually sits
 * there — composited from the source rather than assumed.
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

const CARD = read('../components/commute-chain-card.vue')
const FORM = read('../components/chain-form.vue')
const LEG = read('../components/chain-leg-fields.vue')
const DIALOG = read('../components/chain-removal-dialog.vue')
const DRAFT = read('../chain-draft.ts')
const TYPES = read('../types.ts')
const PATTERN = read('../../platform/components/platform-header.vue')

/** The 设置 directory (`views/settings`), walked as a directory so nothing can escape the audit. */
const SETTINGS_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Every `.vue` under a directory, subdirectories included (`__tests__` holds none). */
function sfcFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sfcFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

/**
 * The chain editor's own files: what this card's source guards read.
 *
 * The station picker it reuses (`station-pin-picker.vue`) is deliberately NOT here — it is a
 * control of the whole screen, not of this card, and it is judged where it lives: by the
 * contrast audit at the end, which runs over every SFC of this page (see `SETTINGS_SFC`).
 * Nothing in this file judges it otherwise, so a claim that these five files are its judges
 * would be false.
 */
const SFC = {
  'commute-chain-card': CARD,
  'chain-form': FORM,
  'chain-leg-fields': LEG,
  'chain-removal-dialog': DIALOG,
  // The page the editor is rendered on. It used to be 设置's one page (`index.vue`); the
  // split in §4.1 moved this card to its own page, so the page-level guards below follow it
  // there rather than judging a screen the card no longer appears on.
  'chains.vue': read('../chains.vue'),
}

/**
 * EVERY SFC of the 设置 screen — the index, the four sub-pages, and the cards they render.
 *
 * The contrast audit runs over all of them, not over the chain card's four files alone: the
 * screen is one surface, and a lightened background or a darkened text in the followed-lines
 * card, the anchors card, the hours card or the picker they share is exactly as unreadable
 * there. WALKING the directory (rather than listing files) is what keeps a page or a card
 * added later from silently escaping the rule: the split into an index plus four sub-pages
 * is exactly the change an enumeration would have let walk out of the audit's scope.
 */
const SETTINGS_SFC: Record<string, string> = Object.fromEntries(
  sfcFiles(SETTINGS_DIR).map(path => [basename(path), readFileSync(path, 'utf8')]),
)

// ---------- the lines a leg may ride ----------

function station(name: string, order: number): Record<string, unknown> {
  return { id: `${name}-${order}`, name, order, interchanges: [] }
}

/** 快线 1 路: a bus route, so its two directions are two upstream line ids. */
const BUS_UP = 'bus_027_1'
const BUS_DOWN = 'bus_027_1_rev'
/** 地铁 88 号线: ONE line id for both directions, each numbering the same stops oppositely. */
const SUBWAY = 'subway_027_88'
/**
 * 环线 3 路: a bus route whose own stop list names 东大桥 TWICE — 线上同名站不止一个
 * (PRD), which is exactly why a stop is a (name, order) PAIR and not a name.
 */
const LOOP_UP = 'bus_027_3'
const LOOP_DOWN = 'bus_027_3_rev'

const STOP_LISTS: Record<string, Record<string, unknown>[]> = {
  [`${BUS_UP}#0`]: [station('十里堡', 1), station('团结湖', 2), station('东大桥', 3), station('建国门', 4)],
  [`${BUS_DOWN}#1`]: [station('建国门', 1), station('东大桥', 2), station('团结湖', 3), station('十里堡', 4)],
  [`${SUBWAY}#0`]: [station('西直门', 1), station('车公庄', 2), station('平安里', 3)],
  [`${SUBWAY}#1`]: [station('平安里', 1), station('车公庄', 2), station('西直门', 3)],
  [`${LOOP_UP}#0`]: [station('南站', 1), station('东大桥', 2), station('北站', 3), station('东大桥', 4), station('终点站', 5)],
  [`${LOOP_DOWN}#1`]: [station('终点站', 1), station('东大桥', 2), station('北站', 3), station('东大桥', 4), station('南站', 5)],
}

/** What each direction's own board says it is heading for (「开往 X」). */
const DIRECTION_NAMES: Record<string, string> = {
  [`${BUS_UP}#0`]: '开往建国门',
  [`${BUS_DOWN}#1`]: '开往十里堡',
  [`${SUBWAY}#0`]: '开往平安里',
  [`${SUBWAY}#1`]: '开往西直门',
  [`${LOOP_UP}#0`]: '开往终点站',
  [`${LOOP_DOWN}#1`]: '开往南站',
}

const FAVOURITES = [
  {
    id: 'fav-bus-1',
    userId: 'default_user',
    cityCode: '027',
    lineId: BUS_UP,
    lineName: '快线 1 路',
    preferredDirection: 0,
    reverseLineId: BUS_DOWN,
    displayOrder: 0,
  },
  {
    id: 'fav-subway-88',
    userId: 'default_user',
    cityCode: '027',
    lineId: SUBWAY,
    lineName: '地铁 88 号线',
    preferredDirection: 0,
    // A subway reuses one line id for both ways; the direction is the stop numbering.
    reverseLineId: SUBWAY,
    displayOrder: 1,
  },
]

/** 环线 3 路, followed on its own so a repeated stop name can be picked from. */
const LOOP_FAVOURITE = {
  id: 'fav-bus-3',
  userId: 'default_user',
  cityCode: '027',
  lineId: LOOP_UP,
  lineName: '环线 3 路',
  preferredDirection: 0,
  reverseLineId: LOOP_DOWN,
  displayOrder: 2,
}

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

/** A stored chain as the API answers one: `seq` is the server's, written from the array's order. */
function stored(body: any, id: string): Record<string, unknown> {
  return {
    ...body,
    id,
    userId: 'default_user',
    createdAt: '2026-01-01T00:00:00.000Z',
    legs: (body.legs ?? []).map((leg: any, seq: number) => ({ ...leg, seq })),
  }
}

/** The one leg shape every stored chain below is built from. */
function storedLeg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId: BUS_UP,
    lineName: '快线 1 路',
    cityCode: '027',
    boardStationName: '东大桥',
    boardStationOrder: 3,
    alightStationName: '建国门',
    alightStationOrder: 4,
    transferExtraMinutes: null,
    ...overrides,
  }
}

function storedChain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chain-saved-1',
    userId: 'default_user',
    name: '早上上班',
    originAnchor: 'home',
    purpose: 'morning',
    displayOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    legs: [storedLeg({ seq: 0 })],
    ...overrides,
  }
}

/**
 * The routes 设置 talks to, with the chain collection answering whatever the test
 * supplies. Registered in order, and the LAST match wins, so a test overrides one
 * route by appending its own.
 */
function routes(options: {
  chains?: unknown[]
  chainRead?: 'ok' | 'fail'
  favourites?: unknown[]
  chainWrite?: (request: { url: string, method: string, body: any }) => unknown
  /** Routes registered last, which is what decides — used to change a default answer. */
  overrides?: Route[]
} = {}): Route[] {
  const chains = options.chains ?? []
  const table: Route[] = [
    [/\/api\/transit\/favorites$/, () => ({ success: true, data: options.favourites ?? FAVOURITES })],
    [
      /\/api\/transit\/settings/,
      () => ({
        success: true,
        data: {
          morningStart: '06:30',
          morningEnd: '11:30',
          eveningStart: '17:00',
          eveningEnd: '22:00',
        },
      }),
    ],
    [/\/api\/transit\/lines\//, lineResponder],
    [/\/api\/transit\/commute-chains\?/, () => (options.chainRead === 'fail'
      ? { success: false, error: '读取失败' }
      : { success: true, data: chains })],
    [/\/api\/transit\/commute-chains$/, (request) => {
      if (request.method !== 'POST') return { success: false, error: '不支持的请求' }
      if (options.chainWrite) return options.chainWrite(request)
      return { success: true, data: stored(request.body, 'chain-new-1') }
    }],
    [/\/api\/transit\/commute-chains\/[^/]+$/, (request) => {
      if (options.chainWrite) return options.chainWrite(request)
      const id = request.url.split('/').at(-1)!
      if (request.method === 'PATCH') return { success: true, data: stored(request.body, id) }
      return { success: true, data: { removed: true } }
    }],
    ...(options.overrides ?? []),
  ]
  return table
}

/** Mount 通勤链路's own page (`/settings/chains`) with its routes, and let the first reads answer. */
async function mountChainEditor(options: Parameters<typeof routes>[0] = {}): Promise<MountedHost> {
  // 设置 split into an index plus four pages: the chain editor is now the page at
  // `/settings/chains` (`chains.vue`), and that is what this file mounts. Every behaviour
  // asserted here is the same card's, on the page that now renders it.
  const host = await mountComponent(ChainsPage, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // reka-ui's focus scope schedules one timer as it unmounts, and that timer reads the
  // document. Let it fire while the harness's stubs are still in place, or it throws
  // into an empty global scope after the test has finished.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

// ---------- reading and driving the rendered card ----------

/** Whether a node sits inside the given subtree. */
function inside(root: HostElement, node: HostElement): boolean {
  let current: HostElement | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

/**
 * The chain card, located the way its NAME is: by the heading it is labelled by
 * (`aria-labelledby`), never by a copy of that text in an `aria-label` — the copy is what
 * makes a screen reader read 「通勤链路」 twice, once as the region and once as the heading.
 */
function cardOf(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'section' && item.props['aria-labelledby'] === 'commute-chain-heading',
    'chain card',
  )
}

function within(host: MountedHost, root: HostElement): HostElement[] {
  return host.nodes(item => inside(root, item))
}

function buttonWith(host: MountedHost, label: string): HostElement {
  const found = within(host, cardOf(host)).find(item => item.tag === 'button'
    && host.textOf(item).includes(label))
  if (!found) throw new Error(`the chain card rendered no 「${label}」 control`)
  return found
}

function legBlock(host: MountedHost, index: number): HostElement {
  return host.node(item => String(item.props['data-chain-leg']) === String(index), `第 ${index + 1} 段`)
}

function legFields(host: MountedHost, index: number): HostElement[] {
  return within(host, legBlock(host, index))
}

/**
 * The stations of one leg, as the pickers offer them: the boarding one first.
 *
 * A list that came from a FILTERING helper (this, `legFields`, `within`…) is asserted to be
 * non-empty before it is spread into another assertion or looped over: an empty list makes
 * the loop pass for free, which is exactly how two 40px controls once satisfied a 44px rule.
 * Any new check whose subjects come from filtering owes that one line first.
 */
function stationTriggers(host: MountedHost, index: number): HostElement[] {
  return legFields(host, index).filter(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))
}

/**
 * Every size the source states, variant prefixes included.
 *
 * The utility after the last `:` is the one that decides: a class rule applies to every
 * occurrence of `text-`, so `lg:text-7xl` sets a font size exactly as `text-7xl` does. The
 * pattern therefore must not require a whitespace boundary immediately before `text-`,
 * which is the only way a prefixed off-ladder size could slip through a ladder that read
 * unprefixed classes alone. Tokens that merely BEGIN with a ladder word are dropped, so a
 * colour's family (`text-slate-400`) is not read as a size — the same filter the rule had.
 */
function fontSizeTokens(source: string): string[] {
  return [...source.matchAll(/(?:^|[\s"'`:=])text-([a-z0-9[\]]+)/g)]
    .map(match => match[1]!)
    .filter(token => /^(?:xs|sm|base|lg|xl|md|[0-9])/.test(token))
}

function nameField(host: MountedHost): HostElement {
  return within(host, cardOf(host)).find(item => item.tag === 'input' && item.props.type === 'text')!
}

function extraField(host: MountedHost, index: number): HostElement {
  return legFields(host, index).find(item => item.tag === 'input' && item.props.type === 'number')!
}

function refusalText(host: MountedHost): string | null {
  const found = host.nodes(item => 'data-chain-refusal' in item.props)[0]
  return found ? host.textOf(found) : null
}

function serverErrorText(host: MountedHost): string | null {
  const found = host.nodes(item => 'data-chain-error' in item.props)[0]
  return found ? host.textOf(found) : null
}

function recordWrites(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.url.startsWith('/api/transit/commute-chains')
    && request.method !== 'GET')
}

async function openComposer(host: MountedHost): Promise<void> {
  await press(host, buttonWith(host, '新增链路'))
}

async function openEditorFor(host: MountedHost, chainName: string): Promise<void> {
  const row = host.node(item => item.tag === 'li' && host.textOf(item).includes(chainName), `the row of ${chainName}`)
  const edit = within(host, row).find(item => item.tag === 'button' && host.textOf(item).includes('编辑'))!
  await press(host, edit)
}

/**
 * Choose one of the lines the select offers, by the label the user reads on it.
 *
 * The value is read off the option the label belongs to, so the control is driven the
 * way the browser drives it rather than by this test knowing a key.
 */
async function chooseLine(host: MountedHost, index: number, label: string): Promise<void> {
  const select = legFields(host, index).find(item => item.tag === 'select')!
  const option = host.node(item => item.tag === 'option' && host.textOf(item) === label, `the option 「${label}」`)
  await choose(host, select, String(option.props.value))
}

/**
 * Pick a station through the picker's own popup, asserting the list it shows is the
 * line's own: the option is matched by the name AND the order it must carry.
 */
async function pickStation(
  host: MountedHost,
  index: number,
  which: 'board' | 'alight',
  name: string,
  order: number,
): Promise<void> {
  const triggers = stationTriggers(host, index)
  const trigger = which === 'board' ? triggers[0] : triggers[1]
  if (!trigger) throw new Error(`第 ${index + 1} 段 rendered no ${which} picker`)
  await press(host, trigger)
  const option = host.node(
    item => item.props.role === 'option' && host.textOf(item) === `${name} 第${order}站`,
    `the stop 「${name} 第${order}站」`,
  )
  await press(host, option)
}

async function save(host: MountedHost): Promise<void> {
  await press(host, buttonWith(host, '保存链路'))
}

/**
 * The leg remove control's own name: the VISIBLE label first, then the leg it removes or
 * the reason it cannot. A name that wholly replaces the visible label — 「删除该段」 on
 * screen, 「删除第 1 段」 in the name — is one a voice-control user reading the visible
 * words out cannot hit (WCAG 2.5.3 Label in Name, Level A).
 */
function removeNameText(inner: string): string {
  return `删除该段（${inner}）`
}

describe('六条规则：录入时就地拦下，不靠提交后报错', () => {
  it('公交段录反了：拒绝，句子说出方向录反了这一事实，且不发任何写请求', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    // 东大桥 is 第 3 站 and 十里堡 is 第 1 站 on this line id: a bus route's stored id has
    // already fixed the direction, so this is the pair entered the wrong way round.
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '十里堡', 1)
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的公交「快线 1 路」只沿站序递增运行：上车站「东大桥」在第 3 站、下车站「十里堡」在第 1 站，方向录反了')
    host.unmount()
  })

  it('地铁段录反了：接受，写出去的仍是下车站序小于上车站序的那一对', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    // ONE line id carries both ways, and 开往平安里 numbers 平安里 第 1 站: boarding 平安里
    // and alighting 西直门 on this list is a real ride the other way, not an entry error.
    await chooseLine(host, 0, '地铁 88 号线 · 开往平安里')
    await pickStation(host, 0, 'board', '平安里', 3)
    await pickStation(host, 0, 'alight', '西直门', 1)
    await save(host)

    expect(refusalText(host)).toBeNull()
    const posts = recordWrites(host).filter(request => request.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.legs[0]).toMatchObject({
      lineId: SUBWAY,
      boardStationName: '平安里',
      boardStationOrder: 3,
      alightStationName: '西直门',
      alightStationOrder: 1,
    })
    host.unmount()
  })

  it('上车站与下车站是同一站：拒绝', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '东大桥', 3)
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的上车站与下车站是同一站「东大桥」（第 3 站）：从一站到它自己不是乘车段')
    host.unmount()
  })

  it('半截的站点：只有站名、没有站序的记录在保存时被拒绝', async () => {
    // A record written before this editor existed (or by a direct write) can hold one
    // half of the pair, which is exactly the state the read side can only answer with
    // `station-unset` — the editor surfaces it instead, and refuses to re-save it.
    const host = await mountChainEditor({
      chains: [storedChain({ legs: [storedLeg({ seq: 0, alightStationOrder: null })] })],
    })
    await openEditorFor(host, '早上上班')
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的下车站「建国门」没有站序：站名与站序要同时选定，单独一半定位不到车站')
    host.unmount()
  })

  it('半截的站点（另一半）：只有站序、没有站名的记录在保存时同样被拒绝', async () => {
    // The mirror of the case above, which had no test of its own: the pair rule is
    // symmetric — 「站名与站序要同时选定」 — and a NUMBER without a name locates no station
    // either, so the same half-record written the other way is refused with its own
    // sentence rather than being read as a station.
    const host = await mountChainEditor({
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationName: null, boardStationOrder: 3 })] })],
    })
    await openEditorFor(host, '早上上班')
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的上车站只有第 3 站这个站序、没有站名：站名与站序要同时选定，单独一半定位不到车站')
    host.unmount()
  })

  it('站名与站序不成对：站序不在该线路的站序里，拒绝并指出是第几站', async () => {
    const host = await mountChainEditor({
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationOrder: 9 })] })],
    })
    await openEditorFor(host, '早上上班')
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的上车站「东大桥」第 9 站不在「快线 1 路 · 开往建国门」的站序里，请重新选择这一站')
    host.unmount()
  })

  it('某一段的站点还没选完：拒绝并点名是哪一段', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的下车站还没选：选完上车站与下车站才能保存')
    host.unmount()
  })

  it('没有乘车段的链路给不出结论：最后一段的删除控制说出原因，规则也拒绝空段草稿', async () => {
    const host = await mountChainEditor()
    await openComposer(host)

    const remove = within(host, legBlock(host, 0))
      .find(item => item.tag === 'button' && host.textOf(item).includes('删除该段'))!
    expect(remove.props.disabled).toBe(true)
    expect(remove.props['aria-label']).toBe(removeNameText(LAST_LEG_REASON))
    expect(remove.props.title).toBe(removeNameText(LAST_LEG_REASON))
    // The visible label is CONTAINED in the name, never replaced by it (2.5.3).
    expect(remove.props['aria-label']).toContain(host.textOf(remove))

    // The same rule, stated where the write happens: a draft with no ride leg is
    // refused rather than sent for the server to reject.
    const empty = { ...emptyChainDraft(), name: '早上上班', legs: [] }
    expect(refuseChainDraft(empty, [])).toEqual({
      legIndex: null,
      message: '链路至少需要一段乘车段：没有乘车段的链路给不出任何结论',
    })
    host.unmount()
  })

  it('两段时「删除该段」可点：它的可访问名字包含这行字，并说清删的是第几段（WCAG 2.5.3）', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await press(host, buttonWith(host, '添加乘车段'))

    const remove = within(host, legBlock(host, 1))
      .find(item => item.tag === 'button' && host.textOf(item).includes('删除该段'))!
    expect(remove.props.disabled).toBe(false)
    // 「删除该段」 is what the user reads and says out loud; the name has to contain it.
    expect(host.textOf(remove)).toBe('删除该段')
    expect(remove.props['aria-label']).toBe(removeNameText('第 2 段'))
    expect(remove.props.title).toBe(removeNameText('第 2 段'))
    host.unmount()
  })
})

describe('写出去的东西，就是 PRD 要求服务端收到的东西', () => {
  it('每段带上线路与上下车站的一对（站名 + 站序），段序就是数组顺序，且不带 seq', async () => {
    const host = await mountChainEditor({ chains: [storedChain({ displayOrder: 4 })] })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await press(host, buttonWith(host, '添加乘车段'))
    await chooseLine(host, 1, '地铁 88 号线 · 开往平安里')
    await pickStation(host, 1, 'board', '车公庄', 2)
    await pickStation(host, 1, 'alight', '平安里', 3)
    await save(host)

    const posts = recordWrites(host).filter(request => request.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('/api/transit/commute-chains')
    expect(posts[0]!.body).toEqual({
      name: '早上上班',
      originAnchor: 'home',
      purpose: 'morning',
      userId: 'default_user',
      displayOrder: 5,
      legs: [
        {
          lineId: BUS_UP,
          lineName: '快线 1 路',
          cityCode: '027',
          boardStationName: '东大桥',
          boardStationOrder: 3,
          alightStationName: '建国门',
          alightStationOrder: 4,
          transferExtraMinutes: null,
        },
        {
          lineId: SUBWAY,
          lineName: '地铁 88 号线',
          cityCode: '027',
          boardStationName: '车公庄',
          boardStationOrder: 2,
          alightStationName: '平安里',
          alightStationOrder: 3,
          transferExtraMinutes: null,
        },
      ],
    })
    host.unmount()
  })

  it('同名站在站序里出现两次时，写出去的是用户点的那一对（站名 + 站序），不是名字查回来的第一个', async () => {
    // 环线 3 路 names 东大桥 at 第 2 站 AND at 第 4 站: 线上同名站不止一个 (PRD). A choice
    // carried as a NAME alone would be resolved back with a `find(name)`, writing the
    // FIRST occurrence while the trigger displayed that same wrong pair — a pair the
    // user never picked, and one the screen would not reveal.
    const host = await mountChainEditor({ favourites: [...FAVOURITES, LOOP_FAVOURITE] })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '环线 3 路 · 开往终点站')
    await pickStation(host, 0, 'board', '东大桥', 4)
    await pickStation(host, 0, 'alight', '终点站', 5)

    // The trigger reads back exactly what was picked: 第4站, never the 第2站 a
    // name-based lookup would have found.
    const triggers = stationTriggers(host, 0)
    expect(triggers, 'the leg rendered no station pickers').toHaveLength(2)
    expect(host.textOf(triggers[0]!)).toContain('东大桥 第4站')

    // And the list's own selected state is the PAIR as well: reopening it announces only
    // 第4站 as selected. Keyed by name, both 「东大桥」 options would be announced selected.
    await press(host, triggers[0]!)
    const options = host.nodes(item => item.props.role === 'option')
      .map(item => ({ text: host.textOf(item), selected: item.props['aria-selected'] }))
    expect(options).toContainEqual({ text: '东大桥 第4站', selected: true })
    expect(options).toContainEqual({ text: '东大桥 第2站', selected: false })

    await save(host)

    const posts = recordWrites(host).filter(request => request.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.legs[0]).toMatchObject({
      lineId: LOOP_UP,
      boardStationName: '东大桥',
      boardStationOrder: 4,
      alightStationName: '终点站',
      alightStationOrder: 5,
    })
    host.unmount()
  })

  it('半截的一对在站里显示为未设置，「未设置」不冒充任何一站', async () => {
    // A stored record holding only an ORDER (name null) is not a station: the picker
    // must not render a number as if it located one.
    const host = await mountChainEditor({
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationName: null, boardStationOrder: 3 })] })],
    })
    await openEditorFor(host, '早上上班')

    const triggers = stationTriggers(host, 0)
    expect(triggers, 'the leg rendered no station pickers').toHaveLength(2)
    expect(host.textOf(triggers[0]!)).toContain('未设置')
    host.unmount()
  })

  it('transferExtraMinutes：留空是 null，填 0 就是 0 —— 两个事实不互相冒充', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await type(host, extraField(host, 0), '0')
    await save(host)

    expect(recordWrites(host)[0]!.body.legs[0].transferExtraMinutes).toBe(0)

    // The same field, cleared again: 「没配」 must not be written as 「没有额外时间」.
    const cleared = await mountChainEditor()
    await openComposer(cleared)
    await type(cleared, nameField(cleared), '早上上班')
    await chooseLine(cleared, 0, '快线 1 路 · 开往建国门')
    await pickStation(cleared, 0, 'board', '东大桥', 3)
    await pickStation(cleared, 0, 'alight', '建国门', 4)
    await type(cleared, extraField(cleared, 0), '5')
    await type(cleared, extraField(cleared, 0), '')
    await save(cleared)

    expect(recordWrites(cleared)[0]!.body.legs[0].transferExtraMinutes).toBeNull()
    host.unmount()
    cleared.unmount()
  })

  it('编辑：草稿来自已存的记录，改完之后整条链路发出去', async () => {
    const host = await mountChainEditor({
      chains: [storedChain({
        legs: [storedLeg({ seq: 0, transferExtraMinutes: 0 })],
      })],
    })
    await openEditorFor(host, '早上上班')

    // The stored draft is on screen: name, purpose, the line and both stations.
    expect(host.textOf(cardOf(host))).toContain('早上上班')
    expect(host.textOf(cardOf(host))).toContain('快线 1 路 · 开往建国门')
    expect(extraField(host, 0).props.value).toBe('0')

    await type(host, nameField(host), '早上上班（改）')
    await press(host, buttonWith(host, '保存链路'))

    const patches = recordWrites(host).filter(request => request.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.url).toBe('/api/transit/commute-chains/chain-saved-1')
    expect(patches[0]!.body.name).toBe('早上上班（改）')
    expect(patches[0]!.body.legs[0]).toMatchObject({
      boardStationName: '东大桥',
      boardStationOrder: 3,
      alightStationName: '建国门',
      alightStationOrder: 4,
      transferExtraMinutes: 0,
    })
    host.unmount()
  })

  it('编辑地铁的反向段：按站序对回它记录时用的那个方向，原样写回', async () => {
    const host = await mountChainEditor({
      chains: [storedChain({
        legs: [storedLeg({
          seq: 0,
          lineId: SUBWAY,
          lineName: '地铁 88 号线',
          boardStationName: '平安里',
          boardStationOrder: 1,
          alightStationName: '西直门',
          alightStationOrder: 3,
        })],
      })],
    })
    await openEditorFor(host, '早上上班')

    // ONE line id carries both ways, so the leg is placed on the direction whose own
    // numbering holds its orders — 开往西直门 numbers 平安里 第 1 站, while 开往平安里
    // numbers it 第 3 站. Loading it onto the other direction would silently flip the
    // ride the record was written for.
    const select = legFields(host, 0).find(item => item.tag === 'select')!
    const option = host.node(item => item.tag === 'option'
      && host.textOf(item) === '地铁 88 号线 · 开往西直门', 'the option 地铁 88 号线 · 开往西直门')
    expect(select.props.value).toBe(option.props.value)

    await press(host, buttonWith(host, '保存链路'))

    const patches = recordWrites(host).filter(request => request.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.body.legs[0]).toMatchObject({
      lineId: SUBWAY,
      boardStationOrder: 1,
      alightStationOrder: 3,
    })
    host.unmount()
  })

  it('删除：确认之后删掉那条记录，列表里不再有它', async () => {
    const host = await mountChainEditor({ chains: [storedChain()] })
    await press(host, buttonWith(host, '删除'))
    expect(host.text()).toContain('删除通勤链路「早上上班」？')

    await press(host, host.node(item => item.tag === 'button' && host.textOf(item) === '确认删除', 'the confirm control'))

    const deletes = recordWrites(host).filter(request => request.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toBe('/api/transit/commute-chains/chain-saved-1')
    expect(host.text()).not.toContain('删除通勤链路「早上上班」？')
    host.unmount()
  })
})

describe('服务端拒绝时如实报错', () => {
  it('把 400 的消息原样显示，表单不关、列表不变', async () => {
    const host = await mountChainEditor({
      chains: [storedChain()],
      chainWrite: () => httpStatus(400, { success: false, error: '下车站的站序必须大于上车站的站序' }),
    })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await save(host)

    expect(host.text()).toContain('下车站的站序必须大于上车站的站序')
    expect(serverErrorText(host)).toBe('下车站的站序必须大于上车站的站序')
    // The form is still open with the draft in it, so nothing typed has to be typed again.
    expect(nameField(host)).toBeDefined()
    expect(refusalText(host)).toBeNull()
    host.unmount()
  })
})

describe('说过的句子不会留在原地，说着用户已经离开的状态', () => {
  it('照着拒绝的话改完下车站，那句拒绝就消失（屏幕已经在它说的状态之外了）', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await save(host)
    expect(refusalText(host)).toBe('第 1 段的下车站还没选：选完上车站与下车站才能保存')

    // The user does exactly what the sentence asked. The alight picker now reads
    // 「建国门 第4站」, so the sentence is no longer true of anything on screen — and a
    // message that outlives its state is a claim about a screen the user has left.
    await pickStation(host, 0, 'alight', '建国门', 4)
    expect(host.textOf(stationTriggers(host, 0)[1]!)).toContain('建国门 第4站')
    expect(refusalText(host)).toBeNull()

    // And the next save attempt is still judged: a real problem is stated again.
    await save(host)
    expect(refusalText(host)).toBeNull()
    host.unmount()
  })

  it('服务端拒绝之后改了草稿，那条服务端的消息也消失（它说的是改动前的草稿）', async () => {
    const host = await mountChainEditor({
      chains: [storedChain()],
      chainWrite: () => httpStatus(400, { success: false, error: '下车站的站序必须大于上车站的站序' }),
    })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await save(host)
    expect(serverErrorText(host)).toBe('下车站的站序必须大于上车站的站序')

    await type(host, nameField(host), '早上上班（改）')
    expect(serverErrorText(host)).toBeNull()
    host.unmount()
  })
})

describe('空状态与读取失败是两个原因，谁也不遮住谁', () => {
  it('读不到时说读取失败并给出重试，不说「还没有录入」', async () => {
    const host = await mountChainEditor({ chainRead: 'fail' })

    expect(host.textOf(cardOf(host))).toContain('换乘链读取失败')
    expect(host.textOf(cardOf(host))).not.toContain('还没有录入通勤链路')
    expect(buttonWith(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('读失败之后按重试：读到就把行显示出来，失败的那条说明消失', async () => {
    const host = await mountChainEditor({ chainRead: 'fail' })
    expect(host.textOf(cardOf(host))).toContain('换乘链读取失败')

    host.server.on(/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [storedChain()] }))
    await press(host, buttonWith(host, '重试'))

    expect(host.textOf(cardOf(host))).toContain('早上上班')
    expect(host.textOf(cardOf(host))).not.toContain('换乘链读取失败')
    host.unmount()
  })

  it('回答是空列表时，说「还没有录入」并指出下一步', async () => {
    const host = await mountChainEditor()

    expect(host.textOf(cardOf(host))).toContain('还没有录入通勤链路')
    expect(host.textOf(cardOf(host))).toContain('新增链路')
    host.unmount()
  })

  it('没有关注线路时，录入里说明这一原因，而不是给一个永远选不出东西的线路列表', async () => {
    const host = await mountChainEditor({ favourites: [] })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')

    expect(host.textOf(cardOf(host))).toContain('还没有关注线路，无法录入乘车段')
    expect(host.nodes(item => item.tag === 'option' && item.props.value !== '')).toHaveLength(0)
    host.unmount()
  })
})

describe('房子里的结构规则', () => {
  it('链路录入是设置里「通勤链路」页上的一张卡片，不是新的一级页面（一条注册表规则：路由是数据；形状换了，规则没换）', () => {
    // 设置 used to be one 841-line page, and this card sat on it. §4.1 split that page into
    // an index plus four sub-pages, so the card now sits on `chains.vue` — the page at
    // `/settings/chains`. What this test holds did not change with the shape: recording a
    // chain is NOT a first-level entry beside 换乘链路, whose page only reads conclusions.
    // The split itself is asserted too, because a card left behind on the index would keep
    // this rule green while the four domains were still crammed into one screen.
    expect(codeOf(read('../chains.vue'))).toContain('<CommuteChainCard')
    expect(codeOf(read('../index.vue'))).not.toContain('<CommuteChainCard')
    expect(codeOf(read('../index.vue'))).not.toContain('<LineOrderList')
    expect(codeOf(read('../index.vue'))).not.toContain('<AnchorPicker')
    const router = codeOf(read('../../../router/index.ts'))
    expect(router).toContain(`path: '/settings'`)
    expect(router).toContain(`path: 'chains'`)
    expect(router).not.toContain('commute-chain-editor')
  })

  it('不承诺产品做不到的事：录入界面的文案里没有自动规划、路线推荐或对永久原因的「稍后再试」（一条关于文案的源码规则）', () => {
    for (const [name, source] of Object.entries({ ...SFC, 'chain-draft': DRAFT, 'types': TYPES })) {
      const code = codeOf(source)
      for (const claim of ['自动规划', '自动生成链路', '推荐路线', '稍后再试', '保证能赶上', '一定能赶上']) {
        expect(code, `${name} promises 「${claim}」`).not.toContain(claim)
      }
    }
  })

  it('字号只走偶数阶梯（一条词法规则：阶梯写在类名里，带变体前缀的也一样算）', () => {
    // The pattern reads the utility after the last `:`, so a prefixed size counts — this is
    // the line that keeps `lg:text-7xl` from slipping past a ladder that only read
    // unprefixed classes. Both directions are stated: a prefixed off-ladder size is caught,
    // and a colour (which merely starts with a ladder word) is not read as a size.
    expect(fontSizeTokens('<span class="lg:text-7xl">')).toEqual(['7xl'])
    // A colour is not a size however it is prefixed: the ladder reads only the families a
    // font-size utility can begin with, so the candidates are the size tokens alone.
    expect(fontSizeTokens('<span class="hover:text-slate-400 text-base md:text-xs">')).toEqual(['base', 'xs'])

    const allowed = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'])
    for (const [name, source] of Object.entries(SFC)) {
      const code = codeOf(source)
      expect(code, `${name} uses an arbitrary font size`).not.toContain('text-[')
      for (const token of fontSizeTokens(code)) {
        expect(allowed.has(token), `${name} uses text-${token}`).toBe(true)
      }
    }
  })

  it('触控目标不小于 44px（房子约定）', async () => {
    const host = await mountChainEditor({ chains: [storedChain()] })
    await openComposer(host)
    // A line has to be chosen for the two pickers to exist at all: without one the list
    // below would carry no picker and the loop would pass over nothing, which is how two
    // 40px controls once satisfied a 44px rule.
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    const pickers = stationTriggers(host, 0)
    expect(pickers, 'the pickers are rendered, or this check has no picker to measure').toHaveLength(2)
    const controls = [
      buttonWith(host, '新增链路'),
      buttonWith(host, '保存链路'),
      buttonWith(host, '取消'),
      buttonWith(host, '添加乘车段'),
      buttonWith(host, '删除该段'),
      legFields(host, 0).find(item => item.tag === 'select')!,
      extraField(host, 0),
      ...pickers,
    ]
    expect(controls.length).toBeGreaterThan(pickers.length)
    for (const control of controls) {
      const classes = String(control.props.class ?? '')
      expect(classes, `${control.tag} is smaller than the house touch target: ${classes}`)
        .toMatch(/min-h-\[44px\]|min-h-11|h-11/)
    }
    host.unmount()
  })

  it('文字在它真正合成的背景上可读（12px 也要 4.5:1）——整张设置页都在检查范围内', () => {
    // EVERY SFC of this screen, the followed-lines rows and the reused pickers included: a
    // rule that only read the chain card's files let a regression ship anywhere else on it.
    for (const name of ['index.vue', 'lines.vue', 'schedule.vue', 'anchors.vue', 'chains.vue',
      'back-to-settings.vue', 'anchor-picker.vue', 'commute-hours-card.vue',
      'commute-hours-form.vue', 'station-pin-picker.vue', 'line-order-list.vue', 'removal-dialog.vue']) {
      expect(Object.keys(SETTINGS_SFC), `${name} is not audited`).toContain(name)
    }

    const audit = auditContrast(SETTINGS_SFC)
    expect(audit.pairs.length).toBeGreaterThan(0)
    expect(audit.violations).toEqual([])

    // A translucent text colour is measured too — composited over the surface it sits on,
    // which is the only way `text-sky-400/80` can be read at all. A colour the audit skips
    // is a colour nothing guards, and this screen paints one.
    const translucent = audit.pairs.filter(pair => pair.textToken === 'text-sky-400/80')
    expect(translucent, 'the translucent developer-mode note is audited').not.toHaveLength(0)
    expect(translucent.every(pair => pair.ratio >= 4.5), 'its composite is readable').toBe(true)
  })

  it('配对只看同一状态：hover 的文字不跟没加 hover 的背景相乘，真实的那一对反而要审到', () => {
    const audit = auditContrast(SETTINGS_SFC)

    // Every pair is one the screen can actually draw: the surface may only carry states the
    // text it is paired with also carries. The cross-product this audit used to do paired
    // `hover:text-slate-950` with the button's base `bg-slate-800` (1.38:1) and `text-slate-200`
    // with `hover:bg-cyan-500` (1.97:1) — neither can co-occur on screen, so both are refuted
    // by the pair the state actually draws.
    const impossible = audit.pairs
      .filter(pair => !pair.surface.variants.every(variant => pair.textVariants.includes(variant)))
      .map(pair => `${pair.source} ${pair.textToken} on ${pair.surface.hex} [${pair.surface.layers.join(' over ')}]`)
    expect(impossible).toEqual([])

    // The 关注 button lifts to bg-cyan-500 and darkens its text in the same state: TWO states,
    // 11.87:1 and 8.31:1. Both are audited; nothing else about that button is.
    //
    // It is identified by its OWN two classes rather than by being the first match for one of
    // them: the button moved to `lines.vue` when 设置 was split, and which file the walk of
    // this directory reaches first is not something this assertion may depend on.
    const onButton = audit.pairs.filter(pair =>
      pair.element.includes('bg-slate-800') && pair.element.includes('hover:bg-cyan-500'))
    const base = onButton.find(pair => pair.textToken === 'text-slate-200')
    expect(base, 'the button\'s base text is audited against its base surface').toBeDefined()
    expect(base!.surface.layers).toContain('bg-slate-800')
    expect(base!.ratio).toBeCloseTo(11.87, 1)

    const hover = onButton.find(pair => pair.textToken === 'hover:text-slate-950')
    expect(hover, 'the button\'s hover text is audited against its HOVER surface').toBeDefined()
    expect(hover!.surface.layers).toContain('hover:bg-cyan-500')
    expect(hover!.ratio).toBeCloseTo(8.31, 1)
  })

  it('添加乘车段的边界与本版一致：到上限的按钮禁用，并在原地说明这是首版的边界', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await press(host, buttonWith(host, '添加乘车段'))

    expect(host.nodes(item => item.props['data-chain-leg'] !== undefined)).toHaveLength(2)
    const add = host.node(item => item.tag === 'button'
      && host.textOf(item).includes('首版一条链路最多 2 段乘车'), 'the add control at its limit')
    expect(add.props.disabled).toBe(true)
    host.unmount()
  })

  it('更换线路会清空该段的上下车站，并说明原因：站序属于一条线路', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await chooseLine(host, 0, '地铁 88 号线 · 开往平安里')

    expect(host.textOf(cardOf(host))).toContain('更换线路后已清空这一段的上车站与下车站')
    expect(host.textOf(stationTriggers(host, 0)[0]!)).toContain('未设置')
    host.unmount()
  })

  it('站点只从该线路的站序列表里选：段里没有手输站名的地方，列表就是那条线路的站序', async () => {
    const host = await mountChainEditor()
    await openComposer(host)
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    // No text field in a leg at all: a hand-typed name is a station nobody can locate,
    // which is why the pair is picked from the line's own list and never typed.
    expect(legFields(host, 0).filter(item => item.tag === 'input').map(item => item.props.type))
      .toEqual(['number'])

    // Two pickers over the SAME stop list, so each carries the name that tells it from
    // the other one for a screen reader: 「上车站」 is not 「下车站」.
    expect(stationTriggers(host, 0).map(item => item.props['aria-label']))
      .toEqual(['上车站', '下车站'])

    await press(host, stationTriggers(host, 0)[0]!)

    expect(host.nodes(item => item.props.role === 'option').map(item => host.textOf(item)))
      .toEqual(['十里堡 第1站', '团结湖 第2站', '东大桥 第3站', '建国门 第4站'])
    host.unmount()
  })

  it('未选线路的段说明下一步，而不是摆出一对空的组合框', async () => {
    const host = await mountChainEditor()
    await openComposer(host)

    expect(host.textOf(legBlock(host, 0))).toContain('请先选择线路与方向，再从它的站序里选上车站与下车站')
    expect(stationTriggers(host, 0)).toHaveLength(0)
    host.unmount()
  })

  it('站点还没读到：说的是「还没读到、要等它出现」，不是「暂无站点数据」（两种事实两句话）', async () => {
    // The read never answers — the request itself fails — so the list is empty because
    // nothing has been read, NOT because this direction has no stops. 「暂无站点数据」 would
    // be a claim about the upstream that nobody has made, and waiting is still exactly what
    // the user can do.
    const host = await mountChainEditor({
      overrides: [[/\/api\/transit\/lines\//, () => { throw new Error('offline') }]],
    })
    await openComposer(host)
    await type(host, nameField(host), '早上上班')
    // The option names the direction by its number: the 「开往 X」 label comes from the very
    // read that has not answered, so a terminus nobody reported must not be invented.
    await chooseLine(host, 0, '快线 1 路 · 方向 0')

    const leg = host.textOf(legBlock(host, 0))
    expect(leg).toContain('「快线 1 路 · 方向 0」的站点还没读到：这一段的上下车站要等它出现才能选')
    expect(leg).not.toContain('暂无站点数据')
    expect(stationTriggers(host, 0)).toHaveLength(0)

    await save(host)
    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的「快线 1 路 · 方向 0」的站点还没读到：这一段的上下车站要等它出现才能选')
    host.unmount()
  })

  it('读不到线路站点时，说的是站点数据不到，而不是让人一直等（一条关于原因与它的措辞的规则）', async () => {
    // The API answers for this direction and lists no stops at all: a state that will
    // never become a list, so the copy must not read as 「还在读取」.
    const host = await mountChainEditor({
      overrides: [[/\/api\/transit\/lines\//, request => ({
        success: true,
        data: {
          lineId: 'bus_027_1',
          direction: Number(/direction=(\d)/.exec(request.url)?.[1] ?? 0),
          directionName: '开往建国门',
          cityCode: '027',
          stops: [],
        },
      })]],
    })
    await openComposer(host)
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    expect(host.textOf(legBlock(host, 0))).toContain('暂无站点数据')
    expect(host.textOf(legBlock(host, 0))).not.toContain('还在读取')
    expect(stationTriggers(host, 0)).toHaveLength(0)
    host.unmount()
  })

  it('已不再关注的线路不会被悄悄换掉：它在选项里说明自己不在关注列表，并拒绝保存', async () => {
    // The stored chain rides 快线 1 路, which is no longer followed: its stop list cannot
    // be read at all, so the pair cannot be verified — which is exactly what the save
    // must say instead of re-numbering the leg onto some other line.
    const host = await mountChainEditor({
      favourites: [FAVOURITES[1]!],
      chains: [storedChain()],
    })
    await openEditorFor(host, '早上上班')
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的「快线 1 路」已不在关注线路里，它的站序无从核对，请重新选择线路')
    host.unmount()
  })

  it('已不再关注的公交线，选项说的是「站序未知」：公交线 id 已经把方向定死，说方向未知是说过头了', async () => {
    const host = await mountChainEditor({
      favourites: [FAVOURITES[1]!],
      chains: [storedChain()],
    })
    await openEditorFor(host, '早上上班')

    const options = host.nodes(item => item.tag === 'option').map(item => host.textOf(item))
    expect(options).toContain('快线 1 路 · 站序未知')
    expect(options, 'a stored bus id fixes the direction, so claiming it is unknown overstates')
      .not.toContain('快线 1 路 · 方向未知')
    host.unmount()
  })

  it('已不再关注的地铁线，选项说的是「方向未知」：一个 id 带两个方向，方向确实读不出来', async () => {
    const host = await mountChainEditor({
      favourites: [FAVOURITES[0]!],
      chains: [storedChain({
        legs: [storedLeg({
          seq: 0,
          lineId: SUBWAY,
          lineName: '地铁 88 号线',
          boardStationName: '平安里',
          boardStationOrder: 1,
          alightStationName: '西直门',
          alightStationOrder: 3,
        })],
      })],
    })
    await openEditorFor(host, '早上上班')

    const options = host.nodes(item => item.tag === 'option').map(item => host.textOf(item))
    expect(options).toContain('地铁 88 号线 · 方向未知')
    host.unmount()
  })

  it('线路是在哪里选的，就在那里说明列表来自关注线路：不等到它绑住手才说', async () => {
    // Only the followed routes are offered, so an unfollowed line is simply absent from the
    // select — and in the steady state nothing else on the screen would say why. The cost is
    // stated where the choice is made, not only when it binds.
    const host = await mountChainEditor()
    await openComposer(host)

    const sentence = '列表来自你关注的线路：没关注的线路要先关注，才能在这里选它的站序'
    expect(host.textOf(legBlock(host, 0))).toContain(sentence)
    host.unmount()
  })

  it('卡片由它自己的标题命名：名字只念一次（aria-labelledby，不是重复一遍的 aria-label）', async () => {
    const host = await mountChainEditor()

    const card = cardOf(host)
    expect(card.props['aria-label']).toBeUndefined()
    const labelled = card.props['aria-labelledby']
    const heading = host.node(item => item.props.id === labelled, 'the heading the card is named by')
    expect(host.textOf(heading)).toBe('通勤链路')
    host.unmount()
  })
})

describe('规则模块本身', () => {
  /** One line+direction option, so a rule about the options can be read without mounting. */
  function option(overrides: Partial<ChainLineOption> = {}): ChainLineOption {
    return {
      key: 'fav-bus-1_0',
      direction: 0,
      lineId: BUS_UP,
      lineName: '快线 1 路',
      cityCode: '027',
      directionLabel: '开往建国门',
      stations: STOP_LISTS[`${BUS_UP}#0`] as never,
      stops: 'ready',
      ...overrides,
    }
  }

  it('选项的名字只写知道的事：开往 X / 方向 N / 方向未知 / 站序未知（一条关于措辞的单元规则）', () => {
    expect(lineOptionLabel(option())).toBe('快线 1 路 · 开往建国门')
    // An upstream that stated no terminus has stated none: the number is the only fact the
    // option still holds, so it is what the label says.
    expect(lineOptionLabel(option({ directionLabel: null }))).toBe('快线 1 路 · 方向 0')
    // A subway reuses ONE id for both directions, so a stored subway line's direction is
    // genuinely unknowable — that is what 方向未知 is for.
    expect(lineOptionLabel(option({ direction: null, directionLabel: null, lineId: SUBWAY, lineName: '地铁 88 号线' })))
      .toBe('地铁 88 号线 · 方向未知')
    // A bus route's two directions are two ids, so the stored id has already fixed which way
    // the leg runs: calling the direction unknown would overstate. What cannot be read is the
    // STOP LIST, and that is what the label says.
    expect(lineOptionLabel(option({ direction: null, directionLabel: null }))).toBe('快线 1 路 · 站序未知')
  })

  it('空段草稿与空名字都被拒绝，且句子说的是事实（一条关于规则的单元规则）', () => {
    const lines = [
      {
        key: 'fav-bus-1_0',
        direction: 0 as const,
        lineId: BUS_UP,
        lineName: '快线 1 路',
        cityCode: '027',
        directionLabel: '开往建国门',
        stations: STOP_LISTS[`${BUS_UP}#0`] as never,
        stops: 'ready' as const,
      },
    ]
    expect(refuseChainDraft(emptyChainDraft(), lines)).toEqual({
      legIndex: null,
      message: '请先给这条链路起个名字',
    })

    const halfFilled = { name: '早上上班', originAnchor: 'home' as const, purpose: 'morning' as const, legs: [{ ...emptyLegDraft(), lineKey: 'fav-bus-1_0', boardStationName: '东大桥' }] }
    expect(refuseChainDraft(halfFilled, lines)?.message)
      .toBe('第 1 段的上车站「东大桥」没有站序：站名与站序要同时选定，单独一半定位不到车站')
  })

  it('有界的选择用房子里已有的控件：平台页用的原生 select，加房子自己的站点组合框，不手搓（一条关于控件选择的源码规则）', () => {
    expect(codeOf(LEG)).toContain('<select')
    expect(codeOf(PATTERN)).toContain('<select')
    expect(codeOf(LEG)).toContain('StationPinPicker')
  })
})
