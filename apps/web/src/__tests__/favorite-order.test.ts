import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { reorder, useTransitStore } from '../stores/transit.store'

/**
 * F9 拖动排序: one order of POSITIONS shared by every followed line, with the pin
 * laid over it as a state. A move stamps a contiguous run of positions over the
 * whole list — the pinned row included, never exempted — and leaves the pin
 * itself alone, which is what lets the settings screen stay a pure order editor
 * showing the stored order.
 */

function favorite(
  id: string,
  displayOrder: number,
  isPinned = false,
  cityCode = '027',
  createdAt?: string,
): UserFavoriteLine {
  return {
    id,
    userId: 'default_user',
    cityCode,
    lineId: `line_${id}`,
    lineName: `线路${id}`,
    preferredDirection: 0,
    displayOrder,
    isPinned,
    createdAt,
  }
}

/**
 * A PATCH answer echoing the row it was asked to move — the position it was
 * given, and everything else the row already carried, exactly as the endpoint
 * returns the stored row.
 */
function echoStored(known: UserFavoriteLine[] = []) {
  return vi.fn(async (url: string, init: { body: string }) => {
    const id = String(url).split('/').pop()!
    const { displayOrder } = JSON.parse(init.body) as { displayOrder: number }
    const row = known.find(f => f.id === id) ?? favorite(id, displayOrder)
    return { json: async () => ({ success: true, data: { ...row, displayOrder } }) }
  })
}

function ids(store: ReturnType<typeof useTransitStore>): string[] {
  return store.favorites.map(f => f.id!)
}

function positions(rows: UserFavoriteLine[]): number[] {
  return rows.map(f => f.displayOrder)
}

describe('F9 reorder stamps one contiguous run of positions', () => {
  const rows = () => [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]

  it('moves a row down the list and renumbers every position', () => {
    const out = reorder(rows(), 0, 2)

    expect(out.map(f => f.id)).toEqual(['fb', 'fc', 'fa'])
    expect(positions(out)).toEqual([0, 1, 2])
  })

  it('moves a row up the list and renumbers every position', () => {
    const out = reorder(rows(), 2, 0)

    expect(out.map(f => f.id)).toEqual(['fc', 'fa', 'fb'])
    expect(positions(out)).toEqual([0, 1, 2])
  })

  it('gives the pinned row a position like every other row', () => {
    // The stored rows all carry position 0 today; the pinned one is not exempt
    // from the run, because the list is positions and the pin is a state.
    const out = reorder([favorite('fp', 0, true), favorite('fb', 0), favorite('fc', 0)], 2, 0)

    expect(out.map(f => f.id)).toEqual(['fc', 'fp', 'fb'])
    expect(positions(out)).toEqual([0, 1, 2])
    // The pin rides along untouched, still exactly one row deep.
    expect(out.find(f => f.id === 'fp')!.isPinned).toBe(true)
    expect(out.filter(f => f.isPinned)).toHaveLength(1)
  })

  it('renumbers positions that were never contiguous', () => {
    const out = reorder([favorite('fa', 0), favorite('fb', 5), favorite('fc', 9)], 0, 0)

    expect(out.map(f => f.id)).toEqual(['fa', 'fb', 'fc'])
    expect(positions(out)).toEqual([0, 1, 2])
  })

  it('leaves the list it was given alone', () => {
    const input = rows()
    reorder(input, 0, 2)

    expect(input.map(f => f.id)).toEqual(['fa', 'fb', 'fc'])
    expect(positions(input)).toEqual([0, 1, 2])
  })

  it('rewrites nothing for an index outside the list', () => {
    for (const [from, to] of [[-1, 1], [0, 9], [9, 0]] as const) {
      const out = reorder([favorite('fa', 0), favorite('fb', 5)], from, to)

      expect(out.map(f => f.id)).toEqual(['fa', 'fb'])
      // A bad index must not silently renumber stored rows.
      expect(positions(out)).toEqual([0, 5])
    }
  })
})

