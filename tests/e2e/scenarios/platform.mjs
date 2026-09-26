/**
 * 站台大屏：列表在刷新中保留、时刻来自响应自身、分钟只来自点名了目标站的读数。
 *
 * 三件事各自钉一个真会做错的形状：
 *  - 「刷新每次都清空列表」—— 刷新期间屏上的行必须还在（挂给每个行元素的标记在刷新后仍在同一个
 *    DOM 节点上，比断言「页面 200」强得多：整表被卸载重挂会把标记一起丢掉）；
 *  - 「最后更新」被写成请求时刻 —— 它必须等于产出这些行的那些响应自己的 `updatedAt`；
 *  - 「预计到站」被自己估一个分钟 —— 数据源没给分钟时该行说「暂无到站耗时」，一个数字都不给。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay, clockTimeOf, recordedRequests, installFetchRecorder, clearRecordedRequests } from '../harness.mjs'
import { favorites as storedFavorites, liveOf, lineDetail } from '../fixtures.mjs'

export const name = '站台大屏'

/** 屏幕上的行：每一行都带一个终到站名。 */
const ROW_TEXTS = `JSON.stringify([...document.querySelectorAll('main div[class*=divide-y] > div')]
  .filter(row => row.innerText.includes('开往'))
  .map(row => row.innerText))`

const FRESHNESS_TIME = `JSON.stringify((() => {
  const match = /最后更新 (\\d{2}:\\d{2}:\\d{2})/.exec(document.querySelector('main')?.innerText ?? '')
  return match ? match[1] : null
})())`

/**
 * 屏幕**自己**收到的那些读数（按线路 + 方向 + 目标站序取全部）。
 *
 * 不能拿测试自己再问一次的结果来比：模拟读数每次读都不同，分钟会漂一两位，那样比的是两次读数。
 * 也不能只取最后一次：屏上的行可能来自上一次（12 秒轮询会让「最后一次」比屏幕还新），
 * 故断言的是「屏幕上的值必须出现在它收到过的某一份载荷里」，且分钟与距站数出自同一份。
 */
async function receivedReads(lineId, direction, order) {
  return (await recordedRequests()).filter(entry =>
    entry.url.includes('/live?') && entry.response?.data
    && entry.url.includes(`/${encodeURIComponent(lineId)}/live?`)
    && entry.url.includes(`direction=${direction}`)
    && entry.url.includes(`order=${order}`))
}

/** 与 `favoriteDirections` 同一条：公交两个方向各一条 lineId，地铁一条 id 服务两个方向。 */
function directionsOf(fav) {
  const primary = fav.preferredDirection === 1 ? 1 : 0
  if (fav.reverseLineId && fav.reverseLineId !== fav.lineId) {
    return [{ direction: primary, lineId: fav.lineId }, { direction: 1 - primary, lineId: fav.reverseLineId }]
  }
  return [{ direction: 0, lineId: fav.lineId }, { direction: 1, lineId: fav.lineId }]
}

/**
 * 与 `departureRowOf` 的选车规则同一条：本站台上仍在开来、且车头没越过本站的那辆车里，
 * 刚过站最靠后的那一辆。分钟只取自它自己的 `travelTimeSec`。
 */
function servedBusOf(buses, stationOrder) {
  let nearest = null
  for (const bus of buses) {
    if (typeof bus.order !== 'number') continue
    if (bus.distanceToWaitStn === -1) continue
    const heading = bus.nextOrder ?? bus.order
    if (heading > stationOrder) continue
    if (!nearest || bus.order > (nearest.order ?? 0)) nearest = bus
  }
  return nearest
}

