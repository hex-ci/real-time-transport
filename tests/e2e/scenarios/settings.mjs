/**
 * 设置页：四个子页可达、链路列表拖动排序后顺序保持、站点选择器带直线距离与「最近」标记、
 * 移动端线路详情头部有上下班方向标识。
 *
 * 「拖动排序后顺序保持」是这一页真正会坏的那件事：拖动是**存储顺序**的编辑，
 * 故断言分三处落：拖完当场看到的顺序、刷新之后仍然的顺序、以及服务端 GET 回来的顺序。
 * 只断言第一处的实现会在「拖完就弹回」时依然通过。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay } from '../harness.mjs'
import { storedChains, lineDetail, favorites as storedFavorites } from '../fixtures.mjs'

export const name = '设置页'

const CHAIN_NAMES = `JSON.stringify([...document.querySelectorAll('[data-drag-handle]')]
  .map(handle => handle.closest('li')?.querySelector('a')?.innerText.split('\\n')[0] ?? null))`

/** 拖拽抓手与目标行的中心点（视口坐标）。 */
const HANDLE_POINTS = `JSON.stringify([...document.querySelectorAll('[data-drag-handle]')].map(handle => {
  const rect = handle.getBoundingClientRect()
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
}))`

/** 用真实鼠标事件拖一次（SortableJS 认的是按压—移动—释放）。 */
async function dragOnto(from, to) {
  await cli(['mousemove', String(from.x), String(from.y)])
  await cli(['mousedown'])
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
    await cli(['mousemove', String(x), String(y)])
    await delay(60)
  }
  await cli(['mouseup'])
  await delay(800)
}

