/**
 * 首页卡片：屏幕上的车辆与分钟，逐张对着接口载荷比。
 *
 * 三条断言分别钉一件真会做错的事：
 *  - 分钟取整错一位，或把别的车/别的方向的分钟充数；
 *  - 车辆角标与它那一行读到的行数不一致；
 *  - 数据源没给分钟时自己编一个（「暂无到站耗时」而不是一个数字）。
 *
 * 「载荷」取的是**页面自己收到的那一份**（fetch 记录器抓的到站应答），不是测试再问一次的结果：
 * 首页每 10 秒重读一次，模拟读数每次读都不同，拿后来那一次比就把「屏幕与它收到的载荷」换成了
 * 「两次读数」。因此断言是「屏幕上的分钟与距站数必须同时出现在它收到过的某一份载荷里」。
 *
 * 第三种用一次 `route` 拦到站请求来演示：载荷换成「车在途但没给到站时间」的形状 ——
 * 那正是服务端对无法估价的车辆下发的样子（`vehicleArrivals` 的缺分钟分支）。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, clockTimeOf, recordedRequests, installFetchRecorder } from '../harness.mjs'
import { lineDetail } from '../fixtures.mjs'

export const name = '首页卡片'

/** 卡片网格的直接子元素就是一张卡片；按线路名定位，不按下标。 */
const CARD_INDEX = name => `JSON.stringify([...document.querySelectorAll('main div.grid > div')]
  .findIndex(card => card.querySelector('span')?.textContent.trim() === ${JSON.stringify(name)}))`

const CARD_TEXT = name => `JSON.stringify([...document.querySelectorAll('main div.grid > div')]
  .find(card => card.querySelector('span')?.textContent.trim() === ${JSON.stringify(name)})?.innerText ?? null)`

/** 页面为「某线路 + 某站序」收到过的全部到站应答。 */
async function receivedArrivals(lineId, order) {
  const orderPattern = new RegExp(`[?&]order=${order}(&|$)`)
  return (await recordedRequests()).filter(entry =>
    entry.url.includes('/arrivals?') && entry.response?.data
    && entry.url.includes(`/${encodeURIComponent(lineId)}/stations/`)
    && orderPattern.test(entry.url))
}

/** 运营状态到那行字：与服务端 `operatingTextOf` 同一条规则（有分钟时才轮到它说话）。 */
function operatingTextOf(status) {
  if (!status) return '暂无来车'
  if (status.state === 'before_first') return status.firstDeparture ? `未到首班 · 首班 ${status.firstDeparture}` : '未到首班'
  if (status.state === 'after_last') return status.lastDeparture ? `已过末班 · 末班 ${status.lastDeparture}` : '已过末班'
  if (status.state === 'operating') return '运营中 · 暂无来车'
  return '运营时间未知 · 暂无来车'
}

