import { readFileSync, readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LAST_LEG_REASON,
  MAX_CHAIN_LEGS,
  emptyChainDraft,
  emptyLegDraft,
  lineOptionLabel,
  orderedLineOptionsFor,
  refuseChainDraft,
} from '../../../views/settings/chain-draft'
import type { ChainLineOption } from '../../../views/settings/types'
import { auditContrast } from '@/__tests__/views/commute-chain/chain-contrast'
import {
  RouterLinkStub,
  httpStatus,
  mountComponent,
  press,
  type,
  type HostElement,
  type MountedHost,
  type Route,
} from './settings-harness'
import ChainsListPage from '../../../views/settings/chains.vue'
import ChainEditorPage from '../../../views/settings/chain-editor.vue'

/**
 * 推出去的那句话。链路卡的三处写操作（保存、删除、顺序）成与败各说一句，由本文件末尾那一组评判；
 * 其余用例不读它。
 */
const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string) => {
      pushed.push(message)
      return pushed.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

beforeEach(() => {
  pushed.length = 0
})

/**
 * F10 的链路编辑器，由**行为**守住。
 *
 * `设置` 的通勤链路页被**挂载**（见 `settings-harness.ts`：Vue 的 runtime-core 渲染为普通对象，
 * 无 jsdom）并按用户驱动它的方式驱动——按控件、从选择器里挑、读印出的文字与发出的请求。故被断言的是
 * 用户得到的东西，包括那条容易弄错的规则：公交线路已存的 id 已固定其方向，故更小的下车站序是录反的段，
 * 而地铁线路 id 同时携带**两个**方向，同样降序的一对是真实可乘的一程。
 *
 * 末尾的对比度审计是链路页自己的（`chain-contrast.ts`），指向本屏的**每个** SFC（`SETTINGS_SFC`）
 * 而非仅这张卡的文件：12px 文字必须在它**真正**所在的表面上、真正所在的状态下可读——由源码合成而非假定。
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

const FORM = read('../../../views/settings/components/chain-form.vue')
const LEG = read('../../../views/settings/components/chain-leg-fields.vue')
const DIALOG = read('../../../views/settings/components/chain-removal-dialog.vue')
const DRAFT = read('../../../views/settings/chain-draft.ts')
const TYPES = read('../../../views/settings/types.ts')
const PATTERN = read('../../../views/platform/components/platform-header.vue')
/** 本屏的选站器：它自己不再画标记，选单来自共用的控件（见下面那条控件选择的源码规则）。 */
const PICKER = read('../../../views/settings/components/station-pin-picker.vue')

/** 设置目录（`views/settings`），按目录遍历，使任何东西都逃不出审计。 */
const SETTINGS_DIR = fileURLToPath(new URL('../../../views/settings', import.meta.url))

/**
 * 本应用生产源码的根（`apps/web/src`）。
 * 控件选择的规则扫的是**整个应用**，而不是本目录：一处原生 select 在哪都算。
 */
const WEB_SRC = fileURLToPath(new URL('../../../', import.meta.url))

/** 某目录下每个 `.vue`，含子目录（`__tests__` 不含）。 */
function sfcFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sfcFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

/**
 * 链路编辑器自己的文件：本卡源码守卫所读的东西。
 *
 * 它复用的选站器（`station-pin-picker.vue`）刻意**不**在此——它是整个屏幕的控件而非本卡的，
 * 它在它所处之处被评判：末尾跑遍本页每个 SFC 的对比度审计。本文件不以其他方式评判它。
 */
const SFC = {
  'chain-form': FORM,
  'chain-leg-fields': LEG,
  'chain-removal-dialog': DIALOG,
  // 渲染列表的页面与渲染编辑器的页面。列表页曾是卡片所在的屏幕；「列表页 + 独立编辑页」把
  // 编辑器移到 `chain-editor.vue`，故下面的页级守卫随它到那里 —— 两页都在守卫范围内，
  // 评判一个表单已经不再出现的屏幕，或放过表单现在所在的那一页，都会让回归漏掉。
  'chains.vue': read('../../../views/settings/chains.vue'),
  'chain-editor.vue': read('../../../views/settings/chain-editor.vue'),
}

/**
 * `设置` 屏的**每个** SFC——索引、四个子页面、以及它们渲染的卡片。
 *
 * 对比度审计跑遍它们全部，而非仅链路卡那四个文件：整个屏幕是一个表面，关注线路卡、锚点卡、时段卡
 * 或它们共用的选择器里被提亮的背景或被压暗的文字，在那里同样不可读。**遍历**目录（而非列出文件）
 * 使日后新增的页面或卡片无法静默逃出该规则——拆成索引加四个子页面正是一个枚举会让其走出审计范围的改动。
 */
const SETTINGS_SFC: Record<string, string> = {
  ...Object.fromEntries(
    sfcFiles(SETTINGS_DIR).map(path => [basename(path), readFileSync(path, 'utf8')]),
  ),
  /**
   * 本屏共用的选站器控件住在 `src/components`（站台屏也用同一个），故它自己的标记也要被审计：
   * 把标记搬出本目录，同时把它的颜色带出审计范围，是这次归一唯一会削弱的东西。
   */
  'searchable-combobox/main.vue': readFileSync(
    fileURLToPath(new URL('../../../components/searchable-combobox/main.vue', import.meta.url)),
    'utf8',
  ),
}

// ---------- 一段可以乘坐的线路 ----------

function station(name: string, order: number): Record<string, unknown> {
  return { id: `${name}-${order}`, name, order, interchanges: [] }
}

/** 快线 1 路：一条公交线路，故其两个方向是两个上游线路 id。 */
const BUS_UP = 'bus_027_1'
const BUS_DOWN = 'bus_027_1_rev'
/** 地铁 88 号线：两个方向共**一个**线路 id，各自反向编号同一批站。 */
const SUBWAY = 'subway_027_88'
/**
 * 环线 3 路：一条自身站表把 东大桥 列了**两次**的公交线路——线上同名站不止一个（PRD），
 * 这正是站是 (站名, 站序) **一对**而非一个名字的原因。
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

/** 每个方向自己的报告板说它开往何处（「开往 X」）。 */
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
    // 地铁两个方向共用一个线路 id；方向就是站序编号。
    reverseLineId: SUBWAY,
    displayOrder: 1,
  },
]

/** 环线 3 路，单独关注它以便可以从重复的站名中挑选。 */
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

/**
 * 关注线路，其中**一条**声明过上下班方向：快线 1 路 的方向 1 是上班方向、方向 0 是下班方向
 * ——两个字段都是使用者在详情页设上车点时落下的。地铁 88 号线 什么都没声明：
 * 它的两个方向因此一个标识都不该有（系统不替他判断他往哪边走）。
 */
const DECLARED_FAVOURITES = [
  { ...FAVOURITES[0]!, morningDirection: 1, eveningDirection: 0 },
  FAVOURITES[1]!,
]

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

/** 一条已存链路，如 API 所答：`seq` 是服务端的，按数组顺序写入。 */
function stored(body: any, id: string): Record<string, unknown> {
  return {
    ...body,
    id,
    userId: 'default_user',
    createdAt: '2026-01-01T00:00:00.000Z',
    legs: (body.legs ?? []).map((leg: any, seq: number) => ({ ...leg, seq })),
  }
}

/** 下面每条已存链路所依据的唯一段形状。 */
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
    purpose: 'morning',
    displayOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    legs: [storedLeg({ seq: 0 })],
    ...overrides,
  }
}

/**
 * `设置` 所对话的路由，其中链路集合应答测试提供的任何内容。按顺序注册，**最后**匹配者胜出，
 * 故测试通过追加自己的路由来覆盖某一条。
 */
