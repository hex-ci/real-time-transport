import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import {
  Database,
  normalizeCommuteChainLegs,
  storedCommuteChainLeg,
} from '../db/client.js'

/**
 * F10: chains are stored, never deduced — these tests are network-free by
 * construction. A call that escaped would throw here rather than spend quota.
 */
function forbidNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    throw new Error(`unexpected upstream call: ${String(url)}`)
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A leg as the wire carries it: one line, a board station and an alight one. */
const LEG = {
  lineId: '010-2-0',
  lineName: '2路',
  cityCode: '027',
  boardStationName: '甲路',
  boardStationOrder: 3,
  alightStationName: '乙路',
  alightStationOrder: 7,
  transferExtraMinutes: null,
}

function chainBody(over: Record<string, unknown> = {}) {
  return {
    name: '上班链路',
    originAnchor: 'home',
    purpose: 'morning',
    legs: [{ ...LEG }],
    ...over,
  }
}

type App = Awaited<ReturnType<typeof buildApp>>

const createChain = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/transit/commute-chains', payload })

const listChains = (app: App, userId?: string) =>
  app.inject({ url: `/api/transit/commute-chains${userId ? `?userId=${userId}` : ''}` })

const json = (res: { body: string }) => JSON.parse(res.body)

describe('F10 chains: storage', () => {
  it('stores a chain and reads its legs back in sequence', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())

    expect(created.id).toBeTruthy()
    expect(created.userId).toBe('default_user')
    expect(created.displayOrder).toBe(0)
    expect(created.createdAt).toBeTruthy()
    expect(created.legs).toHaveLength(1)
    expect(created.legs[0]!.seq).toBe(0)
    expect(created.legs[0]!.alightStationOrder).toBe(7)

    const list = await db.getCommuteChains('default_user')
    expect(list.map(c => c.id)).toEqual([created.id])
    expect(list[0]!.legs[0]!.lineId).toBe('010-2-0')
  })

  it('keeps a leg whose stations are not chosen yet as null, never as an empty name', async () => {
    const db = new Database()
    await db.createCommuteChain(chainBody({
      legs: [
        { ...LEG, boardStationName: null, boardStationOrder: null },
        { ...LEG, alightStationName: null, alightStationOrder: null, transferExtraMinutes: 3 },
      ],
    }))

    const [chain] = await db.getCommuteChains('default_user')
    const [first, second] = chain!.legs

    // Unset is null. An empty string would be a station named "".
    expect(first!.boardStationName).toBeNull()
    expect(first!.boardStationOrder).toBeNull()
    expect(first!.boardStationName).not.toBe('')
    expect(second!.alightStationName).toBeNull()
    expect(second!.alightStationOrder).toBeNull()
    // The configured extra minutes and the unset one are different facts.
    expect(second!.transferExtraMinutes).toBe(3)
    expect(first!.transferExtraMinutes).toBeNull()
  })

  it('numbers the legs from the array order and replaces them as a unit', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())
    const updated = await db.updateCommuteChain(created.id, {
      legs: [
        { ...LEG, lineId: '010-9-0', lineName: '9路' },
        { ...LEG, lineId: '010-52-0', lineName: '52路', transferExtraMinutes: 5 },
      ],
    })

    // The array is the order: seq is stamped from it, so no client-supplied
    // number can leave a gap or a duplicate behind.
    expect(updated!.legs.map(l => l.seq)).toEqual([0, 1])
    expect(updated!.legs.map(l => l.lineId)).toEqual(['010-9-0', '010-52-0'])

    const [read] = await db.getCommuteChains('default_user')
    // The first leg is gone, not merged: legs are one value, written whole.
    expect(read!.legs).toHaveLength(2)
    expect(read!.legs.some(l => l.lineId === '010-2-0')).toBe(false)
  })

  it('updates the chain row without touching legs that were not sent', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())
    const updated = await db.updateCommuteChain(created.id, { name: '晚间链路', purpose: 'evening' })

    expect(updated!.name).toBe('晚间链路')
    expect(updated!.purpose).toBe('evening')
    expect(updated!.legs).toHaveLength(1)
  })

  it('reports a chain that does not exist as null, not as a created row', async () => {
    const db = new Database()
    expect(await db.getCommuteChain('3f1c2f9e-0000-4000-8000-000000000000')).toBeNull()
    expect(await db.updateCommuteChain('3f1c2f9e-0000-4000-8000-000000000000', { name: 'x' })).toBeNull()
    expect(await db.removeCommuteChain('3f1c2f9e-0000-4000-8000-000000000000')).toBe(false)
  })

  it('orders the list by display order and scopes it to one user', async () => {
    const db = new Database()
    const late = await db.createCommuteChain(chainBody({ name: '第二条', displayOrder: 5 }))
    const early = await db.createCommuteChain(chainBody({ name: '第一条', displayOrder: 1 }))
    const other = await db.createCommuteChain(chainBody({ name: '别人', userId: 'someone_else' }))

    expect((await db.getCommuteChains('default_user')).map(c => c.id)).toEqual([early.id, late.id])
    expect((await db.getCommuteChains('someone_else')).map(c => c.id)).toEqual([other.id])
  })

  it('removes a chain and reports the removal', async () => {
    const db = new Database()
    const created = await db.createCommuteChain(chainBody())

    expect(await db.removeCommuteChain(created.id)).toBe(true)
    expect(await db.getCommuteChains('default_user')).toEqual([])
    expect(await db.removeCommuteChain(created.id)).toBe(false)
  })

  it('maps a stored row so an unset column cannot read as a station', () => {
    const leg = storedCommuteChainLeg({
      seq: 1,
      line_id: '010-2-0',
      line_name: '2路',
      city_code: null,
      board_station_name: null,
      board_station_order: null,
      alight_station_name: '乙路',
      alight_station_order: 7,
      transfer_extra_minutes: null,
    })

    expect(leg.seq).toBe(1)
    expect(leg.cityCode).toBe('027')
    expect(leg.boardStationName).toBeNull()
    expect(leg.boardStationOrder).toBeNull()
    expect(leg.alightStationName).toBe('乙路')
    expect(leg.alightStationOrder).toBe(7)
    expect(leg.transferExtraMinutes).toBeNull()
  })

  it('stamps the sequence from position, ignoring a number from the caller', () => {
    const legs = normalizeCommuteChainLegs([
      { ...LEG, seq: 9 },
      { ...LEG, seq: 9 },
    ])

    expect(legs.map(l => l.seq)).toEqual([0, 1])
    expect(legs[0]!.cityCode).toBe('027')
  })
})

