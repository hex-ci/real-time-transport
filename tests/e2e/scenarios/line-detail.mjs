/**
 * 线路详情：切方向与「设为上班上车点」。
 *
 * 两条行为在这里被钉住：
 *  - 屏幕上显示的站点列表、方向名与站数，全部来自**同一个**事实源（那一次详情读取的载荷）；
 *    切方向之后站点列表必须换成另一个方向的站表，而不是原地不动或两者混排；
 *  - 点「设为上班上车点」写出的请求体里，方向是**屏幕上此刻显示的那个方向**换算到收藏行的编号，
 *    站点是屏幕上点开的那一站（站名与站序）。这是真修过的一个缺陷：写下的号曾指反方向，
 *    于是站序属于另一个方向。
 *
 * 站点是画布（Konva）上的节点，故点它要走真实鼠标事件：先问出那一站的视口坐标，再按坐标点。
 */
import { WEB_ORIGIN, goto, pageEval, waitForValue, cli, delay, recordedRequests, installFetchRecorder, clearRecordedRequests } from '../harness.mjs'
import { favorites, lineDetail } from '../fixtures.mjs'

export const name = '线路详情'

/**
 * 画布上每一个站点的视口坐标。
 *
 * 站点在画布上是 Konva 节点：可点的命中圆没有 id（纯视觉节点是 `listening: false`），
 * 而「站在哪里」由两个带 id 的节点共同给出 —— `station-visual-<站 id>` 圆就是站点本身的位置，
 * `station-label-<站 id>` 文本给出站名。坐标取前者、名字取后者，故点的是哪一站是可核对的。
 */
const STATION_POINTS = `JSON.stringify((() => {
  const stage = (window.Konva && window.Konva.stages || [])[0]
  if (!stage) return []
  const rect = stage.container().getBoundingClientRect()
  const canvasWidth = stage.width()
  const canvasHeight = stage.height()
  return stage.find('Circle').filter(c => String(c.id()).startsWith('station-visual-')).map((c) => {
    const at = c.getAbsolutePosition()
    const id = c.id().replace('station-visual-', '')
    const label = stage.findOne('#station-label-' + id)
    return {
      name: label ? label.text() : null,
      x: Math.round(rect.left + at.x),
      y: Math.round(rect.top + at.y),
      onCanvas: at.x > 20 && at.x < canvasWidth - 20 && at.y > 0 && at.y < canvasHeight,
    }
  })
})())`

/**
 * 画布上站名的先后顺序 —— 屏幕上那份站点列表。
 *
 * 只取带 `station-label-` id 的文本节点，也**不**按坐标排序：画布是双排（锯齿）布局，
 * 按 x 排会把两排交错成一份谁都不认的名单；节点的树序就是站序 —— 它们正是照站序逐个加进去的。
 * 画布上还有别的字（上车点徽标的「上/下」、车辆速度、方向标签），故过滤是必要的。
 */
const CANVAS_STOPS = `JSON.stringify((() => {
  const stage = (window.Konva && window.Konva.stages || [])[0]
  if (!stage) return []
  return stage.find('Text')
    .filter(t => String(t.id()).startsWith('station-label-'))
    .map(t => t.text())
})())`

/**
 * 收藏行的方向编号规则（与 `favoriteDirectionOfLine` 同一条）：
 * 公交两个方向是两条上游 lineId，哪条 lineId 就是哪个编号；同一条 id 服务两个方向时用载荷自己的号。
 */
function favoriteDirectionOfLine(fav, lineId, payloadDirection) {
  const primary = fav.preferredDirection === 1 ? 1 : 0
  if (fav.reverseLineId && fav.reverseLineId !== fav.lineId) {
    if (lineId === fav.lineId) return primary
    if (lineId === fav.reverseLineId) return 1 - primary
    return null
  }
  if (lineId !== fav.lineId) return null
  return payloadDirection === 1 ? 1 : 0
}

async function clickStation(point) {
  await cli(['mousemove', String(point.x), String(point.y)])
  await cli(['mousedown'])
  await cli(['mouseup'])
  await delay(600)
}

