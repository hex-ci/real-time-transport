import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { useTransitStore } from '@/stores/transit.store'
import { lineLoadNoticeOf, lineLoadStateOf } from '@/line-load-state'

/**
 * 线路不存在 and 加载失败 are two facts, and the page stated one sentence for both.
 *
 * A line id that does not exist rendered the server's own `error` string as its
 * heading — 「Line not found」, English, in an app with no i18n and no other Latin
 * string — above 「未能加载该线路数据，请稍后重试或检查线路号」. That sentence promised a
 * retry that cannot help a nonexistent line, and asked the user to check a 线路号 that
 * came from the route rather than from a form.
 *
 * Three things are pinned here: the status that tells the two apart, the copy each
 * state is worded with, and the wiring that actually reaches them — the store's own
 * `loadLine` against a stubbed response, so a heading that came from the payload
 * again would be caught here rather than in the browser.
 */

/** A response envelope shaped like the routes' own. */
function answered(status: number, body: unknown) {
  return { status, json: async () => body }
}

const DETAIL_BODY = {
  lineId: 'bus_027_1',
  direction: 0,
  directionName: '开往建国门',
  cityCode: '027',
  stops: [{ id: 's1', name: '东大桥', order: 1, interchanges: [] }],
}

/** Answer every transit read this page makes, with the detail's own status. */
function stubReads(detail: () => unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    if (href.includes('/live')) return answered(200, { success: true, data: null })
    return detail()
  }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the status, not the payload, says which absence this is', () => {
  it('reads 404 as 「no such line」 and everything else as a failed load', () => {
    // 404 is the detail route's own refusal — "Line not found" is its body, and it is
    // the only status that means the line is not there.
    expect(lineLoadStateOf(404)).toBe('not-found')
    for (const status of [400, 500, 502, 503, 200]) {
      expect(lineLoadStateOf(status), `status ${status}`).toBe('unavailable')
    }
  })
})

describe('each absence states only its own truth', () => {
  it('promises a retry only where a retry can help', () => {
    const missing = lineLoadNoticeOf('not-found')
    const failed = lineLoadNoticeOf('unavailable')

    // The failed load may succeed later; the missing line will not appear.
    expect(failed.detail).toContain('重试')
    expect(missing.detail, 'a line that does not exist cannot be retried into existing').not.toContain('重试')
    expect(missing.detail).not.toContain('稍后')
    expect(missing.title).not.toBe(failed.title)
  })

  it('names the checkable action for the missing line and the wait for the failure', () => {
    // The missing line's user is at the end of a wrong address: the action is to pick
    // the line again, not to check a 线路号 that came from the route itself.
    expect(lineLoadNoticeOf('not-found').detail).toContain('没有找到这个线路号')
    expect(lineLoadNoticeOf('unavailable').detail).toContain('请稍后重试')
  })

  it('states both headings in zh-CN — no server string reaches the screen', () => {
    for (const state of ['not-found', 'unavailable'] as const) {
      const notice = lineLoadNoticeOf(state)
      expect(notice.title, `${state}'s heading carries a Latin letter`).not.toMatch(/[A-Za-z]/)
      expect(notice.detail, `${state}'s sentence carries a Latin letter`).not.toMatch(/[A-Za-z]/)
      // …and the heading is not the endpoint's own error body.
      expect(notice.title).not.toBe('Line not found')
    }
  })
})

describe('the component states the copy, never a string from a payload', () => {
  const component = readFileSync(
    fileURLToPath(new URL('../views/line-detail/components/line-load-state.vue', import.meta.url)),
    'utf8',
  )

  it('renders the notice module, and holds no raw error field to render instead', () => {
    // The heading used to be whatever the response said: `{{ loadError || '线路不存在或数据源暂不可用' }}`,
    // which is how 「Line not found」 reached a zh-CN screen. A component that kept an
    // error string as a prop would let the next server-side wording do it again.
    expect(component).toContain('lineLoadNoticeOf')
    expect(component).not.toContain('loadError')
    // The sentence for the failed load lives in the module too, so the two states can
    // not drift apart in the component's own markup.
    expect(component).not.toContain('未能加载该线路数据')
  })
})

describe('the store reaches those two states from the response status', () => {
  it('reports 「no such line」 for the 404 the detail route answers', async () => {
    stubReads(() => answered(404, { success: false, error: 'Line not found' }))
    const store = useTransitStore()

    await store.loadLine('zzz_no_such_line', 0, '027')

    expect(store.loadFailure).toBe('not-found')
    expect(store.currentLineDetail).toBeNull()
    // The raw body never travels as the heading.
    expect(lineLoadNoticeOf(store.loadFailure!).title).not.toContain('Line not found')
  })

  it('reports a failed load for a server that could not produce the line', async () => {
    stubReads(() => answered(500, { success: false, error: 'Internal Server Error' }))
    const store = useTransitStore()

    await store.loadLine('bus_027_1', 0, '027')

    expect(store.loadFailure).toBe('unavailable')
  })

  it('reports a failed load for a request that never arrived, and for an empty answer', async () => {
    stubReads(() => {
      throw new Error('the connection is down')
    })
    const store = useTransitStore()
    await store.loadLine('bus_027_1', 0, '027')
    expect(store.loadFailure).toBe('unavailable')

    stubReads(() => answered(200, { success: false }))
    await store.loadLine('bus_027_1', 0, '027')
    expect(store.loadFailure).toBe('unavailable')
  })

  it('reports no absence at all when the line loads', async () => {
    stubReads(() => answered(200, { success: true, data: DETAIL_BODY }))
    const store = useTransitStore()

    await store.loadLine('bus_027_1', 0, '027')

    expect(store.loadFailure).toBeNull()
    expect(store.currentLineDetail?.lineId).toBe('bus_027_1')
  })
})