function routes(options: {
  chains?: unknown[]
  chainRead?: 'ok' | 'fail'
  favourites?: unknown[]
  chainWrite?: (request: { url: string, method: string, body: any }) => unknown
  /** 最后注册的路由，即起决定作用的那个——用于改变默认答案。 */
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

/**
 * 挂载**新建链路页**（`/settings/chains/new`）及其路由，并让首批读取作答。
 *
 * 「列表页 + 独立编辑页」把表单从列表行里搬到了这一页上：本文件评判的每个行为一字未改，
 * 变的只是它挂在哪一页 —— 以及驱动方式（没有展开这一步了，表单挂载出来就在）。
 */
async function mountChainEditor(options: Parameters<typeof routes>[0] = {}): Promise<MountedHost> {
  return mountChainEditorFor(null, options)
}

/**
 * 挂载**一条链路自己的页面**（`/settings/chains/:chainId`），按那条链路在已存列表里的 id。
 *
 * id 从测试自己给的那份列表里取，而不是写死一个：同一条路由记录上的两页共用同一个组件，
 * 故「编的是哪一条」正是由传进去的那个 id 决定的。
 */
async function mountChainEditorFor(
  chainName: string | null,
  options: Parameters<typeof routes>[0] = {},
): Promise<MountedHost> {
  const rows = (options.chains ?? []) as Array<{ id?: string, name?: string }>
  const row = chainName === null ? null : rows.find(item => item.name === chainName)
  if (chainName !== null && !row?.id) throw new Error(`no stored chain named 「${chainName}」 in this fixture`)
  const host = await mountComponent(ChainEditorPage, {
    props: { chainId: row?.id ?? null },
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 挂载**列表页**（`/settings/chains`）：列表、拖动排序与「新增链路」都在这一页上。 */
async function mountChainList(options: Parameters<typeof routes>[0] = {}): Promise<MountedHost> {
  const host = await mountComponent(ChainsListPage, {
    routes: routes(options),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

afterEach(async () => {
  // reka-ui 的焦点作用域在卸载时排定一个定时器，而该定时器会读 document。
  // 让它在装置的桩件仍就位时触发，否则它会在测试结束后抛进空的全局作用域。
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

// ---------- 读取与驱动渲染出的卡片 ----------

/** 某节点是否位于给定的子树内。 */
function inside(root: HostElement, node: HostElement): boolean {
  let current: HostElement | null = node
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

/**
 * 列表页的区域，按其**名字**定位：按标注它的标题（`aria-labelledby`），绝非按 `aria-label` 里
 * 该文本的副本 —— 正是那个副本让屏幕阅读器把「通勤链路」读两遍，一次作为区域、一次作为标题。
 */
function chainSection(host: MountedHost): HostElement {
  return host.node(
    item => item.tag === 'section' && item.props['aria-labelledby'] === 'commute-chain-heading',
    'chain section',
  )
}

function within(host: MountedHost, root: HostElement): HostElement[] {
  return host.nodes(item => inside(root, item))
}

/**
 * 某个控件，按它印出的文字。
 *
 * 搜索范围是**整页**（含 portal 里的弹层），而不是某一处区域：这些控件分布在不同块里，而按区域
 * 收窄会让一个搬到别处的控件静默地「不存在」。代价是标签必须足够独特 —— 下面用的标签都够
 * （「删除链路」不是「删除该段」，「保存链路」不是任何别的东西）。
 */
function buttonWith(host: MountedHost, label: string): HostElement {
  const found = host.nodes(item => item.tag === 'button' && host.textOf(item).includes(label))[0]
  if (!found) throw new Error(`the page rendered no 「${label}」 control`)
  return found
}

function legBlock(host: MountedHost, index: number): HostElement {
  return host.node(item => String(item.props['data-chain-leg']) === String(index), `第 ${index + 1} 段`)
}

function legFields(host: MountedHost, index: number): HostElement[] {
  return within(host, legBlock(host, index))
}

/**
 * 某一段的三个下拉触发器，按屏上先后：线路与方向、上车站、下车站。
 *
 * 线路与方向那个是**同一个**共用控件（只是不带搜索框），故它和两个站选择器一样，带的是 reka 触发器
 * 自己那个 `aria-expanded`。
 */
function comboTriggers(host: MountedHost, index: number): HostElement[] {
  return legFields(host, index).filter(item => item.tag === 'button'
    && (item.props.role === 'combobox' || item.props['aria-expanded'] !== undefined))
}

/** 本段「线路与方向」下拉的触发器，也是段里三个下拉中最先出现的那个。 */
function lineTrigger(host: MountedHost, index: number): HostElement {
  const found = comboTriggers(host, index)[0]
  if (!found) throw new Error(`第 ${index + 1} 段 rendered no 线路与方向 picker`)
  return found
}

/**
 * 某段的两个站选择器，上车站在前——线路与方向那个下拉在它们之前，不算在内。
 *
 * 来自**筛选** helper 的列表（本函数、`legFields`、`within`……）在被展开进另一个断言或循环之前先断言
 * 非空：空列表会让循环白通过，正是两个 40px 控件曾满足 44px 规则的方式。任何主题来自筛选的新检查都先欠这一行。
 */
function stationTriggers(host: MountedHost, index: number): HostElement[] {
  return comboTriggers(host, index).slice(1)
}

/**
 * 源码陈述的每个尺寸，含变体前缀。
 *
 * 最后一个 `:` 之后的工具类才起决定作用：一条类规则适用于每次出现 `text-` 之处，故 `lg:text-7xl` 与
 * `text-7xl` 一样设定字号。因此模式不得要求 `text-` 之前紧邻空白边界，否则带前缀的阶梯外尺寸就能溜过
 * 一个只读无前缀类的阶梯。仅以阶梯词**开头**的 token 被丢弃，故颜色家族（`text-slate-400`）不会被读成
 * 尺寸——与该规则原有的过滤一致。
 */
function fontSizeTokens(source: string): string[] {
  return [...source.matchAll(/(?:^|[\s"'`:=])text-([a-z0-9[\]]+)/g)]
    .map(match => match[1]!)
    .filter(token => /^(?:xs|sm|base|lg|xl|md|[0-9])/.test(token))
}

/** 表单里的名称字段——本页唯一的文本输入框。 */
function nameField(host: MountedHost): HostElement {
  return host.nodes(item => item.tag === 'input' && item.props.type === 'text')[0]!
}

function extraField(host: MountedHost, index: number): HostElement {
  return legFields(host, index).find(item => item.tag === 'input' && item.props.type === 'number')!
}

function refusalText(host: MountedHost): string | null {
  const found = host.nodes(item => 'data-chain-refusal' in item.props)[0]
  return found ? host.textOf(found) : null
}

function recordWrites(host: MountedHost): Array<{ url: string, method: string, body: any }> {
  return host.server.requests.filter(request => request.url.startsWith('/api/transit/commute-chains')
    && request.method !== 'GET')
}

/**
 * 从线路与方向的下拉里选一条，按用户读到的标签。
 *
 * 面板里的选项取自渲染出的树，故控件按浏览器驱动它的方式驱动，而非由本测试知道某个键。
 */
async function chooseLine(host: MountedHost, index: number, label: string): Promise<void> {
  await press(host, lineTrigger(host, index))
  const option = host.node(item => item.props.role === 'option' && host.textOf(item) === label,
    `the line option 「${label}」`)
  await press(host, option)
}

/**
 * 某一段下拉里的方向选项本身，按屏幕上的先后：打开、读、收起。
 *
 * 值取自渲染出的树，故被断言的是用户读到的东西，而不是本测试对选项集的复述。
 */
async function directionOptionsOf(host: MountedHost, index: number): Promise<HostElement[]> {
  const trigger = lineTrigger(host, index)
  await press(host, trigger)
  const options = host.nodes(item => item.props.role === 'option')
  await press(host, trigger)
  return options
}

/** 同上，只要它们印出来的文字。 */
async function directionOptionTexts(host: MountedHost, index: number): Promise<string[]> {
  return (await directionOptionsOf(host, index)).map(item => host.textOf(item))
}

/**
 * 经选择器自己的弹层选一个站，并断言它显示的列表是该线路自己的：选项按它必须携带的站名**与**站序匹配。
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
 * 段移除控件自己的名字：**可见**标签在前，随后是它移除的段或它不能移除的原因。完全替换可见标签的名字
 * ——屏幕上「删除该段」、名字里「删除第 1 段」——是语音控制用户念出可见文字也点不中的控件
 * （WCAG 2.5.3 名称中标签，A 级）。
 */
function removeNameText(inner: string): string {
  return `删除该段（${inner}）`
}

describe('六条规则：录入时就地拦下，不靠提交后报错', () => {
  it('公交段录反了：拒绝，句子说出方向录反了这一事实，且不发任何写请求', async () => {
    const host = await mountChainEditor()
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    // 东大桥 是本线路 id 上的第 3 站，十里堡 是第 1 站：公交线路已存的 id 已固定方向，
    // 故这是录反了的一对。
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '十里堡', 1)
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的公交「快线 1 路」只沿站序递增运行：上车站「东大桥」在第 3 站、下车站「十里堡」在第 1 站，方向录反了')
    host.unmount()
  })

  it('地铁段录反了：接受，写出去的仍是下车站序小于上车站序的那一对', async () => {
    const host = await mountChainEditor()
    await type(host, nameField(host), '早上上班')
    // 一个线路 id 携带两个方向，而「开往平安里」把平安里编成第 1 站：在此列表上上平安里、下西直门
    // 是另一个方向的真实一程，不是录入错误。
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
    // 在本编辑器存在之前（或经直接写入）记录的记录可以只持有这一对的一半，这正是读侧只能以
    // `station-unset` 作答的状态——编辑器把它表面化，并拒绝重新保存它。
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain({ legs: [storedLeg({ seq: 0, alightStationOrder: null })] })],
    })
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的下车站「建国门」没有站序：站名与站序要同时选定，单独一半定位不到车站')
    host.unmount()
  })

  it('半截的站点（另一半）：只有站序、没有站名的记录在保存时同样被拒绝', async () => {
    // 上一种情形的镜像，它此前没有自己的测试：配对规则是对称的——「站名与站序要同时选定」——
    // 而没有站名的**数字**也定位不到任何站，故另一半缺的记录写入时同样以它自己的句子被拒绝，
    // 而非被读成一个站。
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationName: null, boardStationOrder: 3 })] })],
    })
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的上车站只有第 3 站这个站序、没有站名：站名与站序要同时选定，单独一半定位不到车站')
    host.unmount()
  })

  it('站名与站序不成对：站序不在该线路的站序里，拒绝并指出是第几站', async () => {
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationOrder: 9 })] })],
    })
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的上车站「东大桥」第 9 站不在「快线 1 路 · 开往建国门」的站序里，请重新选择这一站')
    host.unmount()
  })

  it('某一段的站点还没选完：拒绝并点名是哪一段', async () => {
    const host = await mountChainEditor()
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

    const remove = within(host, legBlock(host, 0))
      .find(item => item.tag === 'button' && host.textOf(item).includes('删除该段'))!
    expect(remove.props.disabled).toBe(true)
    expect(remove.props['aria-label']).toBe(removeNameText(LAST_LEG_REASON))
    expect(remove.props.title).toBe(removeNameText(LAST_LEG_REASON))
    // 可见标签被名字**包含**，绝不被它替换（2.5.3）。
    expect(remove.props['aria-label']).toContain(host.textOf(remove))

    // 同一规则，陈述在写入发生之处：没有可乘段的草稿被拒绝，而非送给服务端去拒。
    const empty = { ...emptyChainDraft(), name: '早上上班', legs: [] }
    expect(refuseChainDraft(empty, [])).toEqual({
      legIndex: null,
      message: '链路至少需要一段乘车段：没有乘车段的链路给不出任何结论',
    })
    host.unmount()
  })

  it('两段时「删除该段」可点：它的可访问名字包含这行字，并说清删的是第几段（WCAG 2.5.3）', async () => {
    const host = await mountChainEditor()
    await press(host, buttonWith(host, '添加乘车段'))

    const remove = within(host, legBlock(host, 1))
      .find(item => item.tag === 'button' && host.textOf(item).includes('删除该段'))!
    expect(remove.props.disabled).toBe(false)
    // 「删除该段」是用户读到并说出口的；名字必须包含它。
    expect(host.textOf(remove)).toBe('删除该段')
    expect(remove.props['aria-label']).toBe(removeNameText('第 2 段'))
    expect(remove.props.title).toBe(removeNameText('第 2 段'))
    host.unmount()
  })
})

