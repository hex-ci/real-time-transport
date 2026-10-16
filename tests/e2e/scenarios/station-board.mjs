/**
 * 电子站牌：一个站台上全部经过线路的到站（PRD F5）。
 *
 * 五件事各钉一个真会做错的形状：
 *  - 「换站只是换了个名字」—— 选中那一站必须成为页头那一站，且真的重读一次站台读数；
 *  - 「距离由分钟折出来」—— 屏上的「距本站 X」必须落在它收到过的站台载荷里（按载荷自己的米数），
 *    自造一个数字、或拿分钟换算，都抓得到；
 *  - 「哪趟先来」—— 屏上的分钟序列必须升序（排序就是这一屏的答案本身）；
 *  - **站台选择器的键盘** —— 开面板走原生激活（Enter），打开后上下移动高亮、回车拿走高亮那一项、
 *    Escape 关掉且不动值。这三件只有真按键能证明：单元宿主把事件交给被按的节点自己、不冒泡也不跑
 *    默认动作，量不到它们（见 `apps/web/src/components/searchable-combobox/main.vue`）；
 *  - **刷新后还看这一站** —— 本页记住最后看的那个站台（本地存储）。这条只能这样验：真选一个**不是
 *    列表第一个**的站，真导航一次，再比对它读的站台 id 还是原来那个 —— 退回列表第一个会读到另一个 id。
 *
 * 行相关的断言只在真读到行时做：上游夜里可能一个在途车都没有，那时屏上说的是「暂无到站信息」，
 * 那是这一屏的正常一态，不是失败 —— 但选择器与键盘那一节与上游无关，永远跑。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay, recordedRequests, installFetchRecorder, clearRecordedRequests } from '../harness.mjs'

export const name = '电子站牌'

/** 给浏览器一个真坐标（.env.example 里那个开发用的模拟点），用来验证「附近」那些站。 */
const DEVICE = { lat: 39.9042, lng: 116.4074 }

const TRIGGER = 'main button[aria-label="选择站台"]'
const TRIGGER_TEXT = `JSON.stringify(document.querySelector('${TRIGGER}')?.innerText.trim() ?? null)`
const PANEL_COUNT = `JSON.stringify(document.querySelectorAll('[role=listbox]').length)`
const HIGHLIGHTED = `JSON.stringify([...document.querySelectorAll('[role=option][data-highlighted]')].map(el => el.innerText.trim()))`
const focusTrigger = `(() => { const el = document.querySelector('${TRIGGER}'); el.focus(); return document.activeElement === el })()`

/**
 * 屏幕上的行：每一行都带「开往」。
 *
 * 行本身是一个去详情页的链接（`<a>`），故这里不写死标签名 —— 写 `> *` 取那一层的直接子元素。
 */
const ROW_TEXTS = `JSON.stringify([...document.querySelectorAll('main div[class*=divide-y] > *')]
  .filter(row => row.innerText.includes('开往'))
  .map(row => row.innerText))`

/** 页头那一站：`当前站台：X` 里的 X。 */
const HEADER_STATION = `JSON.stringify((() => {
  const match = /当前站台：\\s*([^\\s]+)/.exec(document.querySelector('main h2')?.innerText ?? '')
  return match ? match[1] : null
})())`

/** 最近一次读站牌读的是哪个站台（URL 里的站台 id）。 */
async function lastBoardStationId() {
  const boards = (await recordedRequests()).filter(entry => entry.url.includes('/board?'))
  const match = /\/api\/transit\/stations\/([^/]+)\/board/.exec(boards.at(-1)?.url ?? '')
  return match ? decodeURIComponent(match[1]) : null
}

/** 屏幕自己收到的站台读数（含答复，供比对用）。 */
async function receivedBoards() {
  return (await recordedRequests()).filter(entry => entry.url.includes('/board?') && entry.response?.data)
}

/** 载荷里所有车辆距本站的米数（这一屏上「距本站」唯一合法的来源）。 */
function distancesInPayload(boards) {
  const out = []
  for (const entry of boards) {
    for (const line of entry.response.data.lines ?? []) {
      for (const arrival of line.arrivals ?? []) {
        if (typeof arrival.distanceToStationMeters === 'number') out.push(arrival.distanceToStationMeters)
      }
    }
  }
  return out
}

