import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { ChelaileProvider } from '../index.js'

/**
 * 上游回答里没有这条线路的记录，是未命中而不是读数。
 *
 * line-detail 接口对从未听说过的 id 也回 200 和一个信封：`jsonr.data`
 * 既没有 `line` 对象、没有站点表、也没有车辆。两次读取必须在这一致：
 * 无记录的载荷在两边都是未命中，存在的线路即使无车在两边也是读数
 * （阳性对照 —— 一刀切拒绝比缺陷更糟），而只有车辆列表能证明上游认识
 * 这条线路的载荷，仍是读数。
 *
 * 甲路 / 乙路 是占位符；下面每一次读取都是桩，永不触达上游。
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * 某个 lineId 的上游回答，按 provider 读取它的方式拼写。
 *
 * 用明文信封（`jsonr.data`）—— provider 接受它与接受加密信封完全一样，
 * 不涉及 key 或 salt，因此这里不依赖任何账号凭据。
 */
function stubChelaileLine(payload: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (!href.includes('encryptedLineDetail')) throw new Error(`unexpected upstream call: ${href}`)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonr: { data: payload } }),
    }
  }))
}

/** 存在的线路会答出的那两个站点。绝不是车辆列表。 */
const STATIONS = [
  { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
  { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
]

/** 上游对从未听说过的线路的回答：什么都没有。 */
const NO_RECORD: Record<string, unknown> = {}

describe('G-D1: the upstream answering about no line is a miss on BOTH reads', () => {
  it('answers null from the live read, not an empty well-formed reading', async () => {
    stubChelaileLine(NO_RECORD)

    const status = await new ChelaileProvider().getLiveStatus('line_027_ghost', 0, '027')

    // 这个文件为此而存在：此处曾给出一个与「真实线路的车辆已全部到站」
    // 无法区分的结果。
    expect(status).toBeNull()
  })

  it('answers null from the detail read for the same payload', async () => {
    stubChelaileLine(NO_RECORD)

    const detail = await new ChelaileProvider().getLineDetail('line_027_ghost', 0, '027')

    expect(detail).toBeNull()
  })

  it('states ONE fact about the line id across both reads, over the shapes where the fact is the same', async () => {
    // 同一个回答的两种读法：一次读取称其为未命中，另一次就不能称其为
    // 线路。只在两者必须一致的两种载荷形态上比较 —— 刻意的例外
    // （带车辆但没有身份的载荷）在下面单独成为一例，并给出理由。
    const shapes: Array<{ name: string, payload: Record<string, unknown> }> = [
      { name: 'no record at all', payload: NO_RECORD },
      { name: 'a line with no vehicle in transit', payload: { line: { name: '甲路', direction: 0 }, stations: STATIONS, buses: [] } },
    ]

    for (const shape of shapes) {
      stubChelaileLine(shape.payload)
      const provider = new ChelaileProvider()
      const detail: LineDetail | null = await provider.getLineDetail('line_027_1', 0, '027')
      const status: LiveLineStatus | null = await provider.getLiveStatus('line_027_1', 0, '027')

      // 同一个载荷的两次读取可以在「答什么」上不同（详情没有车辆），
      // 但绝不能在「上游是否认识这条线路」上不同。
      expect(detail === null, `${shape.name}: the two reads disagree about the line`).toBe(status === null)
    }
  })

  it('answers a reading from vehicles alone, which the detail read cannot', async () => {
    // 两次读取唯一分道的一例，明写出来而不是留给人去发现：载荷列出了
    // 这条线路的车辆，却没有线路名也没有站点表。live 读取照收 —— 车辆
    // 就是上游认识这条线路的证据，拒绝它们会给一条明显在跑的线路 404 ——
    // 而 detail 读取答 null，因为没有站点表构造出的 LineDetail 是一条
    // 零站点的线路，几何消费方会把它当成真实的零长站点序列。
    //
    // 这个夹具决定了 live 读取自己的那一条：没有车辆这条判据，一刀切
    // 拒绝「无线路名、无站点表」的修正会把这份回答也吞掉。
    stubChelaileLine({ buses: [{ busId: 'b1', order: 2, speed: 5 }] })
    const provider = new ChelaileProvider()

    const status: LiveLineStatus | null = await provider.getLiveStatus('line_027_1', 0, '027')
    const detail: LineDetail | null = await provider.getLineDetail('line_027_1', 0, '027')

    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
    expect(detail).toBeNull()
  })
})

describe('G-D1: a line that EXISTS with no vehicle stays a reading', () => {
  it('answers an empty vehicle list, never a miss', async () => {
    stubChelaileLine({ line: { name: '甲路', direction: 0 }, stations: STATIONS, buses: [] })

    const status = await new ChelaileProvider().getLiveStatus('line_027_1', 0, '027')

    // 阳性对照。把这一例也 404 的一刀切拒绝比缺陷更糟：
    // 「此刻没车」是真实且常见的答案。
    expect(status).not.toBeNull()
    expect(status?.buses).toEqual([])
    expect(status?.lineId).toBe('line_027_1')
  })

  it('still answers the line detail beside it', async () => {
    stubChelaileLine({ line: { name: '甲路', direction: 0 }, stations: STATIONS, buses: [] })

    const detail = await new ChelaileProvider().getLineDetail('line_027_1', 0, '027')

    expect(detail?.stops.map(s => s.name)).toEqual(['甲路', '乙路'])
  })

  it('keeps a reading whose only record of the line is its vehicles', async () => {
    // live 读取自己那条判据的区分形态：车辆本身就是「上游认识这条线路」
    // 的记录，所以只看身份（无线路名、无站点表）不能吞掉这份回答。
    stubChelaileLine({ buses: [{ busId: 'b1', order: 2, speed: 5 }] })

    const status = await new ChelaileProvider().getLiveStatus('line_027_1', 0, '027')

    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
  })
})
