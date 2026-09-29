import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterLinkStub,
  mountComponent,
  type HostElement,
  type MountedHost,
  type Route,
} from '@/views/settings/__tests__/settings-harness'
import OverviewPage from '../index.vue'

/**
 * 首页的「行在、但通勤时段从没选过」。
 *
 * `windowState` 说得出三种事实：`stored`（有窗口）、`unset`（没有这一行）、`unchosen`
 * （行在，四个时刻是 NULL）。后两种都没有任何窗口可跟随，所以它们既不是「非通勤时段」（那是在说时钟
 * 落在两个已配置窗口之外），也不是任何内置时段。
 *
 * 这一版里说出这件事的有两处：没设过时那一句琥珀提示（只在 `unset` / `unchosen` 出现），以及「自动」
 * 那一枚的模式说明（三种事实三种词）。页面在这里被挂载（不是断言源码），因为被钉的是页面传递下去的
 * 那个事实。
 */

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: () => {} }),
}))

/**
 * 页面发出的读取，profile 答案由测试控制。
 *
 * 关注线路里有一条带 `reverseLineId` 的：于是「自动/上班/下班/附近」那一排真的在，它的模式说明是
 * 本页说出「现在是哪一档」的唯一地方。
 */
function routes(profile: unknown): Route[] {
  return [
    [/\/api\/transit\/favorites$/, () => ({
      success: true,
      data: [{
        id: 'fav-1',
        userId: 'default_user',
        cityCode: '027',
        lineId: 'bus_027_1',
        reverseLineId: 'bus_027_2',
        lineName: '快线 1 路',
        preferredDirection: 0,
        morningDirection: 0,
        eveningDirection: 1,
        displayOrder: 0,
      }],
    })],
    [/\/api\/transit\/cities/, () => ({ success: true, data: [{ code: '027', name: '北京市', hasMetro: true, hot: true, pinyin: 'beijing' }] })],
    [/\/api\/transit\/commute-profile/, () => profile],
    [/\/api\/transit\/runtime-flags/, () => ({ success: true, data: {} })],
    [/\/api\/transit\/lines\//, () => ({ success: true, data: null })],
  ]
}

async function mountOverview(profile: unknown): Promise<MountedHost> {
  const host = await mountComponent(OverviewPage, {
    routes: routes(profile),
    components: { RouterLink: RouterLinkStub },
  })
  await host.flush()
  return host
}

/** 模式那一排里「自动」那一枚的说明：本页说出当前这一档的地方。 */
function autoModeTitle(host: MountedHost): string {
  const buttons = host.nodes(node => node.tag === 'button' && String(node.props.title ?? '').startsWith('自动：'))
  expect(buttons, 'the page renders no 自动 mode button').toHaveLength(2)
  const titles = new Set(buttons.map(button => String(button.props.title)))
  expect(titles.size, 'the two toolbars disagree about the current mode').toBe(1)
  return [...titles][0]!
}

/** 没设过通勤时段时那一句琥珀提示。 */
function hints(host: MountedHost): HostElement[] {
  return host.nodes(node => String(node.props.class ?? '').includes('text-amber-400'))
}

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

describe('首页：行在、时段没选过，不等于「非通勤时段」', () => {
  it('windowState=unchosen 时，首页说「未设置通勤时段」，不说「非通勤」', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unchosen' },
    })

    const text = host.text()
    expect(text, 'a row whose hours were never chosen was reported as a clock outside a window').not.toContain('非通勤')
    expect(text).toContain('未设置通勤时段')
    // 两档各一句：这一句只在没设过时出现。
    expect(hints(host)).toHaveLength(2)
    host.unmount()
  })

  it('没有这一行时，「未设置通勤时段」仍然是那句话', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '未设置通勤时段', windowState: 'unset' },
    })

    expect(host.text()).toContain('未设置通勤时段')
    expect(host.text()).not.toContain('非通勤')
    expect(hints(host)).toHaveLength(2)
    host.unmount()
  })

  it('正对照：存过时段、而此刻在两个窗口之外时，首页照旧可以说「非通勤时段」', async () => {
    const host = await mountOverview({
      success: true,
      data: { mode: 'auto', description: '非通勤时段', windowState: 'stored' },
    })

    // 那话落在了「自动」那一枚的说明里（模式那几个词本身是页签上的字），而不是一条提示。
    expect(autoModeTitle(host)).toContain('当前非通勤时段')
    expect(hints(host)).toHaveLength(0)
    expect(host.text()).not.toContain('未设置通勤时段')
    host.unmount()
  })

  it('没读到的通勤时段：不声称窗口选定了它', async () => {
    const host = await mountOverview({ success: false, error: '读取失败' })

    // 「没读到」与「没设过」是两件事：「当前非通勤时段」会为一个没人看过的窗口记功。
    expect(autoModeTitle(host)).toContain('未读到通勤时段')
    expect(autoModeTitle(host)).not.toContain('当前非通勤时段')
    host.unmount()
  })
})
