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
  .map(handle => handle.closest('li')?.innerText.split('\\n')[0] ?? null))`

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
  equal('索引列出四个域', rows.map(r => r.href), ['/settings/lines', '/settings/schedule', '/settings/anchors', '/settings/chains'])
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

  // ---- 站点选择器：直线距离与「最近」 --------------------------------------------
  await cli(['click', `getByRole('button', { name: '新增链路' })`])
  const selectValues = await waitForValue(
    `JSON.stringify([...document.querySelectorAll('main select')].map(s => [...s.options].map(o => o.value)))`,
    groups => Array.isArray(groups) && groups.length > 0 && groups[0].length > 0,
    { what: '录入表单的线路选择器', timeout: 20_000 },
  )
  note(`线路选择器选项：${JSON.stringify(selectValues[0])}`)

  // 选项的值是「收藏行 + 方向」（站表按它取），故选的是夹具 A 的那个方向。
  const favId = fixtures.favorites.a.favorite.id
  const value = selectValues[0].find(v => v.startsWith(favId)) ?? selectValues[0][1]
  await cli(['select', 'main select', value])
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
