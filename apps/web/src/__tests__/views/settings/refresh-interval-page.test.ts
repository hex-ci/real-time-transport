import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  click,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
  type RecordedRequest,
} from './settings-harness'
import RefreshIntervalPage from '../../../views/settings/refresh-interval.vue'

/**
 * 实时刷新间隔子页：它说的「当前」必须是**此刻在跑的那个数**。
 *
 * 四种事实互不相同，各由渲染出的字守住：没保存过（按服务端此刻生效的节拍跑着，编辑器起点也取它）、
 * 保存过（每 N 秒）、读不到设置（绝不说 18 —— 那是把失败的读取穿成默认值）、
 * 读完但答案里没有生效值（只说未设置，也不拿 18 顶上）。
 *
 * 保存写回的是选中那一档：请求体里的秒数是唯一判据，页面自己说的话不算。
 */

const pushed: string[] = []

vi.mock('vue-sonner', () => ({
  toast: Object.assign(
    (message: string) => {
      pushed.push(message)
      return pushed.length
    },
    { dismiss: () => {}, custom: () => {} },
  ),
}))

/** 这一页只问一个端点：读一次，可能再写一次。 */
function routes(settings: Record<string, unknown> | 'fail'): Route[] {
  return [
    [/\/api\/transit\/settings/, () => (settings === 'fail' ? { success: false, error: '读取失败' } : settings)],
  ]
}

/** 没保存过的答案：行不存在，生效值由服务端给出。 */
function unsetAnswer(effective: number | 'absent'): Record<string, unknown> {
  return {
    success: true,
    settingsState: 'unset',
    data: null,
    ...(effective === 'absent' ? {} : { effectiveRefreshIntervalSec: effective }),
  }
}

function savedAnswer(sec: number): Record<string, unknown> {
  return {
    success: true,
    settingsState: 'stored',
    data: { refreshIntervalSec: sec },
    effectiveRefreshIntervalSec: sec,
  }
}

async function mountPage(settings: Record<string, unknown> | 'fail', props: Record<string, unknown> = {}): Promise<MountedHost> {
  const host = await mountComponent(RefreshIntervalPage, {
    routes: routes(settings),
    components: { RouterLink: RouterLinkStub },
    props,
  })
  await host.flush()
  return host
}

/** 页面上那个选中的档位按钮（按可见文字找）。 */
function preset(host: MountedHost, sec: number): HostElement {
  return host.node(
    item => item.tag === 'button' && host.textOf(item).trim() === `${sec} 秒`,
    `「${sec} 秒」那一档`,
  )
}

/**
 * 那一行「当前：……」的措辞（那一段还带一句说明「保存后立即生效，不用重启服务」，故断言用包含）。
 *
 * 只取以它开头的那个节点：页面上还有别处提到秒数（档位按钮、「起点」那句），
 * 而这几条断言问的只是「现在在跑几秒」这一句说的是什么。
 */
function currentText(host: MountedHost): string {
  const line = host.nodes(item => host.textOf(item).trim().startsWith('当前：')).at(-1)
  return line ? host.textOf(line) : ''
}

const writes = (host: MountedHost): RecordedRequest[] =>
  host.server.seen(/\/api\/transit\/settings/).filter(request => request.method === 'PATCH')

let host: MountedHost | null = null

afterEach(() => {
  host?.unmount()
  host = null
  pushed.length = 0
})

describe('没保存过：说的是此刻在跑的节拍，编辑器起点也取它', () => {
  it('生效 30 秒 → 「当前：未设置（默认每 30 秒）」，起点是 30 而不是 18', async () => {
    host = await mountPage(unsetAnswer(30))

    expect(currentText(host)).toContain('未设置（默认每 30 秒）')
    expect(host.text(), '起点那一句没说此刻在跑的数').toContain('下面选中的 30 秒只是起点')
    expect(preset(host, 30).props['aria-pressed']).toBe(true)
  })

  it('生效 18 秒 → 同一句话换成 18', async () => {
    host = await mountPage(unsetAnswer(18))

    expect(currentText(host)).toContain('未设置（默认每 18 秒）')
    expect(preset(host, 18).props['aria-pressed']).toBe(true)
  })

  it('读完但没有生效值 → 只说未设置，绝不拿 18 顶上', async () => {
    host = await mountPage(unsetAnswer('absent'))

    expect(currentText(host)).toContain('未设置')
    expect(currentText(host), '生效值没读到却说了 18').not.toContain('默认每')
  })
})

describe('保存过：说使用者自己选的数', () => {
  it('选了 10 秒 → 「当前：每 10 秒」，且不再出现「未设置」', async () => {
    host = await mountPage(savedAnswer(10))

    expect(currentText(host)).toContain('当前：每 10 秒')
    expect(host.text()).not.toContain('未设置')
    expect(preset(host, 10).props['aria-pressed']).toBe(true)
  })
})

describe('读不到设置：说读不到，绝不说 18', () => {
  it('读取失败 → 「当前：未读到设置」', async () => {
    host = await mountPage('fail')

    expect(currentText(host)).toContain('未读到设置')
    expect(host.text(), '读不到时还把 18 当成起点说了出去').not.toContain('只是起点')
  })
})

describe('保存：写回选中的那一档，写完那句话跟着改', () => {
  it('按 60 秒再保存 → 请求体带 60，页面改说「当前：每 60 秒」', async () => {
    host = await mountPage(unsetAnswer(30))

    click(preset(host, 60))
    await host.flush()
    const page = host
    const save = page.node(
      item => item.tag === 'button' && page.textOf(item).includes('保存'),
      '保存按钮',
    )
    click(save)
    await host.flush()

    expect(writes(host)).toHaveLength(1)
    expect(writes(host)[0]?.body, '保存写回的不是选中那一档').toMatchObject({ refreshIntervalSec: 60 })
    expect(currentText(host)).toContain('当前：每 60 秒')
    expect(host.text()).toContain('保存')
  })
})