export async function run({ check, equal, note, fixtures }) {
  const a = fixtures.favorites.a
  const b = fixtures.favorites.b
  const c = fixtures.favorites.c

  await installFetchRecorder()
  await goto(`${WEB_ORIGIN}/`)
  await waitForValue(
    `JSON.stringify(document.querySelectorAll('main div.grid > div').length)`,
    length => length === 3,
    { what: '三张关注线路卡片', timeout: 25_000 },
  )

  const modeLine = await pageEval('JSON.stringify(document.querySelector("main")?.innerText.includes("🏠 上班"))')
  check('时段覆盖此刻时卡片处于上班模式', modeLine === true, `实际 ${modeLine}`)

  // ---- A：分钟与「接口载荷一致」------------------------------------------------
  const answersA = await receivedArrivals(a.line.upLineId, a.boardStop.order)
  const rowsA = answersA.map(entry => entry.response.data.arrivals ?? [])
  const leadingA = rowsA[rowsA.length - 1]?.[0]
  const textA = await pageEval(CARD_TEXT(a.line.lineName))
  check('卡片 A 渲染出来了', typeof textA === 'string', `实际 ${JSON.stringify(textA)}`)
  check('页面收到了卡片 A 的到站载荷', answersA.length > 0, `收到 ${answersA.length} 次`)
  note(`卡片 A 收到的载荷（最后一次）：${JSON.stringify(leadingA)}，共 ${answersA.length} 次读数`)

  if (leadingA) {
    // 屏幕上的分钟与距站数必须同时出现在**同一份**收到的载荷里（混着两次读数的行会失败）。
    // 后续那几行也要能对上：一个列表展示的是一份载荷，不是两次读数的拼盘。
    const expectations = rowsA.map(rows => ({
      leading: typeof rows[0]?.etaSeconds === 'number'
        ? `${Math.max(1, Math.round(rows[0].etaSeconds / 60))}\n分钟后到站`
        : null,
      stops: `${rows[0]?.stopsAway} 站`,
      subsequent: rows.slice(1)
        .filter(row => typeof row.etaSeconds === 'number')
        .map(row => `${Math.max(1, Math.round(row.etaSeconds / 60))}分`),
    }))
    const matched = expectations.some(expectation => expectation.leading !== null
      && String(textA).includes(expectation.leading)
      && String(textA).includes(`距 ${expectation.stops}`)
      && expectation.subsequent.every(text => String(textA).includes(text)))
    check(
      '卡片 A 显示的每一个数字都来自它收到过的那一份载荷',
      matched,
      `载荷里的行 ${JSON.stringify(rowsA.map(rows => rows[0]).slice(0, 3))}，卡片文本：${JSON.stringify(textA)}`,
    )
    const counts = rowsA.map(rows => rows.length)
    check(
      '卡片 A 的车辆角标与它那一行读到的行数一致',
      counts.some(count => String(textA).includes(count > 0 ? `前方 ${count} 辆` : '前方暂无来车')),
      `载荷里的行数 ${JSON.stringify(counts)}，卡片文本：${JSON.stringify(textA)}`,
    )
  }
  else {
    // 数据源没给这一辆车分钟：卡片就必须说「暂无到站耗时」，而不是印一个数字。
    check('载荷没给分钟时卡片说「暂无到站耗时」', String(textA).includes('暂无到站耗时'), `卡片文本：${JSON.stringify(textA)}`)
    check('载荷没给分钟时卡片没有分钟数字', !/\d+\s*分钟后到站/.test(String(textA)), `卡片文本：${JSON.stringify(textA)}`)
  }

  // ---- B：这个方向没有车来（首站）→ 一个数字都不许有 ------------------------------
  const answersB = await receivedArrivals(b.line.upLineId, b.boardStop.order)
  const lastB = answersB[answersB.length - 1]?.response?.data
  const textB = await pageEval(CARD_TEXT(b.line.lineName))
  note(`卡片 B 收到的载荷（最后一次）：arrivals=${(lastB?.arrivals ?? []).length}，运营状态 ${JSON.stringify(lastB?.operatingStatus)}`)
  check('页面收到了卡片 B 的到站载荷', Boolean(lastB), `收到 ${answersB.length} 次`)
  equal('卡片 B 的载荷确实没有来车', lastB?.arrivals ?? [], [])
  check(
    '没有来车时卡片显示该方向的运营事实，而不是一个数字',
    String(textB).includes(operatingTextOf(lastB?.operatingStatus)),
    `期望包含「${operatingTextOf(lastB?.operatingStatus)}」，卡片文本：${JSON.stringify(textB)}`,
  )
  check(
    '没有来车时卡片不含任何「N 分钟后到站」',
    !/\d+\s*分钟后到站/.test(String(textB)),
    `卡片文本：${JSON.stringify(textB)}`,
  )

  // ---- C：上游没给分钟（车在途，却没有到站时间）→ 不许编造 ------------------------
  const cPath = `/api/transit/lines/${encodeURIComponent(c.line.upLineId)}/stations/`
  await cli(['route', `**${cPath}**`, '--body', JSON.stringify({
    success: true,
    data: {
      isExact: false,
      arrivals: [{ stopsAway: 3, distanceMeters: 1200, busId: 'e2e-unpriced', provenance: null }],
      operatingStatus: { state: 'operating', firstDeparture: '05:00', lastDeparture: '23:00' },
      note: null,
      reference: null,
    },
  })])
  try {
    await goto(`${WEB_ORIGIN}/`)
    const cardC = await waitForValue(
      CARD_TEXT(c.line.lineName),
      text => typeof text === 'string' && text.includes('暂无到站耗时'),
      { what: '卡片 C 说出「暂无到站耗时」', timeout: 25_000 },
    )
    check(
      '车在途但数据源没给分钟：卡片说「暂无到站耗时」',
      String(cardC).includes('暂无到站耗时'),
      `卡片文本：${JSON.stringify(cardC)}`,
    )
    check(
      '车在途但数据源没给分钟：卡片不印分钟',
      !/\d+\s*分钟后到站/.test(String(cardC)),
      `卡片文本：${JSON.stringify(cardC)}`,
    )
    check(
      '那一行仍陈述它知道的：距 3 站',
      String(cardC).includes('距 3 站'),
      `卡片文本：${JSON.stringify(cardC)}`,
    )
  }
  finally {
    await cli(['unroute', `**${cPath}**`])
  }

  // ---- 能点进详情 -------------------------------------------------------------
  const detail = await lineDetail(a.line.upLineId, 0)
  const index = await pageEval(CARD_INDEX(a.line.lineName))
  check('卡片 A 在网格里有位置', index >= 0, `下标 ${index}`)
  await cli(['click', `main div.grid > div:nth-child(${index + 1})`])
  await waitForValue(
    'JSON.stringify(location.pathname + location.search)',
    url => typeof url === 'string' && url.startsWith(`/line/${a.line.upLineId}`),
    { what: '进入线路详情', timeout: 20_000 },
  )
  const url = await pageEval('JSON.stringify(location.pathname + location.search)')
  check(
    '点卡片进入的是那张卡片的线路与方向',
    String(url).startsWith(`/line/${a.line.upLineId}`) && String(url).includes('direction=0'),
    `实际 ${url}`,
  )
  const shownName = await pageEval(`JSON.stringify(document.body.innerText.includes(${JSON.stringify(detail.lineName)}))`)
  check('详情页显示的是这条线路', shownName === true, `期望页面含「${detail.lineName}」`)
  const shownDirection = await pageEval(`JSON.stringify(document.body.innerText.includes(${JSON.stringify(detail.directionName)}))`)
  check('详情页显示的是这个方向的终点', shownDirection === true, `期望页面含「${detail.directionName}」`)
  note(`卡片 A 点击前时间戳 ${clockTimeOf(Date.now())}`)
}