/** 屏上的「距本站 2.4 公里 / 850 米」换成米（一位小数即 100 米的粒度）。 */
function metersOfClaim(claim) {
  const km = /距本站\s*([\d.]+)\s*公里/.exec(claim)
  if (km) return Math.round(Number(km[1]) * 1000)
  const m = /距本站\s*([\d.]+)\s*米/.exec(claim)
  if (m) return Math.round(Number(m[1]))
  return null
}

/** 元素文字归一：选单里站名与距离是两块（innerText 带换行），触发器上是一个空格。 */
function norm(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** 屏上每行的分钟数（「还有 N 分钟」/「正进站」→ 0）。 */
function minutesOfRow(text) {
  const at = /正进站/.test(text)
  if (at) return 0
  const match = /还有\s*(\d+)\s*分钟/.exec(text)
  return match ? Number(match[1]) : null
}

export async function run({ check, note }) {
  await installFetchRecorder()
  await goto(`${WEB_ORIGIN}/station-board`)
  await waitForValue(
    `JSON.stringify(document.querySelectorAll('${TRIGGER}').length)`,
    count => count === 1,
    { what: '电子站牌渲染出站台选择器', timeout: 30_000 },
  )
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/board?')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '屏幕读到过一次站台读数', timeout: 30_000 },
  )
  await delay(800)

  const station = await pageEval(TRIGGER_TEXT)
  check('站台选择器选中了一个站', typeof station === 'string' && station.length > 0, `实际 ${JSON.stringify(station)}`)
  const headerStation = await pageEval(HEADER_STATION)
  check('页头说的就是这个站台', typeof headerStation === 'string' && String(station).includes(headerStation), `选择器 ${JSON.stringify(station)}，页头 ${JSON.stringify(headerStation)}`)

  // ---- 行：来自载荷的分钟与距离 ----------------------------------------------------
  const rows = (await pageEval(ROW_TEXTS)) ?? []
  if (rows.length === 0) {
    const text = await pageEval(`JSON.stringify(document.querySelector('main')?.innerText ?? '')`)
    check(
      '没有行时屏上说的是「暂无到站信息」或读不到，而不是编一行出来',
      /暂无到站信息|未读到本站台的到站数据/.test(String(text)),
      String(text).slice(0, 120),
    )
    note('本次读到的站台上没有在途车（或上游读不到），行相关断言跳过')
  }
  else {
    const boards = await receivedBoards()
    const minutes = rows.map(minutesOfRow).filter(minute => minute !== null)
    // 每一行都必须说出点什么：有车说分钟或站数，没车说预报或「暂无到站信息」—— 空行不算说了话。
    const mute = rows.filter(row => minutesOfRow(row) === null && !/暂无到站信息|预报 |还有\s*\d+\s*站|即将到站/.test(row))
    check('没有分钟的行也说出它的处境（站数、预报或「暂无到站信息」），不留下空行', mute.length === 0, JSON.stringify(mute.slice(0, 2)))
    const stationsRows = rows.filter(row => /还有\s*\d+\s*站/.test(row)).length
    if (stationsRows > 0) note(`其中 ${stationsRows} 行没有时刻、由站数当家（「还有 N 站」）`)
    const ascending = minutes.every((minute, index) => index === 0 || minutes[index - 1] <= minute)
    check('按到站先后升序排列（哪趟先来就是这一屏的答案）', ascending, JSON.stringify(minutes))
    if (minutes.length === 0) note(`${rows.length} 行此刻都没有在途车（分钟与「距本站」的断言本次无从谈起）`)

    // 「距本站」只能来自载荷：自造一个数、或拿分钟折一个，都落不进载荷的米数里。
    const payloadDistances = distancesInPayload(boards)
    const claims = rows.flatMap(row => [...String(row).matchAll(/距本站\s*[\d.]+\s*(?:公里|米)/g)].map(match => match[0]))
    const offPayload = claims.filter((claim) => {
      const meters = metersOfClaim(claim)
      return meters === null || !payloadDistances.some(distance => Math.abs(distance - meters) <= 60)
    })
    check(
      '屏上的「距本站」是载荷里量到的米数，不是自己算出来的',
      offPayload.length === 0,
      `载荷米数 ${JSON.stringify(payloadDistances.slice(0, 6))}，落不进载荷的 ${JSON.stringify(offPayload)}`,
    )
    note(`屏上 ${rows.length} 行，其中 ${claims.length} 行带了「距本站」`)
  }

  // ---- 换站：名字与读数一起换 ------------------------------------------------------
  await cli(['click', `getByRole('button', { name: '选择站台' })`])
  await waitForValue(PANEL_COUNT, count => count > 0, { what: '选择器打开', timeout: 10_000 })
  const others = await pageEval(`JSON.stringify([...document.querySelectorAll('[role=listbox] [role=option]')]
    .filter(el => el.getBoundingClientRect().width > 0).map(el => el.innerText.trim()).filter(text => text !== ${JSON.stringify(station)}))`)
  check('列表里存在另一个站可用于切换', (others ?? []).length > 0, JSON.stringify(others))
  const target = others[0]
  await clearRecordedRequests()
  await cli(['click', `getByRole('option', { name: ${JSON.stringify(target)} })`])
  await waitForValue(PANEL_COUNT, count => count === 0, { what: '选中后面板关闭', timeout: 10_000 })
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/board?')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '换站后真的重读了站台', timeout: 30_000 },
  )
  const movedTo = await pageEval(TRIGGER_TEXT)
  check('选择器显示换过去的那个站', norm(movedTo) === norm(target), `期望 ${JSON.stringify(norm(target))}，实际 ${JSON.stringify(norm(movedTo))}`)
  const headerMoved = await pageEval(HEADER_STATION)
  check(
    '页头跟着换过去：换站不只是换了个名字',
    typeof headerMoved === 'string' && String(target).includes(headerMoved),
    `选择器 ${JSON.stringify(movedTo)}，页头 ${JSON.stringify(headerMoved)}`,
  )

  // ---- 刷新之后还看这一站：本页记住最后看的那个站台 ---------------------------------
  // 取列表的**第二个**：退回列表第一个的话，读到的会是另一个站台 id，这条就抓得到。
  await cli(['click', `getByRole('button', { name: '选择站台' })`])
  await waitForValue(PANEL_COUNT, count => count > 0, { what: '选择器打开', timeout: 10_000 })
  const listed = await pageEval(`JSON.stringify([...document.querySelectorAll('[role=listbox] [role=option]')]
    .filter(el => el.getBoundingClientRect().width > 0).map(el => el.innerText.trim()))`)
  check('列表里至少两个站，才分得清「记住的」与「列表第一个」', (listed ?? []).length >= 2, JSON.stringify(listed))
  const pinned = listed[1]
  const pinnedName = norm(pinned).split(' ')[0]

  await clearRecordedRequests()
  await cli(['click', `getByRole('option', { name: ${JSON.stringify(pinned)} })`])
  await waitForValue(PANEL_COUNT, count => count === 0, { what: '选中要固定的那个站', timeout: 10_000 })
  const pinnedId = await lastBoardStationId()
  check('选中后读到的是这个站台的站牌', Boolean(pinnedId), `站台 id ${JSON.stringify(pinnedId)}`)

  await goto(`${WEB_ORIGIN}/station-board`)
  await waitForValue(
    TRIGGER_TEXT,
    value => typeof value === 'string' && norm(value).startsWith(pinnedName),
    { what: '刷新后仍是上次看的那个站', timeout: 30_000 },
  )
  const reloadedTrigger = await pageEval(TRIGGER_TEXT)
  check(
    '刷新后回到上次看的那个站，而不是列表第一个',
    norm(reloadedTrigger).startsWith(pinnedName),
    `期望以 ${JSON.stringify(pinnedName)} 开头，实际 ${JSON.stringify(norm(reloadedTrigger))}`,
  )
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/board?')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '刷新后真的读了站牌', timeout: 30_000 },
  )
  const reloadedId = await lastBoardStationId()
  check(
    '刷新后读的还是同一个站台的站牌',
    reloadedId === pinnedId,
    `刷新前 ${JSON.stringify(pinnedId)}，刷新后 ${JSON.stringify(reloadedId)}`,
  )

  // ---- 键盘：交给 reka，在真浏览器里真的通 -----------------------------------------
  await pageEval(focusTrigger)
  await cli(['press', 'ArrowDown'])
  await delay(300)
  const afterClosedDown = await pageEval(PANEL_COUNT)
  // 现行契约：开面板走 Enter / Space 的原生激活，上/下键不做这件事。
  check('关着时上/下键不开面板：开面板是原生激活那条路', afterClosedDown === 0, `按键后面板数 ${afterClosedDown}`)

  await cli(['press', 'Enter'])
  await waitForValue(PANEL_COUNT, count => count > 0, { what: '键盘打开面板', timeout: 10_000 })
  const openedOptions = await pageEval(`JSON.stringify(document.querySelectorAll('[role=option]').length)`)
  check('Enter 打开面板并列出候选', typeof openedOptions === 'number' && openedOptions > 0, `${openedOptions} 个候选`)

  // reka 的高亮在按键之后才落到某一项上（打开那一刻还没有），故第一次下键建立高亮、第二次移动它。
  await cli(['press', 'ArrowDown'])
  await delay(300)
  const highlightedFirst = await pageEval(HIGHLIGHTED)
  check('下键建立高亮，且恰有一项（reka 的 data-highlighted）', (highlightedFirst ?? []).length === 1, JSON.stringify(highlightedFirst))

  await cli(['press', 'ArrowDown'])
  await delay(300)
  const highlightedNext = await pageEval(HIGHLIGHTED)
  check(
    '再按一次把高亮移到另一项',
    (highlightedNext ?? []).length === 1 && highlightedNext[0] !== highlightedFirst[0],
    `${JSON.stringify(highlightedFirst)} → ${JSON.stringify(highlightedNext)}`,
  )

  await clearRecordedRequests()
  await cli(['press', 'Enter'])
  await waitForValue(PANEL_COUNT, count => count === 0, { what: '回车后面板关闭', timeout: 10_000 })
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/board?')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '回车选站后真的重读了站台', timeout: 30_000 },
  )
  const afterEnter = await pageEval(TRIGGER_TEXT)
  check('回车拿走的是高亮那一项', norm(afterEnter) === norm(highlightedNext[0]), `高亮 ${JSON.stringify(highlightedNext)}，屏上 ${JSON.stringify(afterEnter)}`)
  const headerAfterEnter = await pageEval(HEADER_STATION)
  check(
    '键盘选中的那一站也进了页头',
    typeof headerAfterEnter === 'string' && String(afterEnter).includes(headerAfterEnter),
    `选择器 ${JSON.stringify(afterEnter)}，页头 ${JSON.stringify(headerAfterEnter)}`,
  )

  // Escape：关掉面板，值一动不动。
  await pageEval(focusTrigger)
  await cli(['press', 'Enter'])
  await waitForValue(PANEL_COUNT, count => count > 0, { what: '再次打开面板', timeout: 10_000 })
  const beforeEscape = await pageEval(TRIGGER_TEXT)
  await cli(['press', 'Escape'])
  await waitForValue(PANEL_COUNT, count => count === 0, { what: 'Escape 关掉面板', timeout: 10_000 })
  const afterEscape = await pageEval(TRIGGER_TEXT)
  check('Escape 关掉面板且不动值', afterEscape === beforeEscape, `${JSON.stringify(beforeEscape)} → ${JSON.stringify(afterEscape)}`)

  // ---- 刷新入口：控件，故在顶部那一行（F11）----------------------------------------
  const nativeSelects = await pageEval(`JSON.stringify([...document.querySelectorAll('main select')].length)`)
  check('电子站牌上没有原生 select', nativeSelects === 0, `还有 ${nativeSelects} 个`)

  const toolbarRow = await pageEval(`JSON.stringify((() => {
    const refresh = [...document.querySelectorAll('main button')].find(b => (b.getAttribute('aria-label') || '') === '刷新本站台到站')
    const locate = [...document.querySelectorAll('main button')].find(b => (b.getAttribute('aria-label') || '') === '定位最近站台')
    if (!refresh || !locate) return null
    const r = refresh.getBoundingClientRect()
    const l = locate.getBoundingClientRect()
    return { sameRow: Math.abs(r.top - l.top) < 2, height: Math.round(r.height), width: Math.round(r.width) }
  })())`)
  check('刷新入口在顶部那一行（与定位同排）', toolbarRow?.sameRow === true, JSON.stringify(toolbarRow))

  await clearRecordedRequests()
  await cli(['click', `getByRole('button', { name: '刷新本站台到站' })`])
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/api/transit/refresh')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '按下刷新发出了请求', timeout: 20_000 },
  )
  const refreshBody = await pageEval(`JSON.stringify((window.__e2eFetch || []).find(r => r.url.includes('/api/transit/refresh'))?.requestBody ?? null)`)
  check(
    '刷新点名的是这个站台，而不是屏幕上那几条线路',
    String(refreshBody).includes('station') && !String(refreshBody).includes('lines'),
    String(refreshBody).slice(0, 160),
  )

  // ---- 附近的站台：坐标 → 站 id，列表据此并入「附近」那些站 -------------------------
  // 这一步给浏览器一个真坐标（下面那个点），再按「定位最近站台」：附近的站台由此进列表，
  // 下拉里因此出现带「附近」的那些站（标记只标例外，故不是每一行都带）—— 这是「未关注站台也能读」那条路。
  await cli(['run-code', `async page => {
    await page.context().grantPermissions(['geolocation'])
    await page.context().setGeolocation({ latitude: ${DEVICE.lat}, longitude: ${DEVICE.lng} })
    return 'geolocation ready'
  }`])
  await goto(`${WEB_ORIGIN}/station-board`)
  await waitForValue(
    `JSON.stringify(document.querySelectorAll('${TRIGGER}').length)`,
    count => count === 1,
    { what: '给上坐标之后页面重新就位', timeout: 30_000 },
  )
  await clearRecordedRequests()
  await cli(['click', `getByRole('button', { name: '定位最近站台' })`])
  await waitForValue(
    `JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes('/stations/nearby')).length)`,
    count => typeof count === 'number' && count > 0,
    { what: '定位之后问了附近的站台', timeout: 30_000 },
  )
  const nearbyCall = await pageEval(`JSON.stringify((window.__e2eFetch || []).find(r => r.url.includes('/stations/nearby')) ?? null)`)
  check(
    '附近站台那次请求带了坐标与城市',
    /lng=[\d.]+/.test(String(nearbyCall?.url)) && /lat=[\d.]+/.test(String(nearbyCall?.url)) && /cityCode=/.test(String(nearbyCall?.url)),
    String(nearbyCall?.url).slice(0, 160),
  )
  check('附近站台读到了（200）', nearbyCall?.status === 200, `status=${nearbyCall?.status}`)

  await cli(['click', `getByRole('button', { name: '选择站台' })`])
  await waitForValue(PANEL_COUNT, count => count > 0, { what: '选择器打开（看两种标记）', timeout: 10_000 })
  const marked = await pageEval(`JSON.stringify([...document.querySelectorAll('[role=listbox] [role=option]')]
    .filter(el => el.getBoundingClientRect().width > 0).map(el => el.innerText.trim()))`)
  check(
    '下拉里标出了「附近」的站',
    (marked ?? []).some(text => text.includes('附近')),
    JSON.stringify((marked ?? []).slice(0, 6)),
  )
  // 标记只标例外：关注线路的站表里那些站不标 —— 两种来源都在列表里。
  check(
    '不是每一行都带标记（关注线路的站表那些不标）',
    (marked ?? []).some(text => !text.includes('附近')),
    JSON.stringify((marked ?? []).slice(0, 6)),
  )

  await cli(['press', 'Escape'])
}
