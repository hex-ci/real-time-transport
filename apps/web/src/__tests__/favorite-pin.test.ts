import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { useTransitStore } from '../stores/transit.store'

/**
 * F8 置顶：固定是覆盖在顺序之上的**状态**，绝不对顺序重写。这些测试守住这条线：
 * 固定把一张卡移到顶部，取消固定让它落回自己的槽位，且每个 `displayOrder` 不变。
 */

function favorite(id: string, displayOrder: number, isPinned = false): UserFavoriteLine {
  return {
    id,
    userId: 'default_user',
    cityCode: '027',
    lineId: `line_${id}`,
    lineName: `线路${id}`,
    preferredDirection: 0,
    displayOrder,
    isPinned,
  }
}

/** 形如收藏端点的响应信封。 */
function accepted(data: UserFavoriteLine) {
  return { json: async () => ({ success: true, data }) }
}

function rejected(error: string) {
  return { json: async () => ({ success: false, error }) }
}

function ids(store: ReturnType<typeof useTransitStore>): string[] {
  return store.favorites.map(f => f.id!)
}

describe('F8 pin is a state overlaid on the order', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins a line to the top before the write settles, then keeps the server row', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fb', 1), favorite('fc', 2), favorite('fa', 3)]

    let settleRequest!: (value: unknown) => void
    const inFlight = new Promise((resolve) => {
      settleRequest = resolve
    })
    const fetchMock = vi.fn(() => inFlight)
    vi.stubGlobal('fetch', fetchMock)

    const pending = store.togglePin('fa')

    // 乐观更新：PATCH 尚未结束时卡片已在顶部。
    expect(ids(store)).toEqual(['fa', 'fb', 'fc'])
    expect(store.favorites[0]!.isPinned).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transit/favorites/fa',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ isPinned: true }),
      }),
    )

    settleRequest(accepted(favorite('fa', 3, true)))
    await pending

    expect(ids(store)).toEqual(['fa', 'fb', 'fc'])
    expect(store.favorites.filter(f => f.isPinned).map(f => f.id)).toEqual(['fa'])
  })

  it('drops an un-pinned line back into its own place instead of re-sorting it to the front', async () => {
    const store = useTransitStore()
    // 服务端对 `ORDER BY is_pinned DESC, display_order ASC` 的顺序：
    // `fa` 凭固定打头，其存储位置在最后。
    store.favorites = [favorite('fa', 3, true), favorite('fb', 1), favorite('fc', 2)]

    vi.stubGlobal('fetch', vi.fn(async () => accepted(favorite('fa', 3, false))))

    await store.togglePin('fa')

    expect(ids(store)).toEqual(['fb', 'fc', 'fa'])
    // 这是位置而非顺序写入：每个 display_order 与原来完全一致。
    expect(store.favorites.map(f => f.displayOrder)).toEqual([1, 2, 3])
    expect(store.favorites.some(f => f.isPinned)).toBe(false)
  })

  it('leaves the other lines in place when the leading line is un-pinned', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 1, true), favorite('fb', 2), favorite('fc', 3)]

    vi.stubGlobal('fetch', vi.fn(async () => accepted(favorite('fa', 1, false))))

    await store.togglePin('fa')

    expect(ids(store)).toEqual(['fa', 'fb', 'fc'])
    expect(store.favorites.map(f => f.displayOrder)).toEqual([1, 2, 3])
  })

  it('keeps exactly one line pinned when another line is pinned', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 1, true), favorite('fb', 2), favorite('fc', 3)]

    vi.stubGlobal('fetch', vi.fn(async () => accepted(favorite('fb', 2, true))))

    await store.togglePin('fb')

    expect(ids(store)).toEqual(['fb', 'fa', 'fc'])
    expect(store.favorites.filter(f => f.isPinned).map(f => f.id)).toEqual(['fb'])
  })

  it('rolls the pin back and reports the reason when the write fails', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fb', 1), favorite('fc', 2), favorite('fa', 3)]

    vi.stubGlobal('fetch', vi.fn(async () => rejected('favorite not found')))

    await expect(store.togglePin('fa')).rejects.toThrow('favorite not found')

    expect(ids(store)).toEqual(['fb', 'fc', 'fa'])
    expect(store.favorites.some(f => f.isPinned)).toBe(false)
  })

  it('ignores an id that is not a favourite instead of sending a request', async () => {
    const store = useTransitStore()
    store.favorites = [favorite('fa', 1)]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await store.togglePin('missing')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ids(store)).toEqual(['fa'])
  })
})

describe('F8 pin lives on the home list only', () => {
  const srcDir = fileURLToPath(new URL('../', import.meta.url))

  /** 某视图下的每个源文件，使固定控件无法藏在子组件里。 */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return /\.(vue|ts)$/.test(entry.name) ? [path] : []
    })
  }

  /**
   * 去掉注释的源码，使注释可以陈述规则而不触发针对渲染代码的守卫。处理本仓库写的三种
   * 注释形式：模板里的 HTML 注释，脚本里的 C 风格块注释与行注释——行注释模式避开 URL 的 `://`。
   */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('never exposes pin state to the settings screen', () => {
    // F8：设置页是纯排序编辑器——只显示存储顺序，对固定**无感知**。设置文件的渲染模板
    // 若读到 `isPinned` 或说出「置顶」就破坏了该规则。先剥离注释，故在本树里记录规则本身不会失败。
    const settingsDir = join(srcDir, 'views/settings')
    for (const path of sourceFiles(settingsDir)) {
      const code = stripComments(readFileSync(path, 'utf8'))
      expect(code, `${path} renders pin state; the settings screen must stay pin-unaware`)
        .not.toMatch(/isPinned/)
      expect(code, `${path} mentions 置顶 in rendered code; the settings screen must stay pin-unaware`)
        .not.toMatch(/置顶/)
    }
  })

  it('strips comments without hiding rendered code, so the guard can still fail', () => {
    // 记录该规则的注释对守卫不可见……
    expect(stripComments('<!-- 置顶 is handled on the home list -->\nconst a = 1')).not.toMatch(/置顶/)
    expect(stripComments('// 置顶\nconst a = 1')).not.toMatch(/置顶/)
    expect(stripComments('/* 置顶 */ const a = 1')).not.toMatch(/置顶/)
    // ……但真正渲染的代码不是：这些会触发它。
    expect(stripComments('<span>{{ isPinned ? \'取消置顶\' : \'置顶\' }}</span>')).toMatch(/置顶/)
    // URL 的 `://` 不是行注释。
    expect(stripComments('const u = "https://example.com/置顶"')).toMatch(/置顶/)
  })
})
