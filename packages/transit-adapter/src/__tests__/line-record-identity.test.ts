import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LineDetail, LiveLineStatus } from '@real-time-transport/shared'
import { ChelaileProvider } from '../index.js'

/**
 * An upstream answer that holds NO RECORD of the line is a miss, not a reading.
 *
 * The line-detail endpoint answers 200 with an envelope for ids it has never
 * heard of: `jsonr.data` comes back without a `line` object, without a station
 * list and without a vehicle. The provider's live read turned that into a
 * well-formed `LiveLineStatus` — `{buses: [], dataSource: 'chelaile',
 * isDegraded: false}` — byte-identical to a real line with nothing in transit,
 * while the DETAIL read of the same id answered `null` (it already refused
 * `!name && !stations`). Two routes, one upstream answer, two different facts:
 * a client could not tell 「这条线路不存在」 from 「此刻没车」.
 *
 * So the two reads are pinned TOGETHER here, on the payload shapes that tell
 * them apart: the no-record payload must be a miss on BOTH, a line that exists
 * with no vehicle must be a reading on both (the positive control — a blanket
 * refusal would be worse than the defect), and a payload whose only record of
 * the line is a vehicle list must stay a reading, because vehicles are proof
 * the upstream knows this line.
 *
 * 甲路 / 乙路 are placeholders: no real route or upstream id appears here, and
 * the upstream is never reached — every read below is a stub.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * The upstream answer for one line id, spelled the way the provider reads it.
 *
 * The envelope is the plaintext one (`jsonr.data`), which the provider accepts
 * exactly as it accepts the encrypted one — no key or salt is involved, so
 * nothing here depends on the account's credentials.
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

/** The two stops a line that exists answers with. Never a vehicle list. */
const STATIONS = [
  { sId: 's1', sn: '甲路', order: 1, lat: 39.9, lng: 116.4 },
  { sId: 's2', sn: '乙路', order: 2, lat: 39.91, lng: 116.41 },
]

/** The upstream's answer about a line it has never heard of: nothing at all. */
const NO_RECORD: Record<string, unknown> = {}

describe('G-D1: the upstream answering about no line is a miss on BOTH reads', () => {
  it('answers null from the live read, not an empty well-formed reading', async () => {
    stubChelaileLine(NO_RECORD)

    const status = await new ChelaileProvider().getLiveStatus('line_027_ghost', 0, '027')

    // The lie this file exists for: a status here was indistinguishable from a
    // real line whose vehicles have all finished their trip.
    expect(status).toBeNull()
  })

  it('answers null from the detail read for the same payload', async () => {
    stubChelaileLine(NO_RECORD)

    const detail = await new ChelaileProvider().getLineDetail('line_027_ghost', 0, '027')

    expect(detail).toBeNull()
  })

  it('states ONE fact about the line id across both reads, over the shapes where the fact is the same', async () => {
    // The same answer read two ways: if one read calls it a miss, the other may
    // not call it a line. Checked over the two payload shapes where the two must
    // agree — the deliberate exception (a payload carrying vehicles but no
    // identity) is stated as its own case below, with its reason.
    const shapes: Array<{ name: string, payload: Record<string, unknown> }> = [
      { name: 'no record at all', payload: NO_RECORD },
      { name: 'a line with no vehicle in transit', payload: { line: { name: '甲路', direction: 0 }, stations: STATIONS, buses: [] } },
    ]

    for (const shape of shapes) {
      stubChelaileLine(shape.payload)
      const provider = new ChelaileProvider()
      const detail: LineDetail | null = await provider.getLineDetail('line_027_1', 0, '027')
      const status: LiveLineStatus | null = await provider.getLiveStatus('line_027_1', 0, '027')

      // Two reads of one payload may differ on WHAT they answer (a detail has no
      // vehicles) — never on whether the upstream knows the line.
      expect(detail === null, `${shape.name}: the two reads disagree about the line`).toBe(status === null)
    }
  })

  it('answers a reading from vehicles alone, which the detail read cannot', async () => {
    // The ONE shape where the two reads disagree, stated rather than left to be
    // discovered: a payload that lists this line's vehicles but no name and no
    // stop list. The live read answers it — the vehicles are proof the upstream
    // knows the line, and refusing them would 404 a line that is visibly running
    // — while the detail read answers null, because a LineDetail built from no
    // stop list is a line with no stations, which every geometry consumer would
    // then treat as a real stop sequence of length zero.
    //
    // This is the fixture that decides the live read's own clause: without the
    // vehicles check, a fix that refuses every payload lacking a name and a stop
    // list would swallow this answer too.
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

    // The positive control. A blanket refusal that 404s this case would be worse
    // than the defect: 「此刻没车」 is a real, frequent answer.
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
    // The distinguishing shape for the live read's own clause: vehicles ARE a
    // record that the upstream knows this line, so the identity test alone (no
    // name, no stations) must not swallow the answer.
    stubChelaileLine({ buses: [{ busId: 'b1', order: 2, speed: 5 }] })

    const status = await new ChelaileProvider().getLiveStatus('line_027_1', 0, '027')

    expect(status?.buses.map(b => b.id)).toEqual(['b1'])
  })
})