describe('F9 a move is written one PATCH per row', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends one displayOrder per row that moved', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]
    const fetchMock = echoStored()
    vi.stubGlobal('fetch', fetchMock)

    await store.moveFavorite('fc', 'fa')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transit/favorites/fc',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ displayOrder: 0 }),
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transit/favorites/fa',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ displayOrder: 1 }),
      }),
    )
    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fc', 'fa', 'fb'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1, 2])
  })

  it('leaves a row alone whose position did not change', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]
    const fetchMock = echoStored()
    vi.stubGlobal('fetch', fetchMock)

    await store.moveFavorite('fb', 'fa')

    // Only fa and fb swap; fc is already stored at its position.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fb', 'fa', 'fc'])
  })

  it('writes nothing for a drop that changes no position', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1)]
    const fetchMock = echoStored()
    vi.stubGlobal('fetch', fetchMock)

    await store.moveFavorite('fa', 'fa')
    await store.moveFavorite('missing', 'fa')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['fa', 'fb'])
  })

  it('keeps the home list pin-first while the position moves', async () => {
    const store = useTransitStore()
    // The home order the server sends: the pinned row leads, its own position
    // is last.
    store.favorites = [favorite('fp', 2, true), favorite('fb', 0), favorite('fc', 1)]
    vi.stubGlobal('fetch', echoStored(store.favorites))

    await store.moveFavorite('fb', 'fp')

    // Position order: fb took fp's slot — the rows it crossed shifted up, the
    // pin included, since a pin is a state over the order and not immunity from
    // it.
    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fc', 'fp', 'fb'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1, 2])
    expect(store.favorites.map(f => f.id)).toEqual(['fp', 'fc', 'fb'])
    expect(store.favorites.filter(f => f.isPinned).map(f => f.id)).toEqual(['fp'])
  })

  it('resolves the move in the one list every city shares', async () => {
    const store = useTransitStore()
    store.favorites = [
      favorite('a1', 0),
      favorite('b1', 1, false, '010'),
      favorite('a2', 2),
    ]
    vi.stubGlobal('fetch', echoStored())

    // The settings screen shows 027 only, so it reports 「a2 onto a1」; the row
    // of the other city keeps its relative place, and the whole run is 0..n-1.
    await store.moveFavorite('a2', 'a1')

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['a2', 'a1', 'b1'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1, 2])
  })

  it('falls back to the snapshot when the write fails and the server cannot be re-read', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ success: false, error: 'favorite not found' }),
    })))

    await expect(store.moveFavorite('fc', 'fa')).rejects.toThrow('favorite not found')

    expect(ids(store)).toEqual(['fa', 'fb', 'fc'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1, 2])
  })

  it('adopts the stored order when a write fails, instead of claiming the rollback', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]
    // The batch is not atomic server-side: 'fc' reached position 0 before 'fa'
    // was rejected, so the stored order is now fc/fa/fb. Restoring the snapshot
    // here would report an order the server does not hold.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body: string }) => {
      if (!init) {
        return { json: async () => ({ success: true, data: [favorite('fc', 0), favorite('fa', 1), favorite('fb', 2)] }) }
      }
      return { json: async () => ({ success: false, error: 'favorite not found' }) }
    }))

    await expect(store.moveFavorite('fc', 'fa')).rejects.toThrow('favorite not found')

    expect(ids(store)).toEqual(['fc', 'fa', 'fb'])
  })

  it('rolls back when the request itself fails', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1)]
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    await expect(store.moveFavorite('fb', 'fa')).rejects.toThrow('offline')

    expect(ids(store)).toEqual(['fa', 'fb'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1])
  })

  it('reports the stored order when part of the batch was already applied', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 0), favorite('fb', 1), favorite('fc', 2)]

    // The first PATCH lands — the server now holds fc at position 0 — and the
    // second fails. The batch is not atomic server-side, so the store must
    // report what is STORED, not its own pre-move snapshot.
    const stored = [favorite('fc', 0), favorite('fa', 1), favorite('fb', 2)]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url) === '/api/transit/favorites') {
        return { json: async () => ({ success: true, data: stored }) }
      }
      if (String(url) === '/api/transit/favorites/fc') {
        return { json: async () => ({ success: true, data: favorite('fc', 0) }) }
      }
      return { json: async () => ({ success: false, error: '顺序保存失败' }) }
    }))

    await expect(store.moveFavorite('fc', 'fa')).rejects.toThrow('顺序保存失败')

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fc', 'fa', 'fb'])
    expect(positions(store.favoriteOrder)).toEqual([0, 1, 2])
  })
})

