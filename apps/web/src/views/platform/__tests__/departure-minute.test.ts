import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LiveBusSchema } from '@real-time-transport/shared'
import { departureRowOf } from '../departure-row'
import type { PlatformLineRule } from '../types'

/**
 * H1：报告板的预计到站列必须能陈述真实分钟。
 *
 * 该列曾在每一行每一刻都读作「无法估算 / 暂无到站耗时」，因为它背后的请求没有点名目标站，
 * 而上游只在请求说明开往哪一站时才填车辆的 `travelTimeSec`。路由现在转发该站序，本模块把答案变成行
 * ——故此处钉住两种结果：读数携带站台自己分钟的**行**，以及读数确实没有分钟的行。
 *
 * 两者都不得捏造。未知状态不是要移除的缺陷：没有所服务行程时间的车辆就是没有分钟，而捏造一个
 * （逐站算术、一个标称速度）正是整套 F4 词汇要防的事。坏掉的是**已知**的情形根本无法到达。
 */

const rule: PlatformLineRule = {
  lineId: 'bus_027_1',
  lineName: '快线 1 路',
  direction: 0,
  terminal: '开往建国门',
  stationOrder: 4,
  operatingText: '运营中，本方向暂无来车',
}

/** 一个车辆读数，由它所承载的契约校验。 */
function bus(fields: Record<string, unknown>) {
  return LiveBusSchema.parse({ id: 'v1', updatedAt: 0, ...fields })
}

const answer = (buses: Array<Record<string, unknown>>, dataSource = 'chelaile') => ({
  dataSource,
  buses: buses.map(bus),
})

const rowWith = (buses: Array<Record<string, unknown>>) =>
  departureRowOf({ id: 'dep_1', rule, answer: answer(buses) })

describe('H1: a reading that carries this platform\'s minute is stated as a minute', () => {
  it('takes the minute upstream served for the requested stop', () => {
    // nextOrder === stationOrder：车头正开向本站台，480 s 是来源为它给出的行程时间。
    const row = rowWith([{ order: 2, nextOrder: 3, travelTimeSec: 480, congestion: 'low' }])

    expect(row.etaMinutes).toBe(8)
    expect(row.stopsAway).toBe(1)
    expect(row.unavailable).toBe(false)
    // 分钟不是服务事实：运营文本属于没有分钟的行。
    expect(row.operatingText).toBeNull()
    // 类型随来源，故所服务的分钟是实时。
    expect(row.provenance).toBe('live')
    expect(row.congestion).toBe('low')
  })

  it('keeps the platform\'s minute, not the terminus one, when both are in the payload', () => {
    // 缺陷的确切形状：未定位的读数把每辆车都定价到终点站（此处 3 240 s ≈ 54 min），读起来像真实
    // 分钟，却是错问题的答案。定位读数即上面的 480 s；该行绝不可偏好它同时也能持有的更大数字。
    const row = rowWith([{ order: 2, nextOrder: 3, travelTimeSec: 480, congestion: 'low' }])
    expect(row.etaMinutes).toBe(8)
    expect(row.etaMinutes).not.toBe(54)
  })

  it('states the minute for a vehicle standing at the platform as the imminent one', () => {
    // 上游自己的 0 意为车辆**在**站：把它下沉到 1 分钟是本应用对「马上」的约定，是读数而非猜测。
    const row = rowWith([{ order: 3, nextOrder: 4, travelTimeSec: 0, congestion: 'high' }])
    expect(row.etaMinutes).toBe(1)
    expect(row.stopsAway).toBe(1)
    expect(row.congestion).toBe('high')
  })
})

describe('H1: a reading that carries no minute states the honest unknown', () => {
  it('states no minute for a vehicle heading here with no served travel time', () => {
    // 车辆真实且车头正开向本站台——上游没说何时。该行只陈述这一点，别的都不说：
    // 无分钟、无服务事实（范围内**有**车）、无失败（请求已作答）。
    const row = rowWith([{ order: 2, nextOrder: 3, congestion: 'high' }])

    expect(row.etaMinutes).toBeNull()
    expect(row.stopsAway).toBe(1)
    expect(row.operatingText).toBeNull()
    expect(row.unavailable).toBe(false)
    // 没有数字就没有类型：标记只存在于有分钟之处。
    expect(row.provenance).toBeNull()
    // 拥挤判决是该车自己的，在分钟缺失时仍存在。
    expect(row.congestion).toBe('high')
  })
})

describe('H1: the row is about the vehicle still heading here', () => {
  it('never prices a vehicle that has already cleared the platform', () => {
    // `nextOrder > stationOrder` 是车头已越过的站，chelailie 的 -1 是来源直接说同一件事。
    // 任一都使**本**站台的分钟成为车辆不再前往之处的分钟——故该行是关于它后面那辆车的
    // （480 s, 8 min），绝不是已过去的那辆更近的（60 s）。
    const row = rowWith([
      { id: 'passed', order: 4, nextOrder: 5, travelTimeSec: 60 },
      { id: 'behind', order: 2, nextOrder: 3, travelTimeSec: 480 },
    ])
    expect(row.etaMinutes).toBe(8)

    const sentinel = rowWith([
      { id: 'gone', order: 3, nextOrder: 4, travelTimeSec: 60, distanceToWaitStn: -1 },
      { id: 'behind', order: 2, nextOrder: 3, travelTimeSec: 480 },
    ])
    expect(sentinel.etaMinutes).toBe(8)
  })

  it('states the operating fact when nothing is heading here, rather than a failure', () => {
    // 已作答的读数而没有本站台的车不是错误：该行报线路自己的运营时段所说的（F3 的拆分）。
    const row = rowWith([])
    expect(row.etaMinutes).toBeNull()
    expect(row.stopsAway).toBeNull()
    expect(row.unavailable).toBe(false)
    expect(row.operatingText).toBe(rule.operatingText)
    expect(row.provenance).toBeNull()
  })

  it('states the failed request as the failed request, and claims nothing else', () => {
    const row = departureRowOf({ id: 'dep_1', rule, answer: null })
    expect(row.unavailable).toBe(true)
    expect(row.etaMinutes).toBeNull()
    expect(row.operatingText).toBeNull()
    expect(row.provenance).toBeNull()
  })
})

describe('H1: the board asks about the platform it is showing', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** 去掉说明性文字的文件，故被断言的是代码。 */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('names the station order in the live request, which is what makes the minute exist', () => {
    // 只索要线路方向的视图会收到终点站数字并当作本站台的陈述，
    // 或（如它曾经那样）完全不陈述分钟。
    const view = codeOf(read('../index.vue'))
    expect(view).toContain('order: String(rule.stationOrder)')
    expect(view).toContain('departureRowOf(')
  })

  it('still renders the honest unknown, in exactly one wording', () => {
    // 该状态仍可达且仍只被措辞一次：无分钟、无车辆事实、无失败的行落到报告板的最后一个分支，由它陈述。
    // 措辞现在来自 `@/arrival-copy`——每个到站表面都渲染的同一个模块——故报告板不再自己打这句话，
    // 断言的是渲染而非字面量。
    const board = read('../components/departure-board.vue')
    expect(board.match(/无法估算/g)?.length).toBe(1)
    expect(board).toContain('arrival-copy')
    expect(board.match(/\{\{ ARRIVAL_MINUTE_UNAVAILABLE_TEXT \}\}/g)?.length).toBe(1)
    const row = rowWith([{ order: 2, nextOrder: 3 }])
    expect({ minute: row.etaMinutes, operating: row.operatingText, failed: row.unavailable })
      .toEqual({ minute: null, operating: null, failed: false })
  })
})
