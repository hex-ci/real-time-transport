import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CommuteChain } from '@real-time-transport/shared'
import { useTransitStore } from '../stores/transit.store'

/**
 * F10 的通勤链路也有一份可拖动的存储顺序（与 F9 同一套语义）：拖动即是存储顺序，排完即生效，
 * 新增落到末尾。
 *
 * 顺序是**一条**横跨全部链路的列表，故它由 store 拥有、并由 `displayOrder` 写入服务端 ——
 * 一次拖动只为序号真的变了的那些行各发一个 PATCH，且只带序号：名字、目的、乘车段、接驳方式
 * 都不在这次写入里。
 */

function leg(seq: number) {
  return {
    seq,
    lineId: 'bus_027_1',
    lineName: '快线 1 路',
    cityCode: '027',
    boardStationName: '东大桥',
    boardStationOrder: 3,
    alightStationName: '建国门',
    alightStationOrder: 4,
    transferExtraMinutes: null,
    connectionMode: 'walk' as const,
  }
}

function chain(
  id: string,
  displayOrder: number,
  name = `链路${id}`,
  createdAt = '2026-01-01T00:00:00.000Z',
): CommuteChain {
  return {
    id,
    userId: 'default_user',
    name,
    purpose: 'morning',
    displayOrder,
    createdAt,
    legs: [leg(0)],
  }
}

/** 存储顺序的第二个关键字是创建时刻，与服务端索引 `(display_order, created_at)` 一致。 */
function byPosition(rows: CommuteChain[]): CommuteChain[] {
  return [...rows].sort((a, b) =>
    (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}

function ids(store: ReturnType<typeof useTransitStore>): string[] {
  return store.commuteChains.map(row => row.id!)
}

/** 每个 PATCH 的序号与 URL，按发出的顺序。 */
function writes(fetchMock: any): Array<{ id: string, displayOrder: number, body: string }> {
  return fetchMock.mock.calls.map((call: any[]) => {
    const body = String(call[1].body)
    return {
      id: String(call[0]).split('/').pop()!,
      displayOrder: JSON.parse(body).displayOrder,
      body,
    }
  })
}

/** 回显被写行的 PATCH 应答，像端点返回存储行那样。 */
function echoStored(known: CommuteChain[] = []) {
  return vi.fn(async (url: string, init: { body: string }) => {
    const id = String(url).split('/').pop()!
    const { displayOrder } = JSON.parse(init.body) as { displayOrder: number }
    const row = known.find(item => item.id === id) ?? chain(id, displayOrder)
    return { json: async () => ({ success: true, data: { ...row, displayOrder } }) }
  })
}

describe('F10 一次拖动改变顺序，且只写序号变了的行', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('列表顺序变成拖动后的顺序，序号重新盖成一段连续的 0..n-1', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0), chain('c2', 1), chain('c3', 2)]
    vi.stubGlobal('fetch', echoStored(store.commuteChains))

    await store.moveCommuteChain('c3', 'c1')

    expect(ids(store)).toEqual(['c3', 'c1', 'c2'])
    expect(store.commuteChains.map(row => row.displayOrder)).toEqual([0, 1, 2])
  })

  it('序号没变的那一行不发请求', async () => {
    const store = useTransitStore()
    // 四条：被拖动的 c3 落到 c1 的格子，中间两行顺移，而 c4 会留在它自己的序号上。
    store.commuteChains = [chain('c1', 0), chain('c2', 1), chain('c3', 2), chain('c4', 3)]
    const fetchMock = echoStored(store.commuteChains)
    vi.stubGlobal('fetch', fetchMock)

    await store.moveCommuteChain('c3', 'c1')

    expect(writes(fetchMock)).toEqual([
      { id: 'c3', displayOrder: 0, body: JSON.stringify({ displayOrder: 0 }) },
      { id: 'c1', displayOrder: 1, body: JSON.stringify({ displayOrder: 1 }) },
      { id: 'c2', displayOrder: 2, body: JSON.stringify({ displayOrder: 2 }) },
    ])
    // c4 没有被重发：它已经在自己要落到的位置上。
    expect(writes(fetchMock).some(write => write.id === 'c4')).toBe(false)
    expect(ids(store)).toEqual(['c3', 'c1', 'c2', 'c4'])
  })

  it('相邻两行互换时只写这两行', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0), chain('c2', 1), chain('c3', 2)]
    const fetchMock = echoStored(store.commuteChains)
    vi.stubGlobal('fetch', fetchMock)

    await store.moveCommuteChain('c2', 'c1')

    expect(writes(fetchMock).map(write => write.id)).toEqual(['c2', 'c1'])
    expect(ids(store)).toEqual(['c2', 'c1', 'c3'])
  })

  it('一次落不下任何变化的拖动什么都不写', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0), chain('c2', 1)]
    const fetchMock = echoStored(store.commuteChains)
    vi.stubGlobal('fetch', fetchMock)

    await store.moveCommuteChain('c1', 'c1')
    await store.moveCommuteChain('missing', 'c1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['c1', 'c2'])
  })
})

