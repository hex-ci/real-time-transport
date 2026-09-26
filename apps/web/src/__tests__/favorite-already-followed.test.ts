import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { useTransitStore } from '../stores/transit.store'

/**
 * 客户端的「只允许关注一条」：重复关注是一种**结果**，不是失败。
 *
 * 服务端对已持有的关注回 409 + `alreadyFollowed`，并交出持有该线路的行。把它当成普通
 * 失败与当成一次新关注同样错——线路**确实**已被关注。因此 store 必须报告 `false`
 * （本次调用没有关注它）、保持所有既存行不动，并接收服务端点名的那一行（含
 * `reverseLineId`）：正是该列让设置页的「已关注」标签对用户刚重复关注的那条线路正确。
 *
 * 设置页自身的那一半（`lines.vue`）不在此钉：它由另一轮改动并行编辑。
 */

const UP = '010-52-0'
const DOWN = '010-52-1'

function row(over: Partial<UserFavoriteLine> = {}): UserFavoriteLine {
  return {
    id: 'fa',
    userId: 'default_user',
    cityCode: '027',
    lineId: UP,
    lineName: '52路',
    preferredDirection: 0,
    displayOrder: 0,
    isPinned: false,
    ...over,
  }
}

/** 服务端对 POST /favorites 的应答，即 store 所读的内容。 */
function answers(body: unknown) {
  return vi.fn(async () => ({ json: async () => body }))
}

describe('服务器说「已关注」时，关注没有被当成本次的新关注', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('报 false，不新增卡片，并收下服务器指出的那一行', async () => {
    const store = useTransitStore()
    const stored = row()
    store.favorites = [stored]
    vi.stubGlobal('fetch', answers({
      success: false,
      alreadyFollowed: true,
      error: '已关注',
      data: { ...stored, reverseLineId: DOWN },
    }))

    const followed = await store.addFavorite({ lineId: DOWN, lineName: '52路' })

    expect(followed, 'a duplicate follow was reported as this call having followed it').toBe(false)
    expect(store.favorites, 'the opposite direction was added as a second card').toHaveLength(1)
    expect(store.favorites[0]!.id).toBe('fa')
    // 既存行缺的那个方向：没有它，界面就无法把这条线路显示为已关注，而这是本结果的唯一措辞。
    expect(store.favorites[0]!.reverseLineId).toBe(DOWN)
  })

  it('真的关注上时仍然报 true，并留下新的一行（反向断言）', async () => {
    const store = useTransitStore()
    store.favorites = [row()]
    vi.stubGlobal('fetch', answers({
      success: true,
      data: row({ id: 'fb', lineId: '010-300-0', lineName: '300路', displayOrder: 1 }),
    }))

    const followed = await store.addFavorite({ lineId: '010-300-0', lineName: '300路' })

    expect(followed).toBe(true)
    expect(store.favorites).toHaveLength(2)
  })

  it('说了已关注却没给出那一行：不算成功，也不把这条事实吞掉', async () => {
    const store = useTransitStore()
    store.favorites = [row()]
    vi.stubGlobal('fetch', answers({ success: false, alreadyFollowed: true, error: '已关注' }))

    // 没有可对账的行，也没有任何东西表明发生了一次关注：结果未知，未知的结果不得给出任何方向的断言。
    await expect(store.addFavorite({ lineId: DOWN, lineName: '52路' })).rejects.toThrow('已关注')
    expect(store.favorites).toHaveLength(1)
  })
})
