/**
 * 场景夹具：全部由这个实例自己的 HTTP 接口造出来（关注线路、上车点、锚点、时段、链路），
 * 一行都不直接写库 —— 直接写库的夹具会绕过路由自己的换算与校验，于是测的就不是这条路径。
 *
 * 线路来自上游搜索（北京 027），夹具只固定「用哪一条、用哪一站」这类事实，不固定分钟数：
 * 分钟随上游与模拟器变，断言因此一律对着接口载荷比，从不对着写死的数字比。
 *
 * 上车点这类「哪一站」也不是拍脑袋定的：它从实时载荷里挑 —— 模拟/上游把车放在哪，夹具就把
 * 链路的上车站放在车的下游，否则链路会诚实地拒绝（「暂时没有开往这一站的车」），
 * 而那是夹具的问题，不是被测行为的问题。
 */
import { apiData, resetBusinessTables } from './harness.mjs'

const CITY = '027'

/** 搜索用的关键词，按顺序取够可用的线路就停。 */
const KEYWORDS = ['1路', '2路', '5路', '52路', '特']

/** 北京一带 WGS-84 → GCJ-02 的偏移；锚点按 WGS 提交，站坐标是 GCJ-02，故取锚点时要减掉它。 */
const GCJ_OFFSET = { lat: 0.00155, lng: 0.0059 }

async function usableLines(count) {
  const chosen = []
  for (const keyword of KEYWORDS) {
    const groups = await apiData(`/api/transit/lines/search?keyword=${encodeURIComponent(keyword)}&cityCode=${CITY}`)
    for (const group of groups) {
      if (chosen.length >= count) return chosen
      if (!group.up || !group.down) continue
      if (chosen.some(line => line.upLineId === group.up.lineId)) continue
      const detail = await apiData(`/api/transit/lines/${encodeURIComponent(group.up.lineId)}?direction=0&cityCode=${CITY}`)
      const stops = detail.stops ?? []
      const placed = stops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.lat !== 0 && s.lng !== 0)
      if (stops.length < 10 || placed.length < stops.length - 2) continue
      chosen.push({
        lineName: detail.lineName ?? group.lineName,
        upLineId: group.up.lineId,
        downLineId: group.down.lineId,
        stops,
      })
    }
  }
  if (chosen.length < count) throw new Error(`只找到 ${chosen.length} 条可用线路，需要 ${count} 条`)
  return chosen
}

/** 造一个关注：POST 一条线路，再 PATCH 它的上班上车点（方向 + 站名 + 站序）。 */
async function followLine(line, index, boardStopIndex) {
  const stop = line.stops[boardStopIndex]
  const created = await apiData('/api/transit/favorites', {
    method: 'POST',
    body: {
      userId: 'default_user',
      cityCode: CITY,
      lineId: line.upLineId,
      lineName: line.lineName,
      preferredDirection: 0,
      reverseLineId: line.downLineId,
      displayOrder: index,
    },
  })
  const patched = await apiData(`/api/transit/favorites/${encodeURIComponent(created.id)}`, {
    method: 'PATCH',
    body: { morningDirection: 0, morningStopName: stop.name, morningStopOrder: stop.order },
  })
  return { favorite: patched, boardStop: stop, line }
}

/**
 * 一个覆盖「此刻」的时段。通勤时段是字符串比较（`start <= now <= end`），故窗口必须整段落在
 * 同一天内 —— 跨零点的窗口永远匹配不上，测试不能造出那种窗口。
 */
export function windowCoveringNow() {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const at = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  return { start: at(Math.max(0, minutes - 30)), end: at(Math.min(23 * 60 + 59, minutes + 30)) }
}

/** 一个不含「此刻」的时段：落在 12:00–14:00；若此刻正在其中，就用当天最早的那半小时。 */
export function windowAwayFromNow() {
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  return minutes >= 12 * 60 && minutes <= 14 * 60
    ? { start: '00:00', end: '00:30' }
    : { start: '12:00', end: '14:00' }
}

export async function setSettings(patch) {
  return apiData('/api/transit/settings', { method: 'PATCH', body: patch })
}

export function legOf(line, boardStop, alightStop) {
  return {
    lineId: line.upLineId,
    lineName: line.lineName,
    cityCode: CITY,
    boardStationName: boardStop.name,
    boardStationOrder: boardStop.order,
    alightStationName: alightStop.name,
    alightStationOrder: alightStop.order,
    transferExtraMinutes: null,
    connectionMode: null,
  }
}

/**
 * 让链路真的推演出结论。
 *
 * 上车站不能随便挑：接驳（从锚点走到上车站）要花几分钟，而数据源的那辆车到上车站的时间必须
 * 比这几分钟更长 —— 否则引擎会诚实地答 `no-vehicle-after-connection`（「连走过去的那趟都赶不上」），
 * 那是夹具没准备好，不是被测行为坏了。故这里按**车还有多久到本站**挑站：先量一遍每个候选站上
 * 最近那辆车的到站时间，从时间最长的几个里挑一对上下车站，再把锚点挪到上车站旁边。
 */