describe('F10 顺序写入只带 displayOrder，不碰链路的其他字段', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('每个 PATCH 体里只有 displayOrder', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0, '早上上班'), chain('c2', 1, '下班回家'), chain('c3', 2, '接孩子')]
    const fetchMock = echoStored(store.commuteChains)
    vi.stubGlobal('fetch', fetchMock)

    await store.moveCommuteChain('c3', 'c1')

    const sent = writes(fetchMock)
    // 三条链路、一次把末条拖到首位：三行的序号都变了。
    expect(sent).toHaveLength(3)
    for (const write of sent) {
      // 只有序号：名字、目的、乘车段、接驳方式都不在写入里。
      expect(JSON.parse(write.body)).toEqual({ displayOrder: write.displayOrder })
      expect(write.body).not.toContain('name')
      expect(write.body).not.toContain('purpose')
      expect(write.body).not.toContain('legs')
    }
    for (const call of fetchMock.mock.calls as Array<[string, { method: string }]>) {
      expect(call[1].method).toBe('PATCH')
    }
  })

  it('被移动的行带着自己的名字、目的与乘车段原地更新', async () => {
    const store = useTransitStore()
    const rows = [chain('c1', 0, '早上上班'), chain('c2', 1, '下班回家')]
    store.commuteChains = rows
    vi.stubGlobal('fetch', echoStored(rows))

    await store.moveCommuteChain('c2', 'c1')

    const moved = store.commuteChains[0]!
    expect(moved.id).toBe('c2')
    expect(moved.name).toBe('下班回家')
    expect(moved.purpose).toBe('morning')
    expect(moved.legs).toEqual(rows[1]!.legs)
  })
})

describe('F10 新增链路落到末尾', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST 带的是「持有的最高序号 + 1」，而不是行数', async () => {
    const store = useTransitStore()
    // 序号不连续（中间一条被删过）：按行数会重发 2，与已在 2 上的行并列。
    store.commuteChains = [chain('c1', 0), chain('c2', 2)]
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      return { json: async () => ({ success: true, data: { ...chain('cnew', body.displayOrder, body.name), legs: [leg(0)] } }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await store.saveCommuteChain(null, {
      name: '新链路',
      purpose: 'morning',
      legs: [{
        lineId: 'bus_027_1',
        lineName: '快线 1 路',
        cityCode: '027',
        boardStationName: '东大桥',
        boardStationOrder: 3,
        alightStationName: '建国门',
        alightStationOrder: 4,
        transferExtraMinutes: null,
        connectionMode: null,
      }],
    })

    expect(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body)).displayOrder).toBe(3)
    // ……并落在列表末尾，而不是插到某处。
    expect(ids(store)).toEqual(['c1', 'c2', 'cnew'])
  })
})

describe('F10 拖动后的顺序就是存储顺序', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('重新读取之后仍是拖动后的顺序', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0), chain('c2', 1), chain('c3', 2)]

    // 服务端自己的存表：一次拖动把它带到的序号落进去，随后 GET 按序号交出这张表。
    let stored: CommuteChain[] = [chain('c1', 0, '链路c1', '2026-01-01T00:00:00.000Z'),
      chain('c2', 1, '链路c2', '2026-01-02T00:00:00.000Z'),
      chain('c3', 2, '链路c3', '2026-01-03T00:00:00.000Z')]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body: string }) => {
      if (!init) return { json: async () => ({ success: true, data: byPosition(stored) }) }
      const id = String(url).split('/').pop()!
      const { displayOrder } = JSON.parse(init.body) as { displayOrder: number }
      stored = stored.map(row => (row.id === id ? { ...row, displayOrder } : row))
      return { json: async () => ({ success: true, data: stored.find(row => row.id === id) }) }
    }))

    await store.moveCommuteChain('c3', 'c1')
    // 一次重新读取：store 报出的必须是服务端存着的那个顺序。
    await store.fetchCommuteChains()

    expect(ids(store)).toEqual(['c3', 'c1', 'c2'])
    expect(store.commuteChains.map(row => row.displayOrder)).toEqual([0, 1, 2])
  })

  it('写入失败时与服务端对账，而不是恢复自己的快照', async () => {
    const store = useTransitStore()
    store.commuteChains = [chain('c1', 0), chain('c2', 1), chain('c3', 2)]
    // 逐行的 PATCH 在服务端侧不是原子的：c3 先落到了 0，随后 c1 被拒。
    const served = [chain('c3', 0), chain('c1', 1), chain('c2', 2)]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/transit/commute-chains?')) {
        return { json: async () => ({ success: true, data: served }) }
      }
      return { json: async () => ({ success: false, error: '换乘链不存在' }) }
    }))

    await expect(store.moveCommuteChain('c3', 'c1')).rejects.toThrow('换乘链不存在')

    expect(ids(store)).toEqual(['c3', 'c1', 'c2'])
  })
})