export async function run({ check, note, fixtures }) {
  await installFetchRecorder()
  await goto(`${WEB_ORIGIN}/platform`)
  await waitForValue(
    ROW_TEXTS,
    rows => Array.isArray(rows) && rows.length > 0,
    { what: '站台大屏渲染出行', timeout: 30_000 },
  )

  const station = await pageEval('JSON.stringify(document.querySelector("main select")?.value ?? null)')
  check('站台选择器选中了一个站', typeof station === 'string' && station.length > 0, `实际 ${JSON.stringify(station)}`)

  const favs = await storedFavorites()
  const cityFavs = favs.filter(f => f.cityCode === fixtures.city)

  // 屏幕上每一行背后的规则：某条线路某个方向，以及本站它在那个方向上的站序。
  const rules = []
  for (const fav of cityFavs) {
    for (const { direction, lineId } of directionsOf(fav)) {
      const detail = await lineDetail(lineId, direction)
      const stop = detail.stops.find(s => s.name === station)
      if (stop) rules.push({ lineId, lineName: fav.lineName, direction, stationOrder: stop.order, terminal: detail.directionName })
    }
  }
  note(`站台 ${station} 上的规则：${JSON.stringify(rules.map(r => `${r.lineId}#${r.direction}@${r.stationOrder}`))}`)
  check('本站台至少有一条已关注线路经过', rules.length > 0, `规则 ${rules.length} 条`)

  // ---- 真实读数：屏幕上的每个值都必须出现在它收到过的某一份载荷里 ------------------
  const rows = await pageEval(ROW_TEXTS)
  const received = []
  for (const rule of rules) {
    const answers = await receivedReads(rule.lineId, rule.direction, rule.stationOrder)
    const pairs = answers.map((entry) => {
      const bus = servedBusOf(entry.response.data.buses ?? [], rule.stationOrder)
      if (!bus || typeof bus.travelTimeSec !== 'number') return null
      return {
        minutes: Math.max(1, Math.round(bus.travelTimeSec / 60)),
        stopsAway: Math.max(1, rule.stationOrder - (bus.nextOrder ?? bus.order)),
      }
    }).filter(Boolean)
    received.push({ ...rule, answers: answers.length, pairs })
    note(`${rule.lineName} ${rule.terminal}：收到 ${answers.length} 次读数，载荷里的行 ${JSON.stringify(pairs)}`)
    check(`屏幕确实收到了「${rule.lineName} ${rule.terminal}」的读数`, answers.length > 0, `${rule.lineId} direction=${rule.direction}`)
  }
  note(`屏幕上的行：${JSON.stringify(rows)}`)

  const withMinutes = received.filter(row => row.pairs.length > 0)
  check('载荷里至少有一行给了分钟（否则下面的断言无从谈起）', withMinutes.length > 0, JSON.stringify(received))
  for (const row of withMinutes) {
    const shown = (rows ?? []).find(text => text.split('\n')[0] === row.lineName && text.includes(row.terminal))
    // 分钟与距站数必须来自**同一份**载荷：混着两次读数的行会在下面失败。
    const matched = row.pairs.some(pair => typeof shown === 'string'
      && shown.includes(`${pair.minutes} 分钟`) && shown.includes(`距 ${pair.stopsAway} 站`))
    check(
      `「${row.lineName} ${row.terminal}」的分钟与距站数来自它收到过的那一份载荷`,
      matched,
      `载荷里的行 ${JSON.stringify(row.pairs)}，屏幕：${JSON.stringify(shown)}`,
    )
  }

  const minutesShown = (rows ?? [])
    .map(text => /(\d+)\s*分钟/.exec(text)?.[1])
    .filter(Boolean)
    .map(Number)
  const ascending = minutesShown.every((value, index) => index === 0 || minutesShown[index - 1] <= value)
  check('按预计到站升序排列', ascending, `屏幕上的分钟序列 ${JSON.stringify(minutesShown)}`)

  const reads = (await recordedRequests()).filter(r => r.url.includes('/live?'))
  const namedTarget = reads.filter(r => /[?&]order=\d+/.test(r.url))
  note(`屏幕发过的实时读数：${reads.length} 次，其中点名目标站 ${namedTarget.length} 次`)
  check('屏幕的实时读数点名了目标站（分钟正是它带来的）', namedTarget.length === reads.length && reads.length > 0, JSON.stringify(reads.map(r => r.url)))

  // ---- 「最后更新」= 响应自己的 updatedAt（用一份规定的载荷来分辨它与本机时钟）--------
  //
  // 真实应答的戳就盖在请求的那一刻，与「用本机时钟打戳」一秒之内，断言分不开两者；
  // 故这里把应答换成一份时间戳在 20 分钟前的载荷：屏幕若印出墙上的钟，就一定不是它。
  const STAMP = Date.now() - 20 * 60 * 1000
  const travelSeconds = 481
  const routePattern = '**/api/transit/lines/*/live**'
  const fixedBody = buses => JSON.stringify({
    success: true,
    data: {
      lineId: rules[0].lineId,
      direction: rules[0].direction,
      buses,
      dataSource: 'chelaile',
      isDegraded: false,
      updatedAt: STAMP,
    },
  })

  await cli(['route', routePattern, '--body', fixedBody([
    { id: 'e2e-priced', order: 1, nextOrder: 2, travelTimeSec: travelSeconds, congestion: 'low', updatedAt: STAMP },
  ])])
  try {
    await goto(`${WEB_ORIGIN}/platform`)
    await waitForValue(
      FRESHNESS_TIME,
      time => time === clockTimeOf(STAMP),
      { what: '新鲜度行印出响应自己的时刻', timeout: 25_000 },
    )
    const fixedRows = await waitForValue(
      ROW_TEXTS,
      rows => Array.isArray(rows) && rows.length > 0,
      { what: '规定载荷下的行', timeout: 20_000 },
    )
    const expectedMinutes = Math.max(1, Math.round(travelSeconds / 60))
    for (const text of fixedRows) {
      check(
        `每一行的分钟都是载荷里那辆车的分钟（${expectedMinutes} 分钟）`,
        text.includes(`${expectedMinutes} 分钟`),
        `屏幕：${JSON.stringify(text)}`,
      )
    }
    check(
      '「最后更新」是响应自己的 updatedAt，不是请求那一刻的钟',
      await pageEval(FRESHNESS_TIME) === clockTimeOf(STAMP),
      `响应戳 ${clockTimeOf(STAMP)}，本机钟 ${clockTimeOf(Date.now())}`,
    )
    check(
      '响应戳与本机钟确实不同（这条断言因此能分辨两者）',
      clockTimeOf(STAMP) !== clockTimeOf(Date.now()),
      `两者都是 ${clockTimeOf(STAMP)}`,
    )
  }
  finally {
    await cli(['unroute', routePattern])
  }

  // ---- 数据源没给分钟：一个数字都不许给 -----------------------------------------
  await cli(['route', routePattern, '--body', fixedBody([
    { id: 'e2e-unpriced', order: 1, nextOrder: 2, congestion: 'high', updatedAt: STAMP },
  ])])
  try {
    await goto(`${WEB_ORIGIN}/platform`)
    const rowsMocked = await waitForValue(
      ROW_TEXTS,
      rows => Array.isArray(rows) && rows.some(text => text.includes('无法估算')),
      { what: '没给分钟的行说出「无法估算」', timeout: 25_000 },
    )
    const unavailableRow = rowsMocked.find(text => text.includes('无法估算'))
    check('数据源没给分钟：该行说「暂无到站耗时」', unavailableRow.includes('暂无到站耗时'), JSON.stringify(unavailableRow))
    check('数据源没给分钟：该行不印分钟数字', !/\d+\s*分钟/.test(unavailableRow), JSON.stringify(unavailableRow))
    check('数据源没给分钟：该行的拥挤度仍来自载荷（高）', unavailableRow.includes('拥挤'), JSON.stringify(unavailableRow))
  }
  finally {
    await cli(['unroute', routePattern])
  }

  // 同一个事实在接口那一侧：不点名目标站的读数，一辆车都不会带上分钟。
  const noTarget = await liveOf(rules[0].lineId, rules[0].direction)
  const anyMinutes = (noTarget.buses ?? []).some(bus => typeof bus.travelTimeSec === 'number')
  check('不点名目标站的读数不带分钟（分钟只由点名了目标站的那次读取带来）', anyMinutes === false, JSON.stringify(noTarget.buses))

  // ---- 刷新不清空列表 -----------------------------------------------------------
  const tagged = await pageEval(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('main div[class*=divide-y] > div')].filter(d => d.innerText.includes('开往'))
    rows.forEach((el, index) => { el.dataset.e2eRow = String(index) })
    return rows.length
  })())`)
  check('刷新前屏上有多行', tagged > 0, `标记了 ${tagged} 行`)

  await clearRecordedRequests()
  await cli(['click', `getByRole('button', { name: '刷新车况数据' })`])
  await waitForValue(
    'JSON.stringify((window.__e2eFetch || []).filter(r => r.url.includes("/live?")).length)',
    count => typeof count === 'number' && count > 0,
    { what: '刷新真的重读了实时数据', timeout: 20_000 },
  )
  await delay(1500)
  const survived = await pageEval(`JSON.stringify([...document.querySelectorAll('[data-e2e-row]')]
    .filter(el => el.isConnected && el.innerText.includes('开往')).length)`)
  check(
    '刷新期间屏上的行留在同一个 DOM 节点上（列表没有被清空重建）',
    survived === tagged,
    `刷新前 ${tagged} 行，刷新后仍在原节点上的 ${survived} 行`,
  )
  const rowsAfter = await pageEval(ROW_TEXTS)
  check('刷新之后屏上的行数与内容仍成立', (rowsAfter ?? []).length === tagged, `${(rowsAfter ?? []).length} 行`)
}
