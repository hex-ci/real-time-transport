import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RefreshLiveResult } from '@real-time-transport/shared'
import { click, mountComponent } from '@/__tests__/views/settings/settings-harness'
import { useTransitStore } from '../stores/transit.store'
import {
  REFRESH_COOLDOWN_TOAST_ID,
  REFRESH_RESULT_DURATION_MS,
  RefreshCooldownContent,
} from '../refresh-toast'

/**
 * 一次刷新的结局去哪里说。
 *
 * 三页共用同一条提示（宿主只有 `App.vue` 里那一份），故此处钉的是提示层与 store 之间的接线：
 * 一次按下推几条、每条的内容与身份、冷却那条按什么节奏改写自己、以及宿主那一份的配置。
 *
 * 提示库本身被替换掉：本文件评判的是「我们推了什么」，不是它内部的 DOM —— 库升级会改后者，而前者
 * 是我们自己的契约。库自带一条 polite 的 live region（`Toaster` 渲染的容器），故读屏播报由它承担。
 */

const { pushed, dismissed, custom } = vi.hoisted(() => ({
  pushed: [] as Array<{ message: string, options: Record<string, unknown> }>,
  /** 每一次撤销请求，按它点名的身份。 */
  dismissed: [] as string[],
  /** 以自定义组件渲染的那几条：组件本身，以及它拿到的选项。 */
  custom: [] as Array<{ component: unknown, options: Record<string, unknown> }>,
}))

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string, options: Record<string, unknown> = {}) => {
      pushed.push({ message, options })
      return options.id ?? pushed.length
    },
    {
      dismiss: (id?: string | number) => {
        dismissed.push(String(id ?? ''))
      },
      custom: (component: unknown, options: Record<string, unknown> = {}) => {
        custom.push({ component, options })
        return options.id ?? custom.length
      },
    },
  ),
}))

/** 夹具报告为取得的瞬间。2023-11-14T22:13:20Z。 */
const OBTAINED_AT = 1_700_000_000_000

function okResult(overrides: Partial<RefreshLiveResult> = {}): RefreshLiveResult {
  return {
    dataClass: 'live',
    throttled: false,
    lastUpdatedAt: OBTAINED_AT,
    nextAllowedAt: OBTAINED_AT + 18_000,
    retryAfterSeconds: 18,
    lines: [{
      lineId: 'line_a',
      direction: 0,
      lastUpdatedAt: OBTAINED_AT,
      dataSource: 'chelaile',
      isDegraded: false,
    }],
    ...overrides,
  }
}

function refusedResult(overrides: Partial<RefreshLiveResult> = {}): RefreshLiveResult {
  return {
    dataClass: 'live',
    throttled: true,
    lastUpdatedAt: null,
    nextAllowedAt: OBTAINED_AT + 18_000,
    retryAfterSeconds: 18,
    lines: [],
    ...overrides,
  }
}

function answerOnce(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async () => ({ status, json: async () => body }))
}

/** 那条提示所带的样式类；色调只是给文字撑腰，话本身携带状态。 */
function classOf(index: number): string {
  return String(pushed[index]!.options.class ?? '')
}

const TARGET = [{ lineId: 'line_a', direction: 0, cityCode: '001' }]