describe('写出去的东西，就是 PRD 要求服务端收到的东西', () => {
  it('每段带上线路与上下车站的一对（站名 + 站序），段序就是数组顺序，且不带 seq', async () => {
    // 已存一条 displayOrder 4 的链路：新建的那一条要落到 5，而不是「行数」那个 0。
    const host = await mountChainEditor({ chains: [storedChain({ displayOrder: 4 })] })
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
          connectionMode: null,
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
          connectionMode: null,
        },
      ],
    })
    host.unmount()
  })

  it('选中的那一条写进这一段：换一个方向，写出去的就是那个方向自己的线路 id', async () => {
    // 屏上读到的标签是「快线 1 路 · 上班方向 · 开往十里堡」，而值是不透明的 key——它解析成方向 1
    // 自己的线路 id（公交线路的两个方向是两个 id）。按标签回查会写回方向 0，即用户没选的那一程。
    const host = await mountChainEditor({ favourites: DECLARED_FAVOURITES })
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 上班方向 · 开往十里堡')
    // 触发器当场读回选中的那一条：值确实写进了这一段的草稿。
    expect(host.textOf(lineTrigger(host, 0))).toBe('快线 1 路 · 上班方向 · 开往十里堡')
    await pickStation(host, 0, 'board', '建国门', 1)
    await pickStation(host, 0, 'alight', '十里堡', 4)
    await save(host)

    const posts = recordWrites(host).filter(request => request.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.legs[0]).toMatchObject({ lineId: BUS_DOWN, lineName: '快线 1 路' })
    host.unmount()
  })

  it('同名站在站序里出现两次时，写出去的是用户点的那一对（站名 + 站序），不是名字查回来的第一个', async () => {
    // 环线 3 路 把 东大桥 列在第 2 站**与**第 4 站：线上同名站不止一个（PRD）。仅以**名字**携带的
    // 选择会被 `find(name)` 解析回去，写入**首个**出现，而触发器显示同一对错值——用户从未选过的一对，
    // 且屏幕不会揭示。
    const host = await mountChainEditor({ favourites: [...FAVOURITES, LOOP_FAVOURITE] })
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '环线 3 路 · 开往终点站')
    await pickStation(host, 0, 'board', '东大桥', 4)
    await pickStation(host, 0, 'alight', '终点站', 5)

    // 触发器逐字读回被选中的那一对：第 4 站，绝不是基于名字的查找会找到的第 2 站。
    const triggers = stationTriggers(host, 0)
    expect(triggers, 'the leg rendered no station pickers').toHaveLength(2)
    expect(host.textOf(triggers[0]!)).toContain('东大桥 第4站')

    // 列表自己的选中状态同样是**这一对**：重新打开它只宣布第 4 站为选中。
    // 若按名字为键，两个「东大桥」选项都会被宣布为选中。
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
    // 只持有**站序**（站名为 null）的已存记录不是站：选择器不得把一个数字渲染得像它定位到了某个站。
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain({ legs: [storedLeg({ seq: 0, boardStationName: null, boardStationOrder: 3 })] })],
    })

    const triggers = stationTriggers(host, 0)
    expect(triggers, 'the leg rendered no station pickers').toHaveLength(2)
    expect(host.textOf(triggers[0]!)).toContain('未设置')
    host.unmount()
  })

  it('transferExtraMinutes：留空是 null，填 0 就是 0 —— 两个事实不互相冒充', async () => {
    const host = await mountChainEditor()
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await type(host, extraField(host, 0), '0')
    await save(host)

    expect(recordWrites(host)[0]!.body.legs[0].transferExtraMinutes).toBe(0)

    // 同一字段再次清空：「没配」绝不能被写成「没有额外时间」。
    const cleared = await mountChainEditor()
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
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain({
        legs: [storedLeg({ seq: 0, transferExtraMinutes: 0 })],
      })],
    })

    // 已存的草稿在屏幕上：名称、用途、线路与两个站。
    expect(host.text()).toContain('编辑 早上上班')
    expect(host.text()).toContain('快线 1 路 · 开往建国门')
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
    const host = await mountChainEditorFor('早上上班', {
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

    // 一个线路 id 携带两个方向，故该段被放到其自身编号持有其站序的那个方向——「开往西直门」把平安里
    // 编成第 1 站，而「开往平安里」把它编成第 3 站。把它加载到另一个方向会静默翻转该记录所写的那一程。
    expect(host.textOf(lineTrigger(host, 0))).toBe('地铁 88 号线 · 开往西直门')

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
    const host = await mountChainEditorFor('早上上班', { chains: [storedChain()] })
    await press(host, buttonWith(host, '删除链路'))
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
  it('把 400 的消息原样说一句，表单不关、列表不变', async () => {
    const host = await mountChainEditor({
      chains: [storedChain()],
      chainWrite: () => httpStatus(400, { success: false, error: '下车站的站序必须大于上车站的站序' }),
    })
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await save(host)

    // 操作反馈只说在 toast 上：页上不再留第二处。
    expect(pushed).toEqual(['链路保存失败 早上上班 · 下车站的站序必须大于上车站的站序'])
    expect(host.text()).not.toContain('下车站的站序必须大于上车站的站序')
    // 表单仍带草稿开着，故无需重新输入任何内容。
    expect(nameField(host)).toBeDefined()
    expect(refusalText(host)).toBeNull()
    host.unmount()
  })
})