export async function run({ check, equal, note, fixtures }) {
  const fav = fixtures.favorites.a.favorite
  const up = fixtures.favorites.a.line.upLineId
  const down = fixtures.favorites.a.line.downLineId
  const upDetail = await lineDetail(up, 0)
  const downDetail = await lineDetail(down, 1)

  await installFetchRecorder()
  await goto(`${WEB_ORIGIN}/line/${encodeURIComponent(up)}?direction=0&cityCode=${fixtures.city}`)
  await waitForValue(CANVAS_STOPS, stops => Array.isArray(stops) && stops.length > 5, { what: '画布渲染出站点', timeout: 25_000 })

  const canvasUp = await pageEval(CANVAS_STOPS)
  equal('方向 0 的站点列表就是载荷里的站表', canvasUp.slice(0, upDetail.stops.length), upDetail.stops.map(s => s.name))

  const shownStops = await pageEval('JSON.stringify(document.body.innerText.includes(' + JSON.stringify(`${upDetail.stops.length} 站`) + '))')
  check('屏幕陈述的站数来自同一个载荷', shownStops === true, `期望含「${upDetail.stops.length} 站」`)

  // ---- 点开一站，再把这一站设为上班上车点 --------------------------------------
  /** 在同名站只出现一次的前提下，把画布上的点对上载荷里的站（站名 + 站序）。 */
  function locate(points, detail) {
    return (points ?? [])
      .filter(p => p.onCanvas && p.name && detail.stops.filter(s => s.name === p.name).length === 1)
      .map(p => ({ point: p, stop: detail.stops.find(s => s.name === p.name) }))
  }

  const locatedUp = locate(await pageEval(STATION_POINTS), upDetail)
  note(`画布上可点且站名唯一的站：${JSON.stringify(locatedUp.slice(0, 3).map(l => `${l.stop.name}#${l.stop.order}`))}`)
  check('画布上有可点、且站名唯一的站点', locatedUp.length > 0, `可见站点 ${locatedUp.length} 个`)
  const first = locatedUp[1] ?? locatedUp[0]
  const target = first.point
  const targetStop = first.stop
  note(`将要点击的站点：${targetStop.name} 第${targetStop.order}站（${target.x},${target.y}）`)

  await clickStation(target)
  const popoverText = await waitForValue(
    `JSON.stringify(document.querySelector('[role=dialog]')?.innerText ?? document.body.innerText.slice(0, 400))`,
    text => String(text).includes('设为上班上车点'),
    { what: '站点弹窗打开', timeout: 15_000 },
  ).catch(() => null)
  check('点画布上的站点打开了站点弹窗', popoverText !== null, `目标站 ${targetStop.name}`)
  check('弹窗是关于点中的那一站的', String(popoverText).includes(targetStop.name), `期望含「${targetStop.name}」，实际 ${JSON.stringify(String(popoverText).slice(0, 200))}`)

  await clearRecordedRequests()
  await cli(['click', `getByRole('button', { name: '设为上班上车点' })`])
  await waitForValue(
    'JSON.stringify((window.__e2eFetch || []).filter(r => r.method === "PATCH" && r.url.includes("/favorites/")).length)',
    count => typeof count === 'number' && count > 0,
    { what: '上车点写入发出', timeout: 15_000 },
  )
  const patches = (await recordedRequests()).filter(r => r.method === 'PATCH' && r.url.includes('/favorites/'))
  const body = JSON.parse(patches[0].requestBody)
  const expectedDirection = favoriteDirectionOfLine(fav, up, upDetail.direction)
  equal('写出的方向 = 屏幕上显示的方向（换算到收藏行编号）', body.morningDirection, expectedDirection)
  equal('写出的站点 = 屏幕上点开的那一站', { name: body.morningStopName, order: body.morningStopOrder }, { name: targetStop.name, order: targetStop.order })

  const stored = (await favorites()).find(f => f.id === fav.id)
  equal('服务端存下的上车点与请求体一致', { name: stored.morningStopName, order: stored.morningStopOrder, direction: stored.morningDirection }, { name: targetStop.name, order: targetStop.order, direction: expectedDirection })

  // ---- 切方向：站点列表跟着变 ---------------------------------------------------
  await cli(['click', `getByRole('tab', { name: ${JSON.stringify(`开往 ${upDetail.stops[0].name}`)} })`])
  await waitForValue(
    'JSON.stringify(document.body.innerText.includes(' + JSON.stringify(downDetail.directionName) + '))',
    value => value === true,
    { what: '切到反向', timeout: 20_000 },
  )
  await delay(1500)
  const urlAfter = await pageEval('JSON.stringify(location.pathname + location.search)')
  check('切方向换了 URL 到反向的 lineId', String(urlAfter).includes(encodeURIComponent(down)) && String(urlAfter).includes('direction=1'), `实际 ${urlAfter}`)
  const canvasDown = await pageEval(CANVAS_STOPS)
  equal('方向 1 的站点列表换成了另一个方向的站表', canvasDown.slice(0, downDetail.stops.length), downDetail.stops.map(s => s.name))
  check('两个方向的站表确实不同（同一事实源而非缓存）', JSON.stringify(canvasUp) !== JSON.stringify(canvasDown), '两个方向站表相同')

  // ---- 反向的站点：写出的方向也要跟着屏幕上显示的方向走 --------------------------
  const locatedDown = locate(await pageEval(STATION_POINTS), downDetail)
  check('反向也有可点、站名唯一的站点', locatedDown.length > 0, `可见站点 ${locatedDown.length} 个`)
  const second = locatedDown[1] ?? locatedDown[0]
  const targetDown = second.point
  const targetStopDown = second.stop
  note(`反向将要点击的站点：${targetStopDown.name} 第${targetStopDown.order}站`)

  await clickStation(targetDown)
  await waitForValue(
    'JSON.stringify(document.body.innerText.includes("设为上班上车点"))',
    value => value === true,
    { what: '反向的站点弹窗打开', timeout: 15_000 },
  )
  await clearRecordedRequests()
  await cli(['click', `getByRole('button', { name: '设为上班上车点' })`])
  await waitForValue(
    'JSON.stringify((window.__e2eFetch || []).filter(r => r.method === "PATCH" && r.url.includes("/favorites/")).length)',
    count => typeof count === 'number' && count > 0,
    { what: '反向的上车点写入发出', timeout: 15_000 },
  )
  const patchesDown = (await recordedRequests()).filter(r => r.method === 'PATCH' && r.url.includes('/favorites/'))
  const bodyDown = JSON.parse(patchesDown[0].requestBody)
  const expectedDown = favoriteDirectionOfLine(fav, down, downDetail.direction)
  equal('反向写出的方向 = 屏幕上显示的那个方向', bodyDown.morningDirection, expectedDown)
  check('两个方向的编号确实不同（这条断言才不会恒真）', expectedDirection !== expectedDown, `两次都是 ${expectedDirection}`)
  equal('反向写出的站点 = 屏幕上点开的那一站', { name: bodyDown.morningStopName, order: bodyDown.morningStopOrder }, { name: targetStopDown.name, order: targetStopDown.order })
}