describe('一次按下的结局推一条提示', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pushed.length = 0
    dismissed.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('成功：一条自己退场的提示，说的是 store 那两段拼成的原文', async () => {
    const store = useTransitStore()
    answerOnce(200, { success: true, data: okResult() })

    expect(await store.refreshLive(TARGET)).toBe('ok')

    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.message).toBe('已刷新')
    expect(pushed[0]!.options.duration).toBe(REFRESH_RESULT_DURATION_MS)
    // 不给固定 id：连着两次成功也该各说一次，而不是让第二条被读成第一条的更新。
    expect(pushed[0]!.options.id).toBeUndefined()
    expect(classOf(0)).toContain('text-cyan-300')
    // 上一次的倒计时说的窗口已被这次按下花掉。
    expect(dismissed).toEqual([REFRESH_COOLDOWN_TOAST_ID])
  })

  it('成功：窗口关着的那几秒里不再多推一条（结局只说一次）', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    answerOnce(200, { success: true, data: okResult() })

    await store.refreshLive(TARGET)
    // 服务端把窗口关上了，故倒计时的指针在这几秒里一直在走。
    vi.advanceTimersByTime(5_000)

    expect(store.refreshNow).toBeGreaterThan(OBTAINED_AT)
    expect(pushed).toHaveLength(1)
  })

  it('被拒：驻留的那一条带着服务端的秒数，并按同一个身份逐秒改写自己', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const start = Date.now()
    answerOnce(429, {
      success: false,
      error: '…',
      data: refusedResult({ nextAllowedAt: start + 13_000, retryAfterSeconds: 13 }),
    })

    expect(await store.refreshLive(TARGET)).toBe('throttled')

    // 冷却那条以自定义组件渲染（两个节点，见下面那一组），故它不在字符串那一条里。
    expect(pushed).toHaveLength(0)
    expect(custom).toHaveLength(1)
    expect(custom[0]!.options.componentProps)
      .toEqual({ announcement: '刷新太频繁', detail: ' · 13 秒后可刷新' })
    // 驻留：它说的是「还要等多久」，一次说死就是假的。
    expect(custom[0]!.options.id).toBe(REFRESH_COOLDOWN_TOAST_ID)
    expect(custom[0]!.options.duration).toBe(Infinity)
    expect(String(custom[0]!.options.class ?? '')).toContain('text-amber-300')

    vi.advanceTimersByTime(1_000)
    expect(custom).toHaveLength(2)
    // 同一个身份上的更新是「同一件事的下一秒」，不是第二条通知，故屏幕上只有一条。
    expect(custom[1]!.options.id).toBe(REFRESH_COOLDOWN_TOAST_ID)
    expect(custom[1]!.options.componentProps)
      .toEqual({ announcement: '刷新太频繁', detail: ' · 12 秒后可刷新' })
    // 而它改写的仍是**那一个**组件：库按 id 更新同一条，绝不新挂一个。
    expect(custom[1]!.component).toBe(custom[0]!.component)

    vi.advanceTimersByTime(1_000)
    expect(custom[2]!.options.componentProps)
      .toEqual({ announcement: '刷新太频繁', detail: ' · 11 秒后可刷新' })
    expect(custom[2]!.options.id).toBe(REFRESH_COOLDOWN_TOAST_ID)
  })

  it('窗口一开那条提示就撤掉，而不是留在屏幕上说一个已经不成立的等待', async () => {
    vi.useFakeTimers()
    const store = useTransitStore()
    const start = Date.now()
    answerOnce(429, {
      success: false,
      error: '…',
      data: refusedResult({ nextAllowedAt: start + 3_000, retryAfterSeconds: 3 }),
    })

    await store.refreshLive(TARGET)
    expect(store.refreshOutcome).toBe('throttled')

    vi.advanceTimersByTime(3_000)

    expect(store.refreshOutcome).toBeNull()
    expect(dismissed).toContain(REFRESH_COOLDOWN_TOAST_ID)
  })

  it('失败：红调、自己退场，且与被拒说的话不同', async () => {
    const store = useTransitStore()
    answerOnce(502, { success: false, error: '…', data: null })

    expect(await store.refreshLive(TARGET)).toBe('unavailable')

    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.message).toBe('刷新失败 · 未能取到最新数据')
    expect(pushed[0]!.options.duration).toBe(REFRESH_RESULT_DURATION_MS)
    expect(classOf(0)).toContain('text-rose-300')
  })

  it('连接断开也推一次：没有到达服务端的那一次按压不是沉默', async () => {
    const store = useTransitStore()
    vi.stubGlobal('fetch', async () => {
      throw new Error('no connection')
    })

    expect(await store.refreshLive(TARGET)).toBe('offline')

    expect(pushed.map(item => item.message)).toEqual(['连接已断开 · 请检查网络'])
    expect(classOf(0)).toContain('text-rose-300')
  })

  it('没有可点名的线路时什么都不推：那是没有发出的请求', async () => {
    const store = useTransitStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await store.refreshLive([])).toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(pushed).toHaveLength(0)
  })

  it('两次按下各推一次：同一个结局连着发生也各说一次', async () => {
    const store = useTransitStore()
    answerOnce(200, { success: true, data: okResult() })

    await store.refreshLive(TARGET)
    await store.refreshLive(TARGET)

    expect(pushed.map(item => item.message)).toEqual(['已刷新', '已刷新'])
  })
})

