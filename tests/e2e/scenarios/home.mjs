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
const CARD_INDEX = name => `JSON.stringify([...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')]
  .findIndex(card => card.querySelector('span')?.textContent.trim() === ${JSON.stringify(name)}))`

const CARD_TEXT = name => `JSON.stringify([...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')]
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
    `JSON.stringify(document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]').length)`,
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
    // 已到站的行（isAtStation）按契约显示「正在进站」且不给距站数，断言要跟着它走。
    const atStation = row => row?.isAtStation === true || (row?.etaSeconds === 0 && row?.stopsAway === 0)
    const expectations = rowsA.map(rows => ({
      leading: atStation(rows[0])
        ? '正在进站'
        : (typeof rows[0]?.etaSeconds === 'number'
            ? `${Math.max(1, Math.round(rows[0].etaSeconds / 60))}\n分钟后到站`
            : null),
      stops: atStation(rows[0]) ? null : `${rows[0]?.stopsAway} 站`,
      subsequent: rows.slice(1)
        .filter(row => typeof row.etaSeconds === 'number' && !atStation(row))
        .map(row => `${Math.max(1, Math.round(row.etaSeconds / 60))}分`),
    }))
    const matched = expectations.some(expectation => expectation.leading !== null
      && String(textA).includes(expectation.leading)
      && (expectation.stops === null || String(textA).includes(`距 ${expectation.stops}`))
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

  // ---- 置顶：Vue TransitionGroup 的 move 真的「走过去」，且结束后清掉 move class --------
  // 这一条只有浏览器做得了。顺序对不等于动画存在：这里必须读到多个中间位置，且确认它是 Vue
  // 的 move class 在过渡；手动 FLIP 已删除，不能再把坐标测量钩子当验收前提。
  //
  // 必须在**单列**下量。夹具只有三条关注，宽屏一屏一行摆完，三张卡的纵坐标相同，卡片纵向上根本
  // 没动过 —— 那样的断言抓不到任何东西（没有位移的动画也「没有瞬移」）。
  const cardIds = `JSON.stringify([...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')]
    .map(c => c.getAttribute('data-favorite-id')))`
  const idsBefore = await pageEval(cardIds)
  const pinnedId = idsBefore[idsBefore.length - 1]
  const viewportBefore = await pageEval('JSON.stringify([window.innerWidth, window.innerHeight])')

  await cli(['resize', '375', '800'])
  await waitForValue('JSON.stringify(window.innerWidth)', w => w === 375, { what: '切到单列视口' })
  const idsInColumn = await pageEval(cardIds)
  check(
    '单列下三条关注都在（否则下面几条没得量）',
    idsInColumn.length === idsBefore.length && idsInColumn[idsInColumn.length - 1] === pinnedId,
    `单列 ${JSON.stringify(idsInColumn)}，宽屏 ${JSON.stringify(idsBefore)}`,
  )

  await pageEval(`(() => {
    const cards = () => [...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')]
    const el = cards().find(c => c.getAttribute('data-favorite-id') === ${JSON.stringify(pinnedId)})
    const startTop = Math.round(el.getBoundingClientRect().top)
    const samples = []
    const began = performance.now()
    ;[...el.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('置顶')).click()
    const step = () => {
      const now = cards().find(c => c.getAttribute('data-favorite-id') === ${JSON.stringify(pinnedId)})
      if (now) samples.push(Math.round(now.getBoundingClientRect().top))
      if (performance.now() - began < 900) requestAnimationFrame(step)
      else {
        const settled = cards().find(c => c.getAttribute('data-favorite-id') === ${JSON.stringify(pinnedId)})
        window.__pinProbe = {
          startTop,
          samples,
          settledTop: Math.round(settled.getBoundingClientRect().top),
          settledTransform: getComputedStyle(settled).transform,
          settledClass: settled.className,
          firstId: cards()[0].getAttribute('data-favorite-id'),
        }
      }
    }
    requestAnimationFrame(step)
    return JSON.stringify(true)
  })()`)

  const probe = await waitForValue(
    'JSON.stringify(window.__pinProbe ?? null)',
    v => v && Array.isArray(v.samples) && v.samples.length > 5,
    { what: '置顶动画采样完成', timeout: 15_000 },
  )
  check(
    '置顶确实把它挪到了另一行（故下面几条不是空转）',
    Math.abs(probe.startTop - probe.settledTop) > 40,
    `起点 top ${probe.startTop}，终点 top ${probe.settledTop}`,
  )
  const distinctPositions = new Set(probe.samples).size
  check(
    '置顶时 Vue move transition 给出中间位置（没有瞬移）',
    distinctPositions >= 4,
    `不同 top ${distinctPositions} 个，采样 ${probe.samples.slice(0, 10).join(',')}`,
  )
  check(
    '置顶后它落到首位',
    probe.firstId === pinnedId,
    `首位是 ${probe.firstId}`,
  )
  check(
    '动画结束后不留下残留的 transform 或 move class',
    probe.settledTransform === 'none' && !String(probe.settledClass).includes('favorite-reorder-move'),
    `transform=${probe.settledTransform}，class=${probe.settledClass}`,
  )
  const idsAfter = await pageEval(cardIds)
  check(
    '顺序确实变了（故上面几条不是空转）',
    String(idsAfter[0]) === String(pinnedId) && idsAfter[idsAfter.length - 1] !== pinnedId,
    `置顶前 ${JSON.stringify(idsBefore)}，置顶后 ${JSON.stringify(idsAfter)}`,
  )

  // 收尾：取消置顶，把这个库恢复成测试进来时的样子，视口也还原。
  await pageEval(`(() => {
    const el = [...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')]
      .find(c => c.getAttribute('data-favorite-id') === ${JSON.stringify(pinnedId)})
    ;[...el.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('取消置顶')).click()
    return JSON.stringify(true)
  })()`)
  await waitForValue(cardIds, ids => ids[0] !== pinnedId, { what: '取消置顶生效', timeout: 15_000 })
  await cli(['resize', String(viewportBefore[0]), String(viewportBefore[1])])
  await waitForValue('JSON.stringify(window.innerWidth)', w => w === viewportBefore[0], { what: '还原视口' })

  // ---- 深色面板必须吃掉余下高度 -------------------------------------------------
  // 同一行卡片被网格拉成等高，富余高度若落在面板外面就露出浅色底 —— 卡片深浅两块的比例随邻居而变。
  //
  // 「各卡的缝是否齐平」这一条本身就抓得住回归：拿掉内容面板的 `grow` 后实测各卡的缝变成
  // [30, 116, 65]（夹具里的卡内容量本来就不同）。下面那对探针再把这条路走死 —— 它自己造出
  // 「同排有更高的卡」这个条件，故不依赖夹具恰好排成什么样。
  async function stretchProbe(index, extra) {
    return pageEval(`(() => {
      const card = [...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')][${index}]
      const root = card.querySelector(':scope > [data-favorite-card]')
      const link = root.querySelector(':scope > a')
      const panel = [...link.children].find(c => (c.className || '').includes('bg-slate-950'))
      const bar = root.querySelector(':scope > div.border-t')
      const read = () => ({
        h: Math.round(card.getBoundingClientRect().height),
        panelH: Math.round(panel.getBoundingClientRect().height),
        gap: Math.round(bar.getBoundingClientRect().top - panel.getBoundingClientRect().bottom),
      })
      const before = read()
      card.style.minHeight = (before.h + ${extra}) + 'px'
      const after = read()
      card.style.minHeight = ''
      return JSON.stringify({ before, after })
    })()`)
  }

  const cardsSeen = await pageEval(`JSON.stringify([...document.querySelectorAll('main div.grid.grid-cols-1 > div[data-favorite-id]')].map(card => {
    const root = card.querySelector(':scope > [data-favorite-card]')
    const link = root ? root.querySelector(':scope > a') : null
    const panel = link ? [...link.children].find(c => (c.className || '').includes('bg-slate-950')) : null
    const bar = root ? root.querySelector(':scope > div.border-t') : null
    return {
      panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      gap: panel && bar ? Math.round(bar.getBoundingClientRect().top - panel.getBoundingClientRect().bottom) : null,
    }
  }))`)
  check('每张卡都有深色面板', cardsSeen.every(c => c.panelH !== null), JSON.stringify(cardsSeen))
  check(
    '各卡的深色面板都撑到操作栏前同一个位置',
    Math.max(...cardsSeen.map(c => c.gap)) - Math.min(...cardsSeen.map(c => c.gap)) <= 1,
    `各卡的缝：${JSON.stringify(cardsSeen.map(c => c.gap))}`,
  )

  const STRETCH = 90
  const stretched = await stretchProbe(0, STRETCH)
  check(
    '卡片被拉高时，多出来的高度落进深色面板里',
    stretched.after.panelH - stretched.before.panelH === STRETCH,
    `面板 ${stretched.before.panelH} → ${stretched.after.panelH}，卡高 ${stretched.before.h} → ${stretched.after.h}`,
  )
  check(
    '拉高之后面板与操作栏之间没有多出浅色缝',
    stretched.after.gap === stretched.before.gap,
    `缝 ${stretched.before.gap} → ${stretched.after.gap}`,
  )

  // ---- 能点进详情 -------------------------------------------------------------
  const detail = await lineDetail(a.line.upLineId, 0)
  const index = await pageEval(CARD_INDEX(a.line.lineName))
  check('卡片 A 在网格里有位置', index >= 0, `下标 ${index}`)
  await cli(['click', `main div.grid.grid-cols-1 > div[data-favorite-id]:nth-child(${index + 1})`])
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
