import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { useTransitStore } from '../stores/transit.store'

/**
 * 「只允许关注一条」on the client: a duplicate follow is an OUTCOME, not a failure.
 *
 * The server refuses a follow it already holds with 409 + `alreadyFollowed` and
 * hands back the row that holds the line. Reading that as a plain failure would be
 * as wrong as reading it as a new follow — the line IS followed. So the store must
 * report `false` (this call did not follow it), keep every existing row in place,
 * and take in the row the server named, `reverseLineId` included: that column is
 * what lets the settings screen's own 「已关注」 label be correct for the route the
 * user just tried to follow again.
 *
 * The settings page's own half of this (`lines.vue`) is not pinned here — it is
 * being edited by another pass, and a test needing code that does not exist yet
 * would only be red. What is pinned is the store contract that half depends on.
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

/** The server's answer to a POST /favorites, as the store reads it. */
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
    // The direction the stored row was missing: without it the screen cannot show
    // the route as followed, which is the only wording for this outcome.
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

    // No row to reconcile and nothing that says a follow happened: the outcome is
    // unknown, and an unknown outcome must not be answered with a claim either way.
    await expect(store.addFavorite({ lineId: DOWN, lineName: '52路' })).rejects.toThrow('已关注')
    expect(store.favorites).toHaveLength(1)
  })
})