describe('F10 chains: HTTP routes', () => {
  it('creates, reads, lists, patches and deletes a chain', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody()))
      expect(created.success).toBe(true)
      expect(created.data.legs[0].boardStationOrder).toBe(3)

      const listed = json(await listChains(app))
      expect(listed.data.map((c: { id: string }) => c.id)).toEqual([created.data.id])

      const one = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(one.data.name).toBe('上班链路')

      const patched = json(await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${created.data.id}`,
        payload: { name: '晚间链路', purpose: 'evening', legs: [{ ...LEG, lineId: '010-9-0' }] },
      }))
      expect(patched.data.name).toBe('晚间链路')
      expect(patched.data.legs.map((l: { lineId: string }) => l.lineId)).toEqual(['010-9-0'])

      const removed = json(await app.inject({
        method: 'DELETE',
        url: `/api/transit/commute-chains/${created.data.id}`,
      }))
      expect(removed.data.removed).toBe(true)

      const gone = await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` })
      expect(gone.statusCode).toBe(404)
    }
    finally {
      await app.close()
    }
  })

  it('carries an unset station through the wire as null', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const created = json(await createChain(app, chainBody({
        legs: [{ ...LEG, boardStationName: null, boardStationOrder: null }],
      })))

      const read = json(await app.inject({ url: `/api/transit/commute-chains/${created.data.id}` }))
      expect(read.data.legs[0].boardStationName).toBeNull()
      expect(read.data.legs[0].boardStationOrder).toBeNull()
      expect(read.data.legs[0].boardStationName).not.toBe('')
    }
    finally {
      await app.close()
    }
  })

  it('rejects a chain with no ride leg with a 400 and a reason', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const res = await createChain(app, chainBody({ legs: [] }))
      expect(res.statusCode).toBe(400)
      expect(json(res).success).toBe(false)
      expect(typeof json(res).error).toBe('string')
    }
    finally {
      await app.close()
    }
  })

  it('rejects half a station instead of storing the name without its order', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const res = await createChain(app, chainBody({
        legs: [{ ...LEG, boardStationOrder: null }],
      }))
      expect(res.statusCode).toBe(400)
      expect(json(res).success).toBe(false)
    }
    finally {
      await app.close()
    }
  })

  it('answers 404 for a chain that does not exist', async () => {
    forbidNetwork()
    const app = await buildApp()
    try {
      const missing = '3f1c2f9e-0000-4000-8000-000000000000'
      expect((await app.inject({ url: `/api/transit/commute-chains/${missing}` })).statusCode).toBe(404)

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/transit/commute-chains/${missing}`,
        payload: { name: 'x' },
      })
      expect(patched.statusCode).toBe(404)

      const removed = json(await app.inject({
        method: 'DELETE',
        url: `/api/transit/commute-chains/${missing}`,
      }))
      expect(removed.data.removed).toBe(false)
    }
    finally {
      await app.close()
    }
  })
})
