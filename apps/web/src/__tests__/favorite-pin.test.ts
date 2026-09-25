import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UserFavoriteLine } from '@real-time-transport/shared'
import { useTransitStore } from '../stores/transit.store'

/**
 * F8 置顶: the pin is a STATE overlaid on the order, never a rewrite of it.
 * These tests hold that line: a pin moves one card to the top, un-pinning drops
 * it back into its own slot with every `displayOrder` untouched.
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

/** Response envelopes shaped like the favourites endpoint's. */
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

    // Optimistic: the card is at the top while the PATCH is still open.
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
    // The server's own order for `ORDER BY is_pinned DESC, display_order ASC`:
    // `fa` leads on its pin, its stored position is last.
    store.favorites = [favorite('fa', 3, true), favorite('fb', 1), favorite('fc', 2)]

    vi.stubGlobal('fetch', vi.fn(async () => accepted(favorite('fa', 3, false))))

    await store.togglePin('fa')

    expect(ids(store)).toEqual(['fb', 'fc', 'fa'])
    // Position, not order-write: every display_order is exactly as it was.
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

  /** Every source file under a view, so a pin control cannot hide in a child component. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return /\.(vue|ts)$/.test(entry.name) ? [path] : []
    })
  }

  /**
   * Source with its comments removed, so a comment may STATE a rule without
   * tripping a guard that is about rendered code. Handles the three comment
   * forms this repo writes: HTML comments in templates, and both C-style
   * block and line comments in scripts — the line pattern spares the `://`
   * of a URL.
   */
  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('never exposes pin state to the settings screen', () => {
    // F8: the settings screen is a pure order editor — it shows the stored
    // order and is UNAWARE of pinning. A settings file whose rendered template
    // reads `isPinned` or says 置顶 would break that rule. Comments are stripped
    // first, so merely documenting the rule in this tree does not fail here.
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
    // A comment that documents the rule is invisible to the guard...
    expect(stripComments('<!-- 置顶 is handled on the home list -->\nconst a = 1')).not.toMatch(/置顶/)
    expect(stripComments('// 置顶\nconst a = 1')).not.toMatch(/置顶/)
    expect(stripComments('/* 置顶 */ const a = 1')).not.toMatch(/置顶/)
    // ...but actual rendered code is not: these do trip it.
    expect(stripComments('<span>{{ isPinned ? \'取消置顶\' : \'置顶\' }}</span>')).toMatch(/置顶/)
    // A URL's `://` is not a line comment.
    expect(stripComments('const u = "https://example.com/置顶"')).toMatch(/置顶/)
  })
})
