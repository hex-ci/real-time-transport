import { describe, expect, it } from 'vitest'
import { Database } from '../db/client.js'

// No connection string -> the in-memory store, which mirrors the SQL semantics
// so ordering and pinning can be asserted without PostgreSQL.
const db = new Database()
const USER = 'default_user'

async function seed(): Promise<{ a: string, b: string, c: string }> {
  for (const f of await db.getFavorites(USER)) await db.removeFavorite(f.id!)
  const one = await db.addFavorite({ lineId: '010-1-0', lineName: '1', displayOrder: 0 })
  const two = await db.addFavorite({ lineId: '010-52-0', lineName: '52', displayOrder: 1 })
  const three = await db.addFavorite({ lineId: '010-300-0', lineName: '300', displayOrder: 2 })
  return { a: one.id!, b: two.id!, c: three.id! }
}

const order = async () => (await db.getFavorites(USER)).map(f => f.lineId)

describe('favourites: pinning', () => {
  it('keeps at most one pinned row per user', async () => {
    const { a, b } = await seed()
    await db.setPinned(USER, a, true)
    await db.setPinned(USER, b, true)
    const pinned = (await db.getFavorites(USER)).filter(f => f.isPinned)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]!.lineId).toBe('010-52-0')
  })

  it('lists the pinned row first without changing the stored order', async () => {
    const { c } = await seed()
    await db.setPinned(USER, c, true)
    expect(await order()).toEqual(['010-300-0', '010-1-0', '010-52-0'])
  })

  it('un-pinning drops the row back to its original position', async () => {
    const { c } = await seed()
    const before = await order()
    await db.setPinned(USER, c, true)
    await db.setPinned(USER, c, false)
    expect(await order()).toEqual(before)
  })

  it('reports false for a row that does not exist', async () => {
    await seed()
    expect(await db.setPinned(USER, 'no-such-id', true)).toBe(false)
  })
})

describe('favourites: manual ordering', () => {
  it('persists displayOrder written through updateFavorite', async () => {
    const { a } = await seed()
    await db.updateFavorite(a, { displayOrder: 9 })
    const moved = (await db.getFavorites(USER)).find(f => f.id === a)
    expect(moved!.displayOrder).toBe(9)
  })

  it('orders by displayOrder ascending', async () => {
    const { a } = await seed()
    await db.updateFavorite(a, { displayOrder: 5 })
    expect(await order()).toEqual(['010-52-0', '010-300-0', '010-1-0'])
  })
})

describe('favourites: the creation instant is the order with the position', () => {
  it('reports a creation instant on every row', async () => {
    const { a } = await seed()
    const row = (await db.getFavorites(USER)).find(f => f.id === a)

    // The column exists in the table; the row mapping has to carry it, because
    // it is the tiebreak a client needs to mirror `created_at ASC` locally.
    expect(row!.createdAt).toBeTruthy()
    expect(Number.isNaN(Date.parse(row!.createdAt!))).toBe(false)
  })

  it('orders rows that tie on displayOrder by creation instant', async () => {
    for (const f of await db.getFavorites(USER)) await db.removeFavorite(f.id!)
    await db.addFavorite({ lineId: '010-1-0', lineName: '1', displayOrder: 0 })
    await db.addFavorite({ lineId: '010-52-0', lineName: '52', displayOrder: 0 })
    // Both rows claim position 0: the earlier one holds the earlier slot.
    expect(await order()).toEqual(['010-1-0', '010-52-0'])
  })
})

describe('favourites: pinning is scoped to one user', () => {
  const USER_A = 'user_a'
  const USER_B = 'user_b'

  async function seedUser(userId: string): Promise<string> {
    for (const f of await db.getFavorites(userId)) await db.removeFavorite(f.id!)
    const fav = await db.addFavorite({ userId, lineId: `010-${userId}`, lineName: userId, displayOrder: 0 })
    return fav.id!
  }

  it('pinning one user\'s line leaves another user\'s pin untouched', async () => {
    const a = await seedUser(USER_A)
    const b = await seedUser(USER_B)

    // The second pin's "clear the previous pin for THIS user" step must not
    // reach across users: SQL scopes it with `WHERE user_id = $1`.
    await db.setPinned(USER_A, a, true)
    await db.setPinned(USER_B, b, true)

    const pinnedA = (await db.getFavorites(USER_A)).filter(f => f.isPinned)
    const pinnedB = (await db.getFavorites(USER_B)).filter(f => f.isPinned)

    expect(pinnedA.map(f => f.id)).toEqual([a])
    expect(pinnedB.map(f => f.id)).toEqual([b])
  })
})
