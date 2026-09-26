import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { reorder, useTransitStore } from '../stores/transit.store'

/**
 * F9 拖动排序：所有关注线路共享一套**位置**顺序，固定只是其上的一个状态。一次移动会在
 * 整个列表上盖下一段连续位置——含被固定行，绝不豁免——而固定本身不动，这使设置页得以
 * 保持纯粹的排序编辑器，显示存储的顺序。
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
 * 回显被移动行的 PATCH 应答——它被赋予的位置，以及该行原有的其余内容，
 * 与端点返回存储行的方式一致。
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
    // 存储行今天都带位置 0；被固定行不豁免这段连续位置，因为列表是位置，而固定是状态。
    const out = reorder([favorite('fp', 0, true), favorite('fb', 0), favorite('fc', 0)], 2, 0)

    expect(out.map(f => f.id)).toEqual(['fc', 'fp', 'fb'])
    expect(positions(out)).toEqual([0, 1, 2])
    // 固定原样随行，仍只占一行深。
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
      // 坏的索引不得静默重排已存储的行。
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

    // 只有 fa 与 fb 互换；fc 已在它的位置上。
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
    // 服务端下发的首页顺序：被固定行在前，它自己的位置在最后。
    store.favorites = [favorite('fp', 2, true), favorite('fb', 0), favorite('fc', 1)]
    vi.stubGlobal('fetch', echoStored(store.favorites))

    await store.moveFavorite('fb', 'fp')

    // 按位置排序：fb 占了 fp 的槽位——它跨过的行上移，含固定行；
    // 固定是对顺序的状态，不是对顺序的豁免。
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

    // 设置页只显示 027，因此报告「a2 → a1」；另一城市的行保持相对位置，整段是 0..n-1。
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
    // 服务端侧该批不是原子的：'fc' 在 'fa' 被拒前已到达位置 0，故存储顺序现为 fc/fa/fb。
    // 此处恢复快照会报出服务端并不持有的顺序。
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

    // 首个 PATCH 成功——服务端现在把 fc 放在位置 0——第二个失败。该批在服务端侧非原子，
    // 故 store 必须报出**已存储**的内容，而非自己移动前的快照。
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
 * F9：存储顺序的第二个关键字是 `created_at`，固定在其中根本不是关键字。`displayOrder`
 * 打平的行才是 store 真正持有的状态（重复关注会重发一个），故打平必须按创建时刻、而非
 * 固定优先数组到达的顺序来解。
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
    // 今天存储行都带位置 0 且按固定优先到达。被固定行是**最后**关注的，故它自己的槽位在最后：
    // 固定是首页列表的覆盖层，不得在纯排序编辑器里提起一行。
    store.favorites = [
      favorite('fp', 0, true, '027', '2024-01-03T00:00:00.000Z'),
      favorite('fb', 0, false, '027', '2024-01-01T00:00:00.000Z'),
      favorite('fc', 0, false, '027', '2024-01-02T00:00:00.000Z'),
    ]

    expect(store.favoriteOrder.map(f => f.id)).toEqual(['fb', 'fc', 'fp'])
    // ……而首页列表仍以固定行打头：两种排序不同。
    expect(store.favorites.map(f => f.id)).toEqual(['fp', 'fb', 'fc'])
  })

  it('resolves a reissued position by creation instant, not by the pin', () => {
    // 关注 A(1) → 关注 B(2) → 取关 A → 关注 C 复用 2 → 固定 C。
    // GET /favorites 随后交出 [C, B]，尽管 C 是更新的行。
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
    // 在打平内部按最新在前排列，这不是存储顺序。
    store.favorites = [
      favorite('a', 1, false, '027', '2024-01-02T00:00:00.000Z'),
      favorite('b', 1, false, '027', '2024-01-01T00:00:00.000Z'),
      favorite('p', 5, false, '027', '2024-01-03T00:00:00.000Z'),
    ]
    const pinned = favorite('p', 5, true, '027', '2024-01-03T00:00:00.000Z')
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: pinned }) })))

    await store.togglePin('p')

    // 对应 `ORDER BY is_pinned DESC, display_order ASC, created_at ASC`：
    // 固定行虽位置最大仍打头，打平解出 b 在 a 前。
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
    // A(1) 与 B(2) 曾被关注，随后 A 被取关：只剩位置 2，故按行数（1）会重发 2 并与 fb 打平。
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