describe('说过的句子不会留在原地，说着用户已经离开的状态', () => {
  it('照着拒绝的话改完下车站，那句拒绝就消失（屏幕已经在它说的状态之外了）', async () => {
    const host = await mountChainEditor()
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await save(host)
    expect(refusalText(host)).toBe('第 1 段的下车站还没选：选完上车站与下车站才能保存')

    // 用户完全照那句话做了。下车选择器现在读作「建国门 第4站」，故那句话对屏幕上任何东西都不再为真
    // ——而活得比其状态更久的消息，是关于用户已经离开的屏幕的断言。
    await pickStation(host, 0, 'alight', '建国门', 4)
    expect(host.textOf(stationTriggers(host, 0)[1]!)).toContain('建国门 第4站')
    expect(refusalText(host)).toBeNull()

    // 且下一次保存尝试仍被评判：真正的问题会再次陈述。
    await save(host)
    expect(refusalText(host)).toBeNull()
    host.unmount()
  })

  it('服务端拒绝之后改了草稿，页上不留任何关于旧草稿的话', async () => {
    const host = await mountChainEditor({
      chains: [storedChain()],
      chainWrite: () => httpStatus(400, { success: false, error: '下车站的站序必须大于上车站的站序' }),
    })
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
    await save(host)
    expect(pushed).toEqual(['链路保存失败 早上上班 · 下车站的站序必须大于上车站的站序'])

    await type(host, nameField(host), '早上上班（改）')
    // 那句话只在 toast 上，页上从来没有过它，故也就没有「活得比草稿更久」的那种残留。
    expect(host.text()).not.toContain('下车站的站序必须大于上车站的站序')
    host.unmount()
  })
})