async function deductibleMorningLeg(line, chainId) {
  const total = line.stops.length
  const candidates = []
  for (let order = 2; order <= total - 4; order += 2) {
    const live = await liveOf(line.upLineId, 0, order)
    const heading = (live.buses ?? []).filter(bus =>
      typeof bus.travelTimeSec === 'number' && bus.travelTimeSec > 0
      && typeof bus.order === 'number' && (bus.nextOrder ?? bus.order) <= order)
    if (heading.length === 0) continue
    const soonest = heading.reduce((a, b) => (a.travelTimeSec <= b.travelTimeSec ? a : b))
    if (soonest.travelTimeSec < 480) continue
    candidates.push({ order, busId: soonest.id, travel: soonest.travelTimeSec })
  }
  candidates.sort((a, b) => b.travel - a.travel)
  if (candidates.length === 0) throw new Error(`线路 ${line.upLineId} 上没有「车还早、本站还有站台」的候选站`)

  for (const candidate of candidates.slice(0, 6)) {
    const boardStop = line.stops[candidate.order - 1]
    await setSettings({
      homeLat: boardStop.lat - GCJ_OFFSET.lat,
      homeLng: boardStop.lng - GCJ_OFFSET.lng,
    })
    for (const delta of [3, 5, 8]) {
      const alightOrder = candidate.order + delta
      if (alightOrder > total) continue
      const live = await liveOf(line.upLineId, 0, alightOrder)
      const sameBus = (live.buses ?? []).find(bus =>
        bus.id === candidate.busId && typeof bus.travelTimeSec === 'number' && bus.travelTimeSec > 0)
      if (!sameBus) continue

      const alightStop = line.stops[alightOrder - 1]
      await apiData(`/api/transit/commute-chains/${encodeURIComponent(chainId)}`, {
        method: 'PATCH',
        body: { legs: [legOf(line, boardStop, alightStop)] },
      })
      const ded = await apiData('/api/transit/commute-chains/deductions?purpose=morning')
      const chain = ded.chains.find(c => c.chainId === chainId)
      if (chain?.deduction?.status === 'deduced') {
        return { boardStop, alightStop, deduction: chain.deduction }
      }
    }
  }
  throw new Error(`试过 ${candidates.length} 个候选站，链路仍推演不出结论`)
}

/** 当前存储的关注线路（场景核对写入时用）。 */
export async function favorites() {
  return apiData('/api/transit/favorites')
}

/** 当前存储的链路，按服务端的存储顺序。 */
export async function storedChains() {
  return apiData('/api/transit/commute-chains')
}

/** 某条线路某个方向的实时载荷；不给 order 就是「没点名目标站」的那种读法。 */
export async function liveOf(lineId, direction = 0, order) {
  const qs = new URLSearchParams({ direction: String(direction), cityCode: CITY })
  if (order !== undefined) qs.set('order', String(order))
  return apiData(`/api/transit/lines/${encodeURIComponent(lineId)}/live?${qs.toString()}`)
}

export async function lineDetail(lineId, direction = 0) {
  return apiData(`/api/transit/lines/${encodeURIComponent(lineId)}?direction=${direction}&cityCode=${CITY}`)
}

export async function deductions(purpose) {
  return apiData(`/api/transit/commute-chains/deductions?purpose=${purpose}`)
}

/**
 * 造出全部夹具，并把场景要用到的事实一并返回。
 *
 * 每次调用都先把业务表清空：夹具是**这一跑**的事实，长在上一次的残渣上就没有意义
 * （红灯演示一个跑动里会造好几次）。
 */
export async function seedFixtures() {
  await resetBusinessTables()
  const lines = await usableLines(3)
  const middle = line => Math.max(1, Math.min(line.stops.length - 1, Math.floor(line.stops.length / 3)))

  // A：卡片要显示分钟的那一条（上车点在线路中段）。
  const a = await followLine(lines[0], 0, middle(lines[0]))
  // B：上车点是首站 —— 这个方向不会给出任何来向本站的车，卡片因此一个数字都不该有。
  const b = await followLine(lines[1], 1, 0)
  // C：给「上游没给分钟」那一次留的位置（场景里把它那次到站应答换成没有分钟的形状）。
  const c = await followLine(lines[2], 2, middle(lines[2]))

  const workStop = lines[1].stops[Math.floor(lines[1].stops.length / 2)]
  const window = windowCoveringNow()
  const away = windowAwayFromNow()
  await setSettings({
    morningStart: window.start,
    morningEnd: window.end,
    eveningStart: away.start,
    eveningEnd: away.end,
    workLat: workStop.lat - GCJ_OFFSET.lat,
    workLng: workStop.lng - GCJ_OFFSET.lng,
  })

  const morningChain = await apiData('/api/transit/commute-chains', {
    method: 'POST',
    body: {
      userId: 'default_user',
      name: '上班链路·夹具甲',
      purpose: 'morning',
      displayOrder: 0,
      legs: [legOf(a.line, a.line.stops[1], a.line.stops[Math.max(2, middle(a.line))])],
    },
  })
  const eveningChain = await apiData('/api/transit/commute-chains', {
    method: 'POST',
    body: {
      userId: 'default_user',
      name: '下班链路·夹具乙',
      purpose: 'evening',
      displayOrder: 1,
      legs: [legOf(b.line, b.line.stops[1], b.line.stops[Math.max(2, middle(b.line))])],
    },
  })

  // 上班链路必须有一个真的结论：这是「每段的余量与结论」那一条断言的前提。
  const leg = await deductibleMorningLeg(a.line, morningChain.id)

  return {
    city: CITY,
    lines,
    favorites: { a, b, c },
    chains: { morning: { ...morningChain, leg }, evening: eveningChain },
    anchors: { work: workStop },
    windows: { morning: window, evening: away },
  }
}
