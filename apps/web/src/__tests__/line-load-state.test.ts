import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { useTransitStore } from '@/stores/transit.store'
import { lineLoadNoticeOf, lineLoadStateOf } from '@/line-load-state'

/**
 * 「线路不存在」与「加载失败」是两个事实，页面却给了同一句话。
 *
 * 不存在的线路 id 曾把服务端自己的 `error` 串渲染成标题（英文，在一个无 i18n 的应用里），
 * 并承诺了「重试」——而对不存在的线路，重试毫无帮助。
 *
 * 这里钉三件事：区分两者的状态、每个状态的措辞，以及真正到达它们的接线——store 自己的
 * `loadLine` 对桩响应，使「标题又来自载荷」能在这里而非浏览器里被抓到。
 */

/** 形如各路由自身的响应信封。 */
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

/** 应答本页发出的每次 transit 读取，状态取自 detail 自身的状态。 */
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
    // 404 是 detail 路由自己的拒绝，且是唯一表示线路不在的状态。
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

    // 加载失败以后可能成功；缺失的线路不会出现。
    expect(failed.detail).toContain('重试')
    expect(missing.detail, 'a line that does not exist cannot be retried into existing').not.toContain('重试')
    expect(missing.detail).not.toContain('稍后')
    expect(missing.title).not.toBe(failed.title)
  })

  it('names the checkable action for the missing line and the wait for the failure', () => {
    // 缺失线路的用户处在错误地址的尽头：动作是重新选线路，
    // 而不是检查一个来自路由自身的线路号。
    expect(lineLoadNoticeOf('not-found').detail).toContain('没有找到这个线路号')
    expect(lineLoadNoticeOf('unavailable').detail).toContain('请稍后重试')
  })

  it('states both headings in zh-CN — no server string reaches the screen', () => {
    for (const state of ['not-found', 'unavailable'] as const) {
      const notice = lineLoadNoticeOf(state)
      expect(notice.title, `${state}'s heading carries a Latin letter`).not.toMatch(/[A-Za-z]/)
      expect(notice.detail, `${state}'s sentence carries a Latin letter`).not.toMatch(/[A-Za-z]/)
      // ……且标题不是端点自己的错误正文。
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
    // 标题不得取自响应内容：组件若留着错误串 prop，下一次服务端措辞会重演旧问题。
    expect(component).toContain('lineLoadNoticeOf')
    expect(component).not.toContain('loadError')
    // 加载失败的句子也在模块里，使两个状态不会在组件自己的标记里漂移。
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
    // 原始正文绝不作为标题传递。
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