describe('空状态与读取失败是两个原因，谁也不遮住谁', () => {
  it('列表页读不到时说读取失败并给出重试，不说「还没有录入」', async () => {
    // 「读取失败」与「还没有录入」是同一份列表的两种事实，而它们说的是**列表**：
    // 故这一条现在挂在列表页上（表单搬走之后，编辑页渲染的是这一条自己的字段）。
    const host = await mountChainList({ chainRead: 'fail' })

    expect(host.textOf(chainSection(host))).toContain('换乘链读取失败')
    expect(host.textOf(chainSection(host))).not.toContain('还没有录入通勤链路')
    expect(buttonWith(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('列表页读失败之后按重试：读到就把行显示出来，失败的那条说明消失', async () => {
    const host = await mountChainList({ chainRead: 'fail' })
    expect(host.textOf(chainSection(host))).toContain('换乘链读取失败')

    host.server.on(/\/api\/transit\/commute-chains\?/, () => ({ success: true, data: [storedChain()] }))
    await press(host, buttonWith(host, '重试'))

    expect(host.textOf(chainSection(host))).toContain('早上上班')
    expect(host.textOf(chainSection(host))).not.toContain('换乘链读取失败')
    host.unmount()
  })

  it('列表页回答是空列表时，说「还没有录入」并指出下一步', async () => {
    const host = await mountChainList()

    expect(host.textOf(chainSection(host))).toContain('还没有录入通勤链路')
    expect(host.textOf(chainSection(host))).toContain('新增链路')
    host.unmount()
  })

  it('编辑页上的读取失败也说自己的成因，不借用空状态的措辞', async () => {
    // 编辑页自己也要读那条链路（它没有别的地方可以拿到它），故它同样欠这句话。
    const host = await mountChainEditorFor('早上上班', { chains: [storedChain()], chainRead: 'fail' })

    expect(host.text()).toContain('换乘链读取失败')
    expect(host.text()).not.toContain('还没有录入通勤链路')
    expect(buttonWith(host, '重试')).toBeDefined()
    host.unmount()
  })

  it('没有关注线路时，录入里说明这一原因，而不是给一个永远选不出东西的线路列表', async () => {
    const host = await mountChainEditor({ favourites: [] })
    await type(host, nameField(host), '早上上班')

    expect(host.text()).toContain('还没有关注线路，无法录入乘车段')
    // 这个下拉里一条线路都没有：触发器读占位文字，打开也只得到一张空列表。
    const trigger = lineTrigger(host, 0)
    expect(host.textOf(trigger)).toBe('选择线路与方向')
    await press(host, trigger)
    expect(host.nodes(item => item.props.role === 'option')).toHaveLength(0)
    host.unmount()
  })
})

describe('房子里的结构规则', () => {
  it('链路录入在设置里的两个子页上，不是新的一级页面（一条注册表规则：路由是数据；形状换了，规则没换）', () => {
    // `设置` 曾是一个单页，编辑器就在它上面。§4.1 把它拆成索引加四个子页面，而
    // 「列表页 + 独立编辑页」又把编辑器从列表行里搬到了 `/settings/chains/new` 与
    // `/settings/chains/:chainId`。本测试所守的东西不因形状而变：链路录入**不是**
    // 换乘链路 旁的一级入口，后者的页面只读结论。两页共用同一个组件（同构，只差参数），
    // 而列表页上不再有表单 —— 那正是这次搬动要办的事。
    const list = codeOf(read('../../../views/settings/chains.vue'))
    expect(list).toContain('<DragOrderList')
    expect(list, 'the list page still carries the form').not.toContain('<ChainForm')
    const editor = codeOf(read('../../../views/settings/chain-editor.vue'))
    expect(editor).toContain('<ChainForm')
    expect(codeOf(read('../../../views/settings/index.vue'))).not.toContain('<DragOrderList')
    expect(codeOf(read('../../../views/settings/index.vue'))).not.toContain('<AnchorPicker')
    const router = codeOf(read('../../../router/index.ts'))
    expect(router).toContain(`path: '/settings'`)
    expect(router).toContain(`path: 'chains'`)
    expect(router).not.toContain('commute-chain-editor')
    // 两页都挂在 `/settings` 之下（顶栏点亮靠父记录），且新建那条**静态**路径排在 `:chainId` 之前
    // ——否则 `new` 会被读成一个 chainId，那一页只能说「这条链路不存在」。
    expect(router).toContain(`path: 'chains/new'`)
    expect(router).toContain(`path: 'chains/:chainId'`)
    expect(router.indexOf(`path: 'chains/new'`)).toBeLessThan(router.indexOf(`path: 'chains/:chainId'`))
    expect(router.match(/chain-editor\.vue/g), 'the chain editor page is registered more than once').toHaveLength(2)
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
    // 该模式读取最后一个 `:` 之后的工具类，故带前缀的尺寸也被计入——这一行防止 `lg:text-7xl` 溜过
    // 一个只读无前缀类的阶梯。两个方向都陈述：带前缀的阶梯外尺寸被抓到，而颜色（仅以阶梯词开头）
    // 不被读成尺寸。
    expect(fontSizeTokens('<span class="lg:text-7xl">')).toEqual(['7xl'])
    // 颜色无论怎么加前缀都不是尺寸：阶梯只读字号工具类可能以其开头的家族，故候选只有尺寸 token。
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
    // 「新增链路」住在列表页上，其余在编辑页上：两页各量自己那几个。
    const list = await mountChainList({ chains: [storedChain()] })
    // 「新增链路」是一个**链接**（一条链路自己的页面），不是按钮：脚本跳转要自己接语义、
    // 键盘可达与「在新标签页打开」，而这三样浏览器原生就给了。
    const addLink = list.node(
      item => item.tag === 'a' && list.textOf(item).includes('新增链路'),
      'the 新增链路 link',
    )
    expect(String(addLink.props.class), '新增链路 is smaller than the house touch target')
      .toMatch(/min-h-\[44px\]|min-h-11|h-11/)
    list.unmount()

    const host = await mountChainEditor({ chains: [storedChain()] })
    // 必须先选一条线路，两个选择器才存在：没有它，下面的列表不携带任何选择器，循环将空转通过
    // ——正是两个 40px 控件曾满足 44px 规则的方式。
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    const pickers = stationTriggers(host, 0)
    expect(pickers, 'the pickers are rendered, or this check has no picker to measure').toHaveLength(2)
    const controls = [
      buttonWith(host, '保存链路'),
      buttonWith(host, '添加乘车段'),
      buttonWith(host, '删除该段'),
      lineTrigger(host, 0),
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

  it('「第 N 段」是标题级文字，不是 12px 的字段标签', async () => {
    // 段名与「乘车段」「名称」那些字段标签曾经同字号，读起来像又多了一条字段。它是这一段
    // 自己的标题，故它与表单里的 `h4` 同族（14px 起），不落回 `text-xs`。
    const host = await mountChainEditor({ chains: [storedChain()] })

    const heading = host.nodes(item => item.tag === 'h5' && /^第 \d+ 段$/.test(host.textOf(item).trim()))[0]
    expect(heading, 'the leg heading is not a heading element').toBeDefined()
    const classes = String(heading!.props.class ?? '')
    expect(classes, `the leg heading is field-label sized: ${classes}`).not.toContain('text-xs')
    expect(classes, `the leg heading is not title sized: ${classes}`).toMatch(/text-(sm|base|lg)/)
    host.unmount()
  })

  it('文字在它真正合成的背景上可读（12px 也要 4.5:1）——整张设置页都在检查范围内', () => {
    // 本屏的**每个** SFC，含关注线路行与复用的选择器：只读链路卡文件的规则会让回归在本屏其他地方发布。
    for (const name of ['index.vue', 'lines.vue', 'favorite-editor.vue', 'schedule.vue', 'anchors.vue', 'anchor-detail.vue', 'chains.vue',
      'back-to-settings.vue', 'commute-hours-card.vue',
      'commute-hours-form.vue', 'station-pin-picker.vue', 'drag-order-list.vue', 'removal-dialog.vue']) {
      expect(Object.keys(SETTINGS_SFC), `${name} is not audited`).toContain(name)
    }

    const audit = auditContrast(SETTINGS_SFC)
    expect(audit.pairs.length).toBeGreaterThan(0)
    expect(audit.violations).toEqual([])

    // 半透明文字色也被测量——与它所在的表面合成，这是它们能被读取的唯一方式。
    // 审计跳过的颜色就是没有守卫的颜色。锚点页原先那个开发用模拟说明（`text-sky-400/80`）
    // 已被删掉，故这条改为守住本屏真实画着的那个半透明色（`text-amber-400/90`）。
    const translucent = audit.pairs.filter((pair: { textToken: string }) => /\/\d+$/.test(pair.textToken))
    expect(translucent, 'the translucent note on this screen is audited').not.toHaveLength(0)
    expect(translucent.every((pair: { ratio: number }) => pair.ratio >= 4.5), 'its composite is readable').toBe(true)
  })

  it('配对只看同一状态：hover 的文字不跟没加 hover 的背景相乘，真实的那一对反而要审到', () => {
    const audit = auditContrast(SETTINGS_SFC)

    // 每一对都是屏幕真正画得出的：表面只可携带与其配对的文字同样携带的状态。本审计曾做的叉积把
    // `hover:text-slate-950` 与按钮的基础 `bg-slate-800`（1.38:1）配对、把 `text-slate-200` 与
    // `hover:bg-cyan-500`（1.97:1）配对——两者在屏幕上都无法共存，故都被该状态实际画出的那对驳倒。
    const impossible = audit.pairs
      .filter(pair => !pair.surface.variants.every(variant => pair.textVariants.includes(variant)))
      .map(pair => `${pair.source} ${pair.textToken} on ${pair.surface.hex} [${pair.surface.layers.join(' over ')}]`)
    expect(impossible).toEqual([])

    // 关注 按钮在同一状态提亮到 bg-cyan-500 并压暗其文字：**两个**状态，11.87:1 与 8.31:1。两者都被审计；
    // 该按钮别的什么都不被审计。按它**自己的**两个类识别，而非按其中之一的首个匹配：`设置` 拆分时该按钮
    // 移到了 `lines.vue`，本目录遍历先到哪个文件不是本断言可以依赖的。
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

  it('逐段加到上限：到上限的按钮禁用，并在原地说明这条边界', async () => {
    const host = await mountChainEditor()
    for (let legs = 1; legs < MAX_CHAIN_LEGS; legs += 1) {
      await press(host, buttonWith(host, '添加乘车段'))
    }

    expect(host.nodes(item => item.props['data-chain-leg'] !== undefined)).toHaveLength(MAX_CHAIN_LEGS)
    const add = host.node(item => item.tag === 'button'
      && host.textOf(item).includes(`一条链路最多 ${MAX_CHAIN_LEGS} 段乘车`), 'the add control at its limit')
    expect(add.props.disabled).toBe(true)
    host.unmount()
  })

  it('上限以上的段数一次写完：段序就是数组顺序，链路的段数没有隐含上限', async () => {
    const host = await mountChainEditor()
    await type(host, nameField(host), '四段通勤')

    // 逐个把每一段填满（线路与上下车站），再加下一段。夹具里只有两种线路，故交替使用 ——
    // 本用例看的是**段数**能不能穿过写入路径，不是线路的多样性。
    const plan = [
      { line: '快线 1 路 · 开往建国门', board: ['东大桥', 3], alight: ['建国门', 4] },
      { line: '地铁 88 号线 · 开往平安里', board: ['车公庄', 2], alight: ['平安里', 3] },
      { line: '快线 1 路 · 开往建国门', board: ['东大桥', 3], alight: ['建国门', 4] },
      { line: '地铁 88 号线 · 开往平安里', board: ['车公庄', 2], alight: ['平安里', 3] },
    ]
    for (const [index, step] of plan.entries()) {
      if (index > 0) await press(host, buttonWith(host, '添加乘车段'))
      await chooseLine(host, index, step.line)
      await pickStation(host, index, 'board', step.board[0] as string, step.board[1] as number)
      await pickStation(host, index, 'alight', step.alight[0] as string, step.alight[1] as number)
    }
    await save(host)

    const posts = recordWrites(host).filter(request => request.method === 'POST')
    expect(posts).toHaveLength(1)
    const legs = (posts[0]!.body as { legs: Array<{ lineName: string, boardStationName: string }> }).legs
    expect(legs).toHaveLength(4)
    expect(legs.map(leg => leg.lineName)).toEqual(['快线 1 路', '地铁 88 号线', '快线 1 路', '地铁 88 号线'])
    expect(legs.map(leg => leg.boardStationName)).toEqual(['东大桥', '车公庄', '东大桥', '车公庄'])
    host.unmount()
  })

  it('更换线路会清空该段的上下车站，并说明原因：站序属于一条线路', async () => {
    const host = await mountChainEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await chooseLine(host, 0, '地铁 88 号线 · 开往平安里')

    expect(host.text()).toContain('更换线路后已清空这一段的上车站与下车站')
    expect(host.textOf(stationTriggers(host, 0)[0]!)).toContain('未设置')
    host.unmount()
  })

  it('站点只从该线路的站序列表里选：段里没有手输站名的地方，列表就是那条线路的站序', async () => {
    const host = await mountChainEditor()
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    // 段里完全没有文本输入框：手打的站名是一个没人能定位的站，
    // 这就是这一对从线路自己的列表里选、绝不手打的原因。
    expect(legFields(host, 0).filter(item => item.tag === 'input').map(item => item.props.type))
      .toEqual(['number'])

    // 段里的三个下拉各有把自己与另外两个区分开的名字供屏幕阅读器用：
    // 「线路与方向」不是「上车站」，「上车站」不是「下车站」。
    expect(comboTriggers(host, 0).map(item => item.props['aria-label']))
      .toEqual(['线路与方向', '上车站', '下车站'])

    await press(host, stationTriggers(host, 0)[0]!)

    expect(host.nodes(item => item.props.role === 'option').map(item => host.textOf(item)))
      .toEqual(['十里堡 第1站', '团结湖 第2站', '东大桥 第3站', '建国门 第4站'])
    host.unmount()
  })

  it('线路与方向的下拉不带搜索框：面板打开就是全部线路，与编辑器给的那份列表一条不差', async () => {
    // 这份列表一屏就看完了，缩它没有意义——故它用共用的控件，但不带搜索框。
    const host = await mountChainEditor({ favourites: DECLARED_FAVOURITES })
    await press(host, lineTrigger(host, 0))

    // 整个屏上（含 portal 里的面板）一个搜索框都没有：线路与方向的下拉自己就没带。
    expect(host.nodes(item => item.tag === 'input' && item.props.role === 'combobox'),
      '线路与方向的下拉带上了搜索框').toHaveLength(0)

    const options = host.nodes(item => item.props.role === 'option').map(item => host.textOf(item))
    // 两条关注线路、各两个方向：数量与编辑器交给这一段的那份列表一致，一条都没被缩掉。
    expect(options).toHaveLength(DECLARED_FAVOURITES.length * 2)
    expect(options).toEqual([
      '快线 1 路 · 上班方向 · 开往十里堡',
      '快线 1 路 · 下班方向 · 开往建国门',
      '地铁 88 号线 · 开往平安里',
      '地铁 88 号线 · 开往西直门',
    ])
    host.unmount()
  })

  it('未选线路的段说明下一步，而不是摆出一对空的组合框', async () => {
    const host = await mountChainEditor()

    expect(host.textOf(legBlock(host, 0))).toContain('请先选择线路与方向，再从它的站序里选上车站与下车站')
    expect(stationTriggers(host, 0)).toHaveLength(0)
    host.unmount()
  })

  it('站点还没读到：说的是「还没读到、要等它出现」，不是「暂无站点数据」（两种事实两句话）', async () => {
    // 读取不应答——请求本身失败——故列表为空是因为什么都没读到，**不是**因为本方向没有站。
    // 「暂无站点数据」会是一个没人做过的关于上游的断言，而等待仍是用户确切能做的事。
    const host = await mountChainEditor({
      overrides: [[/\/api\/transit\/lines\//, () => { throw new Error('offline') }]],
    })
    await type(host, nameField(host), '早上上班')
    // 选项按其编号命名方向：「开往 X」标签来自那次尚未作答的读取，
    // 故不得捏造一个没人报告过的终点站。
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
    // API 为本方向作答且完全没列站点：一个永远不会变成列表的状态，故文案不得读成「还在读取」。
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
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')

    expect(host.textOf(legBlock(host, 0))).toContain('暂无站点数据')
    expect(host.textOf(legBlock(host, 0))).not.toContain('还在读取')
    expect(stationTriggers(host, 0)).toHaveLength(0)
    host.unmount()
  })

  it('已不再关注的线路不会被悄悄换掉：它在选项里说明自己不在关注列表，并拒绝保存', async () => {
    // 已存链路乘 快线 1 路，而它已不再被关注：它的站表完全读不到，故这一对无法核实——
    // 这正是保存必须说的，而不是把该段重编到某条别的线路上。
    const host = await mountChainEditorFor('早上上班', {
      favourites: [FAVOURITES[1]!],
      chains: [storedChain()],
    })
    await save(host)

    expect(recordWrites(host)).toHaveLength(0)
    expect(refusalText(host)).toBe('第 1 段的「快线 1 路」已不在关注线路里，它的站序无从核对，请重新选择线路')
    host.unmount()
  })

  it('已不再关注的公交线，选项说的是「站序未知」：公交线 id 已经把方向定死，说方向未知是说过头了', async () => {
    const host = await mountChainEditorFor('早上上班', {
      favourites: [FAVOURITES[1]!],
      chains: [storedChain()],
    })

    const options = await directionOptionTexts(host, 0)
    expect(options).toContain('快线 1 路 · 站序未知')
    expect(options, 'a stored bus id fixes the direction, so claiming it is unknown overstates')
      .not.toContain('快线 1 路 · 方向未知')
    host.unmount()
  })

  it('已不再关注的地铁线，选项说的是「方向未知」：一个 id 带两个方向，方向确实读不出来', async () => {
    const host = await mountChainEditorFor('早上上班', {
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

    const options = await directionOptionTexts(host, 0)
    expect(options).toContain('地铁 88 号线 · 方向未知')
    host.unmount()
  })

  it('线路是在哪里选的，就在那里说明列表来自关注线路：不等到它绑住手才说', async () => {
    // 只提供关注的线路，故未关注的线路在下拉里干脆缺席——而在稳态下屏幕上没有别的东西会说明原因。
    // 代价在做出选择之处陈述，而非只在它绑住手时才说。
    const host = await mountChainEditor()

    const sentence = '列表来自你关注的线路：没关注的线路要先关注，才能在这里选它的站序'
    expect(host.textOf(legBlock(host, 0))).toContain(sentence)
    host.unmount()
  })

  it('列表那块区域由它自己的标题命名：名字只念一次（aria-labelledby，不是重复一遍的 aria-label）', async () => {
    const host = await mountChainList()

    const card = chainSection(host)
    expect(card.props['aria-label']).toBeUndefined()
    const labelled = card.props['aria-labelledby']
    const heading = host.node(item => item.props.id === labelled, 'the heading the card is named by')
    expect(host.textOf(heading)).toBe('通勤链路')
    host.unmount()
  })
})

describe('方向按使用者的声明标注上下班，并按链路自己的目的排序', () => {
  it('标识只来自关注行声明过的那两个字段：没声明的关注行一个标识都不带', async () => {
    // 快线 1 路 声明过（方向 1 上班、方向 0 下班），地铁 88 号线 没声明过：
    // 声明过的两个方向各自成句，没声明过的两条仍只说线路名与「开往 X」。
    const host = await mountChainEditor({ favourites: DECLARED_FAVOURITES })

    expect(await directionOptionTexts(host, 0)).toEqual([
      '快线 1 路 · 上班方向 · 开往十里堡',
      '快线 1 路 · 下班方向 · 开往建国门',
      '地铁 88 号线 · 开往平安里',
      '地铁 88 号线 · 开往西直门',
    ])
    host.unmount()
  })

  it('下班目的的链路里，下班方向那条排在前；上班方向与上游的「开往 X」照旧在', async () => {
    // 目的按**已存链路自己的**那条算：这一条存在链路上，故它必须从编辑页进来（新建页的草稿
    // 一律是上班目的，在那里看不出排序跟着链路走）。
    const host = await mountChainEditorFor('早上上班', {
      favourites: DECLARED_FAVOURITES,
      chains: [storedChain({ purpose: 'evening' })],
    })

    expect(await directionOptionTexts(host, 0)).toEqual([
      '快线 1 路 · 下班方向 · 开往建国门',
      '快线 1 路 · 上班方向 · 开往十里堡',
      '地铁 88 号线 · 开往平安里',
      '地铁 88 号线 · 开往西直门',
    ])
    host.unmount()
  })

  it('上班与下班两个目的只换先后，不换选项集：任何方向都既不停用也不消失', async () => {
    const morning = await mountChainEditor({ favourites: DECLARED_FAVOURITES })
    const evening = await mountChainEditorFor('早上上班', {
      favourites: DECLARED_FAVOURITES,
      chains: [storedChain({ purpose: 'evening' })],
    })

    const morningTexts = await directionOptionTexts(morning, 0)
    const eveningTexts = await directionOptionTexts(evening, 0)
    expect(eveningTexts).not.toEqual(morningTexts)
    expect(eveningTexts).toHaveLength(morningTexts.length)
    expect([...eveningTexts].sort()).toEqual([...morningTexts].sort())
    // 反方向那条（目的不指向它）仍在，且没有一个是禁用的：先往反方向坐到枢纽是真实走法。
    // 禁用与否读的是列表项自己的那一档（reka 只在停用时才标 `data-disabled`）。
    expect((await directionOptionsOf(evening, 0)).every(item => item.props['data-disabled'] === undefined))
      .toBe(true)
    morning.unmount()
    evening.unmount()
  })

  it('在录入屏上换目的，同一条线路的两个方向当场换先后（先后跟着这份草稿的目的走）', async () => {
    const host = await mountChainEditor({ favourites: DECLARED_FAVOURITES })
    expect((await directionOptionTexts(host, 0)).slice(0, 2))
      .toEqual(['快线 1 路 · 上班方向 · 开往十里堡', '快线 1 路 · 下班方向 · 开往建国门'])

    const evening = host.node(
      item => item.props.role === 'radio' && item.props.value === 'evening',
      'the 下班 purpose radio',
    )
    await press(host, evening)

    expect((await directionOptionTexts(host, 0)).slice(0, 2))
      .toEqual(['快线 1 路 · 下班方向 · 开往建国门', '快线 1 路 · 上班方向 · 开往十里堡'])
    host.unmount()
  })
})

describe('规则模块本身', () => {
  /** 一个「线路+方向」选项，使关于选项的规则无需挂载即可读取。 */
  function option(overrides: Partial<ChainLineOption> = {}): ChainLineOption {
    return {
      key: 'fav-bus-1_0',
      lineGroupKey: 'fav-bus-1',
      direction: 0,
      lineId: BUS_UP,
      lineName: '快线 1 路',
      cityCode: '027',
      directionLabel: '开往建国门',
      commuteRole: null,
      stations: STOP_LISTS[`${BUS_UP}#0`] as never,
      stops: 'ready',
      ...overrides,
    }
  }

  /**
   * 一个关注行的两个方向，供排序规则使用：方向 1 是声明的上班方向、方向 0 是下班方向
   * ——两个方向都标了，且各标一个用途，故「谁在前」完全由目的决定。
   */
  function bothMarkedPair(): ChainLineOption[] {
    return [
      option({ key: 'fav-bus-1_0', commuteRole: 'evening', directionLabel: '开往建国门' }),
      option({ key: 'fav-bus-1_1', direction: 1, lineId: BUS_DOWN, commuteRole: 'morning', directionLabel: '开往十里堡' }),
    ]
  }

  it('上班目的把带上班方向的那条排前，下班目的把带下班方向的那条排前（一条关于排序的单元规则）', () => {
    const pair = bothMarkedPair()
    expect(orderedLineOptionsFor(pair, 'morning').map(item => item.key)).toEqual(['fav-bus-1_1', 'fav-bus-1_0'])
    expect(orderedLineOptionsFor(pair, 'evening').map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
  })

  it('两条都没标识、或都标了同一个用途时保持原序：没有可依据的声明就不重排（一条关于静止的单元规则）', () => {
    // 没标识：谁在前没有依据，故先录的那条还在前。
    const unmarked = [
      option({ key: 'fav-bus-1_0', commuteRole: null }),
      option({ key: 'fav-bus-1_1', direction: 1, lineId: BUS_DOWN, commuteRole: null }),
    ]
    expect(orderedLineOptionsFor(unmarked, 'morning').map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
    expect(orderedLineOptionsFor(unmarked, 'evening').map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
    // 都标了同一个用途：两条都匹配，匹配不出先后，故仍是原序——绝不按编号或线路 id 猜一个。
    const bothSame = [
      option({ key: 'fav-bus-1_0', commuteRole: 'both' }),
      option({ key: 'fav-bus-1_1', direction: 1, lineId: BUS_DOWN, commuteRole: 'both' }),
    ]
    expect(orderedLineOptionsFor(bothSame, 'morning').map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
    expect(orderedLineOptionsFor(bothSame, 'evening').map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
  })

  it('排序不是过滤：反方向那条一个不少，也绝不因为没有匹配的标识而被停用（一条关于不替使用者决定的单元规则）', () => {
    // 「先往反方向坐到枢纽」是真实走法：只把带标识的那条提到前面，其余原样留在列表里。
    const lines = [
      option({ key: 'fav-bus-1_0', commuteRole: 'evening' }),
      option({ key: 'fav-bus-1_1', direction: 1, lineId: BUS_DOWN, commuteRole: 'morning' }),
    ]
    const ordered = orderedLineOptionsFor(lines, 'evening')
    expect(ordered.map(item => item.key)).toEqual(['fav-bus-1_0', 'fav-bus-1_1'])
    expect(ordered).toHaveLength(lines.length)
    expect(ordered.every(item => lines.includes(item))).toBe(true)
    // 反向那一程（带上班标识）仍在列表里，没有被停用或降级成一个「不可选」的选项。
    expect(ordered.find(item => item.key === 'fav-bus-1_1')).toBeDefined()
  })

  it('排序只在同一条线路的两个方向之间：跨关注行的先后原样不动（一条关于作用域的单元规则）', () => {
    const lines = [
      option({ key: 'fav-a_0', lineGroupKey: 'fav-a', commuteRole: null }),
      option({ key: 'fav-a_1', lineGroupKey: 'fav-a', direction: 1, lineId: BUS_DOWN, commuteRole: 'morning' }),
      option({ key: 'fav-b_0', lineGroupKey: 'fav-b', lineName: '地铁 88 号线', lineId: SUBWAY, commuteRole: 'morning' }),
      option({ key: 'fav-b_1', lineGroupKey: 'fav-b', lineName: '地铁 88 号线', lineId: SUBWAY, direction: 1, commuteRole: null }),
    ]
    // 上班方向在 第二条线路的第一个方向：它被提到自己那条线路的前面，而这两条线路的先后仍是关注顺序。
    expect(orderedLineOptionsFor(lines, 'morning').map(item => item.key))
      .toEqual(['fav-a_1', 'fav-a_0', 'fav-b_0', 'fav-b_1'])
  })

  it('一条线路只有一个方向时，排序把它原样留下（一条关于边界的单元规则）', () => {
    const single = [option({ key: 'fav-a_0', lineGroupKey: 'fav-a', commuteRole: 'evening' })]
    expect(orderedLineOptionsFor(single, 'morning').map(item => item.key)).toEqual(['fav-a_0'])
  })

  it('选项的名字只写知道的事：开往 X / 方向 N / 方向未知 / 站序未知（一条关于措辞的单元规则）', () => {
    expect(lineOptionLabel(option())).toBe('快线 1 路 · 开往建国门')
    // 未陈述终点站的上游就是没陈述：编号是该选项仍持有的唯一事实，故标签说的就是它。
    expect(lineOptionLabel(option({ directionLabel: null }))).toBe('快线 1 路 · 方向 0')
    // 地铁两个方向共用一个 id，故已存地铁线路的方向确实不可知——这正是「方向未知」的用途。
    expect(lineOptionLabel(option({ direction: null, directionLabel: null, lineId: SUBWAY, lineName: '地铁 88 号线' })))
      .toBe('地铁 88 号线 · 方向未知')
    // 公交线路的两个方向是两个 id，故已存 id 已固定该段走哪个方向：称方向为未知会夸大。
    // 读不到的是**站表**，而标签说的就是它。
    expect(lineOptionLabel(option({ direction: null, directionLabel: null }))).toBe('快线 1 路 · 站序未知')
  })

  it('四个标识情形各自成句：只上班 / 只下班 / 上班·下班 / 没声明过就什么都不标（一条关于措辞的单元规则）', () => {
    // 标识只有两个来源：使用者在关注行上声明的 `morningDirection` 与 `eveningDirection`。
    // 没声明过的方向不是「未确定」而是**没有这个声明**，故它什么都不标——系统不替他判断他往哪边走。
    expect(lineOptionLabel(option({ commuteRole: 'morning' }))).toBe('快线 1 路 · 上班方向 · 开往建国门')
    expect(lineOptionLabel(option({ commuteRole: 'evening' }))).toBe('快线 1 路 · 下班方向 · 开往建国门')
    expect(lineOptionLabel(option({ commuteRole: 'both' }))).toBe('快线 1 路 · 上班·下班 · 开往建国门')
    expect(lineOptionLabel(option({ commuteRole: null }))).toBe('快线 1 路 · 开往建国门')
  })

  it('标识插在线路名与「开往 X」之间：上游的终点站照旧念，兜底措辞也照旧（一条关于次序的单元规则）', () => {
    // 标注只增不改：没有数据源陈述终点站时，仍说编号；方向本身读不出来时，
    // 仍按线路形态说「方向未知」/「站序未知」。
    expect(lineOptionLabel(option({ commuteRole: 'morning', directionLabel: null })))
      .toBe('快线 1 路 · 上班方向 · 方向 0')
    expect(lineOptionLabel(option({ commuteRole: 'evening', directionLabel: null, direction: null })))
      .toBe('快线 1 路 · 下班方向 · 站序未知')
    expect(lineOptionLabel(option({
      commuteRole: 'both', direction: null, directionLabel: null, lineId: SUBWAY, lineName: '地铁 88 号线',
    }))).toBe('地铁 88 号线 · 上班·下班 · 方向未知')
  })

  it('空段草稿与空名字都被拒绝，且句子说的是事实（一条关于规则的单元规则）', () => {
    const lines = [
      {
        key: 'fav-bus-1_0',
        lineGroupKey: 'fav-bus-1',
        direction: 0 as const,
        lineId: BUS_UP,
        lineName: '快线 1 路',
        cityCode: '027',
        directionLabel: '开往建国门',
        commuteRole: null,
        stations: STOP_LISTS[`${BUS_UP}#0`] as never,
        stops: 'ready' as const,
      },
    ]
    expect(refuseChainDraft(emptyChainDraft(), lines)).toEqual({
      legIndex: null,
      message: '请先给这条链路起个名字',
    })

    const halfFilled = { name: '早上上班', purpose: 'morning' as const, legs: [{ ...emptyLegDraft(), lineKey: 'fav-bus-1_0', boardStationName: '东大桥' }] }
    expect(refuseChainDraft(halfFilled, lines)?.message)
      .toBe('第 1 段的上车站「东大桥」没有站序：站名与站序要同时选定，单独一半定位不到车站')
  })

  it('选择器一律走共用的下拉：全仓的生产源码里一个原生 select 都不留（一条关于控件选择的源码规则）', () => {
    // 选项少到一眼看得完时不带搜索框，多到读不完时带上，但两种情况都是**同一个**控件，
    // 而不是各写一份。留下任何一个原生 select 都会让「有界的选择用 select」这条旧读法继续
    // 膨胀出第二份实现，故本规则不放宽成「允许某些 select」。
    const offenders = sfcFiles(WEB_SRC)
      .filter(path => !path.includes('/__tests__/'))
      .filter(path => codeOf(readFileSync(path, 'utf8')).includes('<select'))
    expect(offenders).toEqual([])

    // 三处调用分别落在共用的控件上：链路录入的线路与方向、它复用的选站器、站台屏的表头。
    expect(codeOf(LEG)).toContain('SearchableCombobox')
    expect(codeOf(LEG)).toContain('StationPinPicker')
    expect(codeOf(PATTERN)).toContain('SearchableCombobox')
    expect(codeOf(PICKER)).toContain('SearchableCombobox')
  })
})

describe('链路的三处写操作成与败各说一句', () => {
  /**
   * 拖拽库挂在容器元素自己身上的那个实例。
   *
   * 它按一个每次加载都不同的键挂上去，故这里按前缀找键 —— 库自己的键名就是 `Sortable…`。
   */
  function sortableOf(host: MountedHost): { options: { onEnd: (event: unknown) => void } } {
    const keyOf = (node: HostElement): string | undefined =>
      Object.keys(node).find(name => /^sortable/i.test(name))
    const node = host.node(item => keyOf(item) !== undefined, 'the sortable container')
    return (node as unknown as Record<string, { options: { onEnd: (event: unknown) => void } }>)[keyOf(node)!]!
  }

  /** 一次拖放：被拖走的链路占据它落在其上的那条链路的格子。 */
  async function drag(host: MountedHost, from: number, to: number): Promise<void> {
    sortableOf(host).options.onEnd({ oldIndex: from, newIndex: to })
    await host.flush()
  }

  /** 一条新链路的完整录入：名字、一条公交线路，以及它的一对站。 */
  async function compose(host: MountedHost): Promise<void> {
    await type(host, nameField(host), '早上上班')
    await chooseLine(host, 0, '快线 1 路 · 开往建国门')
    await pickStation(host, 0, 'board', '东大桥', 3)
    await pickStation(host, 0, 'alight', '建国门', 4)
  }

  /** 排队删除并确认。 */
  async function removeFirst(host: MountedHost): Promise<void> {
    await press(host, buttonWith(host, '删除链路'))
    await press(host, host.node(
      item => item.tag === 'button' && host.textOf(item).trim() === '确认删除',
      'the confirm button',
    ))
  }

  it('保存：说一句已保存链路，带上这条链路的名字', async () => {
    const host = await mountChainEditor()
    await compose(host)
    await save(host)

    expect(pushed).toEqual(['已保存链路 早上上班'])
    host.unmount()
  })

  it('保存：被拒时带上服务端给的原因，只说一次', async () => {
    const host = await mountChainEditor({
      chainWrite: () => ({ success: false, error: '一条链路至少要有一段乘车段' }),
    })
    await compose(host)
    await save(host)

    expect(pushed).toEqual(['链路保存失败 早上上班 · 一条链路至少要有一段乘车段'])
    expect(host.text()).not.toContain('一条链路至少要有一段乘车段')
    host.unmount()
  })

  it('删除：说一句已删除链路，带上这条链路的名字', async () => {
    const host = await mountChainEditorFor('早上上班', { chains: [storedChain()] })

    await removeFirst(host)

    expect(pushed).toEqual(['已删除链路 早上上班'])
    host.unmount()
  })

  it('删除：被拒时带上服务端给的原因', async () => {
    const host = await mountChainEditorFor('早上上班', {
      chains: [storedChain()],
      overrides: [[/\/api\/transit\/commute-chains\/[^/]+$/, request => (request.method === 'DELETE'
        ? { success: false, error: '该链路不存在' }
        : { success: true, data: stored(request.body, 'chain-saved-1') })]],
    })

    await removeFirst(host)

    expect(pushed).toEqual(['链路删除失败 早上上班 · 该链路不存在'])
    host.unmount()
  })

  it('顺序：落一次拖放说一句顺序已更新', async () => {
    // 拖动排序住在**列表页**上：编辑器搬走之后，这条列表与它的拖动留在这里。
    const host = await mountChainList({
      chains: [storedChain(), storedChain({ id: 'chain-saved-2', name: '下班回家', displayOrder: 1 })],
    })

    await drag(host, 0, 1)

    expect(pushed).toEqual(['顺序已更新'])
    host.unmount()
  })

  it('顺序：被拒时带上服务端给的原因', async () => {
    const host = await mountChainList({
      chains: [storedChain(), storedChain({ id: 'chain-saved-2', name: '下班回家', displayOrder: 1 })],
      overrides: [[/\/api\/transit\/commute-chains\/[^/]+$/, () => ({ success: false, error: '该链路不存在' })]],
    })

    await drag(host, 0, 1)

    expect(pushed).toEqual(['顺序保存失败 · 该链路不存在'])
    host.unmount()
  })
})