/**
 * F9: the stored order's second keyword is `created_at`, and the pin is not a
 * keyword in it at all. Rows that tie on `displayOrder` are the state the
 * store actually holds — a re-follow reissues one — so a tie must resolve by
 * creation instant rather than by whatever order the pin-first array arrived in.
 */
describe('F9 the settings order is pin-independent under ties', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a pinned row at its creation slot when every position ties', () => {
    const store = useTransitStore()
    // Today's stored rows all carry position 0 and arrive pin-first. The pinned
    // row was followed LAST, so its own slot is last: the pin is a home-list
    // overlay and must not lift a row in a pure order editor.
    store.favorites = [
      favorite('fp', 0, true, '027', '2024-01-03T00:00:00.000Z'),
      favorite('fb', 0, false, '027', '2024-01-01T00:00:00.000Z'),
      favorite('fc', 0, false, '027', '2024-01-02T00:00:00.000Z'),
    ]

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fb', 'fc', 'fp'])
    // ...and the home list still leads with the pin: the two orderings differ.
    expect(store.favorites.map(f => f.id)).toEqual(['fp', 'fb', 'fc'])
  })

  it('resolves a reissued position by creation instant, not by the pin', () => {
    // Follow A(1) → follow B(2) → unfollow A → follow C reuses 2 → pin C.
    // GET /favorites then hands back [C, B] although C is the newer row.
    const store = useTransitStore()
    store.favorites = [
      favorite('fc', 2, true, '027', '2024-01-03T00:00:00.000Z'),
      favorite('fb', 2, false, '027', '2024-01-02T00:00:00.000Z'),
    ]

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fb', 'fc'])
  })

  it('breaks a tie with no pin at all by creation instant', () => {
    const store = useTransitStore()
    store.favorites = [
      favorite('fb', 0, false, '027', '2024-01-02T00:00:00.000Z'),
      favorite('fa', 0, false, '027', '2024-01-01T00:00:00.000Z'),
    ]

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fa', 'fb'])
  })

  it('orders the home list pin-first, then by position and instant', async () => {
    const store = useTransitStore()
    // Listed newest-first inside the tie, which is not the stored order.
    store.favorites = [
      favorite('a', 1, false, '027', '2024-01-02T00:00:00.000Z'),
      favorite('b', 1, false, '027', '2024-01-01T00:00:00.000Z'),
      favorite('p', 5, false, '027', '2024-01-03T00:00:00.000Z'),
    ]
    const pinned = favorite('p', 5, true, '027', '2024-01-03T00:00:00.000Z')
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: pinned }) })))

    await store.togglePin('p')

    // Mirrors `ORDER BY is_pinned DESC, display_order ASC, created_at ASC`: the
    // pin leads despite the highest position, and the tie resolves b before a.
    expect(ids(store)).toEqual(['p', 'b', 'a'])
  })
})

describe('F9 following a line takes a fresh position', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function acceptAdded() {
    return vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { displayOrder: number }
      return { json: async () => ({ success: true, data: favorite('fz', body.displayOrder) }) }
    })
  }

  it('does not reissue a position an existing row already holds', async () => {
    const store = useTransitStore()
    // A(1) and B(2) were followed, then A was unfollowed: only position 2
    // remains, so the row count (1) would reissue 2 and tie with fb.
    store.favorites = [favorite('fb', 2)]
    const fetchMock = acceptAdded()
    vi.stubGlobal('fetch', fetchMock)

    await store.addFavorite({ lineId: 'line_fz', lineName: '新线路' })

    const init = fetchMock.mock.calls[0]![1]
    expect(JSON.parse(init.body).displayOrder).toBe(3)
  })

  it('starts an empty list at the first position instead of a negative slot', async () => {
    const store = useTransitStore()
    const fetchMock = acceptAdded()
    vi.stubGlobal('fetch', fetchMock)

    await store.addFavorite({ lineId: 'line_fz', lineName: '新线路' })

    const init = fetchMock.mock.calls[0]![1]
    expect(JSON.parse(init.body).displayOrder).toBe(0)
  })
})