describe('冷却那条的秒数对读屏隐藏，宣告语仍被读出', () => {
  /**
   * 库自己那个容器整块是一条 `aria-live="polite"`（`aria-relevant="additions text"`）的区域，
   * 故落在里面的**任何**文本变化都会被播报 —— 而冷却那条每秒都改写自己的秒数。
   * 秒数因此单独一个 `aria-hidden` 的节点：被隐藏的文本变化不触发播报，宣告语留在它外面。
   */
  async function mountCooldown(announcement = '刷新太频繁', detail = ' · 12 秒后可刷新') {
    const onCloseToast = vi.fn()
    const host = await mountComponent(RefreshCooldownContent, {
      props: { announcement, detail, onCloseToast },
    })
    return { host, onCloseToast }
  }

  it('秒数那一段是 aria-hidden 的节点，宣告语不在它里面', async () => {
    const { host } = await mountCooldown()

    const hidden = host.nodes(node => node.props['aria-hidden'] === 'true' && host.textOf(node).trim() !== '')
    expect(hidden, 'the countdown is not hidden from the live region').toHaveLength(1)
    // 逐秒改写的那一段正是被隐藏的那一段……
    expect(host.textOf(hidden[0]!).trim()).toBe('· 12 秒后可刷新')
    // ……而宣告语在被隐藏的那一段**之外**，故一条提示说什么仍旧读得出来。
    expect(host.textOf(hidden[0]!)).not.toContain('刷新太频繁')
    expect(host.text()).toContain('刷新太频繁')

    host.unmount()
  })

  it('库里那枚关闭按钮的位置由本组件自己补上，且接的是库交进来的处理', async () => {
    const { host, onCloseToast } = await mountCooldown()

    const close = host.node(
      node => node.tag === 'button' && node.props['aria-label'] === '关闭提示',
      'the close button',
    )
    click(close)

    expect(onCloseToast).toHaveBeenCalledTimes(1)
    host.unmount()
  })
})

describe('宿主全站一份，样式与位置对齐全站', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /** 去掉说明性文字，故被断言的是代码。 */
  function codeOf(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  const app = codeOf(read('../App.vue'))

  it('App.vue 挂着一份 Toaster', () => {
    // 三页共用同一条提示，故宿主只有一处；库自带的那条 live region 就在它里面。
    expect(app).toContain('<Toaster')
    expect(app.match(/<Toaster/g)).toHaveLength(1)
  })

  it('暗色、顶部居中，且往上避让刘海', () => {
    expect(app).toContain('theme="dark"')
    // 移动优先：底部被导航与 Home 指示条占着。
    expect(app).toContain('position="top-center"')
    // 它固定在视口上，逃出了 `<main>` 为每个路由加的安全区留白。
    expect(app).toContain('env(safe-area-inset-top')
    expect(app).toContain(':offset=')
    expect(app).toContain(':mobile-offset=')
  })

  it('条目样式是全站的：圆角、边框、暗底、12px 正文，且可手动关闭', () => {
    expect(app).toContain('rounded-xl')
    expect(app).toContain('border-slate-700')
    expect(app).toContain('bg-slate-800/90')
    expect(app).toContain('text-xs')
    // 关闭按钮是一个真的控件，故键盘也能关掉它。
    expect(app).toContain('close-button')
  })

  it('库自己的外观落在 base 层，故本仓的条目样式压得住它的亮色默认底', () => {
    const css = read('../assets/main.css')
    expect(css).toContain('vue-sonner/style.css')
    // 不写层就是无层规则：无层规则压过任何 @layer（包括本仓 utilities 里的条目样式）。
    expect(css).toMatch(/@import\s+"vue-sonner\/style\.css"\s+layer\(base\)/)
  })

  it('三页都不自己写提示文案：措辞只在一个地方', () => {
    for (const name of ['../views/overview/index.vue', '../views/commute-chain/index.vue', '../views/line-detail/index.vue']) {
      const code = codeOf(read(name))
      expect(code, `${name} pulls the toast library in`).not.toContain('vue-sonner')
      expect(code, `${name} words a refresh state itself`).not.toContain('刷新太频繁')
      expect(code, `${name} states no refresh status anywhere`).toContain('<RefreshControl')
    }
  })
})