export async function run({ check, equal, note, fixtures }) {
  // ---- 四个子页可达 -------------------------------------------------------------
  await goto(`${WEB_ORIGIN}/settings`)
  await waitForValue(
    `JSON.stringify([...document.querySelectorAll('main a[href^="/settings/"]')].map(a => a.getAttribute('href')))`,
    hrefs => Array.isArray(hrefs) && hrefs.length === 4,
    { what: '设置索引的四行', timeout: 20_000 },
  )
  const rows = await pageEval(`JSON.stringify([...document.querySelectorAll('main a[href^="/settings/"]')]
    .map(a => ({ href: a.getAttribute('href'), text: a.innerText.split('\\n')[0] })))`)
  equal('索引列出四个域（通勤链路紧跟关注线路）', rows.map(r => r.href), ['/settings/lines', '/settings/chains', '/settings/schedule', '/settings/anchors'])
  note(`四个域：${JSON.stringify(rows.map(r => r.text))}`)

  const EXPECTED_HEADING = {
    '/settings/lines': '关注线路',
    '/settings/schedule': '通勤时段',
    '/settings/anchors': '位置锚点',
    '/settings/chains': '通勤链路',
  }
  for (const [href, heading] of Object.entries(EXPECTED_HEADING)) {
    await goto(`${WEB_ORIGIN}${href}`)
    const rendered = await waitForValue(
      `JSON.stringify(document.querySelector('main h2')?.textContent ?? null)`,
      text => String(text).includes(heading),
      { what: `${href} 的标题`, timeout: 20_000 },
    )
    check(`${href} 渲染出自己的标题「${heading}」`, String(rendered).includes(heading), `实际 ${JSON.stringify(rendered)}`)
    const stillLit = await pageEval(`JSON.stringify([...document.querySelectorAll('header a, nav a')]
      .filter(a => a.getAttribute('aria-current') === 'page' || a.className.includes('cyan'))
      .map(a => a.getAttribute('href')))`)
    check(`${href} 上顶部导航仍点亮设置项`, JSON.stringify(stillLit).includes('"/settings"'), `实际 ${JSON.stringify(stillLit)}`)
  }

  // ---- 链路列表拖动排序后顺序保持 -----------------------------------------------
  await goto(`${WEB_ORIGIN}/settings/chains`)
  const before = await waitForValue(
    CHAIN_NAMES,
    names => Array.isArray(names) && names.length === 2,
    { what: '两条链路', timeout: 25_000 },
  )
  equal('列表按存储顺序渲染（夹具的录入顺序）', before, [fixtures.chains.morning.name, fixtures.chains.evening.name])

  const points = await pageEval(HANDLE_POINTS)
  check('两条链路各有一个拖拽抓手', points.length === 2, JSON.stringify(points))
  // 把第二条拖到第一条的格子上：顺序应当整体反过来。
  await dragOnto(points[1], { x: points[0].x, y: points[0].y - 6 })

  const dragged = await pageEval(CHAIN_NAMES)
  equal('拖完当场看到的顺序就是新顺序', dragged, [fixtures.chains.evening.name, fixtures.chains.morning.name])

  await goto(`${WEB_ORIGIN}/settings/chains`)
  const afterReload = await waitForValue(
    CHAIN_NAMES,
    names => Array.isArray(names) && names.length === 2,
    { what: '刷新后的两条链路', timeout: 25_000 },
  )
  equal('刷新之后仍是新顺序（顺序被写下来了）', afterReload, [fixtures.chains.evening.name, fixtures.chains.morning.name])

  const stored = await storedChains()
  equal('服务端存下的顺序也是新顺序', stored.map(c => c.name), [fixtures.chains.evening.name, fixtures.chains.morning.name])
  equal('拖动只改顺序，没碰链路的别的内容', stored.map(c => c.purpose).sort(), ['evening', 'morning'])

  // ---- 两个域都是「列表页 + 独立编辑页」 ------------------------------------------
  // 这一层真正会坏的是**入口的形状**：行不再是就地展开，而是一条通往自己那一页的链接；
  // 行内一旦又长出编辑控件，界面就回到了搬动之前的样子。
  const ROW_SHAPE = `JSON.stringify([...document.querySelectorAll('main ul > li')].map(li => ({
    href: li.querySelector('a')?.getAttribute('href') ?? null,
    controls: li.querySelectorAll('input, [role=combobox], [data-chain-leg]').length,
    handleInsideLink: (() => {
      const handle = li.querySelector('[data-drag-handle]')
      const link = li.querySelector('a')
      return handle && link ? link.contains(handle) : null
    })(),
  })))`

  await goto(`${WEB_ORIGIN}/settings/lines`)
  const favRows = await waitForValue(
    ROW_SHAPE,
    rows => Array.isArray(rows) && rows.length === 3,
    { what: '关注线路的三行', timeout: 25_000 },
  )
  check('关注行整行是通往自己那一页的链接', favRows.every(r => r.href?.startsWith('/settings/lines/')), JSON.stringify(favRows.map(r => r.href)))
  check('关注行里没有编辑控件（编辑器搬到了独立页）', favRows.every(r => r.controls === 0), JSON.stringify(favRows.map(r => r.controls)))
  check('拖拽手柄不在链接里（点行才进编辑）', favRows.every(r => r.handleInsideLink === false), JSON.stringify(favRows.map(r => r.handleInsideLink)))
  const favListText = await pageEval(`JSON.stringify(document.querySelector('main').innerText)`)
  check('取消关注不在列表页上', !String(favListText).includes('取消关注'), '列表页出现了取消关注')

  await goto(`${WEB_ORIGIN}${favRows[0].href}`)
  const favEditor = await waitForValue(
    `JSON.stringify(document.querySelector('main').innerText)`,
    text => String(text).includes('编辑 '),
    { what: '关注线路的编辑页', timeout: 25_000 },
  )
  check('关注编辑页有保存与取消关注', String(favEditor).includes('保存') && String(favEditor).includes('取消关注'), String(favEditor).slice(0, 120))
  check('关注编辑页有回到列表的出路', String(favEditor).includes('返回关注线路'), String(favEditor).slice(0, 120))

  // 认不出的 id 不发明默认值：不说成某一条，也不渲染成列表。
  await goto(`${WEB_ORIGIN}/settings/lines/not-a-real-favorite`)
  const favMissing = await waitForValue(
    `JSON.stringify(document.querySelector('main').innerText)`,
    text => String(text).includes('不存在'),
    { what: '认不出的关注 id 的答复', timeout: 20_000 },
  )
  check('认不出的关注 id 说「这条关注不存在」', String(favMissing).includes('这条关注不存在'), String(favMissing).slice(0, 120))

  await goto(`${WEB_ORIGIN}/settings/chains`)
  const chainRows = await waitForValue(
    ROW_SHAPE,
    rows => Array.isArray(rows) && rows.length === 2,
    { what: '通勤链路的两行', timeout: 25_000 },
  )
  check('链路行整行是通往自己那一页的链接', chainRows.every(r => r.href?.startsWith('/settings/chains/')), JSON.stringify(chainRows.map(r => r.href)))
  check('链路行里没有表单控件（表单搬到了独立页）', chainRows.every(r => r.controls === 0), JSON.stringify(chainRows.map(r => r.controls)))
  const chainListText = await pageEval(`JSON.stringify(document.querySelector('main').innerText)`)
  check('删除链路不在列表页上', !String(chainListText).includes('删除链路'), '列表页出现了删除链路')

  // 编辑页：保存与删除同一行，删除在保存右侧。
  await goto(`${WEB_ORIGIN}${chainRows[0].href}`)
  await waitForValue(
    `JSON.stringify(document.querySelector('main').innerText)`,
    text => String(text).includes('编辑 '),
    { what: '链路的编辑页', timeout: 25_000 },
  )
  const ACTIONS = `JSON.stringify([...document.querySelectorAll('main form button')]
    .filter(b => /保存链路|删除链路|取消/.test(b.innerText))
    .map(b => {
      const rect = b.getBoundingClientRect()
      return { text: b.innerText.trim(), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) }
    }))`
  const actions = await pageEval(ACTIONS)
  note(`链路编辑页的动作：${JSON.stringify(actions)}`)
  equal('链路编辑页只有保存与删除两枚动作', actions.map(a => a.text), ['保存链路', '删除链路'])
  check('删除在保存右侧且同一行', actions[1].top === actions[0].top && actions[1].width > 0, JSON.stringify(actions))
  check('两枚动作都 ≥44 高', actions.every(a => a.height >= 44), JSON.stringify(actions.map(a => a.height)))

  // 新建页：没有删除（一条还不存在的链路没什么可删的）。
  await goto(`${WEB_ORIGIN}/settings/chains/new`)
  const createActions = await waitForValue(
    ACTIONS,
    list => Array.isArray(list) && list.length > 0,
    { what: '新建页的动作', timeout: 20_000 },
  )
  equal('新建页只有保存', createActions.map(a => a.text), ['保存链路'])

  // 收尾回到列表页：下面那一段从列表页上的「新增链路」进录入表单。
  await goto(`${WEB_ORIGIN}/settings/chains`)

  // ---- 站点选择器：直线距离与「最近」 --------------------------------------------
  // 「新增链路」是一个**链接**（新页面），不是按钮：它指向 `/settings/chains/new`。
  await cli(['click', `getByRole('link', { name: '新增链路' })`])
  // 「线路与方向」现在也是共用下拉（不带搜索框）：它没有原生 select 的 value，故按可见文字认那一行。
  await cli(['click', `[aria-label="线路与方向"]`])
  const lineOptions = await waitForValue(
    `JSON.stringify([...document.querySelectorAll('[role=option]')].map(o => o.innerText.trim()))`,
    list => Array.isArray(list) && list.length > 0,
    { what: '录入表单的线路选择器', timeout: 20_000 },
  )
  note(`线路选择器选项：${JSON.stringify(lineOptions)}`)

  const wantedLine = lineOptions.find(text => text.includes(fixtures.favorites.a.line.lineName)) ?? lineOptions[0]
  await cli(['click', `getByRole('option', { name: ${JSON.stringify(wantedLine)} })`])
  await delay(2000)

  const OPTIONS = `JSON.stringify([...document.querySelectorAll('[role=option]')].map(o => o.innerText.trim()))`
  // 站的控件是 Combobox 的触发器按钮，名字就是它的标签（上车站 / 下车站）——
  // reka-ui 在这一版里不给它 role=combobox，故按名字点。
  await cli(['click', `getByRole('button', { name: '上车站' })`])
  const options = await waitForValue(
    OPTIONS,
    list => Array.isArray(list) && list.length > 0,
    { what: '站点选择器列出的站', timeout: 20_000 },
  )
  note(`站点选择器：${JSON.stringify(options.slice(0, 4))}`)
  check('选择器给每个站标出直线距离', options.every(text => /直线 \d+(\.\d)? (米|公里)/.test(text)), JSON.stringify(options.slice(0, 3)))
  check('选择的措辞是「直线」，不是步行或路线长度', options.every(text => !/步行|路线|车程/.test(text)), JSON.stringify(options.slice(0, 3)))
  const nearest = options.filter(text => text.includes('最近'))
  equal('「最近」只标在一个站上', nearest.length, 1)
  const marks = options.map(text => Number(/第(\d+)站/.exec(text)?.[1] ?? NaN))
  const ascending = marks.every((value, index) => index === 0 || marks[index - 1] < value)
  check('列出的先后就是线路自己的站序（距离只是标注，没有按距离重排）', ascending, JSON.stringify(marks))

  // ---- 移动端线路详情头部：上下班方向标识 ---------------------------------------
  const fav = (await storedFavorites()).find(f => f.id === fixtures.favorites.a.favorite.id)
  note(`收藏行的上班方向：${fav.morningDirection}（lineId=${fav.lineId}）`)
  const morningLineId = fav.morningDirection === 0 ? fav.lineId : fav.reverseLineId
  const morningDetail = await lineDetail(morningLineId, fav.morningDirection)
  await cli(['resize', '375', '667'])
  await goto(`${WEB_ORIGIN}/line/${encodeURIComponent(morningLineId)}?direction=${fav.morningDirection}&cityCode=${fixtures.city}`)
  const badge = await waitForValue(
    `JSON.stringify((() => {
      const header = [...document.querySelectorAll('main div')].find(d => d.className.includes('md:hidden') && d.innerText.includes('车'))
      return header ? header.innerText : document.body.innerText.slice(0, 200)
    })())`,
    text => String(text).includes('上班方向') || String(text).includes('下班方向'),
    { what: '移动端头部出现通勤方向标识', timeout: 25_000 },
  )
  check('头部标出这是上班方向', String(badge).includes('🏠 上班方向'), `实际 ${JSON.stringify(badge)}`)
  check('头部同时显示这条线路的方向名', String(badge).includes(morningDetail.directionName), `期望含「${morningDetail.directionName}」`)

  // 反方向没有这个标识：标识点名的是用户为这一段选的方向，不是线路类型。
  const otherLineId = morningLineId === fav.lineId ? fav.reverseLineId : fav.lineId
  await goto(`${WEB_ORIGIN}/line/${encodeURIComponent(otherLineId)}?direction=${1 - fav.morningDirection}&cityCode=${fixtures.city}`)
  await delay(3000)
  const otherBadge = await pageEval('JSON.stringify(document.body.innerText.slice(0, 300))')
  check('反方向不标这个标识（它属于用户选的那一段）', !String(otherBadge).includes('上班方向'), `实际 ${JSON.stringify(otherBadge)}`)
  await cli(['resize', '1280', '900'])
}
